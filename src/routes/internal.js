// Free-tier scheduler endpoint. A single bearer-authed POST /internal/tick does
// the work that would otherwise need an always-on worker + Render cron:
//   1. ingest every configured source directly from Google Sheets
//   2. process a bounded batch of queued validation jobs
// Triggered periodically by a free external scheduler (GitHub Actions).
import express from 'express';
import { requireBearer } from '../lib/auth.js';
import { readSheetRows, sourceConfigs } from '../lib/sheets.js';
import { ingestItems } from '../lib/ingest.js';
import { processJobs } from '../worker.js';

export const internalRouter = express.Router();

internalRouter.use(requireBearer);

internalRouter.post('/tick', async (req, res) => {
  const doIngest = req.body?.ingest !== false; // default true
  const requestedSources = req.body?.sources;
  if (requestedSources !== undefined && (
    !Array.isArray(requestedSources) ||
    requestedSources.length === 0 ||
    requestedSources.some((source) => source !== 'NFULL' && source !== 'MFULL')
  )) {
    return res.status(400).json({ error: '`sources` must be a non-empty array containing only NFULL and/or MFULL.' });
  }
  const validateN = req.body?.validate != null
    ? Number(req.body.validate)
    : Number(process.env.VALIDATION_BATCH || 10);

  const result = { ingest: [], validated: 0, errors: [] };

  if (doIngest) {
    const configured = sourceConfigs();
    const wanted = requestedSources ? new Set(requestedSources) : null;
    const selected = wanted ? configured.filter((cfg) => wanted.has(cfg.name)) : configured;

    if (wanted) {
      const configuredNames = new Set(configured.map((cfg) => cfg.name));
      for (const source of wanted) {
        if (!configuredNames.has(source)) result.errors.push(`${source}: source is not configured`);
      }
    }

    for (const cfg of selected) {
      try {
        const rows = await readSheetRows(cfg);
        const items = rows.map((row) => ({ source: cfg.name, row }));
        const r = await ingestItems({ items, runSource: cfg.name });
        result.ingest.push({
          source: cfg.name,
          received: r.records_received,
          inserted: r.records_inserted,
          duplicates: r.duplicates,
          jobs_created: r.detail?.validation_jobs_created ?? 0,
          errors: r.errors
        });
        if (r.errors > 0) result.errors.push(`${cfg.name}: ${r.errors} rows failed ingestion`);
      } catch (err) {
        // One source failing must not stop the others or validation.
        result.errors.push(`${cfg.name}: ${err.message}`);
      }
    }
  }

  // Only validate if a validator is configured (otherwise jobs would just fail).
  if (validateN > 0 && process.env.TECHIES_VALIDATOR_URL) {
    try {
      result.validated = await processJobs(validateN);
    } catch (err) {
      result.errors.push(`validate: ${err.message}`);
    }
  }

  return res.json({ ok: result.errors.length === 0, ...result });
});
