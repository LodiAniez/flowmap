import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

// Exit code policy. See DESIGN.md "Advisory only. Never a gate."
// Findings — unresolved anchors, drifted hops, missing consumers — are ALWAYS exit 0.
// Only the tool failing to run is non-zero. Do not add a --strict mode.
export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2

export class UserError extends Error {
  constructor(message, code = EXIT_ERROR) {
    super(message)
    this.code = code
  }
}

export function findMapPath(startDir = process.cwd()) {
  if (process.env.FLOWMAP_FILE) return resolve(process.env.FLOWMAP_FILE)

  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, 'flowmap.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new UserError('no flowmap.json found in this directory or any parent')
}

export function loadMap(startDir) {
  const path = findMapPath(startDir)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new UserError(`cannot read ${path}: ${err.message}`)
  }

  let map
  try {
    map = JSON.parse(raw)
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${err.message}`)
  }

  map.repos ??= {}
  map.contracts ??= {}
  map.journeys ??= {}
  map.verified ??= {}

  return { map, path, root: dirname(path) }
}

export function saveMap(path, map) {
  writeFileSync(path, JSON.stringify(map, null, 2) + '\n')
}

// Creating the directory is the caller's concern on the write path only. This is called from
// every candidate-path probe — roughly thirty per unresolved import — and an unconditional
// mkdirSync there costs thousands of syscalls per repo for nothing.
const ensured = new Set()

export function cacheDir(root) {
  const dir = process.env.FLOWMAP_CACHE
    ? resolve(process.env.FLOWMAP_CACHE)
    : join(root, '.flowmap-cache')
  if (!ensured.has(dir)) {
    mkdirSync(dir, { recursive: true })
    ensured.add(dir)
  }
  return dir
}

// Resolve the repo ids a command should operate on.
//
// DESIGN.md rejects "a crawler that walks 50 repos". The registry is not that: it holds
// only repos someone deliberately registered, which for a context repo is a handful. So
// the default is every registered repo, and the guard trips on SIZE rather than on the
// absence of a flag — that keeps the friction where the original objection actually was.
export const WIDE_REGISTRY = 12

export function resolveRepoIds(map, requested, { all = false, purpose = 'this command' } = {}) {
  const known = Object.keys(map.repos)

  if (requested.length > 0) {
    const unknown = requested.filter((id) => !known.includes(id))
    if (unknown.length) {
      throw new UserError(
        `unknown repo id(s): ${unknown.join(', ')}\nknown: ${known.join(', ') || '(registry is empty)'}`,
        EXIT_USAGE
      )
    }
    return requested
  }

  if (!known.length) {
    throw new UserError(
      `no repos registered yet.\n` +
        `  flowmap repo add                       register the repo you are standing in\n` +
        `  flowmap repo add <id> <url-or-path>    register another one`,
      EXIT_USAGE
    )
  }

  if (known.length > WIDE_REGISTRY && !all) {
    throw new UserError(
      `${purpose} would sweep all ${known.length} registered repos.\n` +
        `  --repos a,b,c   scope to the ones this feature actually touches (preferred)\n` +
        `  --all           sweep everything anyway\n\n` +
        `A sweep this wide is the crawl this tool is designed to avoid — see DESIGN.md\n` +
        `"Verify by sync, not by push".`,
      EXIT_USAGE
    )
  }

  return known
}
