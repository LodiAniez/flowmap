import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { searchRepos, summarizeFiles } from './search.js'
import { contractFields, describeField } from './fields.js'
import { parseAnchor, resolveAnchor, statusLabel, OK } from './anchor.js'
import { UserError } from './config.js'

export function draftPath(root, name) {
  return join(root, 'drafts', `${name}.json`)
}

// flowmap does the deterministic half and hands the inferential half to whatever agent the
// developer is already running. See DESIGN.md "flowmap never calls a model" — putting an
// SDK in here would break zero-dependency, no-auth and offline in one move.
export function buildBrief(root, map, { name, from, repoIds, seeds, synced, max }) {
  // `flowmap draft <feature>` with no other flags has to be useful on its own, so the
  // feature name itself becomes the first search term. It is usually the right one: the
  // word a team uses for a feature is generally the word that appears in its routes,
  // topics and handlers.
  const seedTerms = dedupe(seeds.length ? seeds : [name, ...matchingContractIds(map, name)])
  const searches = seedTerms.map((needle) => ({
    needle,
    results: searchRepos(root, repoIds, needle, { max }),
  }))

  const relatedContracts = Object.entries(map.contracts).filter(([id, c]) => {
    // Fields are `{ name, type }` objects as often as strings, and joining them raw produced
    // "[object Object]" — so a seed naming a field could never match its contract.
    const hay = `${id} ${c.schema ?? ''} ${contractFields(c).map((f) => f.name).join(' ')}`.toLowerCase()
    return seedTerms.some((t) => hay.includes(t.toLowerCase())) || id.toLowerCase().includes(name.toLowerCase())
  })

  const out = []
  const w = (line = '') => out.push(line)

  w(`# Draft brief: journey "${name}"`)
  w()
  w('You are drafting a candidate cross-repo journey for flowmap. This brief is machine-')
  w('generated; the inference is yours. Write the result to the output file named at the')
  w('bottom, then stop — a human reviews it before it becomes a real journey.')
  w()

  w('## Entry point')
  w()
  w(from ? `\`${from}\`` : '_none given — infer the entry point from the searches below._')
  w()

  w('## Repos in scope')
  w()
  w('Local shallow checkouts of the default branch. Read them directly; do not clone anything.')
  w()
  for (const s of synced) {
    w(`- **${s.id}** — \`${s.dir}\` (${s.branch} @ ${s.sha.slice(0, 7)})`)
  }
  w()

  if (relatedContracts.length) {
    w('## Contracts already known')
    w()
    w('Reuse these ids where they apply. Do not silently invent a variant of one.')
    w()
    for (const [id, c] of relatedContracts) {
      const all = contractFields(c)
      const fields = all.slice(0, 8).map(describeField).join(', ')
      w(`- \`${id}\` (${c.kind ?? 'unknown kind'})${c.schema ? ` — schema: \`${c.schema}\`` : ''}`)
      if (fields) w(`  - fields: ${fields}${all.length > 8 ? ', …' : ''}`)
    }
    w()
  }

  w('## Search results')
  w()
  if (!seeds.length) {
    w(`_Searched for the feature name. Add \`--seed <topic-or-table-or-endpoint>\` if you`)
    w('already know an identifier this feature travels on — it is the strongest starting point._')
    w()
  }
  for (const { needle, results } of searches) {
    w(`### \`${needle}\``)
    w()
    let any = false
    for (const r of results) {
      if (!r.total) continue
      any = true
      w(`**${r.repo}** — ${r.total} hit${r.total === 1 ? '' : 's'}${r.truncated ? ` (showing ${r.hits.length})` : ''}`)
      for (const [path, count] of summarizeFiles(r)) {
        w(`- \`${path}\` (${count})`)
      }
      w()
    }
    if (!any) {
      w('_No hits in any scoped repo. That is itself a finding: either the term is wrong or')
      w('the hop crosses a boundary this search cannot see._')
      w()
    }
  }

  w('## What to produce')
  w()
  w('A JSON file matching this shape:')
  w()
  w('```json')
  w(JSON.stringify(exampleDraft(name, from), null, 2))
  w('```')
  w()

  w('## Rules')
  w()
  w('1. **Two anchors per hop.** `reads` (where data arrives) and `writes` (where it leaves)')
  w('   are usually different files. One anchor makes the next agent edit half the hop.')
  w('2. **Mark what you are unsure of; never drop it.** Set `"confidence": "low"` and explain')
  w('   in `uncertain`. A flagged guess is useful. A silent omission is the exact bug this')
  w('   tool exists to prevent.')
  w('3. **Do not invent contract ids silently.** Reuse the ids listed above where they fit.')
  w('   Anything genuinely new goes in `newContracts` so a human sees it as new.')
  w('4. **Anchors must be repo-relative paths that really exist**, in the form')
  w('   `path/to/file.ts::symbolName`. They are machine-checked in the next step, so a')
  w('   plausible-looking invented path will be caught — do not spend effort disguising a guess.')
  w('5. **A branch consumer is a real hop.** Fan-out is normal: if two services consume the')
  w('   same event, both are hops, and the second one has no outbound contract.')
  w('6. **Prefer too few hops to too many.** Scope is the half no machine can check, and')
  w('   over-inclusion is the known failure mode of generated journeys.')
  w('7. **Record `transform` from the code, not from the field names.** Open the file at the')
  w('   anchor and write down what it actually does to the payload: which fields it adds and')
  w('   from where, which it renames, which it drops. `flowmap visualize` replays exactly')
  w('   these ops, so an invented one produces a confidently wrong simulation. Omitting a')
  w('   hop\'s transforms is fine and is reported as untraced; inventing them is not.')
  w('8. **Give fields real types** where the code states them. `{ "name": "order.total",')
  w('   "type": "number" }` beats a bare string, and you are already reading the source.')
  w()

  w('## Then')
  w()
  w(`Write the file to \`drafts/${name}.json\` and verify your own anchors:`)
  w()
  w('```')
  w(`flowmap draft --check ${name}`)
  w('```')
  w()
  w('That resolves every anchor you proposed against the real checkouts. Fix anything it')
  w('reports — do not hand a human a draft with anchors you have not checked.')
  w()
  w('Then show them the journey and stop. Accepting it is their call, not yours:')
  w()
  w('```')
  w(`flowmap show ${name}      # readable rail view, anchors verified`)
  w(`flowmap accept ${name}    # <- the human runs this, after reviewing`)
  w('```')

  return out.join('\n') + '\n'
}

function exampleDraft(name, from) {
  return {
    name,
    draft: true,
    generatedFrom: from ?? null,
    hops: [
      {
        repo: '<repo-id>',
        inbound: '<contract-id or null for the first hop>',
        outbound: '<contract-id or null for a branch consumer>',
        reads: 'src/routes/example.ts::handlerName',
        writes: 'src/events/publish.ts::publishName',
        note: 'one short line: what this hop does to the data',
        transform: [
          { op: 'add', field: 'order.id', type: 'string', source: 'persist()', note: 'where the value comes from' },
          { op: 'rename', from: 'total', to: 'order.total' },
          { op: 'drop', field: 'cart_id' },
          { op: 'pass', field: 'currency' },
        ],
        confidence: 'high',
      },
    ],
    newContracts: [
      {
        id: '<new-contract-id>',
        kind: 'event',
        schema: 'path/to/schema/file',
        fields: [
          { name: 'order.id', type: 'string', note: 'uuid' },
          { name: 'order.total', type: 'number' },
        ],
      },
    ],
  }
}

function matchingContractIds(map, name) {
  const needle = name.toLowerCase()
  return Object.keys(map.contracts).filter((id) => id.toLowerCase().includes(needle))
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))]
}

export function writeBrief(root, name, content) {
  mkdirSync(join(root, 'drafts'), { recursive: true })
  const path = join(root, 'drafts', `${name}.brief.md`)
  writeFileSync(path, content)
  return path
}

// Anchors get machine-checked BEFORE a human reads the draft. An agent proposing anchors
// will invent plausible file paths; that failure is deterministic and free to catch, so no
// person should spend review attention on it. What survives to review is a journey whose
// anchors are known to resolve — leaving scope and altitude, which is where judgment belongs.
export function checkDraft(root, name) {
  const path = draftPath(root, name)
  if (!existsSync(path)) {
    throw new UserError(`no draft at ${path}\nRun \`flowmap draft ${name} --repos …\` first.`)
  }

  let draft
  try {
    draft = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${err.message}`)
  }

  const rows = []
  const hops = Array.isArray(draft.hops) ? draft.hops : []

  hops.forEach((hop, i) => {
    for (const side of ['reads', 'writes']) {
      const anchor = hop[side]
      if (anchor == null) {
        // A branch consumer legitimately has no outbound write.
        if (side === 'writes' && hop.outbound == null) continue
        rows.push({ hop: i + 1, repo: hop.repo ?? '?', side, anchor: '(missing)', status: 'absent' })
        continue
      }
      const res = resolveAnchor(root, hop.repo, anchor)
      rows.push({ hop: i + 1, repo: hop.repo ?? '?', side, anchor, status: res.status, line: res.line })
    }
  })

  return { path, draft, rows, hops: hops.length }
}

export { statusLabel, OK, parseAnchor }
