// Maps the existing techies-validator-backend response (verdict GOOD/BAD/UNCLEAR
// + opportunity_score + caption/history analysis) onto the doc section-5C decision
// schema. Applies the doc's thresholds and the AI-vs-rules disagreement rule.

export function approveMin() { return Number(process.env.APPROVE_MIN || 75); }
export function reviewMin() { return Number(process.env.REVIEW_MIN || 50); }

const EXCLUDING_FLAGS = ['education', 'non_commercial', 'banned_location', 'minor_update'];

function clamp(n, lo, hi) {
  const v = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
}

/**
 * @param v validator response object (parsed from /analyze content JSON)
 * @param ctx { master, flags } — master_leads row + deterministic advisory flags
 * @returns the doc section-5C decision object
 */
export function mapValidatorToDecision(v, { master, flags = [] }) {
  const score = Math.round(clamp(v.opportunity_score ?? 0, 0, 100));
  const verdict = String(v.verdict || 'UNCLEAR').toUpperCase();

  let decision;
  if (verdict === 'BAD') decision = 'REJECTED';
  else if (verdict === 'UNCLEAR') decision = 'REVIEW_REQUIRED';
  else decision = score >= approveMin() ? 'APPROVED' : (score >= reviewMin() ? 'REVIEW_REQUIRED' : 'REJECTED');

  // Doc section 6: AI and deterministic rules disagree -> manual review.
  let disagreement = false;
  if (decision === 'APPROVED' && flags.some((f) => EXCLUDING_FLAGS.includes(f))) {
    decision = 'REVIEW_REQUIRED';
    disagreement = true;
  }

  const ca = v.caption_analysis || {};
  const leadType = (ca.has_opening_keywords || ca.has_relocation_keywords || ca.has_ownership_keywords)
    ? 'COMMERCIAL_COT' : 'UNKNOWN';
  const intent = score >= approveMin() ? 'HIGH' : (score >= reviewMin() ? 'MEDIUM' : 'LOW');

  const reasons = [];
  if (Array.isArray(v.key_factors)) reasons.push(...v.key_factors);
  if (Array.isArray(v.red_flags)) reasons.push(...v.red_flags.map((r) => `⚠ ${r}`));
  if (v.reasoning) reasons.push(v.reasoning);
  if (disagreement) reasons.push('Deterministic rules flagged excluded signals; routed to manual review.');

  return {
    decision,
    score,
    confidence: v.confidence != null ? clamp(v.confidence, 0, 100) / 100 : null,
    lead_type: leadType,
    intent,
    business_status: verdict === 'GOOD' ? 'TRADING' : 'UNKNOWN',
    contact_status: master.phone ? 'CONTACT_FOUND' : 'NO_CONTACT',
    is_residential: false,
    is_promotional: !!ca.has_minor_update_keywords,
    requires_manual_review: decision === 'REVIEW_REQUIRED',
    reasons,
    extracted: {
      business_name: master.business_name || null,
      phone: master.phone || null,
      email: null,
      postcode: master.postcode || null
    }
  };
}
