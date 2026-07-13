// UK phone normalization to E.164 (+44…). Pure, no I/O.
// Collapses formatting differences so `norm_phone` is a reliable dedup key.
// e.g. "01234567890" and "+44 (0)1234 567890" -> "+441234567890".

/**
 * Normalize a single UK phone string to E.164, or return null if it doesn't look
 * like a UK number (junk, too short/long, non-UK).
 */
export function normalizeUkPhone(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Keep digits and a leading + only.
  let d = raw.replace(/[^\d+]/g, '');
  if (!d) return null;

  // Strip international prefixes down to the national significant number.
  if (d.startsWith('+44')) d = d.slice(3);
  else if (d.startsWith('0044')) d = d.slice(4);
  else if (d.startsWith('44') && d.length >= 12) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  else if (d.startsWith('+')) return null; // some other country code

  // Drop a leftover leading zero from the "+44 (0)…" form.
  d = d.replace(/^0+/, '');

  // UK national significant numbers are 9–10 digits.
  if (!/^\d{9,10}$/.test(d)) return null;

  return `+44${d}`;
}

/**
 * Normalize the first usable phone from a list (Phone Number, Phone 2, Phone 3).
 * Returns the first that normalizes, else null.
 */
export function firstUkPhone(...candidates) {
  for (const c of candidates) {
    const n = normalizeUkPhone(c);
    if (n) return n;
  }
  return null;
}
