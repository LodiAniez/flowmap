import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
