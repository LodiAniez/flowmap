import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (a, c) => execFileSync('git', a, { cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const root = mkdtempSync(join(tmpdir(), 'flowmap-draft-'))
process.env.FLOWMAP_CACHE = join(root, '.flowmap-cache')

// A real repo: buildBrief runs `git grep` over the cache, which needs one.
const repo = join(root, '.flowmap-cache', 'svc')
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'src', 'a.ts'), 'export const TOPIC = "order.created"\n')
run(['init', '-q', '-b', 'main'], repo)
run(['add', '-A'], repo)
run(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo)

const { buildBrief } = await import('../lib/draft.js')

const map = {
  repos: { svc: {} },
  contracts: {
    'event.order.created': {
      kind: 'event',
      schema: 'src/a.ts',
      // The shape the brief itself instructs the drafting agent to produce.
      fields: [
        { name: 'order.id', type: 'string' },
        { name: 'order.total', type: 'number' },
      ],
    },
  },
  journeys: {},
}

const brief = (seeds) =>
  buildBrief(root, map, { name: 'checkout', from: null, repoIds: ['svc'], seeds, synced: [], max: 5 })

// The brief joined raw field objects, so every typed contract rendered as "[object Object]" —
// in the section whose whole purpose is telling the agent which ids and fields already exist.
test('the brief renders typed fields, not [object Object]', () => {
  const text = brief(['order.created'])
  assert.doesNotMatch(text, /\[object Object\]/)
  assert.match(text, /order\.id: string/)
  assert.match(text, /order\.total: number/)
})

// The same expression built the haystack for seed matching, so a seed naming a field could
// never match the contract that declares it.
test('a seed matches a contract by its field names', () => {
  const text = brief(['order.total'])
  assert.match(text, /event\.order\.created/,
    'the contract declaring order.total must be listed as already known')
})
