import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { searchRepos, summarizeFiles } from './search.js'
import { symbolsIn } from './outline.js'
import { draftPath } from './draft.js'
import { UserError, EXIT_USAGE } from './config.js'
import { toPortable } from './paths.js'

// `flowmap draft journey <x>` writes the draft file itself rather than only describing how
// to write one. Everything a machine can settle is settled here — which repos matched, which
// files, which symbols in them are anchorable — leaving the agent the part that actually
// needs reading comprehension: the order of the hops and what each one does to the payload.
//
// Keys prefixed with `_` are scaffolding notes for the agent. `finalize` strips them, so
// they never reach the committed map.
export function writeScaffold(root, map, { name, feature, repoIds, seeds, synced, force = false }) {
  const path = draftPath(root, name)
  if (existsSync(path) && !force) {
    throw new UserError(
      `${path} already exists.\n` +
        `  --force                        overwrite it\n` +
        `  flowmap show journey ${name}   look at what is there first`,
      EXIT_USAGE
    )
  }

  const terms = seeds.length ? seeds : [feature]
  const candidates = {}

  for (const term of terms) {
    for (const result of searchRepos(root, repoIds, term, { max: 200, ignoreCase: true })) {
      if (!result.total) continue
      const entry = (candidates[result.repo] ??= { matched: [], files: {} })
      if (!entry.matched.includes(term)) entry.matched.push(term)
      for (const [file, hits] of summarizeFiles(result, 6)) {
        entry.files[file] = (entry.files[file] ?? 0) + hits
      }
    }
  }

  const shortlist = {}
  for (const [repo, entry] of Object.entries(candidates)) {
    const files = Object.entries(entry.files)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([file, hits]) => ({
        path: file,
        hits,
        // Ready-made anchors: the agent picks one instead of inventing a symbol name.
        anchors: symbolsIn(root, repo, file, { max: 8 }).map((s) => `${file}::${s.symbol}`),
      }))
    shortlist[repo] = { matchedTerms: entry.matched, files }
  }

  const searchedRepos = repoIds.map((id) => {
    const s = synced.find((x) => x.id === id)
    return {
      repo: id,
      // Relative to flowmap.json: another engineer's cache is at the same relative spot.
      checkout: s?.dir ? toPortable(root, s.dir) : null,
      branch: s?.branch ?? null,
      sha: s?.sha?.slice(0, 7) ?? null,
    }
  })

  const draft = {
    name,
    draft: true,
    description: `TODO: one line describing what ${feature} does end to end`,
    hops: [],
    newContracts: [],
    // The payload that really arrives at hop 1, copied from a fixture or test rather than
    // invented. It seeds the simulator in `flowmap visualize`.
    sample: {},

    _instructions: [
      `Replace "hops" with the real journey for "${feature}".`,
      'Read the checkouts listed in _searched — paths are relative to this flowmap.json.',
      'Follow the data, not the imports.',
      'Every hop needs "reads" (where data arrives) and, unless it is a branch consumer,',
      '"writes" (where it leaves). Pick anchors from _candidates or verify your own.',
      'Record "transform" by reading the code at the anchor — never from the field names.',
      'Fill "sample" with a real entry payload copied from a fixture or test, and put real',
      'values on "add" ops via "value" — the simulator shows those instead of placeholders.',
      'An invented transform produces a confidently wrong simulation in `flowmap visualize`.',
      'Omitting transforms is fine and shows as untraced; making them up is not.',
      'Mark anything you could not confirm with "confidence": "low" and an "uncertain" note.',
      'Prefer too few hops to too many. Delete these _ keys or leave them; finalize strips them.',
      `Then: flowmap draft --check ${name}`,
    ],

    _searched: searchedRepos,
    _candidates: shortlist,

    _hopTemplate: {
      repo: '<repo id from _searched>',
      inbound: '<contract id, or null on the first hop>',
      outbound: '<contract id, or null for a branch consumer>',
      reads: '<path/to/file.ts::symbol>',
      writes: '<path/to/file.ts::symbol>',
      note: 'one short line: what this hop does to the data',
      transform: [
        { op: 'add', field: 'order.id', type: 'string', source: 'persist()', value: 'ord_1a2b' },
        { op: 'rename', from: 'total', to: 'order.total' },
        { op: 'drop', field: 'cart_id' },
        { op: 'pass', field: 'currency' },
      ],
      confidence: 'high',
    },

    _contractTemplate: {
      id: '<contract id, e.g. event.order.created>',
      kind: 'event',
      schema: '<path to its authoritative schema>',
      fields: [{ name: 'order.total', type: 'number', note: 'optional' }],
    },
  }

  mkdirSync(join(root, 'drafts'), { recursive: true })
  writeFileSync(path, JSON.stringify(draft, null, 2) + '\n')

  const repoCount = Object.keys(shortlist).length
  const fileCount = Object.values(shortlist).reduce((n, r) => n + r.files.length, 0)
  const anchorCount = Object.values(shortlist).reduce(
    (n, r) => n + r.files.reduce((m, f) => m + f.anchors.length, 0),
    0
  )
  return { path, repoCount, fileCount, anchorCount, shortlist }
}

// `_`-prefixed keys are agent scaffolding and must never reach flowmap.json.
export function stripScaffolding(value) {
  if (Array.isArray(value)) return value.map(stripScaffolding)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripScaffolding(v)])
    )
  }
  return value
}
