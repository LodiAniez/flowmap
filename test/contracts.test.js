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
const { checkContract, parseSchemaRef, IMPORT_DEPTH, SCHEMA_OK, FIELDS_MISSING, SCHEMA_NOT_FOUND, NOT_A_PATH, NO_SCHEMA, INCONCLUSIVE, UNSEARCHED } =
  await import('../lib/contracts.js')

const map = { repos: { svc: {} }, contracts: {}, journeys: {} }
const check = (contract) => checkContract(root, map, 'c', contract)
const checkContractWith = (m, contract, synced, scoped = false) =>
  checkContract(root, m, 'c', contract, { synced, scoped })

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
test('searching every candidate repo and not finding the schema is a finding', () => {
  const only = { repos: { svc: {} }, contracts: {}, journeys: {} }
  const r = checkContractWith(only, { schema: 'src/nowhere.ts', fields: ['x'] }, new Set(['svc']))
  assert.equal(r.status, SCHEMA_NOT_FOUND, 'nothing was left unsearched, so absence is real')
})

// The --local / --repos case: a hop tells us which repo owns the contract, and that repo was
// not synced. The question is genuinely open.
test('a scoped run leaves the question open rather than accusing', () => {
  const m = { repos: { svc: {}, owner: {} }, contracts: {}, journeys: {} }
  const r = checkContractWith(m, { schema: 'src/nowhere.ts', fields: ['x'] }, new Set(['svc']), true)
  assert.equal(r.status, UNSEARCHED, 'a scoped run deliberately skipped repos')
})

// The counterpart, and the one that made the real verdict unreachable: when nothing points
// anywhere the candidate set is a guess, and a guess must not excuse the search.
test('a full run that found nothing is a finding, not an excuse', () => {
  const noHops = { repos: { svc: {}, extra: {} }, contracts: {}, journeys: {} }
  const r = checkContractWith(noHops, { schema: 'src/nowhere.ts', fields: ['x'] }, new Set(['svc']))
  assert.equal(r.status, SCHEMA_NOT_FOUND, 'a hopless repo must not hide a real miss')
})

test('a repo-qualified ref is judged only against that repo', () => {
  const wider = { repos: { svc: {}, other: {} }, contracts: {}, journeys: {} }
  const found = checkContractWith(wider, { schema: 'svc/src/standalone.ts', fields: ['alpha'] }, new Set(['svc']))
  assert.equal(found.status, SCHEMA_OK, 'other being unsynced is irrelevant here')
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
  // A chain one hop longer than the follower goes, built from IMPORT_DEPTH rather than a
  // hardcoded length — otherwise this silently stops testing exhaustion the next time the
  // depth changes, which is exactly what happened when it went from 2 to 3.
  const levels = IMPORT_DEPTH + 1
  writeFileSync(join(repo, 'src', `d${levels}.ts`), 'export const Deep = z.object({ buried: z.string() })\n')
  for (let i = levels - 1; i >= 1; i--) {
    writeFileSync(join(repo, 'src', `d${i}.ts`), `export * from './d${i + 1}.js'\n`)
  }
  writeFileSync(join(repo, 'src', 'd0.ts'), "import './d1.js'\nexport const S = z.object({ own: z.string() })\n")

  assert.equal(check({ schema: 'src/d0.ts', fields: ['own', 'buried'] }).status, INCONCLUSIVE,
    'the buried field sits beyond the walk, so the answer is not knowable')
})

test('a chain exactly as deep as the walk still yields a definite verdict', () => {
  writeFileSync(join(repo, 'src', `e${IMPORT_DEPTH}.ts`), 'export const Leaf = z.object({ reached: z.string() })\n')
  for (let i = IMPORT_DEPTH - 1; i >= 1; i--) {
    writeFileSync(join(repo, 'src', `e${i}.ts`), `export * from './e${i + 1}.js'\n`)
  }
  writeFileSync(join(repo, 'src', 'e0.ts'), "import './e1.js'\nexport const S = z.object({ own: z.string() })\n")

  const r = check({ schema: 'src/e0.ts', fields: ['own', 'reached', 'absent'] })
  assert.equal(r.status, FIELDS_MISSING, 'everything was read, so absence is real')
  assert.deepEqual(r.missing, ['absent'])
})

// A malformed map should surface as an error the CLI can explain, not a raw TypeError.
test('a null journey or contract entry does not throw', () => {
  const broken = { repos: { svc: {} }, contracts: {}, journeys: { x: null } }
  assert.doesNotThrow(() => checkContractWith(broken, { schema: 'src/standalone.ts', fields: [] }, null))
  assert.doesNotThrow(() => checkContractWith(broken, null, null))
  assert.equal(checkContractWith(broken, null, null).status, NO_SCHEMA)
})

// TypeScript interfaces are the commonest non-zod schema shape, and `extends` hides fields
// exactly the way `.extend()` does.
test('a TS interface extending an unreadable base is inconclusive', () => {
  writeFileSync(join(repo, 'src', 'iface.ts'),
    "import type { BasePayload } from '@acme/contracts'\nexport interface Order extends BasePayload { total: number }\n")
  assert.equal(check({ schema: 'src/iface.ts', fields: ['total', 'tenantId'] }).status, INCONCLUSIVE)
})

// Counting the last frontier rather than unfollowed imports made every two-level import graph
// permanently inconclusive, so genuine drift could never be reported.
test('a fully-followed import graph can still report a missing field', () => {
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  writeFileSync(join(repo, 'src', 'deep', 'leaf.ts'), 'export const Leaf = z.object({ deep: z.string() })\n')
  writeFileSync(join(repo, 'src', 'deep', 'mid.ts'), "export * from './leaf.js'\n")
  writeFileSync(join(repo, 'src', 'twolevel.ts'),
    "import { Leaf } from './deep/mid.js'\nexport const S = z.object({ own: z.string() })\n")
  const r = check({ schema: 'src/twolevel.ts', fields: ['own', 'deep', 'absent'] })
  assert.equal(r.status, FIELDS_MISSING, 'the graph was fully read, so absence is real')
  assert.deepEqual(r.missing, ['absent'])
})

// A star re-export republishes whatever the package declares, so every field could be coming
// from somewhere unreadable. Reporting them missing is the confident-wrong-answer case.
test('a star re-export from a package is inconclusive', () => {
  writeFileSync(join(repo, 'src', 'star.ts'), "export * from '@acme/shared-schemas'\n")
  assert.equal(check({ schema: 'src/star.ts', fields: ['total', 'currency'] }).status, INCONCLUSIVE)
})

test('composition through a namespace import is seen', () => {
  writeFileSync(join(repo, 'src', 'ns.ts'),
    "import * as Shared from '@acme/shared-schemas'\nexport const S = Shared.Base.extend({ own: 1 })\n")
  assert.equal(check({ schema: 'src/ns.ts', fields: ['own', 'total'] }).status, INCONCLUSIVE)
})
