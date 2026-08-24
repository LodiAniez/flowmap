import { test } from 'node:test'
import assert from 'node:assert/strict'
import { journey, impact, repoStatus, JOURNEY_COLUMNS, IMPACT_COLUMNS, journeyRow } from '../lib/graph.js'

const map = {
  repos: { a: {}, b: {}, c: {} },
  contracts: {
    'event.order.created': { kind: 'event', fields: [{ name: 'order.id', type: 'string' }, 'order.total'] },
    'db.orders': { kind: 'table', fields: ['order.total', 'order.status'] },
  },
  journeys: {
    checkout: {
      hops: [
        { repo: 'a', outbound: 'event.order.created', reads: 'x.ts::in', writes: 'y.ts::out' },
        // branch consumer: emits nothing
        { repo: 'b', inbound: 'event.order.created', outbound: null, reads: 'b.ts::onEvent' },
        // must still resolve to the event, NOT to hop b which emitted nothing
        { repo: 'c', reads: 'c.ts::alsoOnEvent' },
      ],
    },
  },
  verified: {},
}

test('resolves a journey with its hops in order', () => {
  const j = journey(map, 'checkout')
  assert.equal(j.hops.length, 3)
  assert.deepEqual(j.hops.map((h) => h.repo), ['a', 'b', 'c'])
})

// The fan-out rule from DESIGN.md: two services subscribing to one event is the normal
// case, and looking only at the previous hop breaks the chain the moment it happens.
test('a branch consumer does not break inbound resolution for the hop after it', () => {
  const j = journey(map, 'checkout')
  assert.equal(j.hops[1].inbound, 'event.order.created')
  assert.equal(j.hops[2].inbound, 'event.order.created', 'walks back past the branch consumer')
  assert.equal(j.hops[1].branchConsumer, true)
})

test('an unknown journey returns null rather than throwing', () => {
  assert.equal(journey(map, 'nope'), null)
})

test('impact finds every hop carrying a field, on both sides of a hop', () => {
  const r = impact(map, 'order.total')
  assert.ok(r.contracts.some((c) => c.id === 'event.order.created'))
  assert.ok(r.contracts.some((c) => c.id === 'db.orders'), 'matches across contracts')
  const sides = r.rows.filter((x) => x.repo === 'b').map((x) => x.side)
  assert.ok(sides.includes('in'), 'the consuming side is an edit site too')
})

test('impact matches on a substring of the field path', () => {
  assert.ok(impact(map, 'total').rows.length > 0)
  assert.equal(impact(map, 'nonexistent').rows.length, 0)
})

test('impact reports nothing rather than everything for an empty match', () => {
  const r = impact(map, 'zzz')
  assert.deepEqual(r.contracts, [])
  assert.deepEqual(r.rows, [])
})

// An agent must be able to tell a checked hop from an unchecked one.
test('a repo that has never been verified reports unverified, not ok', () => {
  assert.equal(repoStatus(map, 'a'), 'unverified')
})

test('a verification older than 90 days reports stale', () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  const fresh = new Date(Date.now() - 2 * 86400000).toISOString()
  const m = { ...map, verified: { a: { at: old }, b: { at: fresh }, c: { at: 'garbage' } } }
  assert.equal(repoStatus(m, 'a'), 'stale')
  assert.equal(repoStatus(m, 'b'), 'ok')
  assert.equal(repoStatus(m, 'c'), 'unverified', 'an unparseable date is not a pass')
})

// Column order is a published interface; changing it breaks every agent reading it.
test('agent column order is pinned', () => {
  assert.deepEqual(JOURNEY_COLUMNS, ['hop', 'repo', 'inbound', 'outbound', 'reads', 'writes', 'status'])
  assert.deepEqual(IMPACT_COLUMNS,
    ['journey', 'hop', 'repo', 'side', 'contract', 'field', 'reads', 'writes', 'status'])
  assert.equal(journeyRow(journey(map, 'checkout').hops[0]).length, JOURNEY_COLUMNS.length)
})

test('a missing anchor renders as a dash, never as an empty cell', () => {
  const row = journeyRow(journey(map, 'checkout').hops[2])
  assert.ok(row.every((cell) => String(cell).length > 0), 'empty cells would shift columns')
})
