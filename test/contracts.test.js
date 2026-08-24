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

// A schema registry url or broker address is not a file. Treating one as a repo-relative path
// produced a red "schema file not found" for a perfectly valid contract.
test('a url-shaped schema ref is not treated as a path', () => {
  for (const ref of ['https://schemas.acme.com/order.json', 'kafka://orders/v1', 's3://bucket/x.json']) {
    assert.equal(parseSchemaRef(ref, ['svc']).kind, NOT_A_PATH, `${ref} must not be opened as a file`)
  }
})

test('a non-string schema is reported, not thrown', () => {
  assert.equal(parseSchemaRef(5, ['svc']).kind, NOT_A_PATH)
  assert.equal(parseSchemaRef({ path: 'x' }, ['svc']).kind, NOT_A_PATH)
  assert.doesNotThrow(() => check({ schema: 5, fields: ['x'] }))
})

// Combinator style hides an imported shape exactly as much as `.extend()` does.
test('combinator composition from a package is inconclusive', () => {
  writeFileSync(join(repo, 'src', 'combi.ts'),
    "import { BaseOrder } from '@acme/shared'\nexport const S = z.intersection(BaseOrder, z.object({ note: z.string() }))\n")
  assert.equal(check({ schema: 'src/combi.ts', fields: ['note', 'fromBase'] }).status, INCONCLUSIVE)

  writeFileSync(join(repo, 'src', 'uni.ts'),
    "import { BaseOrder } from '@acme/shared'\nexport const S = z.union([BaseOrder, z.object({ note: z.string() })])\n")
  assert.equal(check({ schema: 'src/uni.ts', fields: ['note', 'fromBase'] }).status, INCONCLUSIVE)
})

// The import spellings a real codebase actually uses. Three consecutive review rounds found
// bugs triggered by an unusual one, so the whole space is swept here rather than waiting for
// the next spelling to surface as a confident wrong answer.
const SPELLINGS = {
  'extensionless': "import { Dep } from './sub/dep'",
  'dot-js': "import { Dep } from './sub/dep.js'",
  'dot-ts': "import { Dep } from './sub/dep.ts'",
  'directory index': "import { Dep } from './sub'",
  'explicit index': "import { Dep } from './sub/index.js'",
  'side-effect': "import './sub/dep.js'",
  're-export named': "export { Dep } from './sub/dep.js'",
  're-export star': "export * from './sub/dep.js'",
  'require': "const { Dep } = require('./sub/dep')",
  'dynamic import': "const m = await import('./sub/dep.js')",
  'type-only': "import type { Dep } from './sub/dep.js'",
  'multiline': "import {\n  Dep,\n} from './sub/dep.js'",
}

for (const [label, statement] of Object.entries(SPELLINGS)) {
  test(`follows a relative import written as: ${label}`, () => {
    mkdirSync(join(repo, 'src', 'sub'), { recursive: true })
    writeFileSync(join(repo, 'src', 'sub', 'dep.ts'), 'export const Dep = z.object({ fromDep: z.string() })\n')
    writeFileSync(join(repo, 'src', 'sub', 'index.ts'), "export * from './dep.js'\n")
    const file = `src/spell-${label.replace(/\W/g, '')}.ts`
    writeFileSync(join(repo, file), `${statement}\nexport const S = z.object({ own: z.string() })\n`)

    const r = check({ schema: file, fields: ['own', 'fromDep'] })
    assert.equal(r.status, SCHEMA_OK, `${label}: the imported field must be found`)
  })
}

// A quote-free statement above a star re-export used to swallow the clause, so the star was
// never seen and a wholesale-hidden package shape counted as contributing nothing.
test('a statement above a star re-export does not swallow it', () => {
  writeFileSync(join(repo, 'src', 'preamble.ts'),
    "export const VERSION = 1\nexport * from '@acme/schemas'\n")
  assert.equal(check({ schema: 'src/preamble.ts', fields: ['fromPkg'] }).status, INCONCLUSIVE)
})

// A file first read at the deepest level never had its own package imports judged, so a shape
// composed from a package down there was reported as definitely missing.
test('a package composed in at the deepest level is still seen', () => {
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  writeFileSync(join(repo, 'src', 'deep', 'c.ts'),
    "import { Base } from '@acme/shared'\nexport const X = Base.extend({ own: 1 })\n")
  writeFileSync(join(repo, 'src', 'deep', 'b.ts'), "export * from './c.js'\n")
  writeFileSync(join(repo, 'src', 'deep', 'a.ts'), "export * from './b.js'\n")
  writeFileSync(join(repo, 'src', 'deepentry.ts'), "export * from './deep/a.js'\n")
  assert.equal(check({ schema: 'src/deepentry.ts', fields: ['fromBase'] }).status, INCONCLUSIVE)
})

// An import pointing at a file already read hides nothing, so it must not flip the verdict.
test('a repeated import of an already-read file is not counted as unknown', () => {
  mkdirSync(join(repo, 'src', 'shared2'), { recursive: true })
  writeFileSync(join(repo, 'src', 'shared2', 'common.ts'), 'export const C = z.object({ shared: z.string() })\n')
  writeFileSync(join(repo, 'src', 'shared2', 'leaf.ts'),
    "import { C } from './common.js'\nexport const L = z.object({ leaf: z.string() })\n")
  writeFileSync(join(repo, 'src', 'shared2', 'index.ts'),
    "export * from './common.js'\nexport * from './leaf.js'\n")
  writeFileSync(join(repo, 'src', 'dupentry.ts'), "export * from './shared2/index.js'\n")

  const r = check({ schema: 'src/dupentry.ts', fields: ['shared', 'leaf', 'absent'] })
  assert.equal(r.status, FIELDS_MISSING, 'everything was read, so absence is real')
  assert.deepEqual(r.missing, ['absent'])
})

// A dotted lowercase name is a topic or message, not a file. Treating one as a path produced
// a false "schema not found" and made a full run sweep the registry hunting for it.
test('a dotted topic or message name is not a file path', () => {
  for (const ref of ['orders.created', 'user.updated', 'order.v1', 'mryum.bill.event']) {
    assert.equal(parseSchemaRef(ref, ['svc']).kind, NOT_A_PATH, `${ref} is not a file`)
  }
})

test('real file extensions are still recognised without a directory', () => {
  for (const ref of ['schema.gql', 'order.proto', 'types.ts', 'events.avsc', 'schema.GQL']) {
    assert.equal(parseSchemaRef(ref, ['svc']).kind, 'path', `${ref} is a file`)
  }
})

// CJS composes exactly as ESM does; not reading its bindings meant a package that hides the
// shape produced a confident "field missing".
test('a package composed in through require() is inconclusive', () => {
  writeFileSync(join(repo, 'src', 'cjs.ts'),
    "const { BaseOrder } = require('@acme/schemas')\nexport const S = BaseOrder.extend({ own: 1 })\n")
  assert.equal(check({ schema: 'src/cjs.ts', fields: ['own', 'total'] }).status, INCONCLUSIVE)
})

test('a package composed in through dynamic import is inconclusive', () => {
  writeFileSync(join(repo, 'src', 'dyn2.ts'),
    "const { BaseOrder } = await import('@acme/schemas')\nexport const S = BaseOrder.extend({ own: 1 })\n")
  assert.equal(check({ schema: 'src/dyn2.ts', fields: ['own', 'total'] }).status, INCONCLUSIVE)
})

// Two files discovered on the final round, one importing the other: the verdict must not
// depend on which was visited first.
test('the verdict does not depend on sibling visit order', () => {
  mkdirSync(join(repo, 'src', 'order'), { recursive: true })
  writeFileSync(join(repo, 'src', 'order', 'y.ts'), 'export const Y = z.object({ fromY: z.string() })\n')
  writeFileSync(join(repo, 'src', 'order', 'x.ts'), "export * from './y.js'\n")
  // Both x and y are reachable at the last level; x imports y.
  writeFileSync(join(repo, 'src', 'order', 'index.ts'), "export * from './x.js'\nexport * from './y.js'\n")
  writeFileSync(join(repo, 'src', 'orderentry.ts'), "export * from './order/index.js'\n")

  const r = check({ schema: 'src/orderentry.ts', fields: ['fromY', 'absent'] })
  assert.equal(r.status, FIELDS_MISSING, 'the graph is fully read either way round')
  assert.deepEqual(r.missing, ['absent'])
})

// A plain lastIndexOf finds `import` inside an identifier, truncating the clause and dropping
// the bindings before it — so the same statement gave a different verdict depending on what a
// co-imported symbol happened to be called.
test('a binding containing the word import or export does not hide the others', () => {
  for (const other of ['helper', 'exportedHelper', 'importantThing', 'reimportCache']) {
    writeFileSync(join(repo, 'src', `kw-${other}.ts`),
      `import { BaseSchema, ${other} } from '@acme/contracts'\nexport const S = BaseSchema.extend({ own: 1 })\n`)
    assert.equal(check({ schema: `src/kw-${other}.ts`, fields: ['total'] }).status, INCONCLUSIVE,
      `co-import named ${other} must not drop BaseSchema`)
  }
})

// verify syncs every repo a schema ref names, whatever the scope — so for a qualified ref that
// repo really was searched, and a deleted file is a genuine finding rather than something the
// scope hid. Suppressing there reported "not checked: this run was scoped" on every scoped run.
test('a repo-qualified schema that is genuinely gone is reported even on a scoped run', () => {
  const map = { repos: { svc: {}, other: {} }, contracts: {}, journeys: {} }
  const gone = checkContractWith(map, { schema: 'svc/src/deleted.ts', fields: ['x'] }, new Set(['svc']), true)
  assert.equal(gone.status, SCHEMA_NOT_FOUND, 'the named repo was searched')

  // A bare path on the same scoped run stays suppressed: we genuinely did not look everywhere.
  const bare = checkContractWith(map, { schema: 'src/deleted.ts', fields: ['x'] }, new Set(['svc']), true)
  assert.equal(bare.status, UNSEARCHED)
})

// The combinator branch matched the binding anywhere before the closing paren, so `z` matched
// inside its own `z.union([z.string(), …])` and every schema using a union went inconclusive —
// the sixth distinct way this check's definite verdict has been made unreachable.
test('ordinary zod combinators do not hide a real verdict', () => {
  const shapes = {
    'plain': 'export const B = z.object({ id: z.string() })',
    'union': 'export const B = z.object({ id: z.union([z.string(), z.number()]) })',
    'or': 'export const B = z.object({ id: z.string() }).or(z.null())',
    'discriminated': 'export const B = z.discriminatedUnion("k", [z.object({ id: z.string() })])',
  }
  for (const [label, body] of Object.entries(shapes)) {
    const file = `src/combi-${label}.ts`
    writeFileSync(join(repo, file), `import { z } from 'zod'\n${body}\n`)
    assert.equal(check({ schema: file, fields: ['id', 'ghost'] }).status, FIELDS_MISSING,
      `${label}: zod's own combinators are not a hidden shape`)
  }
})

test('a package combined in by a combinator is still inconclusive', () => {
  for (const [label, body] of Object.entries({
    intersection: 'export const B = z.intersection(BaseOrder, z.object({ id: z.string() }))',
    union: 'export const B = z.union([BaseOrder, z.object({ id: z.string() })])',
  })) {
    const file = `src/pkgcombi-${label}.ts`
    writeFileSync(join(repo, file),
      `import { z } from 'zod'\nimport { BaseOrder } from '@acme/shared'\n${body}\n`)
    assert.equal(check({ schema: file, fields: ['id', 'fromBase'] }).status, INCONCLUSIVE, label)
  }
})

// Nothing validates flowmap.json on load, so a hand edit can leave anything in `fields`. A
// malformed value is a map defect to report — crashing fails a CI step the tool promises never
// to fail.
test('a malformed fields value is reported, not thrown', async () => {
  const { MALFORMED_FIELDS } = await import('../lib/contracts.js')
  for (const fields of [{ x: 1 }, 'nope', 5, null]) {
    let status
    assert.doesNotThrow(() => {
      status = check({ schema: 'src/standalone.ts', fields }).status
    }, `fields=${JSON.stringify(fields)} must not throw`)
    assert.equal(status, MALFORMED_FIELDS)
  }
  assert.equal(check({ schema: 'src/standalone.ts' }).status, SCHEMA_OK, 'omitted is fine')
})

// looksLikePath accepts .mts/.cts/.jsx as schema files, but resolveImport did not try them —
// so an extensionless import landing on one returned null, set `external`, and suppressed a
// genuine fields-missing verdict.
test('an extensionless import resolves to every extension the tool accepts', () => {
  for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx']) {
    mkdirSync(join(repo, 'src', `ext-${ext}`), { recursive: true })
    writeFileSync(join(repo, 'src', `ext-${ext}`, `base.${ext}`),
      'export const Base = z.object({ deep: z.string() })\n')
    writeFileSync(join(repo, 'src', `ext-${ext}`, 'entry.ts'),
      "import { Base } from './base'\nexport const S = z.object({ own: z.string() })\n")

    const r = check({ schema: `src/ext-${ext}/entry.ts`, fields: ['own', 'deep', 'absent'] })
    assert.equal(r.status, FIELDS_MISSING, `.${ext} must resolve, not downgrade the verdict`)
    assert.deepEqual(r.missing, ['absent'])
  }
})

// contractFields was hardened against a malformed `fields`, but not against a malformed field
// *name*: an array name reached String.prototype.split and crashed a command documented as
// never failing.
test('a malformed field name is coerced, not thrown', async () => {
  const { normalizeField } = await import('../lib/fields.js')
  assert.equal(normalizeField({ name: ['order', 'total'] }).name, 'order,total')
  assert.equal(normalizeField({ name: 5 }).name, '5')
  assert.equal(normalizeField({ name: null }).name, '[object Object]')

  for (const fields of [[{ name: ['a', 'b'] }], [{ name: 5 }], [{ name: {} }]]) {
    assert.doesNotThrow(() => check({ schema: 'src/standalone.ts', fields }),
      `fields=${JSON.stringify(fields)} must not throw`)
  }
})

// A bare path can exist in several repos, and a scoped run only looks in some — so finding
// exactly one copy proves nothing about whether it is the right one.
test('a scoped run withholds a verdict from the one copy it happened to fetch', () => {
  // `svc` holds the file; `other` is registered but was not fetched by this run.
  const map = { repos: { svc: {}, other: {} }, contracts: {}, journeys: {} }

  const scopedRun = checkContractWith(map, { schema: 'src/standalone.ts', fields: ['alpha'] }, new Set(['svc']), true)
  assert.equal(scopedRun.status, UNSEARCHED,
    'other was never looked in, so the copy we found may not be the right one')

  // A full run has looked everywhere, so a single match is the answer.
  const fullRun = checkContractWith(
    map, { schema: 'src/standalone.ts', fields: ['alpha'] }, new Set(['svc', 'other']), false
  )
  assert.equal(fullRun.status, SCHEMA_OK)
})

// A `.proto` include and a JSON Schema $ref carry no bindings, so nothing marked the shape as
// continuing elsewhere and composed fields were reported definitely missing — against a README
// that promises the check works whatever the format.
test('a bindingless include from another format is inconclusive, not missing', () => {
  writeFileSync(join(repo, 'src', 'customer.proto'), 'message Customer { string customer_id = 1; }\n')
  writeFileSync(join(repo, 'src', 'order.proto'), 'import "customer.proto";\nmessage Order { string id = 1; }\n')
  assert.equal(check({ schema: 'src/order.proto', fields: ['id', 'customer_id'] }).status, INCONCLUSIVE)
})

test('a JSON Schema $ref is followed', () => {
  writeFileSync(join(repo, 'src', 'customer.json'), '{"properties":{"customerId":{"type":"string"}}}')
  writeFileSync(join(repo, 'src', 'order.json'),
    '{"properties":{"id":{"type":"string"},"customer":{"$ref":"./customer.json"}}}')
  assert.equal(check({ schema: 'src/order.json', fields: ['id', 'customerId'] }).status, SCHEMA_OK)
  assert.equal(check({ schema: 'src/order.json', fields: ['id', 'nowhere'] }).status, FIELDS_MISSING)
})

// A commented-out import is ordinary in real files. Parsing it as real made its unresolvable
// spec set `external`, downgrading a genuine finding with a claim that is simply false.
test('a commented-out import does not blunt the check', () => {
  writeFileSync(join(repo, 'src', 'commented.ts'),
    "// legacy: import { Old } from './old-removed'\n" +
    "/* import { Older } from './also-gone' */\n" +
    "import { z } from 'zod'\nexport const S = z.object({ total: z.number() })\n")
  const r = check({ schema: 'src/commented.ts', fields: ['total', 'nowhere'] })
  assert.equal(r.status, FIELDS_MISSING, 'dead imports hide nothing')
  assert.deepEqual(r.missing, ['nowhere'])
})

// The deferred last-round judgement dropped the bindingless half of the rule, so the same
// unfollowable include hid the shape at depth 2 and was invisible at depth 3 — the verdict
// depended on how deep the include happened to sit. Uses .proto, where a bindingless include
// genuinely is the composition; in JS/TS the same line is a side effect and hides nothing.
test('a whole-file include hides the shape at any depth', async () => {
  const { IMPORT_DEPTH } = await import('../lib/contracts.js')
  mkdirSync(join(repo, 'src', 'depths'), { recursive: true })

  for (let at = 1; at <= IMPORT_DEPTH; at++) {
    for (let i = 1; i <= IMPORT_DEPTH; i++) {
      const include = i === at ? 'import "google/protobuf/timestamp.proto";\n' : ''
      const next = i < IMPORT_DEPTH ? `import "./d${i + 1}.proto";\n` : ''
      writeFileSync(join(repo, 'src', 'depths', `d${i}.proto`), `${include}${next}message L${i} {}\n`)
    }
    writeFileSync(join(repo, 'src', 'depths', 'entry.proto'), 'import "./d1.proto";\nmessage E {}\n')

    assert.equal(
      check({ schema: 'src/depths/entry.proto', fields: ['nowhere'] }).status,
      INCONCLUSIVE,
      `an unfollowable include at level ${at} must hide the shape`
    )
  }
})

// The counterpart: in JS/TS a bindingless import contributes nothing, and treating it as opaque
// let one `import 'reflect-metadata'` anywhere in the graph turn every real verdict into
// "could not tell".
test('a JS side-effect import does not hide the shape', () => {
  writeFileSync(join(repo, 'src', 'sideeffect.ts'),
    "import 'reflect-metadata'\nimport './polyfills.js'\nimport { z } from 'zod'\n" +
    'export const S = z.object({ id: z.string(), total: z.number() })\n')
  writeFileSync(join(repo, 'src', 'polyfills.ts'), 'globalThis.x = 1\n')

  const r = check({ schema: 'src/sideeffect.ts', fields: ['id', 'discountCode'] })
  assert.equal(r.status, FIELDS_MISSING, 'a side effect composes nothing')
  assert.deepEqual(r.missing, ['discountCode'])
})
