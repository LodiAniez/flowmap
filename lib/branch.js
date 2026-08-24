import { git } from './git.js'

// Default branch names are not a convention you can assume: main, master, develop, trunk
// all appear in the wild, and a repo can rename its default at any time. Every code path
// here asks something authoritative rather than guessing.
//
// The method has to differ by source type, and the trap is that it looks like it doesn't:
//
//   remote URL  -> `ls-remote --symref <url> HEAD` is the upstream default. Correct.
//   local path  -> HEAD is just whatever YOU have checked out right now. Asking it while
//                  you sit on a feature branch records that feature branch forever.
//                  The upstream default lives in refs/remotes/origin/HEAD instead.

// Anything git can clone that is not a filesystem path. Two shapes:
//   scheme://…   https, ssh, git, file, git+ssh, and anything else git grows
//   user@host:…  scp-style, where the user is not necessarily "git"
// Being too narrow here is not cosmetic: a missed form gets resolved as a relative path and
// silently mangled into `<root>/https:/…`, which git cannot clone.
export function isRemoteUrl(source) {
  if (typeof source !== 'string') return false
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source) || /^[^/\\:]+@[^/\\:]+:/.test(source)
}

function parseSymref(output) {
  // "ref: refs/heads/some/branch\tHEAD" — branch names may contain slashes.
  const match = /^ref:\s+refs\/heads\/(.+?)\s/m.exec(output ?? '')
  return match ? match[1] : null
}

export function remoteDefaultBranch(url) {
  const out = git(['ls-remote', '--symref', url, 'HEAD'], { allowFail: true })
  return parseSymref(out)
}

function originUrl(dir) {
  return git(['remote', 'get-url', 'origin'], { cwd: dir, allowFail: true })?.trim() || null
}

function cachedOriginHead(dir) {
  const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, allowFail: true })?.trim()
  // "origin/some/branch" -> "some/branch"
  return ref?.startsWith('origin/') ? ref.slice('origin/'.length) : null
}

// Returns { branch, how } so the caller can show its work. `how` matters: a branch we
// inferred weakly should look different to the user than one the remote told us.
//
// `offline` skips every network round trip. Registration wants the authoritative answer and
// pays one ls-remote for it; a wide scan over dozens of local repos must not, or it turns a
// three-second grep into a two-minute one. The cached origin/HEAD is right almost always,
// and is corrected at registration time anyway.
export function resolveDefaultBranch(source, { offline = false } = {}) {
  if (isRemoteUrl(source)) {
    if (offline) return { branch: null, how: 'unknown' }
    const branch = remoteDefaultBranch(source)
    if (branch) return { branch, how: 'remote' }
    return { branch: null, how: 'unreachable' }
  }

  const origin = originUrl(source)

  if (origin) {
    // Cheap and offline: what this clone was told the default was, when it last looked.
    const cached = cachedOriginHead(source)
    if (offline) {
      if (cached) return { branch: cached, how: 'cached' }
    } else {
      // Authoritative, and survives a stale local origin/HEAD (e.g. after master -> main).
      const fromRemote = remoteDefaultBranch(origin)
      if (fromRemote) return { branch: fromRemote, how: 'remote' }
      if (cached) return { branch: cached, how: 'cached' }
    }
  }

  // No origin at all: a purely local repo genuinely has no upstream default, so its
  // current branch is the only meaningful answer — but say so, because it is also exactly
  // what a feature-branch checkout looks like.
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: source, allowFail: true })?.trim()
  if (current && current !== 'HEAD') return { branch: current, how: 'local-head' }

  return { branch: null, how: 'unknown' }
}

export const HOW_LABEL = {
  remote: 'from remote HEAD',
  cached: 'from cached origin/HEAD — may be stale',
  'local-head': 'from the current checkout — no origin remote to ask',
  unreachable: 'remote could not be reached',
  unknown: 'could not be determined',
}
