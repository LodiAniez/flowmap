import { contractFields } from './fields.js'

const STALE_DAYS = 90

// Resolve a journey into hops with their inbound contract settled.
//
// The subtlety is fan-out. A hop with no outbound is a branch consumer, so the hop after it
// did not receive anything from it — inbound resolution walks *back* to the last hop that
// actually emitted something. Looking only at the immediately previous hop breaks the chain
// the moment two services subscribe to one event, which is the normal case.
export function journey(map, name) {
  const found = map.journeys?.[name]
  if (!found) return null

  const hops = (found.hops ?? []).map((hop, i, all) => ({
    index: i + 1,
    repo: hop.repo,
    inbound: hop.inbound ?? inheritedInbound(all, i),
    outbound: hop.outbound ?? null,
    reads: hop.reads ?? null,
    writes: hop.writes ?? null,
    note: hop.note ?? null,
    transform: hop.transform ?? [],
    branchConsumer: !hop.outbound,
    status: repoStatus(map, hop.repo),
  }))

  return { name, description: found.description ?? null, sample: found.sample ?? null, hops }
}

function inheritedInbound(hops, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (hops[i].outbound) return hops[i].outbound
  }
  return null
}

// Freshness is a commit comparison, never a human-maintained date. Until `verify` has run
// there is nothing to compare against, and the honest answer is "unverified" — not "ok".
// An agent must be able to tell a checked hop from an unchecked one; see DESIGN.md
// "Stale entries stay visible".
export function repoStatus(map, repoId) {
  const record = map.verified?.[repoId]
  if (!record?.at) return 'unverified'

  const at = Date.parse(record.at)
  if (Number.isNaN(at)) return 'unverified'

  const days = (Date.now() - at) / 86_400_000
  return days > STALE_DAYS ? 'stale' : 'ok'
}

// Which hops carry a field. Matching is substring over field paths — fine at current scale,
// and DESIGN.md records it as a known limit for when contracts start sharing field names.
export function impact(map, query) {
  const needle = String(query).toLowerCase()

  const contracts = Object.entries(map.contracts ?? {})
    .map(([id, contract]) => ({
      id,
      contract,
      matched: contractFields(contract).filter((f) => f.name.toLowerCase().includes(needle)),
    }))
    .filter((c) => c.matched.length)

  const byId = new Map(contracts.map((c) => [c.id, c]))
  const rows = []

  for (const name of Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name).hops) {
      // A hop touches the field if it arrives on the inbound contract or leaves on the
      // outbound one — both matter, because the edit sites differ.
      for (const [side, id] of [['in', hop.inbound], ['out', hop.outbound]]) {
        const match = id && byId.get(id)
        if (!match) continue
        for (const field of match.matched) {
          rows.push({
            journey: name,
            hop: hop.index,
            repo: hop.repo,
            side,
            contract: id,
            field: field.name,
            type: field.type ?? null,
            reads: hop.reads ?? null,
            writes: hop.writes ?? null,
            status: hop.status,
          })
        }
      }
    }
  }

  return { query, contracts, rows }
}

// Stable interfaces. See DESIGN.md "Agent consumption": changing a column order is a
// breaking change, so these live in one place rather than inline at the call site.
export const JOURNEY_COLUMNS = ['hop', 'repo', 'inbound', 'outbound', 'reads', 'writes', 'status']
export const IMPACT_COLUMNS = ['journey', 'hop', 'repo', 'side', 'contract', 'field', 'reads', 'writes', 'status']

export function journeyRow(hop) {
  return [hop.index, hop.repo, hop.inbound ?? '-', hop.outbound ?? '-', hop.reads ?? '-', hop.writes ?? '-', hop.status]
}

export function impactRow(r) {
  return [r.journey, r.hop, r.repo, r.side, r.contract, r.field, r.reads ?? '-', r.writes ?? '-', r.status]
}
