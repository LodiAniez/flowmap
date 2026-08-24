#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseArgs, list } from '../lib/args.js'
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
import { display } from '../lib/paths.js'
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

function scopeFor(map, flags, purpose) {
  return resolveRepoIds(map, list(flags.repos), { all: flags.all === true, purpose })
}

function ensureSynced(root, map, ids, flags, mode = 'full', { widen = false } = {}) {
  const missing = ids.filter((id) => !isSynced(root, id))
  if (missing.length && flags['no-sync'] === true) {
    throw new UserError(`not synced: ${missing.join(', ')}\nDrop --no-sync or run \`flowmap sync\`.`)
  }
  if (missing.length) {
    process.stderr.write(dim(`syncing ${missing.length} repo(s): ${missing.join(', ')}\n`))
  }
  return syncMany(root, map, ids, { mode, widen, refresh: flags.refresh === true })
}

// Anchors can only be resolved against real checkouts, so any command that resolves them
// pulls what the journey needs first — and only what it needs.
function syncForJourney(root, map, journey, flags) {
  const ids = [...new Set((journey.hops ?? []).map((h) => h.repo).filter((id) => map.repos[id]))]
  if (ids.length) ensureSynced(root, map, ids, flags)
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
  const { root } = loadMap()
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
  const journey = map.journeys[feature] ?? loadDraft(root, feature).draft
  syncForJourney(root, map, journey, flags)

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

  const j = resolveJourney(map, name)
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
  const named = args.filter((a) => !NOUNS.has(a))

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
  if (!Object.keys(map.journeys).length) {
    throw new UserError(`no journeys in ${display(root, path)} yet — flowmap draft journey <feature>`)
  }

  // --local is the PR-time scope: only this repo's anchors, which are the only ones the
  // author could have broken. See DESIGN.md "Split checks by who can act on them".
  let repoIds = list(flags.repos)
  if (flags.local === true) {
    const here = repoRoot()
    const id = here ? here.split('/').pop() : null
    if (!id || !map.repos[id]) throw new UserError('--local needs to run inside a registered repo', EXIT_USAGE)
    repoIds = [id]
  }

  // Route repo ids through the same validation the rest of the CLI uses, so a typo errors
  // instead of quietly narrowing the scope to nothing.
  if (repoIds.length) resolveRepoIds(map, repoIds, { all: true, purpose: 'verify' })

  const result = runVerify(root, map, path, {
    repoIds: repoIds.length ? repoIds : null,
    journeys: requested.length ? requested : null,
  })

  if (isAgentFormat(flags)) {
    // Only the problems: a clean anchor is not news, and the point is to stay cheap.
    const rows = [...result.broken.map(verifyRow), ...contractRows(result.contractIssues)]
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
    process.stdout.write(
      `  ${mark}  ${bold(r.id)}  ${dim(`${r.ok}/${r.total} anchors  ${r.branch} @ ${r.sha.slice(0, 7)}`)}\n`
    )
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

  if (result.broken.length) {
    process.stdout.write(`\n  ${yellow(`${result.broken.length} anchor(s) no longer resolve:`)}\n`)
    for (const b of result.broken) {
      process.stdout.write(`    ${dim(`${b.journey} hop ${b.hop} ${b.side}`)}  ${b.repo}  ${b.anchor}\n`)
      process.stdout.write(`      ${red(statusLabel(b.status) ?? b.status)}\n`)
    }
    process.stdout.write(
      dim('\n  The map is out of date, not the code. Fix the anchors, or re-draft the journey.\n')
    )
  } else {
    process.stdout.write(`\n  ${green('every anchor resolves.')}\n`)
  }
  if (result.contractIssues.length) {
    const definite = result.contractIssues.filter((c) => c.status !== 'schema-inconclusive').length
    const unsure = result.contractIssues.length - definite
    const parts = [definite ? `${definite} disagree with their schema` : '', unsure ? `${unsure} could not be confirmed` : '']
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
  ensureSynced(root, map, ids, flags, 'full', { widen: true })

  const max = Number(flags.max) > 0 ? Number(flags.max) : 50
  const results = searchRepos(root, ids, needle, { max, ignoreCase: flags.i === true })

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
  for (const r of syncMany(root, map, ids, { mode: 'full', refresh: flags['no-refresh'] !== true })) {
    const state = r.fresh ? green('cloned') : r.refreshed ? cyan('refreshed') : dim('cached')
    process.stdout.write(`  ${state}  ${bold(r.id)}  ${dim(`${r.branch} @ ${r.sha.slice(0, 7)}`)}\n`)
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
  const [name = 'help', ...rest] = positional

  if (flags.help === true || flags.h === true) return help()
  if (name in PLANNED) {
    throw new UserError(`\`flowmap ${name}\` is not built yet — ${PLANNED[name]}.`, EXIT_USAGE)
  }

  const command = COMMANDS[name]
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
