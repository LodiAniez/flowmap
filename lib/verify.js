import { dirname } from 'node:path'
import { journey } from './graph.js'
import { resolveAnchor, parseAnchor, OK } from './anchor.js'
import { syncRepo } from './sync.js'
import { git } from './git.js'
import { cacheDir, saveMap } from './config.js'
import {
  checkContracts, parseSchemaRef, SCHEMA_OK, NO_SCHEMA, NOT_A_PATH, UNSEARCHED,
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
// Repos named explicitly by a schema ref, e.g. `loyalty-contract/src/x.ts::Thing`.
function schemaRepos(map) {
  const ids = Object.keys(map.repos ?? {})
  const found = new Set()
  for (const contract of Object.values(map.contracts ?? {})) {
    const ref = parseSchemaRef(contract.schema, ids)
    if (ref.kind === 'path' && ref.repo) found.add(ref.repo)
  }
  return [...found]
}

function pathsFor(entries, map, repoIds) {
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
    const ref = parseSchemaRef(contract.schema, repoIds)
    if (ref.kind === 'path') add(ref.path)
  }
  return [...paths]
}

export function verify(root, map, mapPath, { repoIds = null, journeys = null, now = new Date() } = {}) {
  const byRepo = anchorsByRepo(map, { journeys })
  const targets = [...byRepo.keys()].filter((id) => (repoIds ? repoIds.includes(id) : true))

  // A shared contracts package holds schemas but hosts no hops, so it never appears in
  // byRepo — yet without it every contract it defines reports "schema not found".
  for (const id of schemaRepos(map)) {
    if (!targets.includes(id) && (!repoIds || repoIds.includes(id))) targets.push(id)
  }

  // The `verified` record is per repo, but scoping to a journey checks only that journey's
  // anchors. Persisting a partial run would mark every OTHER journey's hops in that repo as
  // `ok` despite never being resolved — the confidently-green-on-unverified failure this
  // tool exists to prevent — and would suppress the next run's drift report by moving the
  // recorded sha. So a partial run reports, but does not record.
  const everyAnchor = anchorsByRepo(map)
  const scoped = Boolean(journeys || repoIds)
  const covers = (id) => {
    const seen = byRepo.get(id)?.length ?? 0
    const all = everyAnchor.get(id)?.length ?? 0
    // A repo synced only for its schemas has no anchors at all, and `0 >= 0` would record it
    // on a scoped run — promoting anchorless hops elsewhere to `ok` and moving its sha, which
    // makes the next full run under-report drift.
    if (all === 0) return !scoped
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
      synced = syncRepo(root, id, config, {
        mode: 'sparse',
        refresh: true,
        paths: pathsFor(entries, map, Object.keys(map.repos ?? {})),
      })
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
  const contracts = contractIds.length ? checkContracts(root, map, { contractIds, synced }) : []

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
    partial: repos.filter((r) => r.recorded === false).map((r) => r.id),
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
