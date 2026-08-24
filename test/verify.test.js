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

// The checkout cache is shared across commands and runs, so a cone derived from one journey's
// scope leaves every other journey's files absent — later reported as anchors that no longer
// resolve, on code that is perfectly fine.
test('a scoped run does not narrow the cache against other journeys', async () => {
  const { resolveAnchor } = await import('../lib/anchor.js')
  const two = join(root, 'two-journey')
  mkdirSync(join(two, 'src', 'a'), { recursive: true })
  mkdirSync(join(two, 'src', 'b'), { recursive: true })
  writeFileSync(join(two, 'src', 'a', 'one.ts'), 'export function alpha() {}\n')
  writeFileSync(join(two, 'src', 'b', 'two.ts'), 'export function beta() {}\n')
  run(['init', '-q', '-b', 'main'], two)
  run(['add', '-A'], two)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], two)

  const map = {
    repos: { pair: { url: two, branch: 'main' } },
    contracts: {},
    verified: {},
    journeys: {
      a: { hops: [{ repo: 'pair', reads: 'src/a/one.ts::alpha' }] },
      b: { hops: [{ repo: 'pair', reads: 'src/b/two.ts::beta' }] },
    },
  }
  const mapPath = join(root, 'flowmap-two.json')
  writeFileSync(mapPath, JSON.stringify(map))

  verify(root, map, mapPath, { journeys: ['a'] })
  assert.equal(resolveAnchor(root, 'pair', 'src/b/two.ts::beta').status, 'ok',
    "journey b's anchor must survive a run scoped to journey a")
})

// A bare schema path can live in a repo that hosts no hops. A full run has to look there
// before it is entitled to call the schema missing.
test('a full run searches registered repos that host no hops', () => {
  const shared = join(root, 'shared-contracts')
  mkdirSync(join(shared, 'src', 'schemas'), { recursive: true })
  writeFileSync(join(shared, 'src', 'schemas', 'order.ts'), 'export const Order = { total: 0 }\n')
  run(['init', '-q', '-b', 'main'], shared)
  run(['add', '-A'], shared)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], shared)

  const map = {
    repos: { svc: { url: upstream, branch: 'main' }, shared: { url: shared, branch: 'main' } },
    contracts: { order: { kind: 'event', schema: 'src/schemas/order.ts', fields: ['total'] } },
    verified: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing', outbound: 'order' }] } },
  }
  const mapPath = join(root, 'flowmap-shared.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.contractIssues, [], 'the schema exists; it just lives in a hopless repo')
})

// A repo synced only so its schemas could be read has nothing to verify. Reporting it as
// "skipped by scoping" told users a bare run was scoped and to re-run it bare.
test('a schema-only repo is not reported as skipped by scoping', () => {
  const shared = join(root, 'schemas-only')
  mkdirSync(join(shared, 'src'), { recursive: true })
  writeFileSync(join(shared, 'src', 'x.ts'), 'export const X = 1\n')
  run(['init', '-q', '-b', 'main'], shared)
  run(['add', '-A'], shared)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], shared)

  const map = {
    repos: { svc: { url: upstream, branch: 'main' }, shared: { url: shared, branch: 'main' } },
    contracts: {},
    verified: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
  }
  const mapPath = join(root, 'flowmap-schemasonly2.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.partial, [], 'a bare run is not a scoped run')
  assert.equal(map.verified.shared, undefined, 'and nothing is vouched for there')
})

// Only a full run earns the right to say "not found anywhere", so only a full run should pay
// to look everywhere. A scoped run cloning the whole registry also bypasses the sweep guard.
test('a scoped run does not clone repos outside its scope', () => {
  const other = join(root, 'unrelated-repo')
  mkdirSync(join(other, 'src'), { recursive: true })
  writeFileSync(join(other, 'src', 'x.ts'), 'export const x = 1\n')
  run(['init', '-q', '-b', 'main'], other)
  run(['add', '-A'], other)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], other)

  const map = {
    repos: { svc: { url: upstream, branch: 'main' }, unrelated: { url: other, branch: 'main' } },
    contracts: {},
    verified: {},
    journeys: {
      flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] },
      elsewhere: { hops: [{ repo: 'unrelated', reads: 'src/x.ts::x' }] },
    },
  }
  const mapPath = join(root, 'flowmap-scope-clone.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { journeys: ['flow'] })
  assert.deepEqual(result.repos.map((r) => r.id), ['svc'], 'only the scoped journey\'s repo')
})

// The docs claimed a scoped run never records; the code records whenever the scope happens to
// cover all of a repo's anchors, which is the common one-journey-per-repo case. Pinning the
// real behaviour so the two cannot drift apart again.
test('a scoped run records a repo whose anchors it fully covered', () => {
  const map = freshMap()
  const mapPath = join(root, 'flowmap-scoped-covers.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { journeys: ['flow'] })
  assert.deepEqual(result.partial, [], 'nothing was left unchecked in that repo')
  assert.ok(map.verified.svc, 'so it is recorded')
})

// Declining to sweep a wide registry is also a reason we could not look everywhere. Without
// it, a registry over the sweep guard turned a healthy contract into a red schema-not-found.
test('a registry too wide to sweep does not produce a confident not-found', () => {
  const shared = join(root, 'wide-shared')
  mkdirSync(join(shared, 'src', 'schemas'), { recursive: true })
  writeFileSync(join(shared, 'src', 'schemas', 'order.ts'), 'export const O = z.object({ total: 0 })\n')
  run(['init', '-q', '-b', 'main'], shared)
  run(['add', '-A'], shared)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], shared)

  const repos = { svc: { url: upstream, branch: 'main' }, shared: { url: shared, branch: 'main' } }
  for (let i = 0; i < 12; i++) repos[`filler${i}`] = { url: upstream, branch: 'main' }

  const map = {
    repos,
    contracts: { order: { kind: 'event', schema: 'src/schemas/order.ts', fields: ['total'] } },
    verified: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing', outbound: 'order' }] } },
  }
  const mapPath = join(root, 'flowmap-wide.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.contractIssues, [],
    'the schema exists in a repo the sweep guard stopped us reaching')
})

test('a null contract entry does not crash the schema-repo scan', () => {
  const map = freshMap()
  map.contracts = { broken: null }
  const mapPath = join(root, 'flowmap-nullcontract.json')
  writeFileSync(mapPath, JSON.stringify(map))
  assert.doesNotThrow(() => verify(root, map, mapPath, { journeys: ['flow'] }))
})

// A bare schema path can exist in several repos. Taking the first and reporting a confident
// verdict from it decides the answer by registry ordering.
test('a schema path present in two repos is reported ambiguous, not judged', async () => {
  const { checkContract, AMBIGUOUS } = await import('../lib/contracts.js')
  const a = join(root, '.flowmap-cache', 'repo-a')
  const b = join(root, '.flowmap-cache', 'repo-b')
  for (const d of [a, b]) mkdirSync(join(d, 'src', 'schemas'), { recursive: true })
  writeFileSync(join(a, 'src', 'schemas', 'order.ts'), 'export const O = z.object({ total: 0 })\n')
  writeFileSync(join(b, 'src', 'schemas', 'order.ts'), 'export const O = z.object({ different: 0 })\n')

  const map = { repos: { 'repo-a': {}, 'repo-b': {} }, contracts: {}, journeys: {} }
  const r = checkContract(root, map, 'order', { schema: 'src/schemas/order.ts', fields: ['total'] }, {})
  assert.equal(r.status, AMBIGUOUS)
  assert.deepEqual(r.repos.sort(), ['repo-a', 'repo-b'])
})

// The map must not be rewritten by a run the CLI then rejects as a usage error.
test('a run that checked nothing does not rewrite the map', () => {
  const map = {
    repos: { svc: { url: upstream, branch: 'main' } },
    contracts: {},
    verified: {},
    // A journey with no anchors: nothing to resolve, nothing to record.
    journeys: { empty: { hops: [{ repo: 'svc' }] } },
  }
  const mapPath = join(root, 'flowmap-nothing.json')
  const original = JSON.stringify(map)
  writeFileSync(mapPath, original)

  const result = verify(root, map, mapPath)
  assert.equal(result.checked, 0)
  assert.equal(readFileSync(mapPath, 'utf8'), original, 'the file on disk is untouched')
})

// Discovery registers a repo whenever it merely mentions the search term, so entries nothing
// uses accumulate — and once a full run sweeps the registry to locate bare schema paths, each
// one costs a clone for nothing.
test('registry entries nothing uses are reported', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { svc: {}, holder: {}, nobody: {} },
    contracts: { c: { schema: 'holder/src/x.ts', fields: [] } },
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'a.ts::b' }] } },
  }
  assert.deepEqual(unusedRepos(map), ['nobody'],
    'svc hosts a hop and holder owns a schema; only nobody is dead weight')
})

// Telling someone to remove the repo their schemas live in would break their map. A bare
// schema path does not name its repo, so "nothing uses it" cannot be known from the map alone.
test('a repo holding a bare-path schema is never reported as unused', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { svc: {}, contractsPkg: {} },
    contracts: { c: { schema: 'src/schemas/order.ts', fields: [] } },
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'a.ts::b', outbound: 'c' }] } },
  }
  assert.deepEqual(unusedRepos(map), [], 'without knowing where the schema resolved, claim nothing')
  assert.deepEqual(unusedRepos(map, { foundIn: ['contractsPkg'] }), [],
    'and once we know, the holder is used')
})

test('a genuinely unused repo is still reported when every schema names its repo', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { svc: {}, holder: {}, nobody: {} },
    contracts: { c: { schema: 'holder/src/x.ts', fields: [] } },
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'a.ts::b' }] } },
  }
  assert.deepEqual(unusedRepos(map), ['nobody'])
})

// One located bare path is not licence to judge the rest: on a scoped run most contracts are
// never checked, and the report would name the repo holding them.
test('a partially-resolved bare-path map reports no unused repos', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { api: {}, 'loyalty-contracts': {} },
    contracts: {
      OrderCreated: { schema: 'src/schemas/order.ts', fields: [] },
      LoyaltyEvent: { schema: 'src/schemas/loyalty.ts', fields: [] },
    },
    journeys: { flow: { hops: [{ repo: 'api', reads: 'a.ts::b', outbound: 'OrderCreated' }] } },
  }
  // Only OrderCreated was located; LoyaltyEvent was never checked.
  const partial = unusedRepos(map, { foundIn: ['api'], bareResolved: false })
  assert.deepEqual(partial, [], 'the repo holding the unchecked schema must not be named')

  const complete = unusedRepos(map, { foundIn: ['api', 'loyalty-contracts'], bareResolved: true })
  assert.deepEqual(complete, [], 'and once both resolve, both repos are in use')
})

// not-found and ambiguous carry no missing fields, so counting only "SCHEMA_OK or missing"
// made them look like no work at all — and the CLI then reported "nothing to verify" over a
// real finding.
test('a contract verdict counts as work even when it lists no missing fields', () => {
  const map = {
    repos: { svc: { url: upstream, branch: 'main' } },
    contracts: { 'order.created': { kind: 'event', schema: 'src/schemas/gone.ts', fields: ['x'] } },
    verified: {},
    // Hops carry the contract but have no anchors, so rows will be empty.
    journeys: { flow: { hops: [{ repo: 'svc', outbound: 'order.created' }] } },
  }
  const mapPath = join(root, 'flowmap-contract-only.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.ok(result.contractIssues.length, 'the missing schema is a finding')
  assert.ok(result.checked > 0, 'and the run must not report itself as having checked nothing')
})

// A contract carried only by hops in a repo that failed to sync is dropped from scope; saying
// nothing about it is the map-wide vanishing the suppression reporting exists to prevent.
test('contracts stranded by an unreachable repo are reported', () => {
  const map = {
    repos: { gone: { url: '/nonexistent/repo', branch: 'main' } },
    contracts: { c: { kind: 'event', schema: 'src/x.ts', fields: ['f'] } },
    verified: {},
    journeys: { flow: { hops: [{ repo: 'gone', reads: 'a.ts::b', outbound: 'c' }] } },
  }
  const mapPath = join(root, 'flowmap-stranded.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.contractsStranded, ['c'])
})

// A repo registered for an in-progress draft is in use, even though no accepted journey names
// it — advising its removal would break the draft being worked on.
test('a repo used only by a pending draft is not called unused', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { svc: {}, drafted: {} },
    contracts: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'a.ts::b' }] } },
  }
  assert.deepEqual(unusedRepos(map), ['drafted'], 'without the draft it looks unused')
  assert.deepEqual(
    unusedRepos(map, { drafts: [{ hops: [{ repo: 'drafted', reads: 'x.ts::y' }] }] }),
    [],
    'and with it, it is in use'
  )
})

// And the wiring: verify must actually read drafts/ off disk, not just accept a list.
test('verify reads pending drafts when deciding what is unused', () => {
  const draftsDir = join(root, 'drafts')
  mkdirSync(draftsDir, { recursive: true })
  writeFileSync(join(draftsDir, 'pending.json'),
    JSON.stringify({ name: 'pending', hops: [{ repo: 'drafted', reads: 'x.ts::y' }] }))
  // A malformed sibling must not break the scan.
  writeFileSync(join(draftsDir, 'garbage.json'), '{ not json')

  const map = {
    repos: { svc: { url: upstream, branch: 'main' }, drafted: { url: upstream, branch: 'main' } },
    contracts: {},
    verified: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
  }
  const mapPath = join(root, 'flowmap-drafts.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.unusedRepos, [], 'the drafted repo is in use by a pending draft')
})

// A repo outside this run's scope did not fail. Reporting the two the same way made every
// scoped run — the documented PR-time path — look like a broken sync.
test('a contract outside the run scope is distinguished from one whose repo failed', () => {
  const other = join(root, 'scope-other')
  mkdirSync(join(other, 'src'), { recursive: true })
  writeFileSync(join(other, 'src', 'x.ts'), 'export const x = 1\n')
  run(['init', '-q', '-b', 'main'], other)
  run(['add', '-A'], other)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], other)

  const map = {
    repos: { a: { url: upstream, branch: 'main' }, b: { url: other, branch: 'main' } },
    // A bare path: nothing says which repo holds it, so a scoped run genuinely cannot check it.
    contracts: { onB: { kind: 'event', schema: 'src/x.ts', fields: [] } },
    verified: {},
    journeys: {
      ja: { hops: [{ repo: 'a', reads: 'src/handler.ts::handleThing' }] },
      jb: { hops: [{ repo: 'b', reads: 'src/x.ts::x', outbound: 'onB' }] },
    },
  }
  const mapPath = join(root, 'flowmap-scope-split.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { repoIds: ['a'] })
  assert.deepEqual(result.contractsStranded, [], 'nothing failed to sync')
  assert.deepEqual(result.contractsOutOfScope, ['onB'], 'it was simply not in scope')
})

// A repo-qualified schema names its repo, and verify syncs that repo whatever the scope — so
// the contract is checkable even on a scoped run. Without this, --local silently checked zero
// contracts whose schema lives in a shared contracts package.
test('a repo-qualified schema is checked even on a scoped run', () => {
  const pkg = join(root, 'scope-pkg')
  mkdirSync(join(pkg, 'src'), { recursive: true })
  writeFileSync(join(pkg, 'src', 'order.ts'), 'export const O = z.object({ total: z.number() })\n')
  run(['init', '-q', '-b', 'main'], pkg)
  run(['add', '-A'], pkg)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], pkg)

  const map = {
    repos: { app: { url: upstream, branch: 'main' }, pkg: { url: pkg, branch: 'main' } },
    contracts: { order: { kind: 'event', schema: 'pkg/src/order.ts', fields: ['total', 'ghost'] } },
    verified: {},
    journeys: { flow: { hops: [{ repo: 'app', reads: 'src/handler.ts::handleThing', outbound: 'order' }] } },
  }
  const mapPath = join(root, 'flowmap-qualified-scoped.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { repoIds: ['app'] })
  const order = result.contracts.find((c) => c.id === 'order')
  assert.equal(order?.status, 'fields-missing', 'the named repo was fetched and searched')
  assert.deepEqual(result.contractsOutOfScope, [])
})

// An orphan bare-path contract is never checked by any run, so the repo holding its schema is
// unaccounted for and no repo can safely be called unused. The report is withheld — but the
// reason is stated, which is what makes the silence acceptable rather than a dead feature.
test('an orphan bare-path contract withholds the report, with a reason', () => {
  const spare = join(root, 'orphan-spare')
  mkdirSync(join(spare, 'src'), { recursive: true })
  writeFileSync(join(spare, 'src', 'x.ts'), 'export const x = 1\n')
  run(['init', '-q', '-b', 'main'], spare)
  run(['add', '-A'], spare)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], spare)

  const map = {
    repos: { svc: { url: upstream, branch: 'main' }, nobody: { url: spare, branch: 'main' } },
    // Carried by no hop: left behind when a journey was deleted.
    contracts: { leftover: { kind: 'event', schema: 'src/schemas/old.ts', fields: [] } },
    verified: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
  }
  const mapPath = join(root, 'flowmap-orphan.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.unusedRepos, [], 'the holding repo is unaccounted for')
  assert.match(result.unusedReposUnavailable, /leftover/, 'and the caller is told which contract')
})

// With no orphan in the way, the report still works.
test('the unused-repo report fires when every bare path resolved', () => {
  const spare = join(root, 'clean-spare')
  mkdirSync(join(spare, 'src'), { recursive: true })
  writeFileSync(join(spare, 'src', 'x.ts'), 'export const x = 1\n')
  run(['init', '-q', '-b', 'main'], spare)
  run(['add', '-A'], spare)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], spare)

  const map = {
    repos: { svc: { url: upstream, branch: 'main' }, nobody: { url: spare, branch: 'main' } },
    contracts: {},
    verified: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
  }
  const mapPath = join(root, 'flowmap-clean-unused.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.equal(result.unusedReposUnavailable, null)
  assert.deepEqual(result.unusedRepos, ['nobody'])
})

// `--local` resolves against the repo flowmap.json lives in; advising its removal makes the
// documented PR-time scope fail with "needs to run inside a registered repo".
test('the self-registered repo is never reported as unused', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { ctx: {}, svc: {} },
    contracts: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'a.ts::b' }] } },
  }
  assert.deepEqual(unusedRepos(map), ['ctx'], 'without knowing, it looks unused')
  assert.deepEqual(unusedRepos(map, { self: 'ctx' }), [], 'but --local depends on it')
})

// An orphan contract is never checked, so it must not count towards the completeness gate
// either — counting it let the gate pass with the holding repo unlocated, and the report then
// named that repo as safe to delete.
test('an orphan bare-path contract cannot make a live repo look removable', async () => {
  const { unusedRepos } = await import('../lib/verify.js')
  const map = {
    repos: { app: {}, contractspkg: {} },
    contracts: { 'legacy.order': { schema: 'src/schemas/order.ts', fields: [] } },
    journeys: { flow: { hops: [{ repo: 'app', reads: 'a.ts::b' }] } },
  }
  // The orphan was never resolved, so nothing here is known about contractspkg.
  assert.deepEqual(unusedRepos(map, { foundIn: [], bareResolved: false }), [],
    'an unresolved orphan must not license the claim')
})

test('verify tolerates a map with no verified block', () => {
  const map = {
    repos: { svc: { url: upstream, branch: 'main' } },
    contracts: {},
    journeys: { flow: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
  }
  const mapPath = join(root, 'flowmap-noverified.json')
  writeFileSync(mapPath, JSON.stringify(map))
  assert.doesNotThrow(() => verify(root, map, mapPath))
  assert.ok(map.verified.svc)
})

// A hop naming a contract the map does not define is a map defect acceptDraft already reports,
// not something this run declined to check.
test('a hop naming an undefined contract is not reported as unchecked', () => {
  const map = {
    repos: { a: { url: upstream, branch: 'main' }, b: { url: upstream, branch: 'main' } },
    contracts: {},
    verified: {},
    journeys: {
      ja: { hops: [{ repo: 'a', reads: 'src/handler.ts::handleThing' }] },
      jb: { hops: [{ repo: 'b', reads: 'src/handler.ts::handleThing', outbound: 'does.not.exist' }] },
    },
  }
  const mapPath = join(root, 'flowmap-ghost-contract.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath, { repoIds: ['a'] })
  assert.deepEqual(result.contractsOutOfScope, [], 'it does not exist, so it was not skipped')
  assert.deepEqual(result.contractsStranded, [])
})

// A repo missing from the registry needs the map fixed, not the network retried.
test('a registry defect is not reported as a sync failure', () => {
  const map = {
    repos: { a: { url: upstream, branch: 'main' } },
    contracts: { c: { kind: 'event', schema: 'src/x.ts', fields: [] } },
    verified: {},
    journeys: {
      ja: { hops: [{ repo: 'a', reads: 'src/handler.ts::handleThing' }] },
      jb: { hops: [{ repo: 'not-registered', reads: 'x.ts::y', outbound: 'c' }] },
    },
  }
  const mapPath = join(root, 'flowmap-registry-defect.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const result = verify(root, map, mapPath)
  assert.deepEqual(result.contractsStranded, [], 'not a sync failure')
  assert.deepEqual(result.contractsOutOfScope, [], 'and there is no scope to be outside of')
  assert.deepEqual(result.contractsUnregistered, ['c'], 'it is a registry defect')
})
