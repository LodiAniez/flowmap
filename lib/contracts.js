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
export const AMBIGUOUS = 'schema-ambiguous'
export const MALFORMED_FIELDS = 'fields-malformed'

// How far to chase relative imports. Schemas compose — `VelocityMembershipSchema.omit(...)`
// puts the field names one file away — so searching only the named file reports fields as
// missing when they are merely imported.
//
// Three, measured rather than guessed: on a real map (a ts-rest contracts package with a
// barrel of ten schema modules) depth 2 gave a definite verdict on 3 of 7 contracts and depth
// 3 gave 4 of 7. Depths 4 and 6 also gave 4 of 7, so the remaining three are structurally
// unreadable to this approach and more depth only costs reads. `lib/verify.js` widens the
// sparse cone the same number of levels — the two must agree, or the files this walks are
// simply not on disk.
export const IMPORT_DEPTH = 3

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
  // A schema registry url or a broker address is not a file we can open.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return false
  if (ref.includes('/')) return true
  // Without a directory separator, only a recognised source or schema extension makes this a
  // file. "Anything after a dot" swept in every topic and message name — `orders.created`,
  // `order.v1`, `com.acme.OrderCreated` — which produced a false "schema file not found" and,
  // worse, made a full run sweep the whole registry hunting for a file that never existed.
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|gql|graphql|graphqls|proto|prisma|sql|ya?ml|avsc|avro|xsd|md)$/i.test(ref)
}

export function parseSchemaRef(ref, repoIds) {
  if (!ref) return { kind: NO_SCHEMA }
  // Nothing validates flowmap.json against schema.json on load, so a hand-edited map can put
  // anything here. A malformed value is a map defect to report, not a crash.
  if (typeof ref !== 'string') return { kind: NOT_A_PATH, ref: String(ref) }

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
  // Every extension looksLikePath accepts: omitting one turns a resolvable import into an
  // unresolvable one, which sets `external` and suppresses a genuine fields-missing verdict.
  const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
  const candidates = [base]
  for (const stem of [base, stripped]) {
    for (const ext of exts) candidates.push(stem + ext)
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']) {
      candidates.push(`${stem}/index${ext}`)
    }
  }
  for (const candidate of candidates) {
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
  const lastRoundFiles = []

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
        if (lastRound) {
          // Its own imports will never be walked, so judge them here rather than not at all.
          // Deferred: `seen` is still filling, and testing it now makes the verdict depend on
          // which sibling happened to be visited first.
          lastRoundFiles.push(found)
        } else {
          next.push(found)
        }
      }
    }
    frontier = next
    if (!frontier.length) break
  }

  // Judged once the whole set is known, so the answer does not depend on visit order.
  for (const file of lastRoundFiles) {
    for (const onward of importSpecs(file.body)) {
      if (!onward.spec.startsWith('.')) {
        if (onward.bindings.some((b) => composesFrom(file.body, b))) external = true
        continue
      }
      const onwardPath = resolveImport(root, repoId, file.path, onward.spec)
      if (!onwardPath || !seen.has(onwardPath.path)) unfollowed++
    }
  }

  // Only an import we never followed leaves the shape partly unknown. Counting the last
  // frontier instead made every two-level import graph permanently inconclusive, so genuine
  // drift could not be reported at all.
  if (unfollowed > 0) external = true

  return { text: texts.join('\n'), external, files: seen.size }
}

// Returns { spec, bindings } per import.
//
// Anchored on the `from` clause and read backwards to the nearest import/export keyword.
// Scanning forwards from the keyword instead lets any quote-free statement above swallow the
// clause — `export const VERSION = 1` before `export * from 'pkg'` produced a clause of
// "const VERSION = 1\nexport *", so the star was never seen and a wholesale-hidden package
// shape was treated as contributing nothing.
function importSpecs(source) {
  const out = []

  const fromClause = /\bfrom\s*['"]([^'"]+)['"]/g
  let m
  while ((m = fromClause.exec(source))) {
    const before = source.slice(0, m.index)
    // Boundary-aware: a plain lastIndexOf finds `import` inside an identifier such as
    // `exportedHelper`, truncating the clause there and silently dropping every binding
    // before it — so the same statement gave a different verdict depending on what a
    // co-imported symbol happened to be called.
    let kw = -1
    for (const km of before.matchAll(/\b(?:import|export)\b/g)) kw = km.index
    if (kw === -1) continue
    const clause = before.slice(kw).replace(/^(?:import|export)\b/, '')
    // A clause containing a quote belongs to an earlier statement, not this one.
    if (/['"]/.test(clause)) continue
    out.push({ spec: m[1], bindings: bindingsOf(clause) })
  }

  // Side-effect imports carry no bindings at all.
  const sideEffect = /\bimport\s+['"]([^'"]+)['"]/g
  while ((m = sideEffect.exec(source))) out.push({ spec: m[1], bindings: [] })

  // `require()` and dynamic `import()` do carry bindings, on the left of an assignment. Not
  // reading them meant a package composed in through CJS could never be seen as hiding the
  // shape, so a genuinely unknown field was reported as definitely missing.
  const call = /(?:(?:const|let|var)\s+([^=]+?)\s*=\s*)?(?:await\s+)?\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = call.exec(source))) {
    out.push({ spec: m[2], bindings: m[1] ? bindingsOf(m[1]) : [] })
  }
  return out
}

function bindingsOf(clause) {
  const alias = [...clause.matchAll(/\bas\s+([A-Za-z_$][\w$]*)/g)].map((x) => x[1])
  if (/^\s*\*/.test(clause)) {
    // `export * from 'pkg'` republishes whatever the package declares — the shape is hidden
    // wholesale and there is no binding to look for. `import * as z from 'zod'` only binds a
    // namespace object, and whether that contributes is decided by how it is used.
    return alias.length ? alias : ['*']
  }
  return [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]).filter((n) => n !== 'type')
}

// Does the file build its shape out of this imported binding? A schema composed with
// `Base.extend({...})` or `...Base.shape` genuinely hides fields; `z.object({...})` does not,
// because the fields are right there in the file.
function composesFrom(source, binding) {
  // A star re-export republishes whatever the package declares, so the shape is hidden
  // wholesale — there is no binding to look for.
  if (binding === '*') return true

  const b = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    // method-style, directly or through a namespace import (`Shared.Base.extend`)
    `\\b${b}\\s*\\.(\\s*\\w+\\s*\\.)*\\s*(extend|merge|omit|pick|partial|required|and|or|shape|catchall)\\b` +
      `|\\.\\.\\.\\s*${b}\\b` +
      // Combinator style, where the binding is an argument rather than the receiver. It must
      // not be followed by a dot: `z.union([z.string()])` mentions `z` three times, always as
      // a receiver, and matching those made ordinary zod hide every real verdict.
      `|(?<!\\b${b}\\s*\\.)\\b(intersection|union|discriminatedUnion|allOf|oneOf|anyOf)\\s*\\([^)]*\\b${b}\\b(?!\\s*\\.)` +
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
  // Same tolerance as the schema guard below: a malformed `fields` is a defect in the map.
  if (contract?.fields !== undefined && !Array.isArray(contract.fields)) {
    return { id, status: MALFORMED_FIELDS, ref: contract?.schema ?? null, missing: [] }
  }
  const ref = parseSchemaRef(contract?.schema, repoIds)
  if (ref.kind !== 'path') return { id, status: ref.kind, ref: contract?.schema ?? null, missing: [] }

  const candidates = candidateRepos(map, id, ref.repo)
  const searchable = candidates.repos.filter((r) => !synced || synced.has(r))
  let source = null
  let foundIn = null
  const matches = []
  for (const repo of searchable) {
    const body = readIn(root, repo, ref.path)
    if (body === null) continue
    matches.push(repo)
    if (source === null) {
      source = body
      foundIn = repo
    }
  }

  // A bare path can exist in several repos, and a scoped run only ever looks in some of them —
  // so finding exactly one copy proves nothing about whether it is the right one. Withhold the
  // verdict rather than judging whichever copy happened to be fetched.
  if (matches.length === 1 && scoped && !ref.repo && candidates.repos.length > searchable.length) {
    return {
      id,
      status: UNSEARCHED,
      ref: contract?.schema,
      path: ref.path,
      repos: matches,
      missing: [],
    }
  }

  // A bare path like `src/schemas/order.ts` can exist in several repos. Picking the first and
  // reporting a confident verdict from it is a coin toss; say which repo it means instead.
  if (matches.length > 1) {
    return {
      id,
      status: AMBIGUOUS,
      ref: contract?.schema,
      path: ref.path,
      repos: matches,
      missing: [],
    }
  }
  if (source === null) {
    // "Not in the repos we fetched" is not the same claim as "nowhere". Only the second is a
    // finding; the first means we never looked, and saying otherwise is a false alarm.
    // Whether "nowhere" is honest depends on the run, not on guesswork about which repo owns
    // the schema — a shared contracts package holds schemas for contracts whose hops live
    // elsewhere, so inferring the owner from a hop is wrong. A full run syncs everything that
    // could matter, so absence is real; a scoped run deliberately skipped repos, so it is not.
    //
    // Except when the ref names its repo: verify syncs every repo a schema ref names, whatever
    // the scope, so that one repo really was searched. Suppressing there hid genuine deletions
    // behind "this run was scoped" on every scoped run.
    const unsearched = ref.repo ? searchable.length === 0 : scoped || searchable.length === 0
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
