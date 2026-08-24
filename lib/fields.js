// A contract field is either "order.total" or { name, type, note }. Both spellings are
// accepted because the short one is what a human writes by hand and the long one is what a
// drafting agent produces after reading the code.
export function normalizeField(field) {
  if (typeof field === 'string') return { name: field, type: null, note: null }
  return { name: field?.name ?? String(field), type: field?.type ?? null, note: field?.note ?? null }
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
