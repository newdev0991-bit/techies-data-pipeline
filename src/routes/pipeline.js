// Internal pipeline monitoring routes. Bearer-authed. Doc sections 2 + 9.
import express from 'express';
import { requireBearer } from '../lib/auth.js';
import { pool } from '../db/pool.js';

export const pipelineRouter = express.Router();

pipelineRouter.use(requireBearer);

// Per-source latest run + queue/health snapshot.
pipelineRouter.get('/status', async (_req, res) => {
  try {
    const lastRuns = await pool.query(
      `SELECT DISTINCT ON (source) source, id, status, started_at, finished_at,
              records_received, records_inserted, records_updated, duplicates, errors
         FROM pipeline_runs
        WHERE source IS NOT NULL
        ORDER BY source, started_at DESC`
    );
    const totals = await pool.query(
      `SELECT
         (SELECT count(*) FROM master_leads) AS master_leads,
         (SELECT count(*) FROM raw_leads) AS raw_leads,
         (SELECT count(*) FROM master_leads WHERE possible_duplicate_of IS NOT NULL) AS flagged_possible_duplicates`
    );
    return res.json({
      ok: true,
      per_source: lastRuns.rows,
      totals: totals.rows[0]
    });
  } catch (err) {
    console.error('[pipeline:status]', err.message);
    return res.status(500).json({ error: 'status failed', details: err.message });
  }
});

// Recent runs (paginated).
pipelineRouter.get('/runs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await pool.query(
      `SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    return res.json({ ok: true, runs: rows });
  } catch (err) {
    console.error('[pipeline:runs]', err.message);
    return res.status(500).json({ error: 'runs failed', details: err.message });
  }
});
