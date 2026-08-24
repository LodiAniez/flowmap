import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stripScaffolding } from '../lib/scaffold.js'
import { addRepo as addRepoFn } from '../lib/registry.js'

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flowmap-scaffold-'))

// A real repo, so symbol extraction runs against real source rather than a fake tree.
const repo = join(root, 'cache', 'svc')
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(
  join(repo, 'src', 'publish.ts'),
  ['const TOPIC = "order.created"', '', 'export async function publishOrderCreated(o) {', '  bus.publish(TOPIC, o)', '}'].join('\n')
)
run(['init', '-q', '-b', 'main'], repo)
run(['add', '-A'], repo)
run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo)

process.env.FLOWMAP_CACHE = join(root, 'cache')
const { symbolsIn } = await import('../lib/outline.js')
const { writeScaffold } = await import('../lib/scaffold.js')

test('extracts anchorable symbols from real source', () => {
  const syms = symbolsIn(root, 'svc', 'src/publish.ts').map((s) => s.symbol)
  assert.ok(syms.includes('publishOrderCreated'))
})

test('exported symbols rank above local ones', () => {
  const syms = symbolsIn(root, 'svc', 'src/publish.ts')
  assert.equal(syms[0].symbol, 'publishOrderCreated', 'the exported name is the likely hop boundary')
})

test('writes a draft file with candidate anchors that actually resolve', async () => {
  const map = { repos: { svc: { url: repo, branch: 'main' } }, contracts: {}, journeys: {} }
  const res = writeScaffold(root, map, {
    name: 'checkout',
    feature: 'checkout',
    repoIds: ['svc'],
    seeds: ['order.created'],
    synced: [{ id: 'svc', dir: repo, branch: 'main', sha: 'abcdef1234' }],
  })

  const draft = JSON.parse(readFileSync(res.path, 'utf8'))
  assert.deepEqual(draft.hops, [], 'hops are left for the agent to fill in')
  assert.ok(draft._candidates.svc, 'the matching repo is shortlisted')

  const offered = draft._candidates.svc.files.flatMap((f) => f.anchors)
  assert.ok(offered.includes('src/publish.ts::publishOrderCreated'))

  // The whole point of offering anchors: an agent picking one cannot invent a bad path.
  const { resolveAnchor } = await import('../lib/anchor.js')
  for (const anchor of offered) {
    assert.equal(resolveAnchor(root, 'svc', anchor).status, 'ok', `${anchor} must resolve`)
  }
})

test('refuses to clobber an existing draft', () => {
  const map = { repos: { svc: { url: repo, branch: 'main' } }, contracts: {}, journeys: {} }
  const args = { name: 'checkout', feature: 'checkout', repoIds: ['svc'], seeds: [], synced: [] }
  assert.throws(() => writeScaffold(root, map, args), /already exists/)
  assert.doesNotThrow(() => writeScaffold(root, map, { ...args, force: true }))
})

test('scaffolding keys never reach the committed map', () => {
  const cleaned = stripScaffolding({
    description: 'x',
    _instructions: ['gone'],
    hops: [{ repo: 'a', _candidates: ['gone'], transform: [{ op: 'drop', field: 'f' }] }],
  })
  assert.deepEqual(Object.keys(cleaned), ['description', 'hops'])
  assert.deepEqual(Object.keys(cleaned.hops[0]), ['repo', 'transform'])
  assert.equal(cleaned.hops[0].transform[0].field, 'f', 'real data survives the strip')
})

// --- discovery -------------------------------------------------------------

const { siblingRepos, discover } = await import('../lib/discover.js')

const world = mkdtempSync(join(tmpdir(), 'flowmap-world-'))
function makeRepo(id, files, branch = 'main') {
  const dir = join(world, id)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  run(['init', '-q', '-b', branch], dir)
  run(['add', '-A'], dir)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
  return dir
}

const startRepo = makeRepo('svc-start', { 'a.ts': 'export const TOPIC = "order.created"\n' })
makeRepo('svc-consumer', { 'b.ts': 'subscribe("order.created")\n' })
makeRepo('svc-unrelated', { 'c.ts': 'export const nothing = 1\n' })
// A repo where the feature exists only on an unmerged branch. It needs a real origin:
// without one there is no upstream default to compare against, and the checked-out branch
// is the only notion of "default" the repo has.
const upstream = mkdtempSync(join(tmpdir(), 'flowmap-upstream-'))
const origin = join(upstream, 'svc-branchy-origin')
mkdirSync(origin, { recursive: true })
writeFileSync(join(origin, 'd.ts'), 'export const other = 1\n')
run(['init', '-q', '-b', 'main'], origin)
run(['add', '-A'], origin)
run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], origin)

const branchy = join(world, 'svc-branchy')
run(['clone', '-q', origin, branchy], world)
run(['checkout', '-q', '-b', 'feature/wip'], branchy)
writeFileSync(join(branchy, 'd.ts'), 'subscribe("order.created")\n')
run(['add', '-A'], branchy)
run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'wip'], branchy)

test('finds sibling repos beside the starting repo', () => {
  const ids = siblingRepos(startRepo).map((r) => r.id)
  assert.deepEqual(ids, ['svc-branchy', 'svc-consumer', 'svc-start', 'svc-unrelated'])
})

test('shortlists only repos that mention the term, keeping the start repo first', () => {
  const r = discover({ start: startRepo, terms: ['order.created'] })
  assert.equal(r.matched[0].id, 'svc-start', 'the repo you ran from leads the journey')
  const ids = r.matched.map((m) => m.id)
  assert.ok(ids.includes('svc-consumer'))
  assert.ok(!ids.includes('svc-unrelated'), 'unrelated repos are not registered')
})

// The case that would otherwise report a confident zero: the code exists, just not merged.
test('reports a repo whose match is only on an unmerged branch', () => {
  const r = discover({ start: startRepo, terms: ['order.created'] })
  assert.ok(!r.matched.some((m) => m.id === 'svc-branchy'), 'not treated as part of the map')
  assert.ok(r.headOnly.some((m) => m.id === 'svc-branchy'), 'but surfaced, not silently dropped')
})

// --- portability ------------------------------------------------------------

const { toPortable, fromPortable, display } = await import('../lib/paths.js')

// Every file flowmap writes is read by someone else on a different machine.
test('stored paths are relative and round-trip back', () => {
  const base = '/home/alice/repos/ctx'
  assert.equal(toPortable(base, '/home/alice/repos/ctx/.flowmap-cache/svc'), '.flowmap-cache/svc')
  assert.equal(toPortable(base, '/home/alice/repos/other-svc'), '../other-svc')
  assert.equal(fromPortable(base, '../other-svc'), '/home/alice/repos/other-svc')
})

test('a relative source resolves under a different home directory', () => {
  const mine = toPortable('/Users/dex/repos/ctx', '/Users/dex/repos/orders-api')
  assert.equal(fromPortable('/home/sam/code/ctx', mine), '/home/sam/code/orders-api')
})

test('an already-absolute stored value is left alone', () => {
  assert.equal(fromPortable('/anywhere', '/opt/src/svc'), '/opt/src/svc')
})

test('display keeps outside-the-root paths absolute rather than printing ../../..', () => {
  assert.equal(display('/a/b', '/a/b/drafts/x.json'), 'drafts/x.json')
  assert.equal(display('/a/b', '/other/place'), '/other/place')
})

test('registering a local repo stores it relative, and sync can still find it', () => {
  const ctx = join(root, 'ctx')
  mkdirSync(ctx, { recursive: true })
  const mapPath = join(ctx, 'flowmap.json')
  writeFileSync(mapPath, JSON.stringify({ repos: {}, contracts: {}, journeys: {}, verified: {} }))

  const map = { repos: {}, contracts: {}, journeys: {}, verified: {} }
  const { entry } = addRepoFn(map, mapPath, { id: 'svc', url: repo, branch: 'main' })
  assert.ok(!entry.url.startsWith('/'), `expected a relative url, got ${entry.url}`)
  assert.equal(fromPortable(ctx, entry.url), repo, 'and it resolves back to the real repo')
})

// A clone URL is portable already and is not a path. Resolving one against a root reads the
// scheme as a directory and yields `<root>/https:/github.com/...`, which git cannot clone.
// This only ever bit on a *cold* cache — syncRepo uses the stored source solely on a fresh
// clone, so a warm cache hid it completely.
test('a remote url survives the portable round-trip untouched', () => {
  const root = '/Users/someone/repos/ctx'
  for (const url of [
    'https://github.com/acme/orders-api.git',
    'git@github.com:acme/orders-api.git',
    'ssh://git@host/x.git',
    'git://host/x.git',
    'http://internal/x.git',
  ]) {
    assert.equal(fromPortable(root, url), url, `${url} must not be resolved as a path`)
    assert.equal(toPortable(root, url), url, `${url} must not be relativised`)
  }
})

test('display leaves a remote url alone', () => {
  assert.equal(display('/a/b', 'https://github.com/acme/x.git'), 'https://github.com/acme/x.git')
})

test('paths are still treated as paths after the url guard', () => {
  assert.equal(fromPortable('/a/b', '../c'), '/a/c')
  assert.equal(toPortable('/a/b', '/a/b/d'), 'd')
})
