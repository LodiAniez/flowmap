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
export function syncRepo(root, id, repo, { mode = 'full', refresh = false, paths = [], widen = false } = {}) {
  if (!repo?.url) {
    throw new UserError(`repo "${id}" has no url in the flowmap.json repos registry`)
  }

  const dir = join(cacheDir(root), id)
  const fresh = !existsSync(join(dir, '.git'))
  let freshNarrowed = false
  // Stored sources may be relative to flowmap.json; git needs a real location.
  const source = fromPortable(root, repo.url)

  if (fresh) {
    mkdirSync(dir, { recursive: true })
    const args = ['clone', '--depth', '1', '--no-tags']
    if (repo.branch) args.push('--branch', repo.branch)
    if (mode === 'sparse') args.push('--filter=blob:none', '--sparse')
    args.push(source, dir)
    withBranchDiagnostics(id, repo, source, () => git(args))
    if (mode === 'sparse' && paths.length) {
      // Cone mode is picky about what it accepts, and a rejected path list fails the whole
      // command. Sparse is only an optimisation, so fall back to the full checkout rather
      // than losing the repo's verification over it.
      const ok = git(['sparse-checkout', 'set', ...paths], { cwd: dir, allowFail: true })
      if (ok === null) {
        const off = git(['sparse-checkout', 'disable'], { cwd: dir, allowFail: true })
        // A fresh sparse clone that cannot widen still holds only its root-level files.
        if (off === null) freshNarrowed = true
      }
    }
  } else {
    // Before anything fetches: the cache is keyed by repo id, so an entry whose url later
    // changes — a local path replaced by its origin url, a repo moved to a new host — keeps
    // pulling from whatever origin was configured at clone time. Correct it on any reuse, not
    // only under --refresh: search and draft never pass that flag, and they are the commands
    // that fetch when they widen a blobless clone.
    const configured = git(['remote', 'get-url', 'origin'], { cwd: dir, allowFail: true })?.trim()
    if (configured && configured !== source) {
      git(['remote', 'set-url', 'origin', source], { cwd: dir, allowFail: true })
    }
  }

  if (!fresh && refresh) {
    const branch = repo.branch || currentBranch(dir)
    withBranchDiagnostics(id, repo, source, () => {
      git(['fetch', '--depth', '1', '--no-tags', 'origin', branch], { cwd: dir })
      git(['reset', '--hard', `origin/${branch}`], { cwd: dir })
    })
    git(['clean', '-fd'], { cwd: dir })
  }

  // The cache is shared between commands, so the cone has to match what this caller needs —
  // on every reuse, not only when a refresh was asked for. `verify` narrows a checkout to the
  // anchored paths; `search` and `draft` then grep whatever is on disk, silently missing every
  // file outside the cone and reporting the result as complete.
  const cone = fresh ? null : reconcileSparse(dir, mode, paths, widen)

  return {
    id,
    dir,
    fresh,
    // True when this checkout is still narrowed despite a caller that needs the whole tree.
    narrowed: Boolean(cone?.narrowed) || freshNarrowed,
    narrowedReason: cone?.reason ?? (freshNarrowed ? 'unreachable' : null),
    refreshed: refresh && !fresh,
    branch: repo.branch || currentBranch(dir),
    sha: git(['rev-parse', 'HEAD'], { cwd: dir }).trim(),
  }
}

// A recorded branch that no longer exists is the expected consequence of a repo renaming
// its default (master -> main is the common one). Git's own message for this does not
// mention flowmap or say how to fix it, so translate it into the command that does.
function withBranchDiagnostics(id, repo, source, fn) {
  try {
    return fn()
  } catch (err) {
    const message = String(err.message)
    const missing = /Remote branch .* not found|couldn't find remote ref|unknown revision/i.test(message)
    if (!missing) throw err

    // The resolved source, not the stored one: a relative url would otherwise be looked up
    // against the process cwd and the recovery hint would degrade to "could not reach".
    const { branch: actual, how } = resolveDefaultBranch(source)
    const fix = actual
      ? `Its default branch is now "${actual}" (${HOW_LABEL[how]}). Fix the registry with:\n` +
        `  flowmap repo add ${id} ${repo.url} --branch ${actual} --force`
      : `Could not reach ${repo.url} to find the current default branch.`

    throw new UserError(`repo "${id}" has no branch "${repo.branch}" any more.\n${fix}`)
  }
}

function reconcileSparse(dir, mode, paths, widen) {
  const isSparse = git(['config', 'core.sparseCheckout'], { cwd: dir, allowFail: true })?.trim() === 'true'

  if (mode === 'full') {
    // Widen only for callers that grep the tree for something the map does not name. Doing it
    // for every command would materialise whole repos on a blobless clone and permanently
    // cost verify its sparse checkout.
    if (isSparse) {
      // Disabling sparse on a blobless clone has to fetch the missing blobs, so it fails when
      // origin is unreachable — and --no-sync declines to try at all. Either way the tree is
      // still coned, and the caller must hear about it, or search greps a truncated tree and
      // presents the result as a complete sweep.
      // Two different reasons, and different fixes: --no-sync declined to fetch at all, while
      // an unreachable origin means the fetch was attempted and failed.
      if (!widen) return { narrowed: true, reason: 'declined' }
      const ok = git(['sparse-checkout', 'disable'], { cwd: dir, allowFail: true })
      if (ok === null) return { narrowed: true, reason: 'unreachable' }
    }
    return
  }
  // Only narrow a checkout that is already sparse. Narrowing a full clone would truncate the
  // tree other commands depend on, and nothing would widen it again.
  if (mode === 'sparse' && isSparse && paths.length) {
    const ok = git(['sparse-checkout', 'set', ...paths], { cwd: dir, allowFail: true })
    if (ok === null) {
      // If widening the cone was rejected and disabling it also fails, the checkout keeps its
      // previous, narrower cone. Reporting that as complete makes verify call every anchor
      // outside it "file not found" and blame the map for a local failure.
      const off = git(['sparse-checkout', 'disable'], { cwd: dir, allowFail: true })
      if (off === null) return { narrowed: true, reason: 'unreachable' }
    }
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
