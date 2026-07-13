// Auth middleware. Internal ingestion uses a bearer token; the public read API
// uses an X-API-Key. Both compared with timing-safe equality.
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Require `Authorization: Bearer <PIPELINE_API_TOKEN>` on internal ingest routes. */
export function requireBearer(req, res, next) {
  const expected = process.env.PIPELINE_API_TOKEN;
  if (!expected) return res.status(500).json({ error: 'PIPELINE_API_TOKEN not configured on server.' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/** Require `X-API-Key: <PUBLIC_API_KEY>` on the public read API. */
export function requireApiKey(req, res, next) {
  const expected = process.env.PUBLIC_API_KEY;
  if (!expected) return res.status(500).json({ error: 'PUBLIC_API_KEY not configured on server.' });
  const key = req.headers['x-api-key'] || '';
  if (!key || !safeEqual(key, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}
