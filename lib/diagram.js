import { contractFields, describeField } from './fields.js'

// Mermaid, because it renders inline on GitHub, in PRs, in Notion and in most editors with
// no toolchain, and it diffs as text. A generated PNG would be none of those things.
export function mermaid(map, name, journey) {
  const hops = journey.hops ?? []
  const lines = ['flowchart TD']
  const idOf = (i) => `h${i}`

  hops.forEach((hop, i) => {
    const label = [esc(hop.repo ?? '?')]
    if (hop.note) label.push(`<small>${esc(hop.note)}</small>`)
    lines.push(`  ${idOf(i)}["${label.join('<br/>')}"]`)
  })

  // Edges follow the contracts, not adjacency: a branch consumer hangs off whichever hop
  // last emitted something, which is what makes fan-out draw correctly.
  hops.forEach((hop, i) => {
    if (!hop.inbound) return
    const source = lastEmitterOf(hops, i, hop.inbound)
    if (source === -1) return
    const contract = map.contracts[hop.inbound]
    const fields = contractFields(contract).slice(0, 6).map(describeField)
    const caption = [esc(hop.inbound), ...fields.map((f) => `<small>${esc(f)}</small>`)].join('<br/>')
    lines.push(`  ${idOf(source)} -->|"${caption}"| ${idOf(i)}`)
  })

  hops.forEach((hop, i) => {
    if (!hop.outbound) lines.push(`  ${idOf(i)}:::terminal`)
  })

  lines.push('  classDef terminal stroke-dasharray: 4 3')
  return lines.join('\n')
}

// Walk back to the last hop that actually emitted this contract. See DESIGN.md
// "Branch consumers must not break the chain".
function lastEmitterOf(hops, index, contractId) {
  for (let i = index - 1; i >= 0; i--) {
    if (hops[i].outbound === contractId) return i
  }
  for (let i = index - 1; i >= 0; i--) {
    if (hops[i].outbound) return i
  }
  return -1
}

function esc(text) {
  return String(text).replace(/"/g, "'").replace(/[<>]/g, '')
}

export function markdownDoc(map, name, journey) {
  const out = [`# ${name}`, '']
  if (journey.description) out.push(journey.description, '')
  out.push('```mermaid', mermaid(map, name, journey), '```', '')

  out.push('## Steps', '')
  for (const [i, hop] of (journey.hops ?? []).entries()) {
    out.push(`### ${i + 1}. ${hop.repo}`)
    out.push('')
    if (hop.note) out.push(hop.note, '')
    if (hop.reads) out.push(`- **reads** \`${hop.reads}\``)
    if (hop.writes) out.push(`- **writes** \`${hop.writes}\``)
    if (hop.inbound) out.push(`- **in** \`${hop.inbound}\``)
    if (hop.outbound) out.push(`- **out** \`${hop.outbound}\``)
    out.push('')

    const contract = hop.outbound ? map.contracts[hop.outbound] : null
    const fields = contractFields(contract)
    if (fields.length) {
      out.push('| field | type | note |', '| --- | --- | --- |')
      for (const f of fields) out.push(`| \`${f.name}\` | ${f.type ?? ''} | ${f.note ?? ''} |`)
      out.push('')
    }

    if (Array.isArray(hop.transform) && hop.transform.length) {
      out.push('What this hop does to the payload:', '')
      for (const op of hop.transform) out.push(`- ${describeOp(op)}`)
      out.push('')
    }
  }
  return out.join('\n')
}

export function describeOp(op) {
  switch (op?.op) {
    case 'add':
      return `adds \`${op.field}\`${op.type ? ` (${op.type})` : ''}${op.source ? ` from ${op.source}` : ''}`
    case 'derive':
      return `derives \`${op.field}\`${op.source ? ` from ${op.source}` : ''}`
    case 'rename':
      return `renames \`${op.from}\` to \`${op.to}\``
    case 'drop':
      return `drops \`${op.field}\``
    case 'pass':
      return `passes \`${op.field}\` through unchanged`
    default:
      return `unknown op \`${op?.op}\``
  }
}
