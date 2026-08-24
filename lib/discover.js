import { readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { git, gitGrepExitOk } from './git.js'
import { resolveDefaultBranch } from './branch.js'

// Neighbouring repos are already on disk, so discovery greps them in place instead of
// cloning first. `git grep <pattern> <ref>` searches a branch without checking it out, which
// means we can probe every sibling on its real default branch in about a second, and only
// pay to clone the ones that actually matched.
//
// This is why auto-discovery does not reintroduce the crawl DESIGN.md rejects: the wide
// pass is a local grep, and the expensive step stays scoped to the hits.

export function repoRoot(dir = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true })?.trim()
  return top || null
}

export function siblingRepos(startRepo) {
  const parent = dirname(startRepo)
  const found = []
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(parent, entry.name)
    if (existsSync(join(path, '.git'))) found.push({ id: entry.name, path })
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

// Counts hits for each term on a given ref. Returns null when the ref does not exist, which
// is different from "no hits" and must not be flattened into it.
function countOnRef(path, terms, ref) {
  if (!git(['rev-parse', '--verify', '--quiet', ref], { cwd: path, allowFail: true })) return null
  let total = 0
  const files = new Set()
  for (const term of terms) {
    const out = gitGrepExitOk(['grep', '-I', '-i', '-l', '-F', term, ref, '--'], { cwd: path })
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      files.add(line.replace(/^[^:]*:/, ''))
      total++
    }
  }
  return { hits: total, files: [...files] }
}

export function probe(repo, terms) {
  // Offline: a wide scan cannot afford one network call per repo.
  const { branch } = resolveDefaultBranch(repo.path, { offline: true })
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.path, allowFail: true })?.trim()

  const onDefault = branch ? countOnRef(repo.path, terms, branch) : null
  // Probing HEAD too is what catches "this feature only exists on the branch I am on".
  // Silently reporting zero would be the confidently-wrong answer.
  const onHead = head && head !== branch ? countOnRef(repo.path, terms, 'HEAD') : null

  return {
    ...repo,
    branch,
    head,
    hits: onDefault?.hits ?? 0,
    files: onDefault?.files ?? [],
    headOnly: (onDefault?.hits ?? 0) === 0 && (onHead?.hits ?? 0) > 0,
    headHits: onHead?.hits ?? 0,
  }
}

export function discover({ start, terms, limit = 200 }) {
  const startId = basename(start)
  const candidates = siblingRepos(start).slice(0, limit)
  const results = candidates.map((repo) => probe(repo, terms))

  const matched = results.filter((r) => r.hits > 0 || r.id === startId)
  const headOnly = results.filter((r) => r.headOnly && r.hits === 0 && r.id !== startId)

  matched.sort((a, b) => {
    if (a.id === startId) return -1 // the repo you ran from is the journey's starting point
    if (b.id === startId) return 1
    return b.hits - a.hits || a.id.localeCompare(b.id)
  })

  return { startId, scanned: results.length, matched, headOnly }
}
