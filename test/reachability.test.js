import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every verdict this tool can emit must be reachable from a realistic input.
//
// Three times now the contract check's definite verdict has become unreachable — via an
// incidental `zod` import, via depth-exhaustion accounting, and via a dead schema-not-found
// branch — and each time the whole suite stayed green, because tests assert that a given
// input produces a given output, never that an output is producible at all.
//
// These are deliberately written as "some realistic fixture must yield X". They do not care
// how; they fail only when a status can no longer be reached, which is the failure mode that
// kept escaping.

const run = (a, c) => execFileSync('git', a, { cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flowmap-reach-'))
const repo = join(root, '.flowmap-cache', 'svc')
mkdirSync(join(repo, 'src'), { recursive: true })
mkdirSync(join(repo, '.git'), { recursive: true })

// A plain zod schema — what the overwhelming majority of real schemas look like.
writeFileSync(join(repo, 'src', 'zod.ts'),
  "import { z } from 'zod'\nexport const S = z.object({ present: z.string() })\n")
// A schema that genuinely composes from something unreadable.
writeFileSync(join(repo, 'src', 'composed.ts'),
  "import { Base } from '@acme/contracts'\nexport const S = Base.extend({ own: z.string() })\n")

process.env.FLOWMAP_CACHE = join(root, '.flowmap-cache')
const c = await import('../lib/contracts.js')

const map = { repos: { svc: {} }, contracts: {}, journeys: {} }
const check = (contract, opts = {}) => c.checkContract(root, map, 'c', contract, opts)

test('SCHEMA_OK is reachable', () => {
  assert.equal(check({ schema: 'src/zod.ts', fields: ['present'] }).status, c.SCHEMA_OK)
})

// The one that has gone missing three times.
test('FIELDS_MISSING is reachable from an ordinary zod schema', () => {
  const r = check({ schema: 'src/zod.ts', fields: ['present', 'absent'] })
  assert.equal(r.status, c.FIELDS_MISSING,
    'a definite verdict must be reachable from the commonest real schema shape')
  assert.deepEqual(r.missing, ['absent'])
})

// Real schemas are barrels of barrels. A definite verdict must survive an import graph, not
// only a single self-contained file — this is the shape that broke when depth exhaustion was
// counted against the last frontier rather than against imports never followed.
test('FIELDS_MISSING is reachable through a multi-level import graph', () => {
  mkdirSync(join(repo, 'src', 'g'), { recursive: true })
  writeFileSync(join(repo, 'src', 'g', 'leaf.ts'), 'export const L = z.object({ fromLeaf: z.string() })\n')
  writeFileSync(join(repo, 'src', 'g', 'index.ts'), "export * from './leaf.js'\n")
  writeFileSync(join(repo, 'src', 'graph.ts'),
    "import { z } from 'zod'\nimport { L } from './g/index.js'\nexport const S = z.object({ own: z.string() })\n")

  const r = check({ schema: 'src/graph.ts', fields: ['own', 'fromLeaf', 'absent'] })
  assert.equal(r.status, c.FIELDS_MISSING, 'an import graph must not neutralise the verdict')
  assert.deepEqual(r.missing, ['absent'])
})

test('INCONCLUSIVE is reachable, and only when the shape is genuinely hidden', () => {
  assert.equal(check({ schema: 'src/composed.ts', fields: ['own', 'hidden'] }).status, c.INCONCLUSIVE)
})

test('SCHEMA_NOT_FOUND is reachable on a full run', () => {
  assert.equal(check({ schema: 'src/nowhere.ts', fields: ['x'] }, { synced: new Set(['svc']) }).status,
    c.SCHEMA_NOT_FOUND)
})

test('UNSEARCHED is reachable on a scoped run', () => {
  assert.equal(check({ schema: 'src/nowhere.ts', fields: ['x'] }, { synced: new Set(['svc']), scoped: true }).status,
    c.UNSEARCHED)
})

test('NOT_A_PATH and NO_SCHEMA are reachable', () => {
  assert.equal(check({ schema: '@acme/proto SomeMessage', fields: ['x'] }).status, c.NOT_A_PATH)
  assert.equal(check({ fields: ['x'] }).status, c.NO_SCHEMA)
})

// The same guarantee for anchor resolution, whose statuses feed the agent output.
test('every anchor status is reachable', async () => {
  const a = await import('../lib/anchor.js')
  writeFileSync(join(repo, 'src', 'anchors.ts'), 'export function realSymbol() {}\n')
  assert.equal(a.resolveAnchor(root, 'svc', 'src/anchors.ts::realSymbol').status, a.OK)
  assert.equal(a.resolveAnchor(root, 'svc', 'src/anchors.ts::goneSymbol').status, a.SYMBOL_MISSING)
  assert.equal(a.resolveAnchor(root, 'svc', 'src/gone.ts::realSymbol').status, a.FILE_MISSING)
  assert.equal(a.resolveAnchor(root, 'never-cloned', 'src/anchors.ts::realSymbol').status, a.REPO_MISSING)
  assert.equal(a.resolveAnchor(root, 'svc', 'not-an-anchor').status, a.MALFORMED)
})

// And for the freshness status an agent uses to decide whether to trust a hop.
test('every repo status is reachable', async () => {
  const { repoStatus } = await import('../lib/graph.js')
  const day = 86400000
  assert.equal(repoStatus({ verified: {} }, 'x'), 'unverified')
  assert.equal(repoStatus({ verified: { x: { at: new Date(Date.now() - 2 * day).toISOString() } } }, 'x'), 'ok')
  assert.equal(repoStatus({ verified: { x: { at: new Date(Date.now() - 200 * day).toISOString() } } }, 'x'), 'stale')
})

// --- reachability under a REAL verify -----------------------------------------------------
//
// The tests above build a checkout by hand and call the library directly. That is exactly the
// blind spot that let the sparse cone defeat import-following in production while every unit
// test stayed green: verify narrows the checkout it then reads, and a schema's sibling
// directories fall outside the cone. A verdict is only genuinely reachable if it survives the
// checkout shape verify itself creates.

const gitRun = (a, c) => execFileSync('git', a, { cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function realRepo(name, files) {
  const dir = join(root, name)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  gitRun(['init', '-q', '-b', 'main'], dir)
  gitRun(['add', '-A'], dir)
  gitRun(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
  return dir
}

test('FIELDS_MISSING survives the sparse cone a real verify creates', async () => {
  const { verify } = await import('../lib/verify.js')
  // The ordinary layout: the anchor is nested, and the schema imports from a sibling dir.
  const up = realRepo('coned', {
    'src/api/handler.ts': 'export function handle() {}\n',
    'src/types/base.ts': 'export const Base = z.object({ total: z.number() })\n',
    'src/schemas/order.ts': "import { Base } from '../types/base.js'\nexport const Order = Base\n",
  })
  const map = {
    // A repo id of its own: the unit fixtures above pre-create a fake `svc` cache entry.
    repos: { coned: { url: up, branch: 'main' } },
    contracts: { order: { kind: 'event', schema: 'src/schemas/order.ts', fields: ['total', 'absent'] } },
    journeys: { flow: { hops: [{ repo: 'coned', reads: 'src/api/handler.ts::handle', outbound: 'order' }] } },
    verified: {},
  }
  const mapPath = join(root, 'flowmap-coned.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const r = verify(root, map, mapPath)
  const order = r.contracts.find((x) => x.id === 'order')
  assert.equal(order.status, c.FIELDS_MISSING,
    'the cone must not turn a real verdict into "could not tell"')
  assert.deepEqual(order.missing, ['absent'], 'and `total` must be found through the sibling import')
})

test('SCHEMA_OK survives the sparse cone too', async () => {
  const { verify } = await import('../lib/verify.js')
  const up = realRepo('coned-ok', {
    'src/api/handler.ts': 'export function handle() {}\n',
    'src/types/base.ts': 'export const Base = z.object({ total: z.number() })\n',
    'src/schemas/order.ts': "import { Base } from '../types/base.js'\nexport const Order = Base\n",
  })
  const map = {
    repos: { conedok: { url: up, branch: 'main' } },
    contracts: { order: { kind: 'event', schema: 'src/schemas/order.ts', fields: ['total'] } },
    journeys: { flow: { hops: [{ repo: 'conedok', reads: 'src/api/handler.ts::handle', outbound: 'order' }] } },
    verified: {},
  }
  const mapPath = join(root, 'flowmap-coned-ok.json')
  writeFileSync(mapPath, JSON.stringify(map))
  const r = verify(root, map, mapPath)
  assert.equal(r.contracts.find((x) => x.id === 'order').status, c.SCHEMA_OK)
  assert.deepEqual(r.contractIssues, [])
})

// Correctness under the cone is only half of it: widening the cone until the checker works is
// always possible, and costs the whole point of sparse. Measured on ten real repos, taking
// the top-level directory per schema meant 96MB and 72-95% of each repo checked out. The cone
// must stay tight AND let the schema's imports resolve.
test('the cone stays tight while still resolving schema imports', async () => {
  const { verify } = await import('../lib/verify.js')
  const up = realRepo('tight', {
    'src/api/handler.ts': 'export function handle() {}\n',
    'src/types/base.ts': 'export const Base = z.object({ total: z.number() })\n',
    'src/schemas/order.ts': "import { Base } from '../types/base.js'\nexport const Order = Base\n",
    // Bulk that no anchor and no schema import refers to. It must not be fetched.
    'src/unrelated/a.ts': 'export const a = 1\n',
    'src/unrelated/b.ts': 'export const b = 1\n',
    'docs/manual.md': '# not code\n',
  })
  const map = {
    repos: { tight: { url: up, branch: 'main' } },
    contracts: { order: { kind: 'event', schema: 'src/schemas/order.ts', fields: ['total'] } },
    journeys: { flow: { hops: [{ repo: 'tight', reads: 'src/api/handler.ts::handle', outbound: 'order' }] } },
    verified: {},
  }
  const mapPath = join(root, 'flowmap-tight.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const r = verify(root, map, mapPath)
  assert.equal(r.contracts.find((x) => x.id === 'order').status, c.SCHEMA_OK,
    'the sibling import must still resolve')

  const dir = join(root, '.flowmap-cache', 'tight')
  assert.ok(existsSync(join(dir, 'src', 'types', 'base.ts')), 'the imported schema was fetched')
  assert.ok(!existsSync(join(dir, 'src', 'unrelated', 'a.ts')),
    'but nothing else was — widening to the top-level directory would pull this in')
})
