import { contractFields, normalizeField } from './fields.js'

// Simulation replays a payload through the transforms each hop DECLARES, and those
// declarations come from reading the code at draft time. So this is not a guess about what
// the services do — it is a replay of what someone recorded them doing, anchored to the
// file that does it. When the recording is wrong, the anchor is how you find that out.
//
// No network, nothing running. See DESIGN.md: the tool stays offline and advisory.

const OPS = new Set(['add', 'rename', 'drop', 'pass', 'derive'])

export function simulate(map, journey, input) {
  const hops = journey.hops ?? []
  let payload = flatten(input)
  const steps = []
  const emitted = new Set()

  for (const [i, hop] of hops.entries()) {
    // A hop whose inbound contract nothing upstream emitted is an independent entry point —
    // an external event arriving on its own, not a continuation. Carrying the previous
    // payload into it would invent a lineage the system does not have, so the payload
    // restarts from what that contract declares.
    let restarted = null
    if (hop.inbound && !emitted.has(hop.inbound)) {
      const entry = map.contracts[hop.inbound]
      if (entry) {
        payload = Object.fromEntries(contractFields(entry).map((f) => [f.name, sampleFor(f)]))
        restarted = hop.inbound
      }
    }

    const before = { ...payload }
    const ops = Array.isArray(hop.transform) ? hop.transform : []
    const events = []

    for (const op of ops) {
      if (!OPS.has(op?.op)) {
        events.push({ kind: 'invalid', detail: `unknown op "${op?.op}"` })
        continue
      }
      applyOp(op, payload, events)
    }

    // Anything still present that no op mentioned is passing through undeclared. That is
    // not an error — it is the map admitting it does not describe this field yet.
    const mentioned = new Set(
      ops.flatMap((o) => [o.field, o.from, o.to].filter(Boolean))
    )
    const undeclared = Object.keys(payload).filter((k) => !mentioned.has(k) && k in before)

    const contract = hop.outbound ? map.contracts[hop.outbound] : null
    const declared = contract ? contractFields(contract).map((f) => f.name) : null

    // Fields the outbound contract promises but that never arrived: the strongest signal
    // this simulation produces, because it is where a consumer breaks.
    const missing = declared ? declared.filter((name) => !(name in payload)) : []
    const extra = declared ? Object.keys(payload).filter((k) => !declared.includes(k)) : []

    steps.push({
      index: i + 1,
      restarted,
      repo: hop.repo,
      inbound: hop.inbound ?? null,
      outbound: hop.outbound ?? null,
      note: hop.note ?? null,
      reads: hop.reads ?? null,
      writes: hop.writes ?? null,
      in: before,
      out: { ...payload },
      events,
      undeclared,
      missing,
      extra,
      untraced: ops.length === 0,
    })

    if (hop.outbound) emitted.add(hop.outbound)

    // A branch consumer emits nothing, so the payload does not continue from here. The
    // next hop resumes from the last hop that actually emitted something.
    if (!hop.outbound) payload = { ...before }
  }

  return { steps, output: payload }
}

function applyOp(op, payload, events) {
  switch (op.op) {
    case 'add':
    case 'derive': {
      // Never clobber a value that already arrived. An entry hop that "adds" form fields is
      // describing where they originate, not replacing what the caller actually sent — and
      // a real recorded value beats a generated placeholder every time.
      const present = op.field in payload
      if (!present) payload[op.field] = op.value !== undefined ? op.value : placeholder(op)
      events.push({
        kind: op.op,
        field: op.field,
        source: op.source ?? null,
        note: op.note ?? null,
        carried: present,
      })
      return
    }
    case 'rename': {
      if (op.from in payload) {
        payload[op.to] = payload[op.from]
        delete payload[op.from]
        events.push({ kind: 'rename', from: op.from, to: op.to })
      } else {
        events.push({ kind: 'rename-missing', from: op.from, to: op.to })
      }
      return
    }
    case 'drop': {
      if (op.field in payload) {
        delete payload[op.field]
        events.push({ kind: 'drop', field: op.field })
      }
      return
    }
    case 'pass': {
      if (!(op.field in payload)) events.push({ kind: 'pass-missing', field: op.field })
      return
    }
  }
}

function sampleFor(field) {
  if (field.type === 'number' || field.type === 'int') return 0
  if (field.type === 'boolean') return false
  return `<${field.name}>`
}

function placeholder(op) {
  if (op.type === 'number') return 0
  if (op.type === 'boolean') return false
  return `<${op.field}>`
}

// Payloads are nested JSON but contracts name fields by path, so flatten once and compare
// like with like. "order.total" is a path, never a literal key with a dot in it.
export function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out[prefix] = value
    return out
  }
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out)
    else out[path] = v
  }
  return out
}
