import { dirname, posix } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { journey } from './graph.js'
import { resolveAnchor, parseAnchor, OK } from './anchor.js'
import { syncRepo } from './sync.js'
import { git } from './git.js'
import { cacheDir, saveMap, WIDE_REGISTRY } from './config.js'
import {
  checkContracts, parseSchemaRef, IMPORT_DEPTH, SCHEMA_OK, NO_SCHEMA, NOT_A_PATH, UNSEARCHED,
} from './contracts.js'
import { join } from 'node:path'

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

// Directories a sparse checkout needs: those holding the anchored files, plus those holding
// each contract's schema. This is what keeps verify cheap — kilobytes per repo, not a clone.
//
// Cone-mode sparse-checkout takes directories. Handing it a file path fails the whole
// command ("'schema.gql' is not a directory"), which took out the entire repo's verification.
// A schema ref may also carry a `::symbol` suffix or a repo prefix, neither of which is part
// of the path — parse it rather than trusting the raw string.
// Directories reachable in one hop from whatever is currently on disk and not already coned.
// Called once per import level, with a sync in between — see the caller.
function importDirsOnce(root, repoId, map, repoIds, have) {
  const covered = new Set(have)
  const found = new Set()

  for (const filePath of schemaFilesOnDisk(root, repoId, map, repoIds)) {
    for (const dep of relativeImportsOf(root, repoId, filePath)) {
      const dir = dirname(dep)
      const key = dir === '.' || dir === '' ? '.' : dir
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
  const re = /\b(?:import|export)[^'"]*?['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(source))) {
    // Resolve against the importing file, and normalise the extension the way the checker does.
    const raw = posix.normalize(posix.join(posix.dirname(filePath), m[1]))
    if (raw.startsWith('..')) continue
    // The spec as written matters: `./base.ts` is already a path, and appending an extension
    // to it yields `base.ts.ts`, which never resolves.
    out.push(raw)
    const stripped = raw.replace(/\.(js|mjs|cjs)$/, '')
    for (const ext of ['.ts', '.tsx', '.js', '/index.ts', '/index.js']) out.push(stripped + ext)
  }
  return out
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

export function verify(root, map, mapPath, { repoIds = null, journeys = null, now = new Date() } = {}) {
  const byRepo = anchorsByRepo(map, { journeys })
  const targets = [...byRepo.keys()].filter((id) => (repoIds ? repoIds.includes(id) : true))
  const scoped = Boolean(journeys || repoIds)

  // A shared contracts package holds schemas but hosts no hops, so it never appears in
  // byRepo — yet without it every contract it defines reports "schema not found". Repo-
  // prefixed refs name their repo; a bare path does not, so a full run has to look in every
  // registered repo before it is entitled to call a schema missing. The sparse cone keeps
  // that to the schema directories.
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
  for (const id of alsoSync) {
    if (!targets.includes(id) && (!repoIds || repoIds.includes(id))) targets.push(id)
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
    const entries = byRepo.get(id) ?? []
    const config = map.repos?.[id]

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
    const complete = covers(id)
    repos.push({
      recorded: complete,
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
  const synced = new Set(repos.filter((r) => !r.error).map((r) => r.id))
  const inScope = new Set()
  for (const name of journeys ?? Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name)?.hops ?? []) {
      if (!synced.has(hop.repo)) continue
      if (hop.inbound) inScope.add(hop.inbound)
      if (hop.outbound) inScope.add(hop.outbound)
    }
  }
  const contractIds = Object.keys(map.contracts ?? {}).filter((id) => inScope.has(id))
  // A repo that errored is not evidence of absence — it is evidence we could not look. That
  // legitimately suppresses every "not found", so the reason has to be reported, or contract
  // findings vanish map-wide with nothing saying why.
  const unreachable = repos.filter((r) => r.error).map((r) => r.id)
  const contracts = contractIds.length
    // Not looking everywhere has three causes, and all three forbid a confident "nowhere":
    // the run was scoped, a repo was unreachable, or the registry was too wide to sweep.
    ? checkContracts(root, map, {
        contractIds,
        synced,
        scoped: scoped || unreachable.length > 0 || (bareSchema && !sweepable),
      })
    : []

  // A contract with no schema, or one naming a package rather than a file, is not a failure —
  // there is simply nothing to check against, and saying so beats inventing a verdict.
  const contractIssues = contracts.filter(
    (c) =>
      c.status !== SCHEMA_OK && c.status !== NO_SCHEMA && c.status !== NOT_A_PATH &&
      c.status !== UNSEARCHED
  )

  saveMap(mapPath, map)
  return {
    repos,
    rows,
    broken: rows.filter((r) => r.status !== OK),
    // "Skipped by scoping" means a repo that has anchors this run chose not to resolve. A
    // repo synced only so its schemas could be read has nothing to verify and is not skipped.
    partial: repos.filter((r) => r.recorded === false && r.total > 0).map((r) => r.id),
    // What this run actually examined. `repos` includes entries synced only to read schemas,
    // so it cannot answer "did we check anything".
    checked: rows.length + contracts.length,
    // Why contract findings may be suppressed, so the CLI can say so.
    contractsSuppressedBy: unreachable,
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
