import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
