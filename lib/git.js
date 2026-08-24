import { execFileSync } from 'node:child_process'

// The only external process this tool ever runs. See DESIGN.md "flowmap never calls a model":
// no SDK, no API key, no network beyond git.
export function git(args, { cwd, allowFail = false, maxBuffer = 32 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      maxBuffer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    if (allowFail) return null
    const detail = (err.stderr || err.message || '').toString().trim()
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
}

// git grep exits 1 on "no matches", which is not an error for us.
export function gitGrepExitOk(args, opts) {
  try {
    return execFileSync('git', args, {
      ...opts,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    if (err.status === 1) return ''
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr || err.message).toString().trim()}`)
  }
}
