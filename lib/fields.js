// A contract field is either "order.total" or { name, type, note }. Both spellings are
// accepted because the short one is what a human writes by hand and the long one is what a
// drafting agent produces after reading the code.
export function normalizeField(field) {
  if (typeof field === 'string') return { name: field, type: null, note: null }
  return { name: field?.name ?? String(field), type: field?.type ?? null, note: field?.note ?? null }
}

export function contractFields(contract) {
  return (contract?.fields ?? []).map(normalizeField)
}

export function fieldNames(contract) {
  return contractFields(contract).map((f) => f.name)
}

export function describeField(field) {
  const f = normalizeField(field)
  return f.type ? `${f.name}: ${f.type}` : f.name
}
