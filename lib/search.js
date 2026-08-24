import { join } from 'node:path'
import { gitGrepExitOk } from './git.js'
import { cacheDir } from './config.js'

// The deterministic core of drafting, and worth having on its own.
//
// The problem statement in DESIGN.md says async consumers have no call site to grep for.
// True — but they do reference the *contract identifier*: the topic name, the table name,
// the endpoint path. Searching for the contract rather than the caller is what makes
// fan-out findable, and it is cheap because the repos are already local.
export function searchRepos(root, repoIds, needle, { max = 50, ignoreCase = false } = {}) {
  const results = []

  for (const id of repoIds) {
    const dir = join(cacheDir(root), id)
    const args = ['grep', '-I', '-n', '-F']
    if (ignoreCase) args.push('-i')
    args.push('--', needle)

    const out = gitGrepExitOk(args, { cwd: dir })
    const hits = []

    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const first = line.indexOf(':')
      const second = line.indexOf(':', first + 1)
      if (first === -1 || second === -1) continue
      hits.push({
        repo: id,
        path: line.slice(0, first),
        line: Number(line.slice(first + 1, second)),
        text: line.slice(second + 1).trim().slice(0, 200),
      })
    }

    // Truncation is reported, never silent — a capped result that looks complete is the
    // same failure mode as a stale hop that looks fresh.
    results.push({
      repo: id,
      hits: hits.slice(0, max),
      total: hits.length,
      truncated: hits.length > max,
    })
  }

  return results
}

export function summarizeFiles(result, limit = 10) {
  const byFile = new Map()
  for (const hit of result.hits) {
    byFile.set(hit.path, (byFile.get(hit.path) ?? 0) + 1)
  }
  return [...byFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
}
