// pipeline_runs helpers. Records the doc section-9 import summary and supports
// idempotent replay: re-sending the same idempotency key returns the stored
// counts instead of reprocessing.
import { pool } from '../db/pool.js';

/**
 * Start a run. If `idempotencyKey` is given and already exists, returns
 * { run: null, existing } so the caller can replay the stored counts.
 */
export async function startRun({ source = null, idempotencyKey = null }) {
  if (idempotencyKey) {
    const ins = await pool.query(
      `INSERT INTO pipeline_runs (source, idempotency_key, status)
       VALUES ($1, $2, 'RUNNING')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [source, idempotencyKey]
    );
    if (ins.rows.length === 0) {
      const existing = await pool.query(
        'SELECT * FROM pipeline_runs WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      return { run: null, existing: existing.rows[0] };
    }
    return { run: ins.rows[0], existing: null };
  }

  const ins = await pool.query(
    `INSERT INTO pipeline_runs (source, status) VALUES ($1, 'RUNNING') RETURNING *`,
    [source]
  );
  return { run: ins.rows[0], existing: null };
}

/** Finish a run, writing the count breakdown. */
export async function finishRun(runId, counts) {
  const {
    records_received = 0,
    records_inserted = 0,
    records_updated = 0,
    duplicates = 0,
    errors = 0,
    status = 'COMPLETED',
    detail = {}
  } = counts;

  const { rows } = await pool.query(
    `UPDATE pipeline_runs
       SET finished_at = now(),
           records_received = $2,
           records_inserted = $3,
           records_updated = $4,
           duplicates = $5,
           errors = $6,
           status = $7,
           detail = $8
     WHERE id = $1
     RETURNING *`,
    [runId, records_received, records_inserted, records_updated, duplicates, errors, status, detail]
  );
  return rows[0];
}
