// Internal ingestion routes. Bearer-authed. Doc section 2.
import express from 'express';
import { requireBearer } from '../lib/auth.js';
import { ingestItems } from '../lib/ingest.js';

export const ingestRouter = express.Router();

ingestRouter.use(requireBearer);

// Header idempotency key falls back to body idempotencyKey.
function idemKey(req) {
  return req.headers['idempotency-key'] || req.body?.idempotencyKey || null;
}

function respond(res, result) {
  return res.status(200).json({
    status: result.status,
    run_id: result.run_id,
    records_received: result.records_received,
    records_inserted: result.records_inserted,
    records_updated: result.records_updated,
    duplicates: result.duplicates,
    errors: result.errors,
    validation_jobs_created: result.detail?.validation_jobs_created ?? 0,
    replayed: result.replayed === true
  });
}

function makeSingleSourceHandler(source) {
  return async (req, res) => {
    try {
      const rows = req.body?.rows;
      if (!Array.isArray(rows)) return res.status(400).json({ error: '`rows` must be an array of lead objects.' });
      const items = rows.map((row) => ({ source, row }));
      const result = await ingestItems({ items, runSource: source, idempotencyKey: idemKey(req) });
      return respond(res, result);
    } catch (err) {
      console.error(`[ingest:${source}]`, err.message);
      return res.status(500).json({ error: 'Ingestion failed.', details: err.message });
    }
  };
}

ingestRouter.post('/nfull', makeSingleSourceHandler('NFULL'));
ingestRouter.post('/mfull', makeSingleSourceHandler('MFULL'));

// Mixed batch: each row carries its own source (used by the reconciliation cron).
// Body: { idempotencyKey?, rows: [ { source: 'NFULL'|'MFULL', row: {..headers..} } ] }
ingestRouter.post('/batch', async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: '`rows` must be an array.' });
    const items = [];
    for (const entry of rows) {
      const source = entry?.source;
      const row = entry?.row;
      if (source !== 'NFULL' && source !== 'MFULL') {
        return res.status(400).json({ error: `each row needs source 'NFULL' or 'MFULL' (got ${source}).` });
      }
      if (!row || typeof row !== 'object') {
        return res.status(400).json({ error: 'each row needs a `row` object.' });
      }
      items.push({ source, row });
    }
    const result = await ingestItems({ items, runSource: null, idempotencyKey: idemKey(req) });
    return respond(res, result);
  } catch (err) {
    console.error('[ingest:batch]', err.message);
    return res.status(500).json({ error: 'Ingestion failed.', details: err.message });
  }
});
