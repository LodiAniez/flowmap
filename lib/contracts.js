import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { cacheDir } from './config.js'
import { contractFields } from './fields.js'
import { journey } from './graph.js'

export const SCHEMA_OK = 'ok'
export const FIELDS_MISSING = 'fields-missing'
export const SCHEMA_NOT_FOUND = 'schema-not-found'
export const NOT_A_PATH = 'schema-not-a-path'
export const NO_SCHEMA = 'no-schema'
export const INCONCLUSIVE = 'schema-inconclusive'

// How far to chase relative imports. Schemas compose — `VelocityMembershipSchema.omit(...)`
// puts the field names one file away — so searching only the named file reports fields as
// missing when they are merely imported. Two levels covers the shapes seen in practice
// without turning this into a module resolver.
const IMPORT_DEPTH = 2

// A contract's `schema` is written by hand or by a drafting agent, so it turns up in three
// shapes. Handling all of them beats demanding one and reporting the rest as failures.
//
//   src/schemas/x.ts                      bare path, repo not stated
//   loyalty-contract/src/x.ts::TheSchema  repo-prefixed, and pointing at a symbol
//   @scope/pkg SomeMessage                a package reference, not a path at all
export function parseSchemaRef(ref, repoIds) {
  if (!ref) return { kind: NO_SCHEMA }
  if (/\s/.test(ref)) return { kind: NOT_A_PATH, ref }

  let path = ref
  let symbol = null
  const sep = ref.indexOf('::')
  if (sep !== -1) {
    path = ref.slice(0, sep)
    symbol = ref.slice(sep + 2) || null
  }

  // A leading segment that names a registered repo is the repo, not a directory.
  const [head, ...rest] = path.split('/')
  if (rest.length && repoIds.includes(head)) {
    return { kind: 'path', repo: head, path: rest.join('/'), symbol }
  }
  return { kind: 'path', repo: null, path, symbol }
}

function readIn(root, repoId, relPath) {
  const file = join(cacheDir(root), repoId, relPath)
  if (!existsSync(file) || !statSync(file).isFile()) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// TS/ESM source may name `./x.js` for a file on disk called `x.ts`, and a bare directory for
// its index. Try the shapes rather than giving up on the first miss.
function resolveImport(root, repoId, fromPath, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec))
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '')
  for (const candidate of [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`,
    `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.js`,
    `${stripped}/index.ts`, `${stripped}/index.js`,
  ]) {
    const body = readIn(root, repoId, candidate)
    if (body !== null) return { path: candidate, body }
  }
  return null
}

// Returns the schema file's text plus the text of everything it pulls in by relative path,
// and whether it also imports from packages we cannot follow. That last flag is what keeps
// the check honest: an unfollowable import means "cannot tell", not "field is missing".
function gatherSources(root, repoId, entryPath, entryBody) {
  const seen = new Set([entryPath])
  const texts = [entryBody]
  let external = false
  let frontier = [{ path: entryPath, body: entryBody }]

  for (let depth = 0; depth < IMPORT_DEPTH; depth++) {
    const next = []
    for (const file of frontier) {
      for (const spec of importSpecs(file.body)) {
        if (!spec.startsWith('.')) {
          external = true
          continue
        }
        const found = resolveImport(root, repoId, file.path, spec)
        if (!found || seen.has(found.path)) continue
        seen.add(found.path)
        texts.push(found.body)
        next.push(found)
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return { text: texts.join('\n'), external, files: seen.size }
}

function importSpecs(source) {
  const specs = []
  const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source))) specs.push(m[1])
  }
  return specs
}

// Which repos might hold this contract's schema, best guess first: the ones whose hops touch
// it, then anything else registered. Contracts do not record their owning repo, so guessing
// beats refusing — and the result reports which repo it actually resolved in.
function candidateRepos(map, contractId, hinted) {
  if (hinted) return [hinted]
  const touching = new Set()
  for (const name of Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name).hops) {
      if (hop.inbound === contractId || hop.outbound === contractId) touching.add(hop.repo)
    }
  }
  return [...touching, ...Object.keys(map.repos ?? {}).filter((r) => !touching.has(r))]
}

// Grep-level, deliberately — same posture as anchor resolution. A schema may be zod, JSON
// Schema, GraphQL SDL, a TS interface or a .proto, and parsing all of them is the per-language
// investment DESIGN.md declines to make. A declared field whose name appears nowhere in its
// own schema file is a strong signal regardless of format; the reverse direction (fields in
// the schema but not declared) is not checked, because a schema legitimately carries more
// than a contract chooses to name.
export function checkContract(root, map, id, contract) {
  const repoIds = Object.keys(map.repos ?? {})
  const ref = parseSchemaRef(contract.schema, repoIds)
  if (ref.kind !== 'path') return { id, status: ref.kind, ref: contract.schema ?? null, missing: [] }

  let source = null
  let foundIn = null
  for (const repo of candidateRepos(map, id, ref.repo)) {
    source = readIn(root, repo, ref.path)
    if (source !== null) {
      foundIn = repo
      break
    }
  }
  if (source === null) {
    return { id, status: SCHEMA_NOT_FOUND, ref: contract.schema, path: ref.path, missing: [] }
  }

  const gathered = gatherSources(root, foundIn, ref.path, source)
  const missing = contractFields(contract)
    .filter((f) => !mentions(gathered.text, f.name))
    .map((f) => f.name)

  // A schema that also composes from a package puts part of its shape somewhere we cannot
  // read. Reporting those fields as missing would be a confident wrong answer, so the whole
  // contract is marked inconclusive instead — a flagged unknown beats a false alarm.
  const status = !missing.length
    ? SCHEMA_OK
    : gathered.external
      ? INCONCLUSIVE
      : FIELDS_MISSING

  return {
    id,
    status,
    ref: contract.schema,
    repo: foundIn,
    path: ref.path,
    symbol: ref.symbol,
    checked: contractFields(contract).length,
    filesSearched: gathered.files,
    missing,
  }
}

// Contracts name fields by path (`order.total`) but a schema declares the leaf (`total`), so
// match on the last segment. Word-bounded, or `total` would match `subtotal` and every field
// would look present.
function mentions(source, fieldName) {
  const leaf = fieldName.split('.').pop()
  if (!leaf) return true
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(source)
}

export function checkContracts(root, map, { contractIds = null } = {}) {
  const entries = Object.entries(map.contracts ?? {}).filter(([id]) =>
    contractIds ? contractIds.includes(id) : true
  )
  return entries.map(([id, contract]) => checkContract(root, map, id, contract))
}
