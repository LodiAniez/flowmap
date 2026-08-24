import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { cacheDir } from './config.js'

export const OK = 'ok'
export const SYMBOL_MISSING = 'symbol-missing'
export const FILE_MISSING = 'file-missing'
export const REPO_MISSING = 'repo-missing'
export const MALFORMED = 'malformed'

export function parseAnchor(anchor) {
  if (typeof anchor !== 'string' || !anchor.includes('::')) return null
  const idx = anchor.indexOf('::')
  const path = anchor.slice(0, idx).trim()
  const symbol = anchor.slice(idx + 2).trim()
  if (!path || !symbol) return null
  // Anchors are repo-relative by construction; anything climbing out is malformed.
  if (normalize(path).startsWith('..')) return null
  return { path, symbol }
}

// Tier 1: does the file exist?  Catches moves and deletes — most real drift.
// Tier 2: does the symbol appear as a declaration?  Grep-level, catches renames.
//
// Deliberately NOT a parser. See DESIGN.md "Symbol resolution is two-tier, not parsed":
// escalate to tree-sitter only if this tier proves noisy in practice.
export function resolveAnchor(root, repoId, anchor) {
  const parsed = parseAnchor(anchor)
  if (!parsed) return { status: MALFORMED, anchor }

  const repoDir = join(cacheDir(root), repoId)
  if (!existsSync(join(repoDir, '.git'))) {
    return { status: REPO_MISSING, anchor, ...parsed, repo: repoId }
  }

  const filePath = join(repoDir, parsed.path)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return { status: FILE_MISSING, anchor, ...parsed, repo: repoId }
  }

  const source = readFileSync(filePath, 'utf8')
  const line = findDeclaration(source, parsed.symbol)

  return line
    ? { status: OK, anchor, ...parsed, repo: repoId, line }
    : { status: SYMBOL_MISSING, anchor, ...parsed, repo: repoId }
}

function findDeclaration(source, symbol) {
  const s = escapeRegExp(symbol)
  const patterns = [
    // js/ts/go/python/java/c#/rust/kotlin declaration keywords
    new RegExp(`\\b(function|class|const|let|var|def|func|type|interface|enum|struct|trait|impl|object|val)\\s+${s}\\b`),
    // assignment / property / method-shorthand forms: `foo = `, `foo: `, `foo(`
    new RegExp(`\\b${s}\\s*[:=]\\s*(async\\s+)?(function|\\(|\\[|\\{|new\\b|[A-Za-z_$])`),
    new RegExp(`\\b${s}\\s*\\([^)]*\\)\\s*(:[^;{]*)?\\{`),
    // decorated / exported / annotated handlers
    new RegExp(`@\\w+[^\\n]*\\n\\s*(public|private|protected|async|static|\\s)*${s}\\b`),
  ]

  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) return i + 1
  }
  // Multi-line decorator form needs a whole-source pass.
  return patterns[3].test(source) ? 0 : null
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function statusLabel(status) {
  return {
    [OK]: 'ok',
    [SYMBOL_MISSING]: 'symbol not found',
    [FILE_MISSING]: 'file not found',
    [REPO_MISSING]: 'repo not synced',
    [MALFORMED]: 'malformed anchor',
  }[status] ?? status
}
