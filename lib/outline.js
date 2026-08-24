import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir } from './config.js'

// Candidate anchors, extracted deterministically. The drafting agent should not have to
// guess at `path::symbol` when the symbols are sitting right there in the file — and a
// guessed anchor is the one thing `draft --check` will reject anyway.
//
// Same posture as anchor.js: regex, not a parser. See DESIGN.md "Symbol resolution is
// two-tier, not parsed".
const DECL = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  /\bclass\s+([A-Za-z_$][\w$]*)/,
  /\bdef\s+([A-Za-z_$][\w$]*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
  /\b(?:type|interface|enum|struct)\s+([A-Za-z_$][\w$]*)/,
]

export function symbolsIn(root, repoId, relPath, { max = 12 } = {}) {
  const file = join(cacheDir(root), repoId, relPath)
  if (!existsSync(file) || !statSync(file).isFile()) return []

  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  if (source.length > 400_000) return [] // minified or generated; nothing useful to offer

  const found = []
  const seen = new Set()
  source.split('\n').forEach((line, i) => {
    if (found.length >= max) return
    for (const pattern of DECL) {
      const m = pattern.exec(line)
      if (m && !seen.has(m[1])) {
        seen.add(m[1])
        found.push({ symbol: m[1], line: i + 1, exported: /\bexport\b/.test(line) })
        break
      }
    }
  })

  // Exported names are the ones another repo can actually be talking to, so surface those
  // first — they are far more likely to be the real hop boundary.
  return found.sort((a, b) => Number(b.exported) - Number(a.exported) || a.line - b.line)
}
