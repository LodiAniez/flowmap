import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (a, c) => execFileSync('git', a, { cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flowmap-contracts-'))
const repo = join(root, '.flowmap-cache', 'svc')
mkdirSync(join(repo, 'src', 'schemas'), { recursive: true })
mkdirSync(join(repo, '.git'), { recursive: true })

// The real-world shape this check exists for: a router composes its body from an imported
// schema, so the field names live one file away.
writeFileSync(join(repo, 'src', 'schemas', 'order.ts'),
  'export const OrderSchema = z.object({ id: z.string(), total: z.number(), currency: z.string() })\n')
writeFileSync(join(repo, 'src', 'router.ts'),
  "import { OrderSchema } from './schemas/order.js'\nexport const route = { body: OrderSchema.omit({ id: true }) }\n")
writeFileSync(join(repo, 'src', 'standalone.ts'),
  'export const Thing = z.object({ alpha: z.string(), beta: z.number() })\n')
writeFileSync(join(repo, 'src', 'external.ts'),
  "import { Base } from '@acme/shared-schemas'\nexport const Ext = Base.extend({ local: z.string() })\n")

process.env.FLOWMAP_CACHE = join(root, '.flowmap-cache')
const { checkContract, parseSchemaRef, SCHEMA_OK, FIELDS_MISSING, SCHEMA_NOT_FOUND, NOT_A_PATH, NO_SCHEMA, INCONCLUSIVE } =
  await import('../lib/contracts.js')

const map = { repos: { svc: {} }, contracts: {}, journeys: {} }
const check = (contract) => checkContract(root, map, 'c', contract)

test('parses the three schema reference shapes', () => {
  assert.deepEqual(parseSchemaRef('src/x.ts', ['svc']), { kind: 'path', repo: null, path: 'src/x.ts', symbol: null })
  assert.deepEqual(parseSchemaRef('svc/src/x.ts::Thing', ['svc']),
    { kind: 'path', repo: 'svc', path: 'src/x.ts', symbol: 'Thing' })
  assert.equal(parseSchemaRef('@acme/proto SomeMessage', ['svc']).kind, NOT_A_PATH)
  assert.equal(parseSchemaRef(undefined, []).kind, NO_SCHEMA)
})

test('a field declared in the schema file passes', () => {
  const r = check({ schema: 'src/standalone.ts', fields: ['alpha', 'beta'] })
  assert.equal(r.status, SCHEMA_OK)
})

// The false positive that made the first version of this check useless: searching only the
// named file reports composed fields as missing.
test('follows relative imports, so a composed schema is not a false alarm', () => {
  const r = check({ schema: 'src/router.ts', fields: ['total', 'currency'] })
  assert.equal(r.status, SCHEMA_OK, 'fields live in the imported schema file')
  assert.ok(r.filesSearched > 1, 'it actually read more than the entry file')
})

test('a field that exists nowhere is reported', () => {
  const r = check({ schema: 'src/standalone.ts', fields: ['alpha', 'ghostColumn'] })
  assert.equal(r.status, FIELDS_MISSING)
  assert.deepEqual(r.missing, ['ghostColumn'])
})

test('matching is word-bounded, so a substring is not a false pass', () => {
  // "alph" is inside "alpha" and must not count as present
  assert.deepEqual(check({ schema: 'src/standalone.ts', fields: ['alph'] }).missing, ['alph'])
})

test('a dotted field path matches on its leaf, as schemas declare leaves', () => {
  assert.equal(check({ schema: 'src/standalone.ts', fields: ['order.alpha'] }).status, SCHEMA_OK)
})

// An unfollowable package import means part of the shape is unreadable. Reporting those
// fields as missing would be a confident wrong answer.
test('a schema composing from a package is inconclusive, not missing', () => {
  const r = check({ schema: 'src/external.ts', fields: ['local', 'fromTheBaseSchema'] })
  assert.equal(r.status, INCONCLUSIVE)
})

test('a schema path that does not exist is distinct from a missing field', () => {
  assert.equal(check({ schema: 'src/nope.ts', fields: ['alpha'] }).status, SCHEMA_NOT_FOUND)
})

test('a package reference and an absent schema are not failures', () => {
  assert.equal(check({ schema: '@acme/proto SomeMessage', fields: ['x'] }).status, NOT_A_PATH)
  assert.equal(check({ fields: ['x'] }).status, NO_SCHEMA)
})
