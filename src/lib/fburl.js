// Facebook URL normalization + post-id extraction. Pure, no I/O.
// Goal: two URLs pointing at the same post produce the same normalized string,
// so `norm_permalink` is a reliable exact-dedup key.

const TRACKING_PARAMS = new Set([
  'fbclid', 'mibextid', '__tn__', '__cft__', '__xts__', '__so__',
  'notif_t', 'notif_id', 'ref', 'refsrc', 'hc_ref', 'source',
  'rdid', 'share_url', 'comment_id', 'reply_comment_id', 'paipv',
  'eav', '_rdr', 'app', 'locale', 'wtsid'
]);

// Query params that actually identify content and must be kept.
const MEANINGFUL_PARAMS = ['story_fbid', 'id', 'fbid', 'v'];

function canonicalHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'fb.watch' || h === 'fb.me') return h; // short-link hosts, keep as-is
  if (h.endsWith('facebook.com') || h.endsWith('fb.com')) return 'www.facebook.com';
  return h;
}

/**
 * Return a stable, comparable normalized permalink string, or null if the input
 * is not a usable URL.
 */
export function normalizePermalink(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let input = rawUrl.trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  let u;
  try {
    u = new URL(input);
  } catch {
    return null;
  }

  const host = canonicalHost(u.hostname);

  // Path: drop trailing slash, lowercase (FB treats usernames case-insensitively).
  let path = u.pathname.replace(/\/+$/, '').toLowerCase();
  if (path === '') path = '/';

  // Keep only meaningful query params, sorted for stability.
  const kept = [];
  for (const key of MEANINGFUL_PARAMS) {
    const val = u.searchParams.get(key);
    if (val && !TRACKING_PARAMS.has(key)) kept.push(`${key}=${val.toLowerCase()}`);
  }
  const query = kept.length ? `?${kept.sort().join('&')}` : '';

  return `${host}${path}${query}`;
}

/**
 * Best-effort Facebook post id. Prefers a `pfbid…` token, else a numeric id from
 * the common URL shapes. Returns null when nothing identifiable is present.
 */
export function extractPostId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const s = rawUrl.trim();
  if (!s) return null;

  // pfbid tokens are globally unique post identifiers.
  const pfbid = s.match(/pfbid[0-9A-Za-z]+/i);
  if (pfbid) return pfbid[0];

  const patterns = [
    /\/posts\/(\d+)/i,
    /\/permalink\/(\d+)/i,
    /\/videos\/(\d+)/i,
    /\/reel\/(\d+)/i,
    /[?&]story_fbid=(\d+)/i,
    /[?&]fbid=(\d+)/i,
    /[?&]v=(\d+)/i,
    /\/photos\/[^/]+\/(\d+)/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}
