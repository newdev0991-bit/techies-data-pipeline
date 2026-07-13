// Layer A: cheap deterministic pre-checks that reject obviously-bad leads BEFORE
// spending on the validator (doc section 5A). Conservative on purpose — only hard
// rejects on unambiguous signals; nuanced exclusions become advisory `flags` that
// the decision mapper uses to force manual review if the AI disagrees.

export const RULES_VERSION = '1.1.0';

function freshnessHours() {
  return Number(process.env.FRESHNESS_HOURS || 24);
}

// Advisory keyword signals (not auto-rejected here; see decision.js).
const SIGNAL_KEYWORDS = {
  education: ['school', 'academy', 'nursery', 'tutoring', 'training centre', 'training center', 'college'],
  non_commercial: ['church', 'charity', 'mosque', 'temple', 'fundraiser'],
  banned_location: ['ireland', 'northern ireland', 'guernsey', 'jersey', 'isle of man'],
  minor_update: ['new menu', 'new items', 'new pricelist', 'new price list', 'renovated', 'refurbished', 'new decor', 'new staff']
};

function reject(reason) {
  return { decision: 'REJECTED', reason, flags: [] };
}

/**
 * Run deterministic checks against a master_leads row.
 * Returns either { decision: 'REJECTED', reason } (stop, no AI spend) or
 * { decision: null, flags: [...] } (proceed to evidence + AI).
 */
export function runDeterministicChecks(master) {
  if (!master.norm_permalink) return reject('missing_or_invalid_proof');
  if (!master.message || !String(master.message).trim()) return reject('missing_message');

  if (master.post_timestamp) {
    const ageH = (Date.now() - new Date(master.post_timestamp).getTime()) / 3.6e6;
    if (Number.isFinite(ageH) && ageH > freshnessHours()) {
      return reject(`stale_${Math.round(ageH)}h`);
    }
  }

  const text = `${master.message || ''} ${master.location || ''}`.toLowerCase();
  const flags = [];
  for (const [key, words] of Object.entries(SIGNAL_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) flags.push(key);
  }
  return { decision: null, flags };
}
