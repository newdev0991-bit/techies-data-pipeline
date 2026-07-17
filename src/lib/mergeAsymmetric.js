// Pure, no I/O. The client's asymmetric NFULL-base merge rule:
//   - keep EVERY NFULL row (never dedup NFULL against itself);
//   - an MFULL row is OMITTED iff its match-key appears among NFULL's match-keys;
//   - otherwise keep it — there is NO MFULL self-dedup, so every MFULL-only row
//     survives (even MFULL internal duplicates);
//   - a row with no match-key can't "exist in NFULL", so it is always kept.
//
//   Merged total = all NFULL rows + all MFULL rows whose key ∉ NFULL match-keys.
//
// Inputs are arrays of CANONICAL rows (from `toCanonical`).
import { matchKey } from './matchKey.js';

export function mergeAsymmetric(nfullRows, mfullRows) {
  const nfull = Array.isArray(nfullRows) ? nfullRows : [];
  const mfull = Array.isArray(mfullRows) ? mfullRows : [];

  // The base set of keys present in NFULL (nulls skipped — a keyless NFULL row
  // establishes no key for MFULL to match against).
  const nfullKeys = new Set();
  for (const r of nfull) {
    const k = matchKey(r);
    if (k) nfullKeys.add(k);
  }

  const keptMfull = [];
  const omittedMfull = [];
  for (const r of mfull) {
    const k = matchKey(r);
    if (k && nfullKeys.has(k)) omittedMfull.push(r); // exists in NFULL → omit
    else keptMfull.push(r);                          // MFULL-only (or keyless) → keep
  }

  const kept = [...nfull, ...keptMfull];
  return {
    kept,
    omitted: omittedMfull,
    counts: {
      nfull: nfull.length,
      mfull_total: mfull.length,
      mfull_omitted: omittedMfull.length,
      mfull_only: keptMfull.length,
      merged_total: kept.length
    }
  };
}
