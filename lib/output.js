const enabled = process.stdout.isTTY && !process.env.NO_COLOR

const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const bold = wrap('1')
export const dim = wrap('2')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const cyan = wrap('36')

// The agent format is a stable interface. See DESIGN.md "Agent consumption":
// tab-separated, uncolored, deterministic. Changing column order is a breaking change.
export function tsv(rows) {
  return rows.map((cols) => cols.map(cleanCell).join('\t')).join('\n')
}

function cleanCell(value) {
  return String(value ?? '').replace(/[\t\n\r]+/g, ' ')
}

export function isAgentFormat(flags) {
  return flags.format === 'agent' || flags.agent === true
}
