// Minimal RFC-4180-ish CSV parsing (handles quoted fields, embedded commas and
// newlines). Shared by the reconciliation cron and the shadow-compare script.

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function csvToObjects(text) {
  const rows = parseCsv(text);
  // Skip leading all-empty rows (raw sheet exports often have a blank first row
  // before the real header row).
  let start = 0;
  while (start < rows.length && rows[start].every((v) => !v || v.trim() === '')) start += 1;
  if (rows.length - start < 2) return [];
  const headers = rows[start];
  return rows.slice(start + 1)
    .filter((r) => r.some((v) => v && v.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
