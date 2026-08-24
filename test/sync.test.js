import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (a, c) => execFileSync('git', a, { cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flowmap-sync-'))
process.env.FLOWMAP_CACHE = join(root, '.flowmap-cache')

function makeUpstream(name, files) {
  const dir = join(root, name)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  run(['init', '-q', '-b', 'main'], dir)
  run(['add', '-A'], dir)
  run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir)
  return dir
}

const { syncRepo } = await import('../lib/sync.js')

// Cone-mode sparse-checkout rejects a file path, and a rejected list fails the whole command.
// That took out an entire repo's verification the moment a contract schema was a file.
test('a sparse path list git rejects degrades to a full checkout, not a failure', () => {
  const up = makeUpstream('svc-sparse', { 'src/a.ts': 'export const a = 1\n', 'schema.gql': 'type Q { a: String }\n' })
  const r = syncRepo(root, 'svc-sparse', { url: up, branch: 'main' }, {
    mode: 'sparse',
    paths: ['schema.gql'], // a file, which cone mode refuses
  })
  assert.ok(r.sha, 'the repo still synced')
  assert.ok(existsSync(join(r.dir, 'src', 'a.ts')), 'falls back to a full checkout')
})

test('a valid directory cone still narrows the checkout', () => {
  const up = makeUpstream('svc-cone', { 'src/keep.ts': 'export const k = 1\n', 'other/skip.ts': 'export const s = 1\n' })
  const r = syncRepo(root, 'svc-cone', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['src'] })
  assert.ok(existsSync(join(r.dir, 'src', 'keep.ts')))
})

// The cache is keyed by repo id, so an entry whose url changes later keeps fetching from the
// origin configured at clone time — silently verifying against the wrong source.
test('a changed url re-points an existing cache instead of fetching the old origin', () => {
  const oldUp = makeUpstream('svc-old', { 'src/a.ts': 'export const old = 1\n' })
  const newUp = makeUpstream('svc-new', { 'src/a.ts': 'export const fresh = 1\n' })

  syncRepo(root, 'svc-moved', { url: oldUp, branch: 'main' }, { mode: 'full' })
  const after = syncRepo(root, 'svc-moved', { url: newUp, branch: 'main' }, { mode: 'full', refresh: true })

  const origin = run(['remote', 'get-url', 'origin'], after.dir).trim()
  assert.equal(origin, newUp, 'origin follows the map')
  assert.match(
    execFileSync('cat', [join(after.dir, 'src', 'a.ts')], { encoding: 'utf8' }),
    /fresh/,
    'and the content comes from the new source'
  )
})

// The cone is derived from the map's anchors, so it goes stale when a journey gains a hop.
test('the sparse cone is re-applied on refresh, not frozen at clone time', () => {
  const up = makeUpstream('svc-recone', { 'one/a.ts': 'export const a = 1\n', 'two/b.ts': 'export const b = 1\n' })
  const first = syncRepo(root, 'svc-recone', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['one'] })
  assert.ok(!existsSync(join(first.dir, 'two', 'b.ts')), 'starts narrowed to one/')

  const second = syncRepo(root, 'svc-recone', { url: up, branch: 'main' }, {
    mode: 'sparse', refresh: true, paths: ['one', 'two'],
  })
  assert.ok(existsSync(join(second.dir, 'two', 'b.ts')), 'a widened cone takes effect')
})

// verify runs with mode:'sparse'. Narrowing a checkout that search/draft cloned full would
// silently truncate the tree they grep, and nothing ever widens it again.
test('a full checkout is never converted to sparse by a later sparse refresh', () => {
  const up = makeUpstream('svc-full', { 'one/a.ts': 'export const a = 1\n', 'two/b.ts': 'export const findme = 1\n' })
  syncRepo(root, 'svc-full', { url: up, branch: 'main' }, { mode: 'full' })

  const after = syncRepo(root, 'svc-full', { url: up, branch: 'main' }, {
    mode: 'sparse', refresh: true, paths: ['one'],
  })
  assert.ok(existsSync(join(after.dir, 'two', 'b.ts')),
    'the full tree survives, or search and draft would go blind')
})

// The mirror of the previous test, and the more damaging direction: verify narrows a
// checkout, then search greps whatever is on disk and reports a partial result as complete.
test('a sparse checkout is widened before a full-mode command uses it', () => {
  const up = makeUpstream('svc-widen', {
    'anchored/a.ts': 'export const a = 1\n',
    'elsewhere/b.ts': 'export const findMeAnywhere = 1\n',
  })
  syncRepo(root, 'svc-widen', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['anchored'] })
  const narrowed = join(root, '.flowmap-cache', 'svc-widen', 'elsewhere', 'b.ts')
  assert.ok(!existsSync(narrowed), 'starts narrowed')

  // No refresh flag: reconciliation must happen on plain reuse, which is how search calls it.
  const after = syncRepo(root, 'svc-widen', { url: up, branch: 'main' }, { mode: 'full', widen: true })
  assert.ok(existsSync(join(after.dir, 'elsewhere', 'b.ts')),
    'search must not grep a truncated tree and call the result complete')
})

// Widening is for the commands that grep. Doing it for every full-mode sync would materialise
// whole repos on a blobless clone and permanently cost verify its sparse checkout.
test('a full-mode sync that does not grep leaves the cone alone', () => {
  const up = makeUpstream('svc-keepcone', {
    'anchored/a.ts': 'export const a = 1\n',
    'elsewhere/b.ts': 'export const b = 1\n',
  })
  syncRepo(root, 'svc-keepcone', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['anchored'] })
  const after = syncRepo(root, 'svc-keepcone', { url: up, branch: 'main' }, { mode: 'full' })
  assert.ok(!existsSync(join(after.dir, 'elsewhere', 'b.ts')), 'the cone survives')
})

// --no-sync declines to widen, which is correct — but the tree is still coned, and a caller
// that greps it has to know, or it presents a partial sweep as complete.
test('declining to widen still reports the checkout as narrowed', () => {
  const up = makeUpstream('svc-nosync', { 'a/one.ts': 'export const a = 1\n', 'b/two.ts': 'export const b = 1\n' })
  syncRepo(root, 'svc-nosync', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['a'] })

  const declined = syncRepo(root, 'svc-nosync', { url: up, branch: 'main' }, { mode: 'full', widen: false })
  assert.equal(declined.narrowed, true, 'silence here would look like a complete tree')

  const widened = syncRepo(root, 'svc-nosync', { url: up, branch: 'main' }, { mode: 'full', widen: true })
  assert.equal(widened.narrowed, false)
})

// Widening for search clears core.sparseCheckout, so reading that flag afterwards makes the
// checkout look like one the user cloned in full — and verify then declines to re-narrow it,
// permanently converting every blobless sparse clone into a full one.
test('a checkout flowmap made sparse can be re-narrowed after being widened', () => {
  const up = makeUpstream('svc-renarrow', {
    'anchored/a.ts': 'export const a = 1\n',
    'elsewhere/b.ts': 'export const b = 1\n',
  })
  syncRepo(root, 'svc-renarrow', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['anchored'] })

  const wide = syncRepo(root, 'svc-renarrow', { url: up, branch: 'main' }, { mode: 'full', widen: true })
  assert.ok(existsSync(join(wide.dir, 'elsewhere', 'b.ts')), 'search sees the whole tree')

  const narrow = syncRepo(root, 'svc-renarrow', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['anchored'] })
  assert.ok(!existsSync(join(narrow.dir, 'elsewhere', 'b.ts')),
    'and verify gets its cone back rather than paying for a full checkout forever')
})

// A checkout the user cloned in full is still never narrowed.
test('a full clone is still never narrowed', () => {
  const up = makeUpstream('svc-userfull', { 'one/a.ts': 'export const a = 1\n', 'two/b.ts': 'export const b = 1\n' })
  syncRepo(root, 'svc-userfull', { url: up, branch: 'main' }, { mode: 'full' })
  const after = syncRepo(root, 'svc-userfull', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['one'] })
  assert.ok(existsSync(join(after.dir, 'two', 'b.ts')))
})

// A caller that had no reason to widen is not a problem to report. Blaming --no-sync for it
// fired the warning on the most common read command and pointed at a flag nobody passed.
test('declining to widen by choice is distinguished from --no-sync declining', () => {
  const up = makeUpstream('svc-reason', { 'a/one.ts': 'export const a = 1\n', 'b/two.ts': 'export const b = 1\n' })
  syncRepo(root, 'svc-reason', { url: up, branch: 'main' }, { mode: 'sparse', paths: ['a'] })

  const byDesign = syncRepo(root, 'svc-reason', { url: up, branch: 'main' }, { mode: 'full', widen: false })
  assert.equal(byDesign.narrowedReason, 'by-design', 'the caller simply did not need the rest')

  // The CLI sets blockedByFlag only when the caller wanted to widen and --no-sync stopped it;
  // `offline` alone says nothing about the caller's intent.
  const blocked = syncRepo(root, 'svc-reason', { url: up, branch: 'main' },
    { mode: 'full', widen: false, offline: true, blockedByFlag: true })
  assert.equal(blocked.narrowedReason, 'declined', '--no-sync is a different story')

  const offlineButUnwanted = syncRepo(root, 'svc-reason', { url: up, branch: 'main' },
    { mode: 'full', widen: false, offline: true })
  assert.equal(offlineButUnwanted.narrowedReason, 'by-design',
    'offline alone must not be blamed when the caller never wanted the rest')
})

// Correcting a changed url on disk while declining to fetch records the change as done, so no
// later run ever performs the fetch it implies — and search goes on grepping the previous
// repository's files forever, reporting them as complete.
test('--no-sync leaves a changed url uncorrected rather than half-applied', () => {
  const oldUp = makeUpstream('svc-offline-old', { 'a.ts': 'export const which = "old"\n' })
  const newUp = makeUpstream('svc-offline-new', { 'a.ts': 'export const which = "new"\n' })

  syncRepo(root, 'svc-offline', { url: oldUp, branch: 'main' }, { mode: 'full' })
  const offline = syncRepo(root, 'svc-offline', { url: newUp, branch: 'main' }, { mode: 'full', offline: true })
  assert.equal(run(['remote', 'get-url', 'origin'], offline.dir).trim(), oldUp,
    'the correction is still owed, not silently recorded as done')

  // And the next online run actually performs it.
  const online = syncRepo(root, 'svc-offline', { url: newUp, branch: 'main' }, { mode: 'full' })
  assert.equal(run(['remote', 'get-url', 'origin'], online.dir).trim(), newUp)
  assert.match(readFileSync(join(online.dir, 'a.ts'), 'utf8'), /new/, 'and the tree follows')
})

// Deferring the url correction is right, but the tree is then the previous repository's and a
// silent complete-looking result is the failure the deferral was meant to avoid.
test('a deferred url correction is reported as a stale checkout', () => {
  const oldUp = makeUpstream('svc-stale-old', { 'a.ts': 'export const which = "old"\n' })
  const newUp = makeUpstream('svc-stale-new', { 'a.ts': 'export const which = "new"\n' })

  syncRepo(root, 'svc-stale', { url: oldUp, branch: 'main' }, { mode: 'full' })
  const offline = syncRepo(root, 'svc-stale', { url: newUp, branch: 'main' }, { mode: 'full', offline: true })
  assert.equal(offline.staleOrigin, true, 'the caller must be told these are the old files')

  const online = syncRepo(root, 'svc-stale', { url: newUp, branch: 'main' }, { mode: 'full' })
  assert.equal(online.staleOrigin, false, 'and not told once it is corrected')
})
