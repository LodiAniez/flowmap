import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix, normalize } from 'node:path'
import { cacheDir } from './config.js'
import { contractFields } from './fields.js'
import { journey } from './graph.js'

export const SCHEMA_OK = 'ok'
export const FIELDS_MISSING = 'fields-missing'
export const SCHEMA_NOT_FOUND = 'schema-not-found'
export const NOT_A_PATH = 'schema-not-a-path'
export const NO_SCHEMA = 'no-schema'
export const INCONCLUSIVE = 'schema-inconclusive'
export const UNSEARCHED = 'schema-repo-not-synced'

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
// A schema ref is a path only if it looks like one. `@acme/contracts`, `com.acme.Order` and
// a bare `OrderCreated` are package or message references: there is nothing on disk to check,
// and treating them as paths reports a healthy map as broken (and pollutes the sparse cone).
function looksLikePath(ref) {
  if (/\s/.test(ref)) return false
  if (ref.startsWith('@')) return false // npm scope
  if (ref.includes('/')) return true
  // A file extension is lowercase; `com.acme.OrderCreated` is a message name, not a file.
  // A file extension is uniform case — `.ts`, `.gql`, `.GQL`. A CamelCase suffix like
  // `.OrderCreated` is a message name, not a file.
  return /\.([a-z0-9]{1,10}|[A-Z0-9]{1,10})$/.test(ref)
}

export function parseSchemaRef(ref, repoIds) {
  if (!ref) return { kind: NO_SCHEMA }

  // Split the `::symbol` suffix off before classifying: `order.ts::OrderSchema` is a path,
  // and testing the whole ref would reject it as a package reference.
  let path = ref
  let symbol = null
  const sep = ref.indexOf('::')
  if (sep !== -1) {
    path = ref.slice(0, sep)
    symbol = ref.slice(sep + 2) || null
  }

  if (!looksLikePath(path)) return { kind: NOT_A_PATH, ref }

  // Repo-relative by construction, same rule parseAnchor enforces. Without this a schema
  // path can climb out of the checkout and read arbitrary files off the machine.
  if (normalize(path).startsWith('..') || path.startsWith('/')) return { kind: NOT_A_PATH, ref }

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
  // The entry path is guarded against climbing out of the checkout; a followed import must
  // be too, or a crafted `from '../../../../etc/hosts'` reads outside the repo.
  if (base.startsWith('..') || base.startsWith('/')) return null
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
  let unfollowed = 0
  let frontier = [{ path: entryPath, body: entryBody }]

  for (let depth = 0; depth < IMPORT_DEPTH; depth++) {
    const next = []
    const lastRound = depth === IMPORT_DEPTH - 1
    for (const file of frontier) {
      for (const { spec, bindings } of importSpecs(file.body)) {
        if (!spec.startsWith('.')) {
          if (bindings.some((b) => composesFrom(file.body, b))) external = true
          continue
        }
        const found = resolveImport(root, repoId, file.path, spec)
        if (!found) {
          // A relative import we cannot read — absent from a sparse checkout, or genuinely
          // missing — hides part of the shape. Same honesty rule as a package import.
          external = true
          continue
        }
        if (seen.has(found.path)) continue
        seen.add(found.path)
        texts.push(found.body)
        // Read at the last level: only a genuine unknown if it pulls in more of the shape
        // that we will now never look at. A leaf file hides nothing.
        if (lastRound) {
          if (importSpecs(found.body).some((i) => i.spec.startsWith('.'))) unfollowed++
        } else {
          next.push(found)
        }
      }
    }
    frontier = next
    if (!frontier.length) break
  }

  // Only an import we never followed leaves the shape partly unknown. Counting the last
  // frontier instead made every two-level import graph permanently inconclusive, so genuine
  // drift could not be reported at all.
  if (unfollowed > 0) external = true

  return { text: texts.join('\n'), external, files: seen.size }
}

// Returns { spec, bindings } per import. Bindings matter only for package imports, where
// they decide whether the package actually contributes to the shape.
function importSpecs(source) {
  const out = []
  // `export … from` matters as much as `import … from`: a schema barrel is written
  // `export * from './schema.velocity.js'`, and missing it makes every contract behind a
  // barrel look like it has fields nowhere in its schema.
  const withBindings = /\b(?:import|export)\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g
  const bare = [/\bimport\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g]

  let m
  while ((m = withBindings.exec(source))) {
    const names = [...m[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]).filter((n) => n !== 'type')
    out.push({ spec: m[2], bindings: names })
  }
  for (const re of bare) {
    while ((m = re.exec(source))) out.push({ spec: m[1], bindings: [] })
  }
  return out
}

// Does the file build its shape out of this imported binding? A schema composed with
// `Base.extend({...})` or `...Base.shape` genuinely hides fields; `z.object({...})` does not,
// because the fields are right there in the file.
function composesFrom(source, binding) {
  const b = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    // zod and friends
    `\\b${b}\\s*\\.\\s*(extend|merge|omit|pick|partial|required|and|or|shape)\\b` +
      `|\\.\\.\\.\\s*${b}\\b` +
      // plain TypeScript, which is the commonest non-zod schema shape
      `|\\b(extends|implements)\\s+[^{]*\\b${b}\\b`
  ).test(source)
}

// Where to look for this contract's schema, most likely first. A ref that names its repo is
// definitive; otherwise try the repos whose hops carry the contract, then the rest of the
// registry. Ordering only — whether "not found" is a finding is decided by the run's scope,
// not by guessing which repo owns the file.
function candidateRepos(map, contractId, hinted) {
  if (hinted) return { repos: [hinted] }

  const touching = new Set()
  for (const name of Object.keys(map.journeys ?? {})) {
    for (const hop of journey(map, name)?.hops ?? []) {
      if (hop.inbound === contractId || hop.outbound === contractId) touching.add(hop.repo)
    }
  }
  const rest = Object.keys(map.repos ?? {}).filter((r) => !touching.has(r))
  return { repos: [...touching, ...rest] }
}

// Grep-level, deliberately — same posture as anchor resolution. A schema may be zod, JSON
// Schema, GraphQL SDL, a TS interface or a .proto, and parsing all of them is the per-language
// investment DESIGN.md declines to make. A declared field whose name appears nowhere in its
// own schema file is a strong signal regardless of format; the reverse direction (fields in
// the schema but not declared) is not checked, because a schema legitimately carries more
// than a contract chooses to name.
export function checkContract(root, map, id, contract, { synced = null, scoped = false } = {}) {
  const repoIds = Object.keys(map.repos ?? {})
  const ref = parseSchemaRef(contract?.schema, repoIds)
  if (ref.kind !== 'path') return { id, status: ref.kind, ref: contract?.schema ?? null, missing: [] }

  const candidates = candidateRepos(map, id, ref.repo)
  const searchable = candidates.repos.filter((r) => !synced || synced.has(r))
  let source = null
  let foundIn = null
  for (const repo of searchable) {
    source = readIn(root, repo, ref.path)
    if (source !== null) {
      foundIn = repo
      break
    }
  }
  if (source === null) {
    // "Not in the repos we fetched" is not the same claim as "nowhere". Only the second is a
    // finding; the first means we never looked, and saying otherwise is a false alarm.
    // Whether "nowhere" is honest depends on the run, not on guesswork about which repo owns
    // the schema — a shared contracts package holds schemas for contracts whose hops live
    // elsewhere, so inferring the owner from a hop is wrong. A full run syncs everything that
    // could matter, so absence is real; a scoped run deliberately skipped repos, so it is not.
    const unsearched = scoped || searchable.length === 0
    return {
      id,
      status: unsearched ? UNSEARCHED : SCHEMA_NOT_FOUND,
      ref: contract?.schema,
      path: ref.path,
      missing: [],
    }
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
    ref: contract?.schema,
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

export function checkContracts(root, map, { contractIds = null, synced = null, scoped = false } = {}) {
  const entries = Object.entries(map.contracts ?? {}).filter(([id]) =>
    contractIds ? contractIds.includes(id) : true
  )
  return entries.map(([id, contract]) => checkContract(root, map, id, contract, { synced, scoped }))
}
