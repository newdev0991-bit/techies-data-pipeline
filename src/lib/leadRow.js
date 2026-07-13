// Merge a master lead's raw source payloads into one row object keyed by the
// verbose Google-Sheet headers (first non-empty value wins across sources), so a
// lead found by BOTH sources presents the richest available fields. Shared by the
// public read API and the validation worker.
export function mergePayloads(payloads) {
  const merged = {};
  for (const p of payloads || []) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && v !== null && String(v).trim() !== '' && !merged[k]) {
        merged[k] = v;
      }
    }
  }
  return merged;
}
