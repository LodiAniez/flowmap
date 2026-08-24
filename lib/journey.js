import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { resolveAnchor, statusLabel, OK } from './anchor.js'
import { draftPath } from './draft.js'
import { stripScaffolding } from './scaffold.js'
import { contractFields, describeField } from './fields.js'
import { describeOp } from './diagram.js'
import { UserError, saveMap } from './config.js'
import { bold, dim, green, yellow, red, cyan } from './output.js'

// Reviewing raw JSON is the step where a human silently stops reading. The rail metaphor
// from DESIGN.md — stops are repos, segments are contracts — is what the reviewer is
// actually being asked to judge, so render that rather than the file.
export function renderJourney(root, map, name, journey, { resolve = true } = {}) {
  const out = []
  const w = (line = '') => out.push(line)
  const hops = journey.hops ?? []

  w(`${bold(name)}${journey.draft ? yellow('  [draft — not yet in flowmap.json]') : ''}`)
  if (journey.description) w(dim(`  ${journey.description}`))
  w(dim(`  ${hops.length} hop${hops.length === 1 ? '' : 's'}`))
  w()

  hops.forEach((hop, i) => {
    const flag = hop.confidence === 'low' ? yellow('  ● unsure') : ''
    w(`  ${bold(String(i + 1).padStart(2))}  ${bold(hop.repo ?? '?')}${flag}`)

    for (const side of ['reads', 'writes']) {
      const anchor = hop[side]
      if (!anchor) continue
      const res = resolve ? resolveAnchor(root, hop.repo, anchor) : null
      const where = res?.line ? dim(`:${res.line}`) : ''
      const mark = !res ? ' ' : res.status === OK ? green('✓') : red('✗')
      w(`      ${mark} ${dim(side.padEnd(6))} ${anchor}${where}`)
      if (res && res.status !== OK) w(`        ${red(statusLabel(res.status))}`)
    }

    if (hop.note) w(`        ${dim(hop.note)}`)
    for (const op of hop.transform ?? []) {
      w(`        ${dim('·')} ${dim(describeOp(op).replace(/`/g, ''))}`)
    }
    if (hop.uncertain) w(`        ${yellow(`unsure: ${hop.uncertain}`)}`)

    if (hop.outbound) {
      const contract = map.contracts[hop.outbound] ?? findNewContract(journey, hop.outbound)
      const named = contractFields(contract).slice(0, 6).map(describeField)
      const fields = named.length ? dim(`  (${named.join(', ')})`) : ''
      const unknown = contract ? '' : red('  ← not defined anywhere')
      w(dim('        │'))
      w(`        ${dim('└─')} ${cyan(hop.outbound)}${fields}${unknown}`)
      w(dim('        ▼'))
    } else if (i < hops.length - 1) {
      // A hop with no outbound is a branch consumer; the chain continues from an earlier one.
      w(dim('        ┊  (branch consumer — chain continues from an earlier hop)'))
    }
  })

  return out.join('\n')
}

function findNewContract(journey, id) {
  return (journey.newContracts ?? []).find((c) => c.id === id)
}

export function loadDraft(root, name) {
  const path = draftPath(root, name)
  if (!existsSync(path)) {
    throw new UserError(
      `no draft named "${name}" at ${path}\n` + `Generate one with:  flowmap draft ${name}`
    )
  }
  try {
    return { path, draft: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${err.message}`)
  }
}

// Merging a reviewed draft into flowmap.json is the step that was missing, and doing it by
// hand is where the whole flow stopped being worth using.
export function acceptDraft(root, map, mapPath, name, { force = false, keepDraft = false } = {}) {
  const { path, draft } = loadDraft(root, name)
  const hops = draft.hops ?? []
  if (!hops.length) throw new UserError(`draft "${name}" has no hops`)

  const broken = []
  for (const [i, hop] of hops.entries()) {
    for (const side of ['reads', 'writes']) {
      if (!hop[side]) continue
      const res = resolveAnchor(root, hop.repo, hop[side])
      if (res.status !== OK) broken.push({ hop: i + 1, side, anchor: hop[side], status: res.status })
    }
  }

  // Declining to write anchors that do not resolve is data integrity, not gating: nothing
  // about a build or a merge is affected. --force exists for the case where the reviewer
  // knows better than the resolver.
  if (broken.length && !force) {
    const lines = broken.map((b) => `  hop ${b.hop} ${b.side}  ${b.anchor} — ${statusLabel(b.status)}`)
    throw new UserError(
      `${broken.length} anchor(s) in "${name}" do not resolve:\n${lines.join('\n')}\n\n` +
        `Fix the draft, or accept anyway with --force.`
    )
  }

  const newContracts = draft.newContracts ?? []
  const added = []
  for (const contract of newContracts) {
    if (!contract?.id || contract.id.startsWith('<')) continue // untouched template row
    if (!map.contracts[contract.id]) {
      const { id, ...rest } = contract
      map.contracts[id] = rest
      added.push(id)
    }
  }

  const missingContracts = []
  for (const hop of hops) {
    for (const id of [hop.inbound, hop.outbound]) {
      if (id && !map.contracts[id]) missingContracts.push(id)
    }
  }

  const unsure = hops.filter((h) => h.confidence === 'low')
  const replaced = Boolean(map.journeys[name])

  map.journeys[name] = stripScaffolding({
    ...(draft.description ? { description: draft.description } : {}),
    // A recorded entry payload is evidence read out of the codebase, so it survives the
    // strip alongside hops and transforms — unlike confidence, which the reviewer resolves.
    ...(draft.sample && Object.keys(draft.sample).length ? { sample: draft.sample } : {}),
    hops: hops.map(cleanHop),
  })
  saveMap(mapPath, map)

  // The brief is drafting scaffolding, spent once the journey is accepted. Leaving it makes
  // drafts/ look like it still holds unfinished work, which is the opposite of true.
  const briefPath = path.replace(/\.json$/, '.brief.md')
  const hadBrief = existsSync(briefPath) // record before deleting, or we cannot report it
  if (!keepDraft) {
    unlinkSync(path)
    if (hadBrief) unlinkSync(briefPath)
  }

  return {
    hops: hops.length,
    added,
    missingContracts: [...new Set(missingContracts)],
    unsure: unsure.length,
    broken: broken.length,
    replaced,
    draftPath: path,
    briefPath: hadBrief ? briefPath : null,
    draftRemoved: !keepDraft,
  }
}

// Draft-only bookkeeping does not belong in the committed map: `confidence` and `uncertain`
// record how sure the *agent* was, and a human has now answered that question by accepting.
function cleanHop(hop) {
  const { confidence, uncertain, ...rest } = hop
  return rest
}
