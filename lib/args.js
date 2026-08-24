// Minimal argv parser. Supports --key=value, --key value, --flag, and positionals.
// Hand-rolled because a dependency here would be the first crack in "zero dependencies".

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

    // `--key value` only consumes the next token if it is not itself a flag.
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      set(flags, body, next)
      i++
    } else {
      set(flags, body, true)
    }
  }

  return { flags, positional }
}

// Repeated flags collapse into an array so `--seed a --seed b` works.
function set(flags, key, value) {
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
