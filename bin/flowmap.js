#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { parseArgs, list, BOOLEAN_FLAGS } from '../lib/args.js'
import { loadMap, findMapPath, resolveRepoIds, UserError, EXIT_OK, EXIT_ERROR, EXIT_USAGE } from '../lib/config.js'
import { syncMany, isSynced } from '../lib/sync.js'
import { searchRepos } from '../lib/search.js'
import { buildBrief, writeBrief, checkDraft, statusLabel, OK } from '../lib/draft.js'
import {
  initMap, addRepo, removeRepo, normalizeSource, describeLocalRepo, originUrlOf, hideCacheFromGit,
} from '../lib/registry.js'
import { resolveDefaultBranch, isRemoteUrl, HOW_LABEL } from '../lib/branch.js'
import { renderJourney, acceptDraft, loadDraft } from '../lib/journey.js'
import { mermaid, markdownDoc } from '../lib/diagram.js'
import { journey as resolveJourney, impact as resolveImpact, journeyRow, impactRow } from '../lib/graph.js'
import { verify as runVerify, verifyRow, contractRows } from '../lib/verify.js'
import { writeScaffold } from '../lib/scaffold.js'
import { discover, repoRoot } from '../lib/discover.js'
import { serve } from '../lib/server.js'
import { display, fromPortable } from '../lib/paths.js'
import { bold, dim, red, green, yellow, cyan, tsv, isAgentFormat } from '../lib/output.js'

const USAGE = `flowmap — cross-repo data-flow context reference

  flowmap journey <feature>           the ordered hops, for an agent to read
  flowmap impact <field>              every hop carrying a field
  flowmap draft journey <feature>     map a feature across repos into a draft
  flowmap show journey <feature>      diagram it, with payload fields and types
  flowmap finalize journey <feature>  accept a reviewed draft into flowmap.json
  flowmap verify [<feature>]          re-check every anchor against default branches
  flowmap visualize                   interactive UI, with payload simulation

Setup
  flowmap init                        create flowmap.json, registering this repo
  flowmap repo add [<id> <src>]       register a repo (no args = the one you're in)
  flowmap repo list | remove <id>

Also
  flowmap search <string>             find a contract identifier across repos
  flowmap sync                        refresh local checkouts

Options
  --repos a,b,c    narrow scope         --seed <term>    extra search term (repeatable)
  --all            sweep a big registry --from <anchor>  entry point for a draft
  --refresh        re-fetch checkouts   --out <path>     write output elsewhere
  --format=agent   tab-separated output --port <n>       visualize port (default 7777)

flowmap is advisory. It never fails a build, blocks a merge, or votes on a PR:
findings always exit 0. See DESIGN.md.`

const PLANNED = {}

function help() {
  process.stdout.write(USAGE + '\n')
}

// A narrowed checkout has two causes with two different fixes; blaming the network for a
// flag the user passed sends them looking in the wrong place.
// The headline for a checkout that needs reporting. A stale origin is not a partial checkout:
// the tree is complete, it is simply a different repository's.
function narrowedHeadline(r, what) {
  return r.staleOrigin
    ? `warning: ${r.id} is a checkout of a different repository — ${what}\n`
    : `warning: ${r.id} is a partial checkout — ${what}\n`
}

function narrowedHint(r) {
  if (r.staleOrigin) {
    return dim('  its registered url changed and --no-sync declined the re-fetch; these are the\n') +
      dim('  previous repository\'s files. Drop the flag to pick up the new one.\n')
  }
  return r.narrowedReason === 'declined'
    ? dim('  --no-sync declined to fetch the rest of it; drop the flag to search it all\n')
    : dim('  flowmap could not fetch the rest of it; retry when origin is reachable\n')
}

// A checkout left narrow because this caller had no reason to widen it is not a problem to
// report — the cone already covers what it is about to read.
const worthWarning = (r) => (r.narrowed && r.narrowedReason !== 'by-design') || r.staleOrigin

// Which registry entry the checkout we are standing in corresponds to. Matched on the repo's
// origin url or its path first, falling back to the directory name — `repo add billing
// ../billing-service` registers `billing` under a directory called `billing-service`.
function localRepoId(map) {
  const here = repoRoot()
  if (!here) return null

  const origin = originUrlOf(here)
  for (const [id, entry] of Object.entries(map.repos ?? {})) {
    if (!entry?.url) continue
    if (origin && entry.url === origin) return id
    if (!isRemoteUrl(entry.url) && fromPortable(dirname(findMapPath()), entry.url) === here) return id
  }

  const name = basename(here)
  return Object.hasOwn(map.repos ?? {}, name) ? name : null
}

function scopeFor(map, flags, purpose) {
  requireValues(flags, ['repos', 'seed', 'max', 'out'])
  requireSingle(flags, ['max', 'out'])
  return resolveRepoIds(map, list(flags.repos), { all: flags.all === true, purpose })
}

// A scope flag given without a value parses as `true` (bare) or `''` (with `=`), and list()
// turns both into an empty array — so the run silently widens to everything while the caller
// believes it is scoped. This has to guard every command, not just the one it was found on.
function requireValues(flags, names) {
  for (const name of names) {
    const given = flags[name]
    if (given === undefined) continue
    if (given === true || list(given).length === 0) {
      throw new UserError(`--${name} needs a value`, EXIT_USAGE)
    }
  }
}

// A flag repeated where only one value makes sense arrives as an array, which then fails a
// `typeof === 'string'` test and silently falls back to a default the caller did not ask for.
function requireSingle(flags, names) {
  for (const name of names) {
    if (Array.isArray(flags[name])) {
      throw new UserError(`--${name} was given more than once`, EXIT_USAGE)
    }
  }
}

// A boolean written `--force=` is an unset variable, not "on". Silently reading it as on would
// force-accept a draft whose anchors do not resolve.
function rejectEmptyBooleans(flags) {
  for (const [name, value] of Object.entries(flags)) {
    // Booleans only: a value flag written `--repos=` gets the clearer "needs a value" from
    // requireValues, which knows what that flag is for.
    if (BOOLEAN_FLAGS.has(name) && value === '') {
      throw new UserError(`--${name} was given an empty value`, EXIT_USAGE)
    }
  }
}

function ensureSynced(root, map, ids, flags, mode = 'full', { widen = false } = {}) {
  let offline = false
  let blockedByFlag = false
  const missing = ids.filter((id) => !isSynced(root, id))
  if (flags['no-sync'] === true) {
    if (missing.length) {
      throw new UserError(`not synced: ${missing.join(', ')}\nDrop --no-sync or run \`flowmap sync\`.`)
    }
    // Widening a blobless sparse clone has to fetch, which --no-sync promised not to do — and
    // so does re-fetching after a changed origin url. Keep the caller's intent separate, so a
    // caller that never wanted to widen is not told the flag stopped it.
    offline = true
    if (widen) blockedByFlag = true
    widen = false
  }
  if (missing.length) {
    process.stderr.write(dim(`syncing ${missing.length} repo(s): ${missing.join(', ')}\n`))
  }
  return syncMany(root, map, ids, {
    mode,
    widen,
    offline,
    blockedByFlag,
    refresh: !offline && flags.refresh === true,
  })
}

// Anchors can only be resolved against real checkouts, so any command that resolves them
// pulls what the journey needs first — and only what it needs.
function syncForJourney(root, map, journey, flags, { widen = true } = {}) {
  // A hand-edited draft can carry anything here; checkDraft guards the same way, and this runs
  // before it now.
  const hops = Array.isArray(journey?.hops) ? journey.hops : []
  const ids = [...new Set(hops.map((h) => h?.repo).filter((id) => id && map.repos[id]))]
  if (!ids.length) return []
  // Widen: verify's cone is built from the journeys already in the map, so it cannot contain
  // a draft's anchors. Resolving them against a checkout verify narrowed reports files that
  // exist as missing, and finalize then refuses the draft with nothing explaining why.
  // Always 'full': a fresh clone needs the whole tree, because nothing here knows a cone.
  // `widen` alone decides whether an existing sparse checkout is opened up — passing 'sparse'
  // without paths clones with --sparse and never sets a cone, so the checkout holds only the
  // repo root and every anchor resolves as missing.
  const synced = ensureSynced(root, map, ids, flags, 'full', { widen })
  for (const r of synced.filter(worthWarning)) {
    process.stderr.write(
      yellow(narrowedHeadline(r, 'anchors there may report as missing')) + narrowedHint(r)
    )
  }
  return synced
}

// ---------------------------------------------------------------- draft journey

// Running `draft journey` inside a repo should need no setup at all: that repo is the start
// of the journey, its neighbours are the candidates, and a local grep decides which of them
// the feature actually touches. Registration is a consequence of discovery, not a prerequisite.
function autoSetup(feature, flags) {
  const here = repoRoot()
  if (!here) return null

  // findMapPath honours FLOWMAP_FILE without checking the file is there, so existence is
  // what decides whether to bootstrap — not whether a path could be produced.
  let mapPath = null
  try {
    const found = findMapPath()
    if (existsSync(found)) mapPath = found
  } catch {
    /* nothing above us */
  }
  if (!mapPath) {
    const { path } = initMap(here, {})
    process.stdout.write(`${green('created')} ${path}\n`)
    mapPath = path
    if (hideCacheFromGit(dirname(path))) {
      process.stdout.write(dim(`  .flowmap-cache/ excluded locally via .git/info/exclude\n`))
    }
  }

  const { map, path, root } = loadMap()
  const registryEmpty = !Object.keys(map.repos).length
  if (!registryEmpty && flags.discover !== true) return { map, path, root }

  const terms = list(flags.seed).length ? list(flags.seed) : [feature]
  process.stderr.write(dim(`scanning repos beside ${here.split('/').pop()} for ${terms.join(', ')}…\n`))

  const found = discover({ start: here, terms })

  for (const repo of found.matched) {
    if (map.repos[repo.id]) continue
    const origin = originUrlOf(repo.path)
    // Registration gets the authoritative branch — only a few repos, so one round trip each.
    const { branch } = resolveDefaultBranch(repo.path)
    addRepo(map, path, {
      id: repo.id,
      url: origin ?? repo.path,
      branch: branch ?? repo.branch ?? undefined,
    })
  }

  const hits = found.matched.map((r) => `${r.id}${r.id === found.startId ? ' (start)' : ` ${r.hits}`}`)
  process.stdout.write(
    `${green('discovered')} ${dim(`${found.matched.length} of ${found.scanned} repos: `)}${hits.join(dim(', '))}\n`
  )

  // A feature living only on an unmerged branch is invisible to a map of default branches.
  // Reporting zero here without saying why would be the confidently-wrong answer.
  if (found.headOnly.length) {
    process.stdout.write(
      `  ${yellow('not on their default branch, only on the branch checked out locally:')}\n`
    )
    for (const r of found.headOnly) {
      process.stdout.write(dim(`    ${r.id}  ${r.headHits} hit(s) on ${r.head}\n`))
    }
    process.stdout.write(
      dim(`  flowmap maps merged code. To include one anyway:\n`) +
        dim(`    flowmap repo add <id> <path> --branch <branch> --force\n`)
    )
  }

  return loadMap()
}

function draftJourney(feature, flags) {
  if (!feature) throw new UserError('usage: flowmap draft journey <feature>', EXIT_USAGE)
  // Before autoSetup: it creates flowmap.json, edits .git/info/exclude, runs discovery and
  // makes a network round trip per repo. Aborting after all that is a bad way to reject an
  // argument we could have rejected immediately.
  requireValues(flags, ['repos', 'seed', 'from', 'max'])
  requireSingle(flags, ['out', 'from', 'max'])

  const ctx = autoSetup(feature, flags) ?? loadMap()
  const { map, root } = ctx

  const ids = scopeFor(map, flags, 'drafting')
  const synced = ensureSynced(root, map, ids, flags, 'full', { widen: true })
  const seeds = list(flags.seed)

  // The draft file is the deliverable, not the brief. Everything deterministic is resolved
  // and written here; the agent opens the file and fills in the part that needs reading.
  const scaffold = writeScaffold(root, map, {
    name: feature,
    feature,
    repoIds: ids,
    seeds,
    synced,
    force: flags.force === true,
  })

  for (const r of synced.filter(worthWarning)) {
    process.stderr.write(yellow(narrowedHeadline(r, 'candidates may be incomplete')) + narrowedHint(r))
  }

  const brief = buildBrief(root, map, {
    name: feature,
    from: typeof flags.from === 'string' ? flags.from : null,
    repoIds: ids,
    seeds,
    synced,
    max: Number(flags.max) > 0 ? Number(flags.max) : 20,
  })
  const briefPath = writeBrief(root, feature, brief)

  if (flags.brief === true) {
    process.stdout.write(brief)
    return
  }

  process.stdout.write(`${green('drafted')} ${bold(feature)} ${dim(`-> ${display(root, scaffold.path)}`)}\n\n`)

  if (!scaffold.repoCount) {
    process.stdout.write(
      `  ${yellow('no repo matched')} ${bold(seeds.length ? seeds.join(', ') : feature)}\n` +
        dim('  That is itself a finding. Try the contract identifier rather than the feature\n') +
        dim('  name — a topic, table or endpoint: --seed order.created\n')
    )
  } else {
    process.stdout.write(
      dim(`  ${scaffold.repoCount} repo(s), ${scaffold.fileCount} candidate file(s), `) +
        dim(`${scaffold.anchorCount} anchor(s) ready to use\n\n`)
    )
    for (const [repo, entry] of Object.entries(scaffold.shortlist)) {
      process.stdout.write(`  ${bold(repo)}\n`)
      for (const f of entry.files.slice(0, 3)) {
        const anchors = f.anchors.length ? dim(`  ${f.anchors.length} symbol(s)`) : dim('  no symbols found')
        process.stdout.write(`    ${cyan(f.path)}${anchors}\n`)
      }
    }
  }

  process.stdout.write(dim(`\n  the file lists candidate anchors per repo; fill in "hops"\n`))
  process.stdout.write(dim(`  longer brief: ${display(root, briefPath)}\n\n`))
  process.stdout.write(`  ${dim('then')}  flowmap draft --check ${feature}\n`)
}

function checkJourney(feature, flags) {
  const { map, root } = loadMap()

  // Same reason show and finalize widen: verify's cone is built from the journeys already in
  // the map, so it cannot contain a draft's anchors. Resolving them against a narrowed
  // checkout reports files that exist as missing.
  const { draft } = loadDraft(root, feature)
  syncForJourney(root, map, draft, flags)

  const { rows, path, hops } = checkDraft(root, feature)

  if (isAgentFormat(flags)) {
    process.stdout.write(tsv(rows.map((r) => [r.hop, r.repo, r.side, r.anchor, r.status, r.line ?? ''])) + '\n')
    return
  }

  process.stdout.write(`${bold(display(root, path))} ${dim(`— ${hops} hop(s)`)}\n\n`)
  for (const r of rows) {
    const ok = r.status === OK
    const where = r.line ? dim(`:${r.line}`) : ''
    process.stdout.write(
      `  ${ok ? green('ok  ') : red('BAD ')} hop ${r.hop} ${dim(r.side.padEnd(6))} ${r.repo}  ${r.anchor}${where}\n`
    )
    if (!ok) process.stdout.write(`       ${yellow(statusLabel(r.status))}\n`)
  }

  const bad = rows.filter((r) => r.status !== OK).length
  process.stdout.write('\n')
  process.stdout.write(
    bad
      ? `${yellow(`${bad} of ${rows.length} anchors did not resolve.`)}\n`
      : `${green(`all ${rows.length} anchors resolve.`)}\n`
  )
  // Findings never exit non-zero. See DESIGN.md "Advisory only. Never a gate."
}

// ---------------------------------------------------------------- show journey

function showJourney(feature, flags) {
  if (!feature) throw new UserError('usage: flowmap show journey <feature>', EXIT_USAGE)
  const { map, root } = loadMap()
  // hasOwn, not bracket access: `journeys.constructor` is inherited, and `show journey
  // constructor` otherwise printed an empty journey and wrote a diagram file for it.
  requireValues(flags, ['out'])
  requireSingle(flags, ['out'])
  const accepted = Object.hasOwn(map.journeys, feature) ? map.journeys[feature] : undefined
  const journey = accepted ?? loadDraft(root, feature).draft
  // Only a draft needs widening: verify's cone is built from the accepted journeys, so it
  // already covers this one's anchors. Widening anyway would disable sparse on every hop repo
  // for a read-only command.
  syncForJourney(root, map, journey, flags, { widen: !accepted })

  if (flags.mermaid === true) {
    process.stdout.write(mermaid(map, feature, journey) + '\n')
    return
  }

  process.stdout.write(renderJourney(root, map, feature, journey) + '\n')

  // The terminal view is for reading now; the file is for sharing in a PR.
  const dir = join(root, 'diagrams')
  mkdirSync(dir, { recursive: true })
  const out = typeof flags.out === 'string' ? flags.out : join(dir, `${feature}.md`)
  writeFileSync(out, markdownDoc(map, feature, journey))
  process.stdout.write(dim(`\n  diagram written to ${display(root, out)}\n`))
  process.stdout.write(dim(`  renders as mermaid on GitHub; --mermaid prints just the graph\n`))
}

// ---------------------------------------------------------------- finalize journey

function finalizeJourney(feature, flags) {
  if (!feature) throw new UserError('usage: flowmap finalize journey <feature>', EXIT_USAGE)
  const { map, path, root } = loadMap()
  syncForJourney(root, map, loadDraft(root, feature).draft, flags)

  const r = acceptDraft(root, map, path, feature, {
    force: flags.force === true,
    keepDraft: flags['keep-draft'] === true,
  })

  process.stdout.write(
    `${green(r.replaced ? 'updated' : 'finalized')} ${bold(feature)} ${dim(`— ${r.hops} hops -> ${display(root, path)}`)}\n`
  )
  if (r.added.length) process.stdout.write(dim(`  added contracts: ${r.added.join(', ')}\n`))
  if (r.draftRemoved) {
    const removed = [display(root, r.draftPath)]
    if (r.briefPath) removed.push(display(root, r.briefPath))
    process.stdout.write(dim(`  removed ${removed.join(', ')}\n`))
  }
  if (r.broken) {
    process.stdout.write(`  ${yellow(`${r.broken} anchor(s) accepted despite not resolving (--force)`)}\n`)
  }
  if (r.missingContracts.length) {
    process.stdout.write(`  ${yellow(`contracts referenced but not defined: ${r.missingContracts.join(', ')}`)}\n`)
  }
  if (r.unsure) {
    process.stdout.write(dim(`  ${r.unsure} hop(s) were marked unsure by the drafter — worth a second look\n`))
  }
  process.stdout.write(dim(`\n  flowmap show journey ${feature}\n`))
}

// ---------------------------------------------------------------- journey / impact
//
// These are the cheap read paths, and the reason the project exists: an agent asks where a
// feature goes and gets a few hundred tokens instead of sweeping the repos. They read
// flowmap.json and nothing else — no sync, no network, no checkouts. Keeping them offline
// is what makes them worth calling reflexively.

function journeyCmd(args, flags) {
  const name = args[0]
  const { map } = loadMap()

  if (!name) {
    const names = Object.keys(map.journeys)
    if (!names.length) throw new UserError('no journeys yet — flowmap draft journey <feature>', EXIT_USAGE)
    process.stdout.write(names.join('\n') + '\n')
    return
  }

  const j = Object.hasOwn(map.journeys, name) ? resolveJourney(map, name) : null
  if (!j) {
    throw new UserError(
      `no journey "${name}"\nknown: ${Object.keys(map.journeys).join(', ') || '(none)'}`,
      EXIT_USAGE
    )
  }

  if (isAgentFormat(flags)) {
    process.stdout.write(tsv(j.hops.map(journeyRow)) + '\n')
    return
  }

  process.stdout.write(`${bold(j.name)}${j.description ? dim(` — ${j.description}`) : ''}\n\n`)
  for (const hop of j.hops) {
    const flag = hop.status === 'ok' ? '' : yellow(`  [${hop.status}]`)
    process.stdout.write(`  ${bold(String(hop.index).padStart(2))}  ${bold(hop.repo)}${flag}\n`)
    if (hop.inbound) process.stdout.write(dim(`      in   ${hop.inbound}\n`))
    if (hop.reads) process.stdout.write(`      ${dim('reads ')}${cyan(hop.reads)}\n`)
    if (hop.writes) process.stdout.write(`      ${dim('writes')} ${cyan(hop.writes)}\n`)
    if (hop.outbound) process.stdout.write(dim(`      out  ${hop.outbound}\n`))
    if (hop.branchConsumer) process.stdout.write(dim(`      (branch consumer — emits nothing)\n`))
  }
  process.stdout.write(dim(`\n  ${j.hops.length} hops. --format=agent for tab-separated output.\n`))
}

function impactCmd(args, flags) {
  const query = args[0]
  if (!query) throw new UserError('usage: flowmap impact <field>', EXIT_USAGE)

  const { map } = loadMap()
  const result = resolveImpact(map, query)

  if (isAgentFormat(flags)) {
    if (result.rows.length) process.stdout.write(tsv(result.rows.map(impactRow)) + '\n')
    return
  }

  if (!result.contracts.length) {
    process.stdout.write(
      `${yellow('no contract carries a field matching')} ${bold(query)}\n\n` +
        dim('Matching is substring over field paths. Try a shorter fragment, or check\n') +
        dim('`flowmap journey <name>` to see which contracts exist.\n')
    )
    return
  }

  process.stdout.write(`${bold(query)} ${dim(`— ${result.rows.length} hop(s) across ${new Set(result.rows.map(r => r.journey)).size} journey(s)`)}\n\n`)
  for (const c of result.contracts) {
    process.stdout.write(`  ${cyan(c.id)} ${dim(c.matched.map((f) => (f.type ? `${f.name}: ${f.type}` : f.name)).join(', '))}\n`)
  }
  process.stdout.write('\n')
  for (const r of result.rows) {
    const flag = r.status === 'ok' ? '' : yellow(` [${r.status}]`)
    const anchor = r.side === 'in' ? r.reads : r.writes ?? r.reads
    process.stdout.write(`  ${dim(`${r.journey} hop ${r.hop}`)}  ${bold(r.repo)}${flag}\n`)
    if (anchor) process.stdout.write(`      ${cyan(anchor)}\n`)
  }
}

// ---------------------------------------------------------------- verify

function verifyCmd(args, flags) {
  const { map, path, root } = loadMap()

  // `flowmap verify <feature>` is the obvious spelling, so accept it rather than silently
  // verifying everything and letting the caller believe they scoped it.
  if (!Object.keys(map.journeys).length) {
    throw new UserError(`no journeys in ${display(root, path)} yet — flowmap draft journey <feature>`)
  }
  // Strip the noun only when it is not itself a journey name — otherwise a feature called
  // "journey" silently verifies everything while looking scoped.
  const named = args.filter((a) => !NOUNS.has(a) || Object.hasOwn(map.journeys, a))

  // Validate every spelling, positional and flag alike. An unrecognised name would otherwise
  // resolve to zero anchors and print "every anchor resolves" — a clean bill of health for
  // nothing checked, which is worse than an error.
  // Deduped: a repeated name (`verify flow --journey flow`) would push each anchor twice,
  // inflating the scoped count past the full one so `covers()` wrongly reports full coverage.
  const requested = [...new Set([...named, ...list(flags.journey)])]
  for (const name of requested) {
    // hasOwn, not truthiness: `journeys.constructor` is inherited and would pass.
    if (!Object.hasOwn(map.journeys, name)) {
      throw new UserError(
        `no journey "${name}"\nknown: ${Object.keys(map.journeys).join(', ') || '(none)'}`,
        EXIT_USAGE
      )
    }
  }

  // --local is the PR-time scope: only this repo's anchors, which are the only ones the
  // author could have broken. See DESIGN.md "Split checks by who can act on them".
  for (const flag of ['journey', 'repos']) {
    // `--journey` with no value parses as `true`, list() yields [], and the run silently
    // widens to everything — the precise "the caller believes they scoped it" failure the
    // name validation below exists to prevent.
    // `--journey` bare parses as true; `--journey=` parses as an empty string. Both would
    // otherwise widen the run to everything while the caller believes it is scoped.
    const given = flags[flag]
    if (given === true || (given !== undefined && list(given).length === 0)) {
      throw new UserError(`--${flag} needs a value`, EXIT_USAGE)
    }
  }

  let repoIds = list(flags.repos)
  if (flags.local === true) {
    const id = localRepoId(map)
    if (!id) throw new UserError('--local needs to run inside a registered repo', EXIT_USAGE)
    repoIds = [id]
  }

  // Route repo ids through the same validation the rest of the CLI uses, so a typo errors
  // instead of quietly narrowing the scope to nothing.
  if (repoIds.length) resolveRepoIds(map, repoIds, { all: true, purpose: 'verify' })

  const result = runVerify(root, map, path, {
    repoIds: repoIds.length ? repoIds : null,
    journeys: requested.length ? requested : null,
    // The repo we are standing in, so the unused report cannot advise removing the one
    // `--local` depends on. Resolved by matching the registry, not by assuming the id equals
    // the directory name — `repo add billing ../billing-service` breaks that assumption.
    self: localRepoId(map),
  })

  // Built before the early return: an agent run that checked nothing still has to say so, and
  // returning ahead of this branch wrote nothing at all to stdout.
  const skippedRows = () =>
    contractRows([
      ...(result.contractsStranded ?? []).map((id) => ({ id, status: 'repo-unreachable', missing: [] })),
      ...(result.contractsOutOfScope ?? []).map((id) => ({ id, status: 'out-of-scope', missing: [] })),
      ...(result.contractsUnregistered ?? []).map((id) => ({ id, status: 'repo-unregistered', missing: [] })),
      ...(result.contractsPartial ?? []).map((id) => ({ id, status: 'checkout-incomplete', missing: [] })),
    ])

  if (!result.checked) {
    if (isAgentFormat(flags)) {
      const rows = skippedRows()
      if (rows.length) process.stdout.write(tsv(rows) + '\n')
    }
    // Report what went wrong first: a repo that failed to clone is a hard failure, and
    // returning early with "nothing to verify" would present it as an empty-but-fine map.
    for (const r of result.repos.filter((x) => x.error)) {
      process.stderr.write(`  ${red('!')} ${bold(r.id)}  ${yellow(r.error)}\n`)
    }
    // Never a non-zero exit: --local is documented as the PR-time scope, and a repo that is
    // registered but not yet in a journey is an ordinary state, not a usage error. See
    // DESIGN.md "Advisory only. Never a gate."
    process.stderr.write(
      yellow(
        repoIds.length
          ? `nothing to verify — no anchored hop in repo(s) ${repoIds.join(', ')}\n`
          : requested.length
            ? `nothing to verify — ${requested.join(', ')} has no anchored hops\n`
            : `nothing to verify — no journey in the map has a reads or writes anchor\n`
      ) + dim('  reporting this rather than a clean result, which would mean nothing was checked\n')
    )
    // The contracts those hops carry are the only thing this run has to say; returning without
    // them reports a clean-ish nothing over checks that never happened.
    for (const [ids, why] of [
      [result.contractsPartial, "their repo's checkout came up incomplete"],
      [result.contractsStranded, 'their repo failed to sync'],
      [result.contractsUnregistered, 'their repo is not in the registry'],
      [result.contractsOutOfScope, 'they are outside this run\'s scope'],
    ]) {
      if (ids?.length) {
        process.stderr.write(dim(`  ${ids.length} contract(s) not checked: ${why}\n`))
      }
    }
    return
  }

  if (isAgentFormat(flags)) {
    // Only the problems: a clean anchor is not news, and the point is to stay cheap.
    // Ambiguous and unsearched schemas are not "issues", but an agent still needs to know a
    // verdict was a coin toss or never taken — silence reads as a clean result.
    const notable = result.contracts.filter(
      (c) => c.status === 'schema-ambiguous' || c.status === 'schema-repo-not-synced'
    )
    // Contracts dropped before they were ever checked produce no `contracts` entry at all, so
    // without these the agent sees an empty result and reads it as clean.
    const rows = [
      ...result.broken.map(verifyRow),
      ...contractRows([...result.contractIssues, ...notable]),
      ...skippedRows(),
    ]
    if (rows.length) process.stdout.write(tsv(rows) + '\n')
    return
  }

  for (const r of result.repos) {
    if (r.error) {
      process.stdout.write(`  ${red('!')} ${bold(r.id)}  ${yellow(r.error)}\n`)
      continue
    }
    const all = r.ok === r.total
    const mark = all ? green('ok') : red('!!')
    const tally = r.total > 0 ? `${r.ok}/${r.total} anchors  ` : 'schemas only  '
    process.stdout.write(`  ${mark}  ${bold(r.id)}  ${dim(`${tally}${r.branch} @ ${r.sha.slice(0, 7)}`)}\n`)
    // Drift is the interesting output: not "it failed" but "here is what moved under you".
    if (r.moved) {
      const n = r.range?.commits
      process.stdout.write(
        dim(`      moved ${r.previousSha.slice(0, 7)} -> ${r.sha.slice(0, 7)}`) +
          dim(n ? ` (${n} commit${n === 1 ? '' : 's'})` : '') +
          dim(` since ${r.previousAt}\n`)
      )
    }
  }

  const stale = result.repos.filter((r) => r.narrowed)
  if (stale.length) {
    process.stdout.write(
      `\n  ${yellow(`${stale.length} checkout(s) are incomplete: ${stale.map((r) => r.id).join(', ')}`)}\n` +
        dim('  anchors reported missing there may simply not have been fetched\n')
    )
  }
  if (result.contractsStranded?.length) {
    process.stdout.write(
      `  ${yellow(`${result.contractsStranded.length} contract(s) not checked:`)} carried only by hops in a repo that failed to sync\n`
    )
  }
  if (result.contractsUnregistered?.length) {
    process.stdout.write(
      `  ${yellow(`${result.contractsUnregistered.length} contract(s) not checked:`)} carried only by hops in a repo the registry does not list\n` +
        dim('  add it with `flowmap repo add`, or fix the hop\n')
    )
  }
  if (result.contractsPartial?.length) {
    process.stdout.write(
      `  ${yellow(`${result.contractsPartial.length} contract(s) not checked:`)} their repo's checkout came up incomplete\n`
    )
  }
  if (result.contractsOutOfScope?.length) {
    process.stdout.write(
      dim(`  ${result.contractsOutOfScope.length} contract(s) not checked: carried only by hops outside this run's scope\n`)
    )
  }
  if (result.broken.length) {
    process.stdout.write(`\n  ${yellow(`${result.broken.length} anchor(s) no longer resolve:`)}\n`)
    for (const b of result.broken) {
      process.stdout.write(`    ${dim(`${b.journey} hop ${b.hop} ${b.side}`)}  ${b.repo}  ${b.anchor}\n`)
      process.stdout.write(`      ${red(statusLabel(b.status) ?? b.status)}\n`)
    }
    process.stdout.write(
      stale.length
        ? dim('\n  Some checkouts are incomplete, so these may simply not have been fetched.\n') +
            dim('  Re-run once origin is reachable before treating them as map drift.\n')
        : dim('\n  The map is out of date, not the code. Fix the anchors, or re-draft the journey.\n')
    )
  } else if (result.rows.length) {
    process.stdout.write(`\n  ${green('every anchor resolves.')}\n`)
  }
  const suppressed = result.contracts.filter((c) => c.status === 'schema-repo-not-synced')
  if (suppressed.length && result.contractsSuppressedReason) {
    process.stdout.write(
      `  ${yellow(`${suppressed.length} contract(s) not checked:`)} ${result.contractsSuppressedReason}\n` +
        dim('  a schema absent from the repos we could read is not proof it is absent\n')
    )
  }
  if (result.unusedReposUnavailable) {
    process.stdout.write(
      dim(`  cannot tell which registered repos are unused: ${result.unusedReposUnavailable}\n`)
    )
  }
  if (result.unusedRepos?.length) {
    process.stdout.write(
      `  ${dim(`${result.unusedRepos.length} registered repo(s) nothing uses: ${result.unusedRepos.join(', ')}`)}\n` +
        dim('  no hop names them and no contract schema lives there — flowmap repo remove <id>\n')
    )
  }
  const ambiguous = result.contracts.filter((c) => c.status === 'schema-ambiguous')
  for (const c of ambiguous) {
    process.stdout.write(
      `  ${yellow('ambiguous schema:')} ${c.id} — ${c.path} exists in ${c.repos.join(', ')}\n` +
        dim('  qualify it as <repo>/<path> so the verdict is not a coin toss\n')
    )
  }
  if (result.contractIssues.length) {
    const definite = result.contractIssues.filter((c) => c.status === 'fields-missing').length
    const absent = result.contractIssues.filter((c) => c.status === 'schema-not-found').length
    const unsure = result.contractIssues.length - definite - absent
    const parts = [
      definite ? `${definite} disagree with their schema` : '',
      absent ? `${absent} name a schema file that is not there` : '',
      unsure ? `${unsure} could not be confirmed` : '',
    ]
    process.stdout.write(`\n  ${yellow(`contracts: ${parts.filter(Boolean).join(', ')}`)}\n`)
    for (const c of result.contractIssues) {
      if (c.status === 'schema-inconclusive') {
        // A flagged unknown must not read as a finding — that is the whole point of the
        // status. The schema composes from something we could not read.
        process.stdout.write(`    ${cyan(c.id)} ${dim(`— ${c.path}`)}\n`)
        process.stdout.write(
          `      ${yellow(`could not confirm: ${c.missing.join(', ')}`)}\n` +
            dim(`      the schema composes from a source flowmap cannot read\n`)
        )
      } else if (c.missing.length) {
        process.stdout.write(`    ${cyan(c.id)} ${dim(`— ${c.path}`)}\n`)
        process.stdout.write(`      ${red(`not found in the schema: ${c.missing.join(', ')}`)}\n`)
      } else {
        process.stdout.write(`    ${cyan(c.id)}  ${red(statusLabel(c.status) ?? c.status)} ${dim(c.ref ?? '')}\n`)
      }
    }
  }

  // A repo that failed to sync and a repo skipped by scoping both went unrecorded, but the
  // advice differs — telling someone to "run it bare" when they just did is worse than silent.
  const failed = result.repos.filter((r) => r.error).map((r) => r.id)
  const skipped = result.partial.filter((id) => !failed.includes(id))
  const recorded = result.repos.filter((r) => r.recorded).map((r) => r.id)

  if (recorded.length) {
    process.stdout.write(dim(`  recorded ${recorded.length} repo(s) in ${display(root, path)}\n`))
  }
  if (skipped.length) {
    process.stdout.write(
      `  ${yellow('scoped run — not recorded:')} ${skipped.join(', ')}\n` +
        dim('  Verification is tracked per repo, so a partial run cannot mark one verified\n') +
        dim('  without vouching for journeys it never checked. Run `flowmap verify` bare.\n')
    )
  }
  if (failed.length && !recorded.length && !skipped.length) {
    process.stdout.write(dim(`  nothing recorded — no repo could be reached\n`))
  }
  // Findings never exit non-zero. See DESIGN.md "Advisory only. Never a gate."
}

// ---------------------------------------------------------------- visualize

async function visualize(args, flags) {
  const { map, root, path } = loadMap()
  if (!Object.keys(map.journeys).length) {
    throw new UserError(
      `no journeys in ${path} yet.\n` +
        `  flowmap draft journey <feature>      map one\n` +
        `  flowmap finalize journey <feature>   then accept it`
    )
  }
  requireValues(flags, ['port'])
  requireSingle(flags, ['port'])
  const port = Number(flags.port) > 0 ? Number(flags.port) : 7777
  await serve({ root, mapPath: path, port })
  return true // keep the process alive
}

// ---------------------------------------------------------------- setup

function init(args, flags) {
  const { path, map } = initMap(process.cwd(), { force: flags.force === true })
  process.stdout.write(`${green('created')} ${path}\n`)

  const local = flags['no-self'] === true ? null : describeLocalRepo()
  if (local) {
    const { branch, how } = resolveDefaultBranch(local.source)
    if (branch) {
      addRepo(map, path, { id: local.id, url: local.url, branch })
      const note = how === 'remote' ? '' : dim(`  ${HOW_LABEL[how]}`)
      process.stdout.write(`${green('added')}   ${bold(local.id)} ${dim(`-> ${local.url} (${branch})`)}${note}\n`)
    } else {
      process.stdout.write(`${yellow('skipped')} ${local.id} — ${HOW_LABEL[how]}\n`)
    }
  }

  process.stdout.write('\nNext:\n\n')
  process.stdout.write('  flowmap repo add billing git@github.com:org/billing.git\n')
  process.stdout.write('  flowmap draft journey checkout\n')
}

function repo(args, flags) {
  const [action = 'list', ...rest] = args
  const { map, path } = loadMap()

  if (action === 'list') {
    const ids = Object.keys(map.repos)
    if (!ids.length) {
      process.stdout.write(dim('registry is empty — add one with `flowmap repo add`\n'))
      return
    }
    for (const id of ids) {
      const r = map.repos[id]
      process.stdout.write(`  ${bold(id)}  ${dim(`${r.url}${r.branch ? ` (${r.branch})` : ''}`)}\n`)
    }
    return
  }

  if (action === 'add') {
    let [id, source] = rest
    if (!id) {
      const local = describeLocalRepo()
      if (!local) throw new UserError('not inside a git repository — pass `<id> <url-or-path>`', EXIT_USAGE)
      id = local.id
      source = local.source
      process.stderr.write(dim(`detected ${id} -> ${local.url}\n`))
    }
    if (!source) throw new UserError(`usage: flowmap repo add <id> <url-or-path>`, EXIT_USAGE)
    requireValues(flags, ['branch'])
    requireSingle(flags, ['branch'])

    const resolved = normalizeSource(source)

    // flowmap.json is committed and reviewed in PRs, so an absolute local path is the wrong
    // thing to record: it works on exactly one machine.
    let url = resolved
    let portability = null
    if (!isRemoteUrl(resolved)) {
      const origin = originUrlOf(resolved)
      if (origin && flags['keep-path'] !== true) {
        url = origin
        portability = dim('  using its origin url so this entry works for everyone')
      } else if (!origin) {
        // Stored relative to flowmap.json, so it survives a different home directory — but
        // only for someone whose repos sit in the same arrangement.
        portability = yellow('  no origin remote — stored as a relative path, so it needs the same repo layout')
      }
    }

    let branch, how
    if (typeof flags.branch === 'string') {
      branch = flags.branch
      how = 'given'
    } else {
      ;({ branch, how } = resolveDefaultBranch(resolved))
    }
    if (!branch) {
      throw new UserError(
        `could not determine the default branch for ${url} (${HOW_LABEL[how]})\n` +
          `Pass it explicitly:  flowmap repo add ${id} ${source} --branch <name>`
      )
    }

    const { entry, previous } = addRepo(map, path, { id, url, branch }, { force: flags.force === true })
    const note = how === 'given' ? '' : dim(`  ${HOW_LABEL[how]}`)
    process.stdout.write(
      `${green(previous ? 'updated' : 'added')} ${bold(id)} ${dim(`-> ${entry.url} (${branch})`)}${note}\n`
    )
    if (portability) process.stdout.write(`${portability}\n`)
    if (previous && previous.branch !== branch) {
      process.stdout.write(`  ${yellow(`default branch changed: ${previous.branch} -> ${branch}`)}\n`)
    }
    if (how === 'local-head') {
      process.stdout.write(`  ${yellow('no origin remote — this is just its current checkout')}\n`)
    }
    return
  }

  if (action === 'remove' || action === 'rm') {
    const id = rest[0]
    if (!id) throw new UserError('usage: flowmap repo remove <id>', EXIT_USAGE)
    removeRepo(map, path, id)
    process.stdout.write(`${green('removed')} ${id}\n`)
    return
  }

  throw new UserError(`unknown repo action "${action}" — use add, list, or remove`, EXIT_USAGE)
}

function search(args, flags) {
  const needle = args[0]
  if (!needle) throw new UserError('usage: flowmap search <string>', EXIT_USAGE)

  const { map, root } = loadMap()
  const ids = scopeFor(map, flags, 'search')
  const synced = ensureSynced(root, map, ids, flags, 'full', { widen: true })

  const max = Number(flags.max) > 0 ? Number(flags.max) : 50
  const results = searchRepos(root, ids, needle, { max, ignoreCase: flags.i === true })

  for (const s of synced.filter(worthWarning)) {
    process.stderr.write(yellow(narrowedHeadline(s, 'results may be incomplete')) + narrowedHint(s))
  }

  if (isAgentFormat(flags)) {
    const rows = results.flatMap((r) => r.hits.map((h) => [h.repo, h.path, h.line, h.text]))
    if (rows.length) process.stdout.write(tsv(rows) + '\n')
    for (const r of results.filter((r) => r.truncated)) {
      process.stderr.write(`truncated\t${r.repo}\t${r.hits.length}\t${r.total}\n`)
    }
    return
  }

  const total = results.reduce((n, r) => n + r.total, 0)
  if (!total) {
    process.stdout.write(
      `${yellow('no hits')} for ${bold(needle)} in ${ids.length} repo(s)\n\n` +
        dim('Async consumers reference the contract identifier — try the topic, table,\n') +
        dim('or endpoint name rather than a caller.\n')
    )
    return
  }
  for (const r of results) {
    if (!r.total) continue
    const shown = r.truncated ? ` ${yellow(`(showing ${r.hits.length} of ${r.total})`)}` : ''
    process.stdout.write(`\n${bold(r.repo)} ${dim(`— ${r.total} hit${r.total === 1 ? '' : 's'}`)}${shown}\n`)
    for (const h of r.hits) process.stdout.write(`  ${cyan(`${h.path}:${h.line}`)}  ${dim(h.text)}\n`)
  }
  process.stdout.write(`\n${dim(`${total} hit(s) across ${ids.length} repo(s)`)}\n`)
}

function sync(args, flags) {
  const { map, root } = loadMap()
  const ids = scopeFor(map, flags, 'sync')
  const results = syncMany(root, map, ids, {
    mode: 'full',
    // sync prepares checkouts for hand-grepping, so a tree verify narrowed must be widened.
    widen: true,
    refresh: flags['no-refresh'] !== true,
  })
  for (const r of results) {
    const state = r.fresh ? green('cloned') : r.refreshed ? cyan('refreshed') : dim('cached')
    const partial = r.narrowed ? yellow('  partial — could not fetch the rest') : ''
    process.stdout.write(`  ${state}  ${bold(r.id)}  ${dim(`${r.branch} @ ${r.sha.slice(0, 7)}`)}${partial}\n`)
  }
}

// ---------------------------------------------------------------- dispatch

// `draft journey <x>` reads better than `draft <x>` and leaves room for `draft contract`
// later. The noun stays optional so the shorter form keeps working.
const NOUNS = new Set(['journey', 'journeys'])

function withNoun(handler) {
  return (args, flags) => {
    const rest = NOUNS.has(args[0]) ? args.slice(1) : args
    return handler(rest[0], flags, rest)
  }
}

const COMMANDS = {
  journey: journeyCmd,
  impact: impactCmd,
  verify: verifyCmd,
  draft: (args, flags) => {
    // `--check=` (an unset shell variable) must not fall through to a full draft run.
    if (flags.check !== undefined) {
      requireValues(flags, flags.check === true ? [] : ['check'])
      requireSingle(flags, ['check'])
    }
    const target = flags.check === true ? args[args.length - 1] : flags.check
    if (target) return checkJourney(String(target), flags)
    return withNoun(draftJourney)(args, flags)
  },
  show: withNoun(showJourney),
  finalize: withNoun(finalizeJourney),
  accept: withNoun(finalizeJourney),
  visualize,
  init,
  repo,
  search,
  sync,
  help,
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  // Every other value flag is guarded at its command; `--format` is read everywhere, so guard
  // it once here. `--format=` silently yields human prose to a caller parsing TSV.
  if (flags.format !== undefined) {
    requireValues(flags, ['format'])
    requireSingle(flags, ['format'])
    if (!['agent', 'human'].includes(String(flags.format))) {
      throw new UserError(`--format must be "agent" or "human"`, EXIT_USAGE)
    }
  }
  const [name = 'help', ...rest] = positional

  rejectEmptyBooleans(flags)
  if (flags.help === true || flags.h === true) return help()
  // hasOwn: `in` walks the prototype, so `flowmap toString` reported itself as "not built yet"
  // followed by the source of Object.prototype.toString.
  if (Object.hasOwn(PLANNED, name)) {
    throw new UserError(`\`flowmap ${name}\` is not built yet — ${PLANNED[name]}.`, EXIT_USAGE)
  }

  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command) throw new UserError(`unknown command "${name}"\n\n${USAGE}`, EXIT_USAGE)
  return command(rest, flags)
}

main()
  .then((keepAlive) => {
    // `visualize` returns truthy: the server owns the process from here.
    if (!keepAlive) process.exit(EXIT_OK)
  })
  .catch((err) => {
    process.stderr.write(`${red('error')}: ${err.message}\n`)
    process.exit(err instanceof UserError ? err.code ?? EXIT_ERROR : EXIT_ERROR)
  })
