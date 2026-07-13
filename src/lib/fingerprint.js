// Secondary/fuzzy dedup fingerprints. Pure, no I/O.
// Used only when no EXACT key (post_id / permalink / phone) matches, to FLAG a
// possible duplicate for human review — never to auto-merge (doc section 3).

const BUSINESS_SUFFIXES = new Set([
  'ltd', 'limited', 'llp', 'llc', 'plc', 'inc', 'co', 'company',
  'the', 'and', '&'
]);

/** Strip accents (café -> cafe). */
function deaccent(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Canonical business key: lowercase, de-accented, punctuation removed, common
 * company suffixes/stopwords dropped. "ABC Café" and "ABC Cafe Ltd" -> "abccafe".
 */
export function businessKey(name) {
  if (!name) return '';
  const words = deaccent(String(name))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !BUSINESS_SUFFIXES.has(w));
  return words.join('');
}

/** Normalize a postcode for comparison: uppercase, no spaces. */
export function postcodeKey(postcode) {
  if (!postcode) return '';
  return String(postcode).toUpperCase().replace(/\s+/g, '');
}

/**
 * Composite secondary fingerprint from a canonical lead: normalized business name
 * + postcode. Same business at the same postcode across sources produces the same
 * value even when phone/URL differ (exact phone matches are already caught by
 * norm_phone). Returns null when there isn't enough signal to be meaningful.
 */
export function fingerprint(lead) {
  const b = businessKey(lead.business_name);
  const p = postcodeKey(lead.postcode);

  // Require both the business key and a postcode to avoid over-flagging.
  if (!b || !p) return null;

  return `${b}|${p}`;
}
