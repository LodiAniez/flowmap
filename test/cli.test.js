import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFileSync as run } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flowmap.js')
const root = mkdtempSync(join(tmpdir(), 'flowmap-cli-'))

const git = (args, cwd) => run('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const repo = join(root, 'svc')
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'src', 'handler.ts'), 'export function handleThing() {}\n')
git(['init', '-q', '-b', 'main'], repo)
git(['add', '-A'], repo)
git(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo)

const mapPath = join(root, 'flowmap.json')
writeFileSync(mapPath, JSON.stringify({
  repos: { svc: { url: repo, branch: 'main' } },
  contracts: {},
  journeys: { checkout: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
  verified: {},
}))

// Runs the real binary. Returns { code, out, err } — never throws, because a non-zero exit
// is itself something these tests assert on.
function flowmap(...args) {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FLOWMAP_FILE: mapPath, FLOWMAP_CACHE: join(root, '.cache'), NO_COLOR: '1' },
    })
    return { code: 0, out, err: '' }
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' }
  }
}

test('an unknown journey name errors instead of reporting a clean pass', () => {
  const r = flowmap('verify', 'chekout')
  assert.equal(r.code, 2)
  assert.match(r.err, /no journey "chekout"/)
})

// `journeys.constructor` is inherited from Object.prototype, so a truthiness check passes it
// through, verify resolves zero anchors, and prints "every anchor resolves" — a clean bill
// of health for nothing checked.
test('a prototype key is not mistaken for a journey', () => {
  for (const key of ['constructor', 'toString', 'valueOf']) {
    const r = flowmap('verify', key)
    assert.equal(r.code, 2, `${key} must be rejected`)
    assert.doesNotMatch(r.out, /every anchor resolves/, `${key} must not report a pass`)
  }
})

test('a typo in --journey errors rather than checking nothing', () => {
  const r = flowmap('verify', '--journey', 'chekout')
  assert.equal(r.code, 2)
  assert.match(r.err, /no journey/)
})

test('a typo in --repos errors rather than narrowing to nothing', () => {
  const r = flowmap('verify', '--repos', 'typoo')
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown repo id/)
})

test('both noun spellings are accepted, as elsewhere in the CLI', () => {
  assert.equal(flowmap('verify', 'journey', 'checkout').code, 0)
  assert.equal(flowmap('verify', 'journeys', 'checkout').code, 0)
})

// The parser regression, end to end: --local must not consume the journey name.
test('--local and a positional journey name both apply', () => {
  const r = flowmap('verify', '--local', 'checkout')
  assert.doesNotMatch(r.err, /no journey/)
})

test('findings never produce a non-zero exit', () => {
  const broken = join(root, 'broken.json')
  writeFileSync(broken, JSON.stringify({
    repos: { svc: { url: repo, branch: 'main' } },
    contracts: {},
    journeys: { checkout: { hops: [{ repo: 'svc', reads: 'src/handler.ts::gone' }] } },
    verified: {},
  }))
  const r = execFileSync('node', [CLI, 'verify'], {
    encoding: 'utf8',
    env: { ...process.env, FLOWMAP_FILE: broken, FLOWMAP_CACHE: join(root, '.cache2'), NO_COLOR: '1' },
  })
  assert.match(r, /no longer resolve/)
  // reaching here at all means exit 0 — execFileSync throws otherwise
})

test('journey and impact emit the pinned column counts', () => {
  const j = flowmap('journey', 'checkout', '--format=agent').out.trim()
  assert.equal(j.split('\t').length, 7)
  const i = flowmap('impact', 'nothing-matches', '--format=agent')
  assert.equal(i.code, 0, 'an empty impact result is not an error')
})

// A scope that resolves to nothing must not print a clean bill of health — the same rule the
// journey-name guard enforces, applied to the repo scope.
test('a repo scope that covers no hop errors instead of reporting success', () => {
  const orphan = join(root, 'orphan.json')
  writeFileSync(orphan, JSON.stringify({
    repos: { svc: { url: repo, branch: 'main' }, extra: { url: repo, branch: 'main' } },
    contracts: {},
    journeys: { checkout: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
    verified: {},
  }))
  let out, code
  try {
    out = execFileSync('node', [CLI, 'verify', '--repos', 'extra'], {
      encoding: 'utf8',
      env: { ...process.env, FLOWMAP_FILE: orphan, FLOWMAP_CACHE: join(root, '.cache3'), NO_COLOR: '1' },
    })
    code = 0
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '')
    code = e.status
  }
  assert.doesNotMatch(out, /every anchor resolves/, 'a clean result here would mean nothing was checked')
  assert.equal(code, 2)
})

// `--journey` with no value parses as true, list() yields [], and the run silently widens to
// everything while the user believes it is scoped — then records it.
test('a scope flag with no value is rejected, not silently widened', () => {
  for (const flag of ['--journey', '--repos']) {
    const r = flowmap('verify', flag)
    assert.equal(r.code, 2, `${flag} with no value must not run`)
    assert.match(r.err, /needs a value/)
  }
})
