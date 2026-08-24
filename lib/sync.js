import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.js'
import { resolveDefaultBranch, HOW_LABEL } from './branch.js'
import { cacheDir, UserError } from './config.js'
import { fromPortable } from './paths.js'

// Two checkout shapes, and the difference is load-bearing (DESIGN.md "Drafting journeys"):
//
//   'sparse' — verify. We know exactly which files the anchors name, so fetch only those.
//              Blobless + sparse pulls kilobytes instead of the repo.
//   'full'   — search and draft. Cannot use sparse: not knowing which files matter IS the
//              question being asked. Still shallow, so it stays bounded.
export function syncRepo(root, id, repo, { mode = 'full', refresh = false, paths = [] } = {}) {
  if (!repo?.url) {
    throw new UserError(`repo "${id}" has no url in the flowmap.json repos registry`)
  }

  const dir = join(cacheDir(root), id)
  const fresh = !existsSync(join(dir, '.git'))
  // Stored sources may be relative to flowmap.json; git needs a real location.
  const source = fromPortable(root, repo.url)

  if (fresh) {
    mkdirSync(dir, { recursive: true })
    const args = ['clone', '--depth', '1', '--no-tags']
    if (repo.branch) args.push('--branch', repo.branch)
    if (mode === 'sparse') args.push('--filter=blob:none', '--sparse')
    args.push(source, dir)
    withBranchDiagnostics(id, repo, () => git(args))
    if (mode === 'sparse' && paths.length) {
      git(['sparse-checkout', 'set', ...paths], { cwd: dir })
    }
  } else if (refresh) {
    const branch = repo.branch || currentBranch(dir)
    withBranchDiagnostics(id, repo, () => {
      git(['fetch', '--depth', '1', '--no-tags', 'origin', branch], { cwd: dir })
      git(['reset', '--hard', `origin/${branch}`], { cwd: dir })
    })
    git(['clean', '-fd'], { cwd: dir })
  }

  return {
    id,
    dir,
    fresh,
    refreshed: refresh && !fresh,
    branch: repo.branch || currentBranch(dir),
    sha: git(['rev-parse', 'HEAD'], { cwd: dir }).trim(),
  }
}

// A recorded branch that no longer exists is the expected consequence of a repo renaming
// its default (master -> main is the common one). Git's own message for this does not
// mention flowmap or say how to fix it, so translate it into the command that does.
function withBranchDiagnostics(id, repo, fn) {
  try {
    return fn()
  } catch (err) {
    const message = String(err.message)
    const missing = /Remote branch .* not found|couldn't find remote ref|unknown revision/i.test(message)
    if (!missing) throw err

    const { branch: actual, how } = resolveDefaultBranch(repo.url)
    const fix = actual
      ? `Its default branch is now "${actual}" (${HOW_LABEL[how]}). Fix the registry with:\n` +
        `  flowmap repo add ${id} ${repo.url} --branch ${actual} --force`
      : `Could not reach ${repo.url} to find the current default branch.`

    throw new UserError(`repo "${id}" has no branch "${repo.branch}" any more.\n${fix}`)
  }
}

function currentBranch(dir) {
  const name = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFail: true })
  const trimmed = name?.trim()
  return !trimmed || trimmed === 'HEAD' ? 'HEAD' : trimmed
}

export function syncMany(root, map, ids, opts = {}) {
  const results = []
  for (const id of ids) {
    results.push(syncRepo(root, id, map.repos[id], opts))
  }
  return results
}

export function isSynced(root, id) {
  return existsSync(join(cacheDir(root), id, '.git'))
}
