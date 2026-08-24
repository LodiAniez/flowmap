import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, execFileSync as run } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
  // A trailing object overrides the environment — some cases need their own map file.
  const opts = typeof args.at(-1) === 'object' ? args.pop() : {}
  const env = {
    ...process.env,
    FLOWMAP_FILE: opts.mapPath ?? mapPath,
    FLOWMAP_CACHE: opts.cache ?? join(root, '.cache'),
    NO_COLOR: '1',
  }
  // spawnSync, not execFileSync: the latter returns stdout only, so stderr is discarded
  // whenever the command succeeds — and notices are written to stderr with an exit code of 0,
  // which is precisely what these assert on.
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
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
test('a repo scope that covers no hop says so instead of reporting success', () => {
  const orphan = join(root, 'orphan.json')
  writeFileSync(orphan, JSON.stringify({
    repos: { svc: { url: repo, branch: 'main' }, extra: { url: repo, branch: 'main' } },
    contracts: {},
    journeys: { checkout: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
    verified: {},
  }))
  // The notice goes to stderr, so capture both streams whichever way it exits.
  const r = flowmap('verify', '--repos', 'extra', { mapPath: orphan, cache: join(root, '.cache3') })
  const out = r.out + r.err
  const code = r.code
  assert.doesNotMatch(out, /every anchor resolves/, 'a clean result here would mean nothing was checked')
  assert.match(out, /nothing to verify/, 'and it must say so')
  // Never a non-zero exit for a finding: --local is the documented PR-time scope, and a repo
  // registered but not yet in a journey is an ordinary state. See DESIGN.md "Never a gate."
  assert.equal(code, 0, 'reporting nothing to check is not a usage error')
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

// DESIGN.md: "No exit code that breaks CI." Every command must exit 0 for a finding, whatever
// the finding is — the whole tool is advisory. Sweeping the surface rather than trusting that
// each new guard remembered it.
test('no command exits non-zero for a finding', () => {
  const broken = join(root, 'findings.json')
  writeFileSync(broken, JSON.stringify({
    repos: { svc: { url: repo, branch: 'main' } },
    contracts: { c: { kind: 'event', schema: 'src/gone.ts', fields: ['nope'] } },
    journeys: { checkout: { hops: [{ repo: 'svc', reads: 'src/handler.ts::gone', outbound: 'c' }] } },
    verified: {},
  }))
  const opts = { mapPath: broken, cache: join(root, '.cache-findings') }

  // --local is excluded deliberately: run outside a registered repo it is a usage error, not
  // a finding, and usage errors are allowed to exit 2.
  for (const argv of [['verify'], ['journey', 'checkout'], ['impact', 'nope'], ['verify', '--format=agent']]) {
    const r = flowmap(...argv, opts)
    assert.equal(r.code, 0, `flowmap ${argv.join(' ')} must not exit non-zero on a finding`)
  }
})

test('an empty scope flag value is rejected like a missing one', () => {
  for (const arg of ['--journey=', '--repos=']) {
    const r = flowmap('verify', arg)
    assert.equal(r.code, 2, `${arg} must not silently widen the run`)
    assert.match(r.err, /needs a value/)
  }
})

// checkJourney now syncs before checkDraft, so a hand-edited draft with a non-array `hops`
// reaches syncForJourney first and must not crash with a raw TypeError.
test('a malformed draft reports rather than crashing', () => {
  const dir = join(root, 'drafts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'broken.json'), JSON.stringify({ name: 'broken', hops: {} }))
  const r = flowmap('draft', '--check', 'broken', { mapPath: join(root, 'flowmap.json') })
  assert.notEqual(r.code, 1, 'a map defect is not an internal error')
  assert.doesNotMatch(r.err, /is not a function/, 'and never a raw TypeError')
})

// `show journey` on an accepted feature must work against a cold cache. Passing mode 'sparse'
// with no paths clones with --sparse and never sets a cone, so the checkout holds only the
// repo root and every anchor resolves as missing — with no warning, because a fresh clone
// reports narrowed: false.
test('show journey resolves anchors on a cold cache', () => {
  const cold = join(root, 'cold.json')
  writeFileSync(cold, JSON.stringify({
    repos: { svc: { url: repo, branch: 'main' } },
    contracts: {},
    journeys: { checkout: { hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }] } },
    verified: {},
  }))
  const r = flowmap('show', 'journey', 'checkout', { mapPath: cold, cache: join(root, '.cache-cold') })
  assert.doesNotMatch(r.out, /file not found/, 'the anchor exists and the tree must contain it')
  assert.match(r.out, /handleThing/)
})

// Contracts dropped before they were ever checked produce no `contracts` entry, so an agent
// run that says nothing at all reads as a clean result.
test('the agent format reports contracts it never checked', () => {
  const scoped = join(root, 'agent-scope.json')
  writeFileSync(scoped, JSON.stringify({
    repos: { a: { url: repo, branch: 'main' }, b: { url: repo, branch: 'main' } },
    contracts: { onB: { kind: 'event', schema: 'b/src/handler.ts', fields: [] } },
    journeys: {
      ja: { hops: [{ repo: 'a', reads: 'src/handler.ts::handleThing' }] },
      jb: { hops: [{ repo: 'b', reads: 'src/handler.ts::handleThing', outbound: 'onB' }] },
    },
    verified: {},
  }))
  const r = flowmap('verify', '--repos', 'a', '--format=agent',
    { mapPath: scoped, cache: join(root, '.cache-agentscope') })
  assert.match(r.out, /onB/, 'silence here would read as a clean result')
  assert.equal(r.code, 0)
})

// The valueless-scope guard was written for verify and covered only verify; every other
// command widened to the whole registry while the caller believed the run was scoped.
test('a valueless scope flag is rejected on every command that scopes', () => {
  for (const argv of [
    ['search', 'needle', '--repos'],
    ['search', 'needle', '--repos='],
    ['draft', 'journey', 'x', '--repos'],
    ['sync', '--repos'],
    ['verify', '--repos'],
  ]) {
    const r = flowmap(...argv)
    assert.equal(r.code, 2, `flowmap ${argv.join(' ')} must not silently widen`)
    assert.match(r.err, /needs a value/)
  }
})

// autoSetup creates flowmap.json, edits .git/info/exclude, runs discovery and makes a network
// round trip per repo. Rejecting an argument after all that is a bad way to reject an argument.
test('draft journey validates its flags before doing anything', () => {
  const fresh = join(root, 'fresh-draft')
  mkdirSync(fresh, { recursive: true })
  const r = flowmap('draft', 'journey', 'checkout', '--repos',
    { mapPath: join(fresh, 'flowmap.json'), cache: join(fresh, '.cache') })
  assert.equal(r.code, 2)
  assert.match(r.err, /needs a value/)
  assert.ok(!existsSync(join(fresh, 'flowmap.json')), 'and nothing was created first')
})

// `--check` is dual-form. Listing it as boolean made the equals spelling fall through to
// draftJourney(undefined) and die with a misleading usage message.
test('draft --check accepts both spellings', () => {
  const dir = join(root, 'drafts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dual.json'), JSON.stringify({
    name: 'dual', hops: [{ repo: 'svc', reads: 'src/handler.ts::handleThing' }],
  }))
  for (const argv of [['draft', '--check', 'dual'], ['draft', '--check=dual']]) {
    const r = flowmap(...argv)
    assert.doesNotMatch(r.err, /usage: flowmap draft journey/, `${argv.join(' ')} must resolve the draft`)
    assert.match(r.out + r.err, /dual/)
  }
})

// A boolean written `--force=` is an unset shell variable, not "on" — silently reading it as
// on would force-accept a draft whose anchors do not resolve.
test('an empty value on a boolean flag is rejected', () => {
  for (const arg of ['--force=', '--all=']) {
    const r = flowmap('verify', arg)
    assert.equal(r.code, 2, `${arg} must not be read as on`)
    assert.match(r.err, /empty value/)
  }
})

// A bare value flag parses as true, and Number(true) is 1 — so --max silently caps at one hit.
test('a bare numeric flag is rejected rather than read as 1', () => {
  for (const argv of [['search', 'needle', '--max'], ['visualize', '--port']]) {
    const r = flowmap(...argv)
    assert.equal(r.code, 2, `flowmap ${argv.join(' ')} must not silently mean 1`)
    assert.match(r.err, /needs a value/)
  }
})

// verifyCmd was hardened against inherited keys; the read commands were not, so `show journey
// constructor` printed an empty journey and wrote a diagram file for it.
test('read commands reject prototype keys as journey names', () => {
  for (const key of ['constructor', 'toString', 'valueOf']) {
    for (const cmd of ['show', 'journey']) {
      const argv = cmd === 'show' ? ['show', 'journey', key] : ['journey', key]
      const r = flowmap(...argv)
      assert.notEqual(r.code, 0, `flowmap ${argv.join(' ')} must not succeed`)
      assert.doesNotMatch(r.out, /0 hops/, 'and must not render an empty journey')
    }
  }
})

// A value flag given an empty value reached writeFileSync('') and died with ENOENT and exit 1,
// where its sibling guards produce a usage error.
test('an empty value on a path flag is a usage error', () => {
  const r = flowmap('show', 'journey', 'checkout', '--out=')
  assert.equal(r.code, 2)
  assert.match(r.err, /needs a value/)
})
