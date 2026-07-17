// Pure, no I/O. The cross-source "same lead" key for the asymmetric NFULL-base
// merge is the normalized UK phone ONLY (client rule: phone is unique per business,
// so it's the sole basis for deciding an MFULL lead already exists in NFULL).
// `null` when the lead has no phone → it can't match anything and is always kept.
export function matchKey(canonical) {
  if (!canonical) return null;
  return canonical.norm_phone || null;
}
