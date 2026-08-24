import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { git } from './git.js'
import { resolveDefaultBranch, isRemoteUrl } from './branch.js'
import { toPortable } from './paths.js'
import { UserError, EXIT_USAGE, saveMap } from './config.js'

const SCAFFOLD = { repos: {}, contracts: {}, journeys: {}, verified: {} }

// Honours FLOWMAP_FILE for the same reason loadMap does: if the two disagree about where
// the map lives, init writes one file and every later command reads a different one.
export function initMap(dir, { force = false } = {}) {
  const path = process.env.FLOWMAP_FILE ? resolve(process.env.FLOWMAP_FILE) : join(dir, 'flowmap.json')
  if (existsSync(path) && !force) {
    throw new UserError(`${path} already exists (use --force to overwrite)`, EXIT_USAGE)
  }
  mkdirSync(dirname(path), { recursive: true })
  const map = structuredClone(SCAFFOLD)
  writeFileSync(path, JSON.stringify(map, null, 2) + '\n')
  return { path, map }
}

// A repo "url" is anything git can clone, which includes a local path. That matters for
// the common case of pointing flowmap at repos you already have checked out.
export function normalizeSource(input) {
  if (!input) return null
  if (isRemoteUrl(input)) return input

  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  const abs = resolve(expanded)
  if (!existsSync(join(abs, '.git'))) {
    throw new UserError(`${abs} is not a git repository`, EXIT_USAGE)
  }
  return abs
}

// The checkout cache lands next to flowmap.json, which — after auto-discovery — is often
// inside a working repo. Left alone it shows up as untracked noise in `git status` on
// someone's real project. Excluding it locally via .git/info/exclude keeps their committed
// .gitignore untouched: this is our mess to hide, not a change to their repo's config.
export function hideCacheFromGit(root) {
  const gitDir = git(['rev-parse', '--git-dir'], { cwd: root, allowFail: true })?.trim()
  if (!gitDir) return false

  const excludePath = join(resolve(root, gitDir), 'info', 'exclude')
  try {
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    if (existing.includes('.flowmap-cache')) return false
    mkdirSync(dirname(excludePath), { recursive: true })
    writeFileSync(excludePath, existing.replace(/\n*$/, '\n') + '\n# added by flowmap\n.flowmap-cache/\n')
    return true
  } catch {
    return false
  }
}

export function originUrlOf(dir) {
  return git(['remote', 'get-url', 'origin'], { cwd: dir, allowFail: true })?.trim() || null
}

export function describeLocalRepo(dir = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true })?.trim()
  if (!top) return null

  const remote = git(['remote', 'get-url', 'origin'], { cwd: top, allowFail: true })?.trim()
  return { id: basename(top), url: remote || top, source: top }
}

export function addRepo(map, path, { id, url, branch }, { force = false } = {}) {
  // A local source becomes a path relative to flowmap.json. Origin URLs pass through: they
  // are portable already, and are preferred wherever a repo has one.
  if (url && !isRemoteUrl(url)) url = toPortable(dirname(path), url)
  if (map.repos[id] && !force) {
    throw new UserError(
      `repo "${id}" is already registered as ${map.repos[id].branch ?? '(no branch)'}\n` +
        `Use --force to update it — that is also how you fix a renamed default branch.`,
      EXIT_USAGE
    )
  }
  const previous = map.repos[id]
  map.repos[id] = branch ? { url, branch } : { url }
  saveMap(path, map)
  return { entry: map.repos[id], previous }
}

export function removeRepo(map, path, id) {
  if (!map.repos[id]) {
    throw new UserError(`repo "${id}" is not registered`, EXIT_USAGE)
  }
  delete map.repos[id]
  saveMap(path, map)
}

export { resolveDefaultBranch }
