import { dirname, join, posix } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { journey } from './graph.js'
import { resolveAnchor, parseAnchor, OK } from './anchor.js'
import { syncRepo } from './sync.js'
import { git } from './git.js'
import { cacheDir, saveMap, WIDE_REGISTRY } from './config.js'
import {
  checkContracts, parseSchemaRef, IMPORT_DEPTH, SCHEMA_OK, NO_SCHEMA, NOT_A_PATH, UNSEARCHED,
  AMBIGUOUS,
} from './contracts.js'

// Every anchor in every journey, grouped by the repo that owns it. Verification is per repo
// because that is the unit that gets synced, and because the anchors in one repo share a
// commit — one sha answers for all of them.
export function anchorsByRepo(map, { journeys = null } = {}) {
  // Deduped here rather than at the caller: a repeated name pushes every anchor twice, and a
  // scoped count that exceeds the full count makes coverage look complete when it is not.
  const names = [...new Set(journeys ?? Object.keys(map.journeys ?? {}))]
  const byRepo = new Map()

  for (const name of names) {
    const resolved = journey(map, name)
    if (!resolved) continue
    for (const hop of resolved.hops) {
      for (const side of ['reads', 'writes']) {
        if (!hop[side]) continue
        if (!byRepo.has(hop.repo)) byRepo.set(hop.repo, [])
        byRepo.get(hop.repo).push({ journey: name, hop: hop.index, side, anchor: hop[side] })
      }
    }
  }
  return byRepo
}

// Directories reachable in one hop from whatever is currently on disk and not already coned.
// Called once per import level, with a sync in between — see the caller.
function importDirsOnce(root, repoId, map, repoIds, have) {
  const covered = new Set(have)
  const found = new Set()

  for (const filePath of schemaFilesOnDisk(root, repoId, map, repoIds)) {
    for (const key of importDirKeys(root, repoId, filePath)) {
      if (!covered.has(key)) found.add(key)
    }
  }
  return [...found]
}

// Every schema file for this repo plus everything already fetched under the coned directories:
// after a widening sync those are the newly readable files whose own imports are still unknown.
function schemaFilesOnDisk(root, repoId, map, repoIds) {
  const files = new Set()
  for (const contract of Object.values(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract?.schema, repoIds)
    if (ref.kind !== 'path') continue
    if (ref.repo && ref.repo !== repoId) continue
    files.add(ref.path)
    for (const seen of readableFrom(root, repoId, ref.path)) files.add(seen)
  }
  return [...files]
}

// Transitively, the files we can already read from here. Bounded by what is on disk, which is
// what makes the per-level sync necessary in the first place.
function readableFrom(root, repoId, entry, seen = new Set()) {
  for (const dep of relativeImportsOf(root, repoId, entry)) {
    if (seen.has(dep)) continue
    if (!existsSync(join(cacheDir(root), repoId, dep))) continue
    seen.add(dep)
    readableFrom(root, repoId, dep, seen)
  }
  return seen
}

// Cone directories for one file's relative imports.
//
// Derived from the import spec, never from the candidate files built off it. Taking dirname()
// of a synthetic `<spec>/index.ts` candidate yields the spec itself as a "directory", and when
// the spec carries an extension (`../shared/base.ts`) that is a file — which cone mode rejects,
// failing the whole `sparse-checkout set` and falling back to disabling sparse for good.
// Guarding with existsSync did not help: git validates against the repository tree while
// existsSync sees only the working tree, so a file outside the current cone looks absent.
function importDirKeys(root, repoId, filePath) {
  const keys = new Set()
  for (const spec of relativeSpecsOf(root, repoId, filePath)) {
    const dir = posix.dirname(spec)
    keys.add(dir === '.' || dir === '' ? '.' : dir)
    // An extensionless spec may itself be a directory holding an index file.
    if (!posix.basename(spec).includes('.')) keys.add(spec)
  }
  return [...keys]
}

// The normalised, repo-relative target of each relative import, before any extension guessing.
function relativeSpecsOf(root, repoId, filePath) {
  const file = join(cacheDir(root), repoId, filePath)
  if (!existsSync(file)) return []
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  // Anchored on what actually introduces a module specifier. Matching any quoted dot-string
  // after an import/export keyword swept in ordinary data — `export const TEMPLATES =
  // './templates'` became an import, bloating the cone and occasionally handing git a file.
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  let m
  for (const re of patterns) {
    while ((m = re.exec(source))) {
      const raw = posix.normalize(posix.join(posix.dirname(filePath), m[1]))
      if (!raw.startsWith('..')) out.push(raw)
    }
  }
  return out
}

function relativeImportsOf(root, repoId, filePath) {
  const file = join(cacheDir(root), repoId, filePath)
  if (!existsSync(file)) return []
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  // Every form lib/contracts.js follows, or the checker looks for a file the cone never
  // fetched and downgrades a real verdict to "could not tell".
  // Anchored on what actually introduces a module specifier. Matching any quoted dot-string
  // after an import/export keyword swept in ordinary data — `export const TEMPLATES =
  // './templates'` became an import, bloating the cone and occasionally handing git a file.
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  let m
  for (const re of patterns) while ((m = re.exec(source))) {
    // Resolve against the importing file, and normalise the extension the way the checker does.
    const raw = posix.normalize(posix.join(posix.dirname(filePath), m[1]))
    if (raw.startsWith('..')) continue
    // The spec as written matters: `./base.ts` is already a path, and appending an extension
    // to it yields `base.ts.ts`, which never resolves.
    out.push(raw)
    const stripped = raw.replace(/\.(js|mjs|cjs)$/, '')
    // Must match lib/contracts.js resolveImport, or the checker reads a file the cone never
    // fetched — the two have drifted apart before.
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']) {
      out.push(stripped + ext)
    }
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']) out.push(`${stripped}/index${ext}`)
  }
  return out
}

// Why `unusedRepos` declined to judge, if it did. Null when the report is available.
function unusedReposReason(map, contracts) {
  const ids = Object.keys(map.repos ?? {})
  const byId = new Map(contracts.map((c) => [c.id, c]))
  const carried = new Set()
  for (const name of Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name)?.hops ?? []) {
      for (const id of [hop.inbound, hop.outbound]) if (id) carried.add(id)
    }
  }
  for (const [id, contract] of Object.entries(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract?.schema, ids)
    if (ref.kind !== 'path' || ref.repo) continue
    if (!carried.has(id)) return `${id} names a schema by a bare path but no hop carries it`
    if (!byId.get(id)?.repo) return `${id}'s schema was not located`
  }
  return null
}

// Drafts awaiting review. Their repos are in use even though no accepted journey names them.
function pendingDrafts(root) {
  const dir = join(root, 'drafts')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    } catch {
      // A malformed draft tells us nothing about repo usage; skip it rather than throw.
    }
  }
  return out
}

// Whether every bare-path schema in the map was located by this run. Anything less and the
// registry picture is partial, so nothing can be called unused.
function allBareResolved(map, contracts) {
  const ids = Object.keys(map.repos ?? {})
  const byId = new Map(contracts.map((c) => [c.id, c]))
  const carried = new Set()
  for (const name of Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name)?.hops ?? []) {
      for (const id of [hop.inbound, hop.outbound]) if (id) carried.add(id)
    }
  }

  for (const [id, contract] of Object.entries(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract?.schema, ids)
    if (ref.kind !== 'path' || ref.repo) continue
    // An orphan — in the map but carried by no hop — is never checked by any run, so waiting
    // for it to resolve meant the unused-repo report could never fire at all. Orphans arise
    // normally when a journey is deleted and its contracts stay behind.
    // An orphan is never checked, so it can never resolve — and a bare path we never located
    // means some repo's role is unknown.
    if (!carried.has(id) || !byId.get(id)?.repo) return false
  }
  return true
}

// Registry entries nothing uses: no journey hop names them and no contract schema lives in
// them. Discovery adds a repo whenever it merely mentions the search term, so these accumulate
// — and once a full run sweeps the registry to locate bare schema paths, each one costs a
// clone for nothing and pushes the registry towards the sweep guard.
export function unusedRepos(map, { foundIn = [], bareResolved = null, drafts = [], self = null } = {}) {
  const ids = Object.keys(map.repos ?? {})
  const used = new Set(foundIn)

  // The repo `flowmap init` registered for itself is what `--local` resolves against. Advising
  // its removal makes the documented PR-time scope fail with "needs to run inside a registered
  // repo", so it is never dead weight even when no journey names it.
  if (self) used.add(self)

  // A repo registered by `draft journey` is in use even though no accepted journey names it
  // yet. Removing it would make every hop in the pending draft resolve as repo-missing.
  for (const draft of drafts) {
    for (const hop of Array.isArray(draft?.hops) ? draft.hops : []) if (hop?.repo) used.add(hop.repo)
  }
  for (const name of Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name)?.hops ?? []) used.add(hop.repo)
  }

  // Any bare path we did not locate — carried or orphaned — leaves a repo unaccounted for, so
  // no repo can be called unused. An orphan is never checked by any run, so its presence
  // withholds the report permanently; that is the honest answer, and the caller is told why
  // rather than left wondering where the report went.
  let bare = false
  for (const contract of Object.values(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract?.schema, ids)
    if (ref.kind !== 'path') continue
    if (ref.repo) used.add(ref.repo)
    else bare = true
  }

  // A bare path does not say which repo holds it, so a repo can only be called unused once
  // every bare path has actually been located. One resolved path is not licence to judge the
  // rest: on a scoped run most contracts are never checked, and the report would name the
  // repo holding them. Telling someone to remove that breaks their map.
  if (bare && bareResolved !== true) return []

  return ids.filter((id) => !used.has(id))
}

// Repos named explicitly by a schema ref, e.g. `loyalty-contract/src/x.ts::Thing`.
function schemaRepos(map) {
  const ids = Object.keys(map.repos ?? {})
  const found = new Set()
  for (const contract of Object.values(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract?.schema, ids)
    if (ref.kind === 'path' && ref.repo) found.add(ref.repo)
  }
  return [...found]
}

// Directories a sparse checkout needs: those holding this repo's anchored files and its own
// contract schemas. Cone mode takes directories — handing it a file path fails the whole
// command — and a schema ref may carry a `::symbol` suffix or another repo's prefix, so parse
// it rather than trusting the raw string.
function pathsFor(entries, map, repoIds, repoId) {
  const paths = new Set()
  const add = (filePath) => {
    const dir = dirname(filePath)
    // Cone mode rejects a leading slash; '.' is how the repo root is spelled.
    paths.add(dir === '.' || dir === '' ? '.' : dir)
  }

  for (const e of entries) {
    const parsed = parseAnchor(e.anchor)
    if (parsed) add(parsed.path)
  }
  for (const contract of Object.values(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract?.schema, repoIds)
    if (ref.kind !== 'path') continue
    // A ref that names another repo says nothing about this one's layout; adding its
    // directory here quietly re-inflates every cone.
    if (ref.repo && ref.repo !== repoId) continue
    add(ref.path)
  }
  return [...paths]
}

export function verify(root, map, mapPath, { repoIds = null, journeys = null, self = null, now = new Date() } = {}) {
  const selfRepo = self
  // Exported and called with caller-supplied maps; loadMap normalises this but a direct caller
  // may not, and throwing here would lose a run that has already synced and mutated repos.
  map.verified ??= {}
  const byRepo = anchorsByRepo(map, { journeys })
  const targets = [...byRepo.keys()].filter((id) => (repoIds ? repoIds.includes(id) : true))
  const scoped = Boolean(journeys || repoIds)

  // A shared contracts package holds schemas but hosts no hops, so it never appears in
  // byRepo — yet without it every contract it defines reports "schema not found".
  // Only a full run earns the right to say "not found anywhere", so only a full run pays to
  // look everywhere — and only when some schema ref does not name its own repo, which is the
  // sole reason to look beyond the ones the journeys already touch.
  const bareSchema = Object.values(map.contracts ?? {}).some((c) => {
    const ref = parseSchemaRef(c?.schema, Object.keys(map.repos ?? {}))
    return ref.kind === 'path' && !ref.repo
  })
  const registry = Object.keys(map.repos ?? {})
  const sweepable = !scoped && bareSchema && registry.length <= WIDE_REGISTRY
  const alsoSync = sweepable ? registry : schemaRepos(map)
  const namedBySchema = new Set(schemaRepos(map))
  // Repos fetched only so their schemas can be read. Their anchors are deliberately not
  // resolved: `--repos a` means verify a's anchors, and pulling b in for its schema must not
  // quietly widen what is being verified.
  const schemaOnly = new Set()
  for (const id of alsoSync) {
    if (targets.includes(id)) continue
    const inScopeRepo = !repoIds || repoIds.includes(id)
    // A repo named outright by a schema ref is synced whatever the scope: lib/contracts.js
    // treats a repo-qualified "not found" as real precisely because that repo was searched,
    // and filtering it out here made --local silently check zero such contracts. Its cone is
    // just the schema directories, so the cost is a few kilobytes.
    if (!inScopeRepo && !namedBySchema.has(id)) continue
    if (!inScopeRepo) schemaOnly.add(id)
    targets.push(id)
  }

  // The `verified` record is per repo, but scoping to a journey checks only that journey's
  // anchors. Persisting a partial run would mark every OTHER journey's hops in that repo as
  // `ok` despite never being resolved — the confidently-green-on-unverified failure this
  // tool exists to prevent — and would suppress the next run's drift report by moving the
  // recorded sha. So a partial run reports, but does not record.
  const everyAnchor = anchorsByRepo(map)
  const covers = (id) => {
    const seen = byRepo.get(id)?.length ?? 0
    const all = everyAnchor.get(id)?.length ?? 0
    // A repo synced only for its schemas has no anchors at all, and `0 >= 0` would record it
    // on a scoped run — promoting anchorless hops elsewhere to `ok` and moving its sha, which
    // makes the next full run under-report drift.
    // A repo synced only for its schemas resolved no anchors, so there is nothing to vouch
    // for. Recording it would move its sha and mark anchorless hops elsewhere as ok.
    if (all === 0) return false
    return seen >= all
  }

  const repos = []
  const rows = []

  for (const id of targets) {
    const entries = schemaOnly.has(id) ? [] : byRepo.get(id) ?? []
    const config = Object.hasOwn(map.repos ?? {}, id) ? map.repos[id] : undefined

    if (!config) {
      // A journey naming a repo the registry does not know is a defect in the map, not a
      // drifted anchor, and must not be reported as one.
      repos.push({ id, error: 'not in the repos registry', recorded: false, ok: 0, total: entries.length })
      for (const e of entries) rows.push({ ...e, repo: id, status: 'repo-unregistered' })
      continue
    }

    const previous = map.verified?.[id] ?? null
    let synced
    try {
      // Every anchor in the map, not just this run's scope. The checkout cache is shared
      // between commands and runs, so a cone derived from one journey would leave every
      // other journey's files absent — reported later as anchors that no longer resolve.
      const base = pathsFor(everyAnchor.get(id) ?? [], map, Object.keys(map.repos ?? {}), id)
      synced = syncRepo(root, id, config, { mode: 'sparse', refresh: true, paths: base })

      // Schemas compose across sibling directories, which a cone does not include — so the
      // first pass can leave a schema's own imports unreadable and every verdict downgraded
      // to "could not tell". Widening to the whole top-level directory fixes that but costs
      // the entire sparse benefit (measured: 96MB and 68s across ten real repos). Instead,
      // read what landed, follow its relative imports, and widen by exactly those directories.
      // One round per import level, syncing between them: a level can only be discovered by
      // reading the level above it, and that is not on disk until its widening lands. Must
      // match IMPORT_DEPTH in lib/contracts.js — a cone shallower than the walk leaves the
      // checker reading files that were never fetched.
      let cone = base
      for (let level = 0; level < IMPORT_DEPTH; level++) {
        const extra = importDirsOnce(root, id, map, Object.keys(map.repos ?? {}), cone)
        if (!extra.length) break
        cone = [...cone, ...extra]
        synced = syncRepo(root, id, config, { mode: 'sparse', refresh: false, paths: cone })
      }
    } catch (err) {
      repos.push({ id, error: err.message, recorded: false, ok: 0, total: entries.length, previous })
      for (const e of entries) rows.push({ ...e, repo: id, status: 'unreachable' })
      continue
    }

    let ok = 0
    for (const e of entries) {
      const res = resolveAnchor(root, id, e.anchor)
      if (res.status === OK) ok++
      rows.push({ ...e, repo: id, status: res.status, line: res.line ?? null })
    }

    // The useful question is not "does it pass" but "what changed since we last looked".
    // Recording the sha is what turns a bare failure into a commit range to inspect.
    // Boolean, not a short-circuited undefined: this value is read by callers and emitted
    // in output, so "we have never looked" must be false, not absent.
    const moved = Boolean(previous?.sha && previous.sha !== synced.sha)
    // covers() answers "did this run resolve all of the repo's anchors"; it cannot see that
    // the checkout was incomplete, so half the anchors may have failed purely for not having
    // been fetched. Recording that stamps those hops ok and moves the sha, hiding the drift
    // from the next run too.
    const complete = covers(id) && !synced.narrowed
    repos.push({
      recorded: complete,
      // A checkout left on a stale cone reports anchors outside it as deleted; without this
      // the CLI concludes "the map is out of date" for what is a local failure.
      narrowed: Boolean(synced.narrowed),
      narrowedReason: synced.narrowedReason ?? null,
      id,
      branch: synced.branch,
      sha: synced.sha,
      previousSha: previous?.sha ?? null,
      previousAt: previous?.at ?? null,
      moved,
      range: moved ? commitRange(root, id, previous.sha, synced.sha) : null,
      ok,
      total: entries.length,
    })

    if (complete) {
      map.verified[id] = {
        branch: synced.branch,
        sha: synced.sha,
        at: now.toISOString().slice(0, 10),
        anchors: `${ok}/${entries.length}`,
      }
    }
  }

  // Only contracts belonging to the journeys this run covered, and only where a repo that
  // touches them was actually synced. Checking one whose repo was never fetched would report
  // "schema not found" for a contract that is perfectly fine.
  // A narrowed checkout is not a searched one: a schema that exists but was never fetched
  // reads exactly like a schema that is gone, and a full run would call that not-found.
  const synced = new Set(repos.filter((r) => !r.error && !r.narrowed).map((r) => r.id))
  const partialCheckouts = repos.filter((r) => r.narrowed).map((r) => r.id)
  const inScope = new Set()
  // Why a contract could not be checked, kept apart: a repo that errored is a failure, a repo
  // simply outside this run's scope is not. Reporting the second as the first makes every
  // scoped run — the documented PR-time path — look like a broken sync.
  // Same split as `unreachable` below: a repo missing from the registry needs the map fixed,
  // not the network retried, so its contracts must not be reported as a sync failure.
  const failedRepos = new Set(
    repos.filter((r) => r.error && r.error !== 'not in the repos registry').map((r) => r.id)
  )
  const unregisteredRepos = new Set(
    repos.filter((r) => r.error === 'not in the repos registry').map((r) => r.id)
  )
  const narrowedRepos = new Set(partialCheckouts)
  const strandedByFailure = new Set()
  const strandedByScope = new Set()
  const strandedByRegistry = new Set()
  const strandedByPartial = new Set()
  for (const name of journeys ?? Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name)?.hops ?? []) {
      for (const id of [hop.inbound, hop.outbound]) {
        if (!id) continue
        if (synced.has(hop.repo)) inScope.add(id)
        else if (failedRepos.has(hop.repo)) strandedByFailure.add(id)
        // Cloned and registered, but its files were not all fetched — a local failure, not a
        // scope the caller chose.
        else if (narrowedRepos.has(hop.repo)) strandedByPartial.add(id)
        // A repo the registry does not list has no scope to be outside of; saying it does
        // sends the user looking for a scope flag they never passed.
        else if (unregisteredRepos.has(hop.repo) || !Object.hasOwn(map.repos ?? {}, hop.repo)) {
          strandedByRegistry.add(id)
        } else strandedByScope.add(id)
      }
    }
  }
  // Only contracts that exist: a hop naming an undefined one is a map defect that acceptDraft
  // already reports, not something this run declined to check.
  const defined = (id) => Object.hasOwn(map.contracts ?? {}, id)
  const stranded = [...strandedByFailure].filter((id) => defined(id) && !inScope.has(id))
  const outOfScope = [...strandedByScope].filter(
    (id) => defined(id) && !inScope.has(id) && !strandedByFailure.has(id)
  )
  const unregistered = [...strandedByRegistry].filter(
    (id) => defined(id) && !inScope.has(id) && !strandedByFailure.has(id)
  )
  const contractIds = Object.keys(map.contracts ?? {}).filter((id) => inScope.has(id))
  // A repo that errored is not evidence of absence — it is evidence we could not look. That
  // legitimately suppresses every "not found", so the reason has to be reported, or contract
  // findings vanish map-wide with nothing saying why.
  // A repo missing from the registry is a map defect, not a network failure, and must not be
  // reported as one — the two need different fixes.
  const unreachable = repos.filter((r) => r.error && r.error !== 'not in the repos registry').map((r) => r.id)
  const contracts = contractIds.length
    // Not looking everywhere has three causes, and all three forbid a confident "nowhere":
    // the run was scoped, a repo was unreachable, or the registry was too wide to sweep.
    ? checkContracts(root, map, {
        contractIds,
        synced,
        scoped: scoped || unreachable.length > 0 || partialCheckouts.length > 0 || (bareSchema && !sweepable),
      })
    : []

  // A contract with no schema, or one naming a package rather than a file, is not a failure —
  // there is simply nothing to check against, and saying so beats inventing a verdict.
  const contractIssues = contracts.filter(
    (c) =>
      c.status !== SCHEMA_OK && c.status !== NO_SCHEMA && c.status !== NOT_A_PATH &&
      c.status !== UNSEARCHED && c.status !== AMBIGUOUS
  )

  // Work actually done: any contract we reached a verdict about. Skipped ones (no schema, not
  // a path, repo not synced) prove nothing — but not-found and ambiguous are verdicts, and
  // counting them as nothing let the CLI report "nothing to verify" over a real finding.
  const skipped = new Set([NO_SCHEMA, NOT_A_PATH, UNSEARCHED])
  const checked = rows.length + contracts.filter((c) => !skipped.has(c.status)).length
  if (checked > 0) saveMap(mapPath, map)

  return {
    repos,
    rows,
    broken: rows.filter((r) => r.status !== OK),
    // "Skipped by scoping" means a repo that has anchors this run chose not to resolve. A
    // repo synced only so its schemas could be read has nothing to verify and is not skipped;
    // nor is one held back solely because its checkout came up incomplete, which is a local
    // failure with its own message rather than a consequence of the scope.
    partial: repos
      .filter((r) => r.recorded === false && r.total > 0 && !r.narrowed && !r.error)
      .map((r) => r.id),
    // What this run actually examined. `repos` includes entries synced only to read schemas,
    // so it cannot answer "did we check anything".
    checked,
    // Why contract findings may be suppressed, so the CLI can say so rather than going quiet.
    // Pass the repos schemas were actually resolved in, so a bare path cannot make the repo
    // holding it look unused.
    unusedRepos: unusedRepos(map, {
      foundIn: contracts.map((c) => c.repo).filter(Boolean),
      // Every bare-path contract in the map was checked and located, so the picture is whole.
      bareResolved: allBareResolved(map, contracts),
      drafts: pendingDrafts(root),
      self: selfRepo,
    }),
    // Why the unused-repo report is unavailable, so its absence is explicable.
    unusedReposUnavailable: unusedReposReason(map, contracts),
    contractsStranded: stranded,
    contractsOutOfScope: outOfScope,
    contractsUnregistered: unregistered,
    contractsPartial: [...strandedByPartial].filter((id) => defined(id) && !inScope.has(id)),
    contractsSuppressedReason: unreachable.length
      ? `could not reach ${unreachable.join(', ')}`
      : partialCheckouts.length
        ? `${partialCheckouts.join(', ')} could only be fetched in part`
      : scoped
        ? 'this run was scoped, so repos outside it were never searched'
        : bareSchema && !sweepable
          ? `the registry has more than ${WIDE_REGISTRY} repos, so it was not swept`
          : null,
    contracts,
    contractIssues,
  }
}

// Best-effort: a shallow clone usually cannot see the old commit, and that is fine — the
// shas alone still tell you it moved.
function commitRange(root, id, from, to) {
  const dir = join(cacheDir(root), id)
  const count = git(['rev-list', '--count', `${from}..${to}`], { cwd: dir, allowFail: true })?.trim()
  return { from: from.slice(0, 7), to: to.slice(0, 7), commits: count ? Number(count) : null }
}

export const VERIFY_COLUMNS = ['repo', 'journey', 'hop', 'side', 'anchor', 'status', 'line']

export function verifyRow(r) {
  return [r.repo, r.journey, r.hop, r.side, r.anchor, r.status, r.line ?? '-']
}

// Contract findings ride the same seven columns rather than adding new ones: `side` is
// "schema" and `anchor` carries `contractId:field`. Growing VERIFY_COLUMNS would be a
// breaking change to a published interface for the sake of one row type.
export function contractRows(issues) {
  return issues.flatMap((c) =>
    c.missing.length
      ? c.missing.map((field) => [c.repo ?? '-', '-', '-', 'schema', `${c.id}:${field}`, c.status, '-'])
      : [[c.repo ?? '-', '-', '-', 'schema', c.id, c.status, '-']]
  )
}
