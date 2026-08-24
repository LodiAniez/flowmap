import { relative, resolve, isAbsolute, sep } from 'node:path'
import { isRemoteUrl } from './branch.js'

// Everything flowmap writes to disk is read by someone else on a different machine, so no
// absolute path may survive into a file. Paths are stored relative to the directory holding
// flowmap.json and resolved back at runtime. `../loyalty-connector` works for anyone whose
// repos sit side by side; `/Users/me/repos/...` works only for me.
export function toPortable(root, target) {
  if (!target) return target
  // A clone URL is already portable and is not a path. Running it through relative()/resolve()
  // produces nonsense like `<root>/https:/github.com/...` — the scheme reads as a directory.
  if (isRemoteUrl(target)) return target
  const rel = relative(root, resolve(target))
  // Normalise to posix separators so a map written on Windows reads on macOS.
  return rel.split(sep).join('/') || '.'
}

export function fromPortable(root, stored) {
  if (!stored) return stored
  if (isRemoteUrl(stored)) return stored
  return isAbsolute(stored) ? stored : resolve(root, stored)
}

// For anything printed rather than stored: a path under the map root reads better as a
// relative one, and anything outside it stays absolute so it is not misleading.
export function display(root, target) {
  if (isRemoteUrl(target)) return target
  const rel = toPortable(root, target)
  return rel.startsWith('..') ? target : rel
}
