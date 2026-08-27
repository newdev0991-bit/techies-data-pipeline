import { EXPECTED_HEADERS } from './canonical.js';

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

// Serializer for the display rows served by the public leads endpoint: the 9
// display columns plus the `source` badge.
export function toCsv(leads, headers = [...EXPECTED_HEADERS, 'source']) {
  const esc = (v) => {
    // Collapse embedded newlines so every record is ONE physical line — the
    // frontends' line-based CSV parser breaks on multi-line quoted fields.
    let s = v === null || v === undefined ? '' : String(v);
    s = s.replace(/[\r\n]+/g, ' ').trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // The header row goes through esc() too: EXPECTED_HEADERS[7] contains a comma
  // ("Post Code (Please Put The Full Postcode, Example: CH41 5LH)"), so joining
  // it raw split it into two fields and shifted every later column one to the
  // left — the `source` badge landed under "Lead Proof URL".
  const lines = [headers.map(esc).join(',')];
  for (const lead of leads) {
    lines.push(headers.map((h) => esc(lead[h])).join(','));
  }
  return lines.join('\n');
}
