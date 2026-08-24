// Minimal argv parser. Supports --key=value, --key value, --flag, and positionals.
// Hand-rolled because a dependency here would be the first crack in "zero dependencies".

// Flags that never take a value. Without this, `--local checkout` binds "checkout" as the
// value of --local: the flag reads as false AND the positional disappears, so a command the
// user believes is doubly scoped silently runs against everything.
export const BOOLEAN_FLAGS = new Set([
  'all', 'local', 'force', 'refresh', 'no-refresh', 'no-sync', 'no-self', 'no-open',
  'keep-draft', 'keep-path', 'check', 'mermaid', 'brief', 'discover', 'agent', 'help', 'h', 'i',
])

export function parseArgs(argv) {
  const flags = {}
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }

    const body = arg.slice(2)
    const eq = body.indexOf('=')

    if (eq !== -1) {
      set(flags, body.slice(0, eq), body.slice(eq + 1))
      continue
    }

    // `--key value` only consumes the next token if it is not itself a flag, and never for
    // a flag that is known to be boolean.
    const next = argv[i + 1]
    if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      set(flags, body, next)
      i++
    } else {
      set(flags, body, true)
    }
  }

  return { flags, positional }
}

// Repeated flags collapse into an array so `--seed a --seed b` works — except boolean ones,
// which stay scalar. Every consumer tests `=== true`, so `--force --force` would otherwise
// read as false: the flag repeated is the flag ignored, which is the worst possible reading.
function set(flags, key, value) {
  if (BOOLEAN_FLAGS.has(key)) {
    // `--local=true` must not arrive as the string 'true': every consumer tests `=== true`,
    // so it would read as false and widen the run the caller believed they had scoped.
    // Anything explicitly falsy is honoured; anything else means "on".
    flags[key] = value === true ? true : !/^(false|0|no|off)$/i.test(String(value))
    return
  }
  if (key in flags) {
    flags[key] = [].concat(flags[key], value)
  } else {
    flags[key] = value
  }
}

export function list(value) {
  if (value === undefined || value === true) return []
  return [].concat(value)
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)
}
