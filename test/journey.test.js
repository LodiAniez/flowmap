import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'flowmap-journey-'))
process.env.FLOWMAP_CACHE = join(root, '.flowmap-cache')
mkdirSync(join(root, '.flowmap-cache', 'svc', 'src'), { recursive: true })
mkdirSync(join(root, '.flowmap-cache', 'svc', '.git'), { recursive: true })
writeFileSync(join(root, '.flowmap-cache', 'svc', 'src', 'a.ts'), 'export function handler() {}\n')
mkdirSync(join(root, 'drafts'), { recursive: true })

const { acceptDraft } = await import('../lib/journey.js')

// Bracket access made an inherited id look already-defined, so the contract was silently not
// added — and the sibling check, hardened earlier, then reported the same id as undefined.
test('a newContracts id that shadows a prototype key is still added', () => {
  writeFileSync(join(root, 'drafts', 'proto.json'), JSON.stringify({
    name: 'proto',
    hops: [{ repo: 'svc', reads: 'src/a.ts::handler', outbound: 'constructor' }],
    newContracts: [{ id: 'constructor', kind: 'event', schema: 'src/a.ts', fields: ['x'] }],
  }))

  const map = { repos: { svc: {} }, contracts: {}, journeys: {}, verified: {} }
  const mapPath = join(root, 'flowmap.json')
  writeFileSync(mapPath, JSON.stringify(map))

  const r = acceptDraft(root, map, mapPath, 'proto')
  assert.deepEqual(r.added, ['constructor'], 'it was not already defined')
  assert.deepEqual(r.missingContracts, [], 'and must not then be reported as undefined')
})
