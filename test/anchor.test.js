import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'flowmap-test-'))
process.env.FLOWMAP_CACHE = join(root, 'cache')

const repo = join(root, 'cache', 'svc')
mkdirSync(join(repo, '.git'), { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })

writeFileSync(
  join(repo, 'src', 'shapes.ts'),
  [
    'export async function handlerFn(req) {}',
    'export const arrowFn = async (e) => {}',
    'class OrderService {}',
    'def python_handler(event):',
    'func GoHandler(w, r) {}',
    'const TOPIC = "order.created"',
  ].join('\n')
)

const { parseAnchor, resolveAnchor, OK, SYMBOL_MISSING, FILE_MISSING, REPO_MISSING, MALFORMED } =
  await import('../lib/anchor.js')
const { tsv } = await import('../lib/output.js')

test('parseAnchor splits path and symbol', () => {
  assert.deepEqual(parseAnchor('src/a.ts::doThing'), { path: 'src/a.ts', symbol: 'doThing' })
})

test('parseAnchor rejects malformed and traversing anchors', () => {
  assert.equal(parseAnchor('src/a.ts'), null)
  assert.equal(parseAnchor('::orphan'), null)
  assert.equal(parseAnchor('src/a.ts::'), null)
  assert.equal(parseAnchor('../outside.ts::x'), null)
})

// Tier 2 has to span languages without becoming a parser. See DESIGN.md
// "Symbol resolution is two-tier, not parsed."
for (const symbol of ['handlerFn', 'arrowFn', 'OrderService', 'python_handler', 'GoHandler', 'TOPIC']) {
  test(`resolves declaration form: ${symbol}`, () => {
    const res = resolveAnchor(root, 'svc', `src/shapes.ts::${symbol}`)
    assert.equal(res.status, OK, `${symbol} should resolve`)
    assert.ok(res.line > 0)
  })
}

test('distinguishes a renamed symbol from an invented path', () => {
  assert.equal(resolveAnchor(root, 'svc', 'src/shapes.ts::renamedAway').status, SYMBOL_MISSING)
  assert.equal(resolveAnchor(root, 'svc', 'src/nope.ts::anything').status, FILE_MISSING)
})

test('reports an unsynced repo distinctly from a bad anchor', () => {
  assert.equal(resolveAnchor(root, 'never-synced', 'src/shapes.ts::handlerFn').status, REPO_MISSING)
  assert.equal(resolveAnchor(root, 'svc', 'not-an-anchor').status, MALFORMED)
})

test('a symbol mentioned but not declared does not resolve', () => {
  // guards against the regex degrading into a bare substring match
  assert.equal(resolveAnchor(root, 'svc', 'src/shapes.ts::created').status, SYMBOL_MISSING)
})

test('agent format never emits a tab or newline inside a cell', () => {
  const out = tsv([['a\tb', 'c\nd', 1]])
  assert.equal(out, 'a b\tc d\t1')
  assert.equal(out.split('\t').length, 3)
})
