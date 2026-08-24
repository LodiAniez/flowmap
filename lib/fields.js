// A contract field is either "order.total" or { name, type, note }. Both spellings are
// accepted because the short one is what a human writes by hand and the long one is what a
// drafting agent produces after reading the code.
export function normalizeField(field) {
  if (typeof field === 'string') return { name: field, type: null, note: null }
  // Coerced here rather than at each use: a hand-edited `{"name": ["order","total"]}` otherwise
  // reaches String.prototype.split and takes down a command that promises never to fail.
  const name = field?.name
  return {
    name: typeof name === 'string' ? name : String(name ?? field),
    type: typeof field?.type === 'string' ? field.type : null,
    note: typeof field?.note === 'string' ? field.note : null,
  }
}

export function contractFields(contract) {
  // Nothing validates flowmap.json against schema.json on load, so `fields` can be anything a
  // hand edit left behind. A malformed value is a map defect to report, not a crash — and
  // crashing here fails a CI step that the tool promises never to fail.
  const fields = contract?.fields
  return Array.isArray(fields) ? fields.map(normalizeField) : []
}


export function describeField(field) {
  const f = normalizeField(field)
  return f.type ? `${f.name}: ${f.type}` : f.name
}
