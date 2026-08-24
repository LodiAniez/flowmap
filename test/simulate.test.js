import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulate, flatten } from '../lib/simulate.js'
import { mermaid } from '../lib/diagram.js'

const map = {
  contracts: {
    'event.order.created': {
      kind: 'event',
      fields: [{ name: 'order.id', type: 'string' }, { name: 'order.total', type: 'number' }],
    },
  },
  journeys: {},
}

const journey = {
  hops: [
    {
      repo: 'orders-api',
      outbound: 'event.order.created',
      transform: [
        { op: 'add', field: 'order.id', type: 'string', source: 'persist()' },
        { op: 'rename', from: 'total', to: 'order.total' },
        { op: 'drop', field: 'cart_id' },
      ],
    },
    {
      repo: 'fulfilment',
      inbound: 'event.order.created',
      outbound: null,
      transform: [{ op: 'pass', field: 'order.id' }],
    },
  ],
}

test('replays declared transforms over a payload', () => {
  const { steps } = simulate(map, journey, { cart_id: 'c_1', total: 42.5 })
  assert.equal(steps[0].out['order.total'], 42.5, 'renamed field keeps its value')
  assert.ok(!('cart_id' in steps[0].out), 'dropped field is gone')
  assert.ok('order.id' in steps[0].out, 'added field appears')
})

test('flags a field the outbound contract promises but never arrived', () => {
  const { steps } = simulate(map, journey, { cart_id: 'c_1' }) // no `total`
  assert.ok(steps[0].missing.includes('order.total'))
  assert.ok(steps[0].events.some((e) => e.kind === 'rename-missing'))
})

// The point of the whole feature: a field nobody declared must not look accounted for.
test('flags an undeclared field rather than passing it silently', () => {
  const { steps } = simulate(map, journey, { cart_id: 'c_1', total: 1, coupon: 'SAVE10' })
  assert.ok(steps[0].undeclared.includes('coupon'))
  assert.ok(steps[0].extra.includes('coupon'))
})

test('a hop with no recorded transforms is reported as untraced, not as unchanged', () => {
  const bare = { hops: [{ repo: 'x', outbound: null }] }
  const { steps } = simulate(map, bare, { a: 1 })
  assert.equal(steps[0].untraced, true)
})

test('a branch consumer does not consume the payload for later hops', () => {
  const fanout = {
    hops: [
      { repo: 'a', outbound: 'event.order.created', transform: [{ op: 'add', field: 'order.id' }] },
      { repo: 'b', inbound: 'event.order.created', outbound: null, transform: [{ op: 'drop', field: 'order.id' }] },
      { repo: 'c', inbound: 'event.order.created', outbound: null },
    ],
  }
  const { steps } = simulate(map, fanout, {})
  assert.ok('order.id' in steps[2].in, 'hop c still sees what hop a emitted')
})

test('flatten turns nested json into contract-style field paths', () => {
  assert.deepEqual(flatten({ order: { id: 'x', total: 2 } }), { 'order.id': 'x', 'order.total': 2 })
})

test('mermaid draws the edge from the emitting hop and carries types', () => {
  const out = mermaid(map, 'checkout', journey)
  assert.match(out, /flowchart TD/)
  assert.match(out, /h0 -->\|"event\.order\.created/)
  assert.match(out, /order\.total: number/)
})

// --- entry payloads ---------------------------------------------------------

test('an add never overwrites a value that already arrived', () => {
  const entry = {
    hops: [
      {
        repo: 'ui',
        outbound: 'event.order.created',
        // A form "adds" fields in the sense of originating them — but when the caller
        // actually supplied them, the supplied value is the real one.
        transform: [{ op: 'add', field: 'order.total', type: 'number', source: 'form input' }],
      },
    ],
  }
  const { steps } = simulate(map, entry, { 'order.total': 42.5 })
  assert.equal(steps[0].out['order.total'], 42.5, 'the supplied value survives')
  assert.equal(steps[0].events[0].carried, true, 'and is reported as already present')
})

test('an add uses a recorded value when the field is genuinely absent', () => {
  const j = {
    hops: [{ repo: 'api', outbound: 'event.order.created',
      transform: [{ op: 'add', field: 'order.id', value: 'ord_1a2b', source: 'persist()' }] }],
  }
  const { steps } = simulate(map, j, {})
  assert.equal(steps[0].out['order.id'], 'ord_1a2b')
  assert.equal(steps[0].events[0].carried, false)
})

// A hop fed by an external event is not a continuation of the hops above it. Carrying the
// upstream payload in would invent a lineage the system does not have.
test('a hop whose inbound nothing upstream emitted restarts the payload', () => {
  const twoEntry = {
    hops: [
      { repo: 'a', outbound: 'event.order.created', transform: [{ op: 'add', field: 'order.id', value: 'o1' }] },
      { repo: 'b', inbound: 'external.bill.paid', outbound: null },
    ],
  }
  const withExternal = {
    ...map,
    contracts: {
      ...map.contracts,
      'external.bill.paid': { kind: 'event', fields: [{ name: 'billId', type: 'string' }] },
    },
  }
  const { steps } = simulate(withExternal, twoEntry, {})
  assert.equal(steps[1].restarted, 'external.bill.paid')
  assert.ok('billId' in steps[1].in, 'it starts from its own contract')
  assert.ok(!('order.id' in steps[1].in), 'and does not inherit the unrelated upstream payload')
})

test('a hop fed by a contract an earlier hop did emit continues normally', () => {
  const { steps } = simulate(map, journey, { total: 1 })
  assert.equal(steps[1].restarted, null, 'hop 2 consumes what hop 1 emitted')
  assert.ok('order.total' in steps[1].in)
})

// `contracts.constructor` is inherited and truthy, so an undefined outbound id looked defined:
// `declared` became [] rather than null, and every payload key was then reported as not in the
// contract — a fabricated finding in the visualiser.
test('a prototype-named contract id is treated as undefined', () => {
  const j = {
    hops: [
      { repo: 'a', outbound: 'constructor', transform: [{ op: 'add', field: 'x', value: 1 }] },
      { repo: 'b', inbound: 'toString', outbound: null },
    ],
  }
  const { steps } = simulate({ contracts: {}, journeys: {} }, j, {})
  assert.deepEqual(steps[0].extra, [], 'no contract means nothing to be extra to')
  assert.deepEqual(steps[0].missing, [])
  assert.equal(steps[1].restarted, null, 'and an inherited inbound does not restart the payload')
})
