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
const { checkContract, parseSchemaRef, SCHEMA_OK, FIELDS_MISSING, SCHEMA_NOT_FOUND, NOT_A_PATH, NO_SCHEMA, INCONCLUSIVE, UNSEARCHED } =
  await import('../lib/contracts.js')

const map = { repos: { svc: {} }, contracts: {}, journeys: {} }
const check = (contract) => checkContract(root, map, 'c', contract)
const checkContractWith = (m, contract, synced) => checkContract(root, m, 'c', contract, { synced })

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

// parseAnchor rejects paths that climb out of the checkout; a schema ref must too, or it
// reads arbitrary files off the machine and reports them as a passing contract.
test('a schema path cannot escape the repo checkout', () => {
  for (const ref of ['../../etc/passwd', '../outside.ts', '/etc/passwd']) {
    assert.equal(parseSchemaRef(ref, ['svc']).kind, NOT_A_PATH, `${ref} must be rejected`)
  }
})

test('a side-effect import is followed, since a schema file can arrive that way', () => {
  writeFileSync(join(repo, 'src', 'side.ts'),
    "import './schemas/order.js'\nexport const S = z.object({ own: z.string() })\n")
  const r = check({ schema: 'src/side.ts', fields: ['own', 'currency'] })
  assert.equal(r.status, SCHEMA_OK, 'currency comes from the side-effect imported file')
})

// "We searched and it is not there" and "we never looked" are different claims, and only the
// first is a finding. But over-applying the second made a genuine missing schema unreportable
// as soon as one unsynced repo existed anywhere in the registry.
test('searching a repo and not finding the schema is a finding', () => {
  const wider = { repos: { svc: {}, other: {} }, contracts: {}, journeys: {} }
  const r = checkContractWith(wider, { schema: 'src/nowhere.ts', fields: ['x'] }, new Set(['svc']))
  assert.equal(r.status, SCHEMA_NOT_FOUND, 'svc was searched; absence there is real')
})

test('having searched nothing at all is unsearched, not missing', () => {
  const wider = { repos: { svc: {}, other: {} }, contracts: {}, journeys: {} }
  const r = checkContractWith(wider, { schema: 'src/nowhere.ts', fields: ['x'] }, new Set())
  assert.equal(r.status, UNSEARCHED)
})

// `import { z } from 'zod'` does not hide any part of the shape, but treating every package
// import as opaque made INCONCLUSIVE universal for TypeScript — the check's one definite
// verdict became unreachable.
test('an incidental package import does not make the check inconclusive', () => {
  writeFileSync(join(repo, 'src', 'plain.ts'),
    "import { z } from 'zod'\nimport { randomUUID } from 'node:crypto'\nexport const S = z.object({ alpha: z.string() })\n")
  const r = check({ schema: 'src/plain.ts', fields: ['alpha', 'ghost'] })
  assert.equal(r.status, FIELDS_MISSING, 'zod is not part of the shape')
  assert.deepEqual(r.missing, ['ghost'])
})

test('a package the schema actually composes from is inconclusive', () => {
  writeFileSync(join(repo, 'src', 'composed.ts'),
    "import { Base } from '@acme/shared'\nexport const S = Base.extend({ own: z.string() })\n")
  assert.equal(check({ schema: 'src/composed.ts', fields: ['own', 'fromBase'] }).status, INCONCLUSIVE)
})

test('an unreadable relative import is inconclusive, not a missing field', () => {
  writeFileSync(join(repo, 'src', 'dangling.ts'),
    "import { Other } from './not-on-disk.js'\nexport const S = z.object({ own: z.string() })\n")
  // Absent from a sparse checkout or genuinely deleted — either way part of the shape is hidden.
  assert.equal(check({ schema: 'src/dangling.ts', fields: ['own', 'elsewhere'] }).status, INCONCLUSIVE)
})

test('a followed import cannot climb out of the repo checkout', () => {
  writeFileSync(join(root, 'OUTSIDE.ts'), 'export const secretField = 1\n')
  writeFileSync(join(repo, 'src', 'escape.ts'),
    "import { x } from '../../../OUTSIDE.js'\nexport const S = z.object({ own: z.string() })\n")
  const r = check({ schema: 'src/escape.ts', fields: ['secretField'] })
  assert.notEqual(r.status, SCHEMA_OK, 'must not resolve a field by reading outside the repo')
})

// Schema barrels are written `export * from './x.js'`. Matching only `import … from` made
// every contract behind a barrel report fields that are plainly in its schema.
test('re-exports are followed, not just imports', () => {
  mkdirSync(join(repo, 'src', 'barrel'), { recursive: true })
  writeFileSync(join(repo, 'src', 'barrel', 'member.ts'),
    'export const Member = z.object({ firstName: z.string(), lastName: z.string() })\n')
  writeFileSync(join(repo, 'src', 'barrel', 'index.ts'), "export * from './member.js'\n")
  writeFileSync(join(repo, 'src', 'via-barrel.ts'),
    "import { Member } from './barrel/index.js'\nexport const route = { body: Member }\n")

  const r = check({ schema: 'src/via-barrel.ts', fields: ['firstName', 'lastName'] })
  assert.equal(r.status, SCHEMA_OK, 'fields arrive through the barrel')
})

test('depth exhaustion with files still unexplored is inconclusive', () => {
  // three levels of relative hops, one more than the follower goes
  writeFileSync(join(repo, 'src', 'd3.ts'), 'export const Deep = z.object({ buried: z.string() })\n')
  writeFileSync(join(repo, 'src', 'd2.ts'), "export * from './d3.js'\n")
  writeFileSync(join(repo, 'src', 'd1.ts'), "export * from './d2.js'\n")
  writeFileSync(join(repo, 'src', 'd0.ts'), "import './d1.js'\nexport const S = z.object({ own: z.string() })\n")
  assert.equal(check({ schema: 'src/d0.ts', fields: ['own', 'buried'] }).status, INCONCLUSIVE)
})
