import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flowmap-verify-'))
process.env.FLOWMAP_CACHE = join(root, '.flowmap-cache')

const upstream = join(root, 'svc-origin')
mkdirSync(join(upstream, 'src'), { recursive: true })
writeFileSync(join(upstream, 'src', 'handler.ts'), 'export function handleThing(x) { return x }\n')
run(['init', '-q', '-b', 'main'], upstream)
run(['add', '-A'], upstream)
run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], upstream)

const { verify, anchorsByRepo, VERIFY_COLUMNS, verifyRow } = await import('../lib/verify.js')

function freshMap() {
  return {
    repos: { svc: { url: upstream, branch: 'main' } },
    contracts: {},
    journeys: {
      flow: { hops: [{ repo: 'svc', outbound: null, reads: 'src/handler.ts::handleThing' }] },
    },
    verified: {},
  }
}

test('collects every anchor in the map, grouped by the repo that owns it', () => {
  const byRepo = anchorsByRepo(freshMap())
  assert.deepEqual([...byRepo.keys()], ['svc'])
  assert.equal(byRepo.get('svc').length, 1)
})

test('records branch, sha and an anchor tally after a clean run', () => {
  const map = freshMap()
  const mapPath = join(root, 'flowmap.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.equal(result.broken.length, 0)

  const saved = JSON.parse(readFileSync(mapPath, 'utf8')).verified.svc
  assert.equal(saved.branch, 'main')
  assert.equal(saved.anchors, '1/1')
  assert.match(saved.sha, /^[0-9a-f]{40}$/)
  assert.match(saved.at, /^\d{4}-\d{2}-\d{2}$/)
})

// The point of recording the sha: a re-run answers "what moved", not just "did it pass".
test('reports that a repo moved since the last verification', () => {
  const map = freshMap()
  const mapPath = join(root, 'flowmap-moved.json')
  map.verified.svc = { branch: 'main', sha: '0'.repeat(40), at: '2020-01-01', anchors: '1/1' }
  writeFileSync(mapPath, JSON.stringify(map))

  const { repos } = verify(root, map, mapPath)
  assert.equal(repos[0].moved, true)
  assert.equal(repos[0].previousSha, '0'.repeat(40))
})

test('a first run does not claim the repo moved', () => {
  const map = freshMap()
  const mapPath = join(root, 'flowmap-first.json')
  writeFileSync(mapPath, JSON.stringify(map))
  assert.equal(verify(root, map, mapPath).repos[0].moved, false)
})

test('distinguishes a renamed symbol from a deleted file', () => {
  const map = freshMap()
  map.journeys.flow.hops = [
    { repo: 'svc', reads: 'src/handler.ts::renamedAway' },
    { repo: 'svc', reads: 'src/gone.ts::handleThing' },
  ]
  const mapPath = join(root, 'flowmap-broken.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const { broken } = verify(root, map, mapPath)
  assert.deepEqual(broken.map((b) => b.status).sort(), ['file-missing', 'symbol-missing'])
})

// A journey naming an unregistered repo is a defect in the map, not a drifted anchor, and
// conflating the two sends someone looking in the wrong place.
test('an unregistered repo is reported distinctly from a broken anchor', () => {
  const map = freshMap()
  map.journeys.flow.hops = [{ repo: 'never-registered', reads: 'a.ts::b' }]
  const mapPath = join(root, 'flowmap-unreg.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const { repos, broken } = verify(root, map, mapPath)
  assert.match(repos[0].error, /registry/)
  assert.equal(broken[0].status, 'repo-unregistered')
})

test('scoping to a repo leaves other repos verification untouched', () => {
  const map = freshMap()
  map.repos.other = { url: upstream, branch: 'main' }
  map.journeys.flow.hops.push({ repo: 'other', reads: 'src/handler.ts::handleThing' })
  map.verified.other = { branch: 'main', sha: 'abc', at: '2020-01-01', anchors: '1/1' }

  const mapPath = join(root, 'flowmap-scoped.json')
  writeFileSync(mapPath, JSON.stringify(map))
  verify(root, map, mapPath, { repoIds: ['svc'] })

  const saved = JSON.parse(readFileSync(mapPath, 'utf8')).verified
  assert.equal(saved.other.at, '2020-01-01', 'an unscoped repo keeps its previous record')
  assert.notEqual(saved.svc.at, '2020-01-01')
})

test('agent column order is pinned', () => {
  assert.deepEqual(VERIFY_COLUMNS, ['repo', 'journey', 'hop', 'side', 'anchor', 'status', 'line'])
  const row = verifyRow({ repo: 'a', journey: 'j', hop: 1, side: 'reads', anchor: 'x::y', status: 'ok' })
  assert.equal(row.length, VERIFY_COLUMNS.length)
  assert.equal(row[6], '-', 'a missing line renders as a dash, never an empty cell')
})

// `verified` is tracked per repo, but scoping to a journey resolves only that journey's
// anchors. Recording a partial run marks every OTHER journey's hops in that repo `ok`
// without ever checking them — and moves the sha, suppressing the next drift report.
test('a journey-scoped run does not record verification for the repo', async () => {
  const { journey } = await import('../lib/graph.js')
  const map = freshMap()
  map.journeys.other = { hops: [{ repo: 'svc', reads: 'src/handler.ts::doesNotExist' }] }
  const mapPath = join(root, 'flowmap-partial.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { journeys: ['flow'] })

  assert.deepEqual(result.partial, ['svc'], 'the run reports itself as partial')
  assert.equal(map.verified.svc, undefined, 'nothing is recorded')
  assert.equal(journey(map, 'other').hops[0].status, 'unverified',
    'the unchecked journey must not inherit a pass')
})

test('a full run does record, and its tally covers every journey in the repo', () => {
  const map = freshMap()
  map.journeys.other = { hops: [{ repo: 'svc', reads: 'src/handler.ts::doesNotExist' }] }
  const mapPath = join(root, 'flowmap-full.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.partial, [])
  assert.equal(map.verified.svc.anchors, '1/2', 'the broken anchor is counted')
  assert.equal(result.broken.length, 1)
})

test('a repo-scoped run over all its journeys still records', () => {
  const map = freshMap()
  const mapPath = join(root, 'flowmap-repo-scoped.json')
  writeFileSync(mapPath, JSON.stringify(map))
  const result = verify(root, map, mapPath, { repoIds: ['svc'] })
  assert.deepEqual(result.partial, [], 'scoping by repo is not partial coverage of that repo')
  assert.ok(map.verified.svc)
})

// Cone mode rejects a leading slash, which failed the whole sparse-checkout command and made
// verify fall back to materialising the entire repo.
test('a root-level file contributes "." to the sparse cone, not "/"', async () => {
  const { anchorsByRepo } = await import('../lib/verify.js')
  const mod = await import('../lib/verify.js')
  // pathsFor is internal; exercise it through a map whose anchor sits at the repo root.
  const map = {
    repos: { svc: { url: upstream, branch: 'main' } },
    contracts: { c: { schema: 'schema.gql', fields: [] } },
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'root.ts::thing' }] } },
    verified: {},
  }
  const mapPath = join(root, 'flowmap-root.json')
  writeFileSync(mapPath, JSON.stringify(map))
  const result = mod.verify(root, map, mapPath)
  // The run must complete rather than dying on the cone; the anchor itself is expected to fail.
  assert.ok(result.repos[0].sha, 'the repo synced despite root-level paths')
  assert.equal(result.repos[0].error, undefined)
  void anchorsByRepo
})

// An entirely offline run records nothing, and must not claim otherwise.
test('a run where every repo is unreachable reports itself as not recorded', () => {
  const map = {
    repos: { svc: { url: '/nonexistent/nowhere', branch: 'main' } },
    contracts: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'a.ts::b' }] } },
    verified: {},
  }
  const mapPath = join(root, 'flowmap-offline.json')
  writeFileSync(mapPath, JSON.stringify(map))
  const result = verify(root, map, mapPath)
  assert.deepEqual(result.partial, ['svc'], 'an errored repo counts as not recorded')
  assert.equal(map.verified.svc, undefined)
})

// A repeated name pushed every anchor twice, so the scoped count exceeded the full count and
// coverage came out true — recording a run that had checked one journey and vouching for all.
test('a repeated journey name does not fake full coverage', () => {
  const map = freshMap()
  map.journeys.other = { hops: [{ repo: 'svc', reads: 'src/handler.ts::doesNotExist' }] }
  const mapPath = join(root, 'flowmap-dupe.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { journeys: ['flow', 'flow'] })
  assert.deepEqual(result.partial, ['svc'], 'still a partial run')
  assert.equal(map.verified.svc, undefined, 'and still records nothing')
  assert.equal(result.broken.length, 0, 'nor double-counts anchors')
})

// A repo synced only for its schemas has no anchors; `0 >= 0` would record it on a scoped run.
test('a schema-only repo is not recorded by a scoped run', async () => {
  const { checkContracts } = await import('../lib/contracts.js')
  void checkContracts
  const map = freshMap()
  map.repos.contracts = { url: upstream, branch: 'main' }
  map.contracts = { c: { schema: 'contracts/src/handler.ts', fields: [] } }
  const mapPath = join(root, 'flowmap-schemaonly.json')
  writeFileSync(mapPath, JSON.stringify(map))

  verify(root, map, mapPath, { journeys: ['flow'] })
  assert.equal(map.verified.contracts, undefined, 'a scoped run vouches for nothing')
})
