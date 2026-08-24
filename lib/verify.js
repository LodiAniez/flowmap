import { dirname } from 'node:path'
import { journey } from './graph.js'
import { resolveAnchor, parseAnchor, OK } from './anchor.js'
import { syncRepo } from './sync.js'
import { git } from './git.js'
import { cacheDir, saveMap } from './config.js'
import { checkContracts, SCHEMA_OK, NO_SCHEMA, NOT_A_PATH } from './contracts.js'
import { join } from 'node:path'

// Every anchor in every journey, grouped by the repo that owns it. Verification is per repo
// because that is the unit that gets synced, and because the anchors in one repo share a
// commit — one sha answers for all of them.
export function anchorsByRepo(map, { journeys = null } = {}) {
  const names = journeys ?? Object.keys(map.journeys ?? {})
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

// Paths a sparse checkout needs: the files the anchors name, plus each contract's schema.
// This is what keeps verify cheap — kilobytes per repo instead of a clone.
function pathsFor(entries, map) {
  const paths = new Set()
  for (const e of entries) {
    const parsed = parseAnchor(e.anchor)
    if (parsed) paths.add(dirname(parsed.path) === '.' ? parsed.path : dirname(parsed.path))
  }
  for (const contract of Object.values(map.contracts ?? {})) {
    if (contract.schema && !contract.schema.includes(' ')) paths.add(contract.schema)
  }
  return [...paths]
}

export function verify(root, map, mapPath, { repoIds = null, journeys = null, now = new Date() } = {}) {
  const byRepo = anchorsByRepo(map, { journeys })
  const targets = [...byRepo.keys()].filter((id) => (repoIds ? repoIds.includes(id) : true))

  // The `verified` record is per repo, but scoping to a journey checks only that journey's
  // anchors. Persisting a partial run would mark every OTHER journey's hops in that repo as
  // `ok` despite never being resolved — the confidently-green-on-unverified failure this
  // tool exists to prevent — and would suppress the next run's drift report by moving the
  // recorded sha. So a partial run reports, but does not record.
  const everyAnchor = anchorsByRepo(map)
  const covers = (id) => (byRepo.get(id)?.length ?? 0) >= (everyAnchor.get(id)?.length ?? 0)

  const repos = []
  const rows = []

  for (const id of targets) {
    const entries = byRepo.get(id)
    const config = map.repos?.[id]

    if (!config) {
      // A journey naming a repo the registry does not know is a defect in the map, not a
      // drifted anchor, and must not be reported as one.
      repos.push({ id, error: 'not in the repos registry', ok: 0, total: entries.length })
      for (const e of entries) rows.push({ ...e, repo: id, status: 'repo-unregistered' })
      continue
    }

    const previous = map.verified?.[id] ?? null
    let synced
    try {
      synced = syncRepo(root, id, config, { mode: 'sparse', refresh: true, paths: pathsFor(entries, map) })
    } catch (err) {
      repos.push({ id, error: err.message, ok: 0, total: entries.length, previous })
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
    repos.push({
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

    const complete = covers(id)
    repos[repos.length - 1].recorded = complete
    if (complete) {
      map.verified[id] = {
        branch: synced.branch,
        sha: synced.sha,
        at: now.toISOString().slice(0, 10),
        anchors: `${ok}/${entries.length}`,
      }
    }
  }

  // Contracts are checked only against repos this run actually synced, otherwise a scoped
  // run would report a contract as missing purely because its repo was never fetched.
  const synced = new Set(repos.filter((r) => !r.error).map((r) => r.id))
  const contractIds = Object.keys(map.contracts ?? {}).filter((id) =>
    [...anchorsByRepo(map, { journeys }).keys()].some((r) => synced.has(r))
  )
  const contracts = contractIds.length ? checkContracts(root, map, { contractIds }) : []

  // A contract with no schema, or one naming a package rather than a file, is not a failure —
  // there is simply nothing to check against, and saying so beats inventing a verdict.
  const contractIssues = contracts.filter(
    (c) => c.status !== SCHEMA_OK && c.status !== NO_SCHEMA && c.status !== NOT_A_PATH
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
      ? c.missing.map((field) => [c.repo ?? '-', '-', '-', 'schema', `${c.id}:${field}`, 'field-missing', '-'])
      : [[c.repo ?? '-', '-', '-', 'schema', c.id, c.status, '-']]
  )
}
