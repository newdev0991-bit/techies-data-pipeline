// Manually queue historical (INGESTED) leads for validation. Historical rows are
// NOT auto-validated at ingest (backfill policy) — run this when you're ready to
// spend on them. The worker then processes the queue as usual.
//
// Usage: npm run bulk-revalidate [limit]
//   limit  optional max number of leads to queue (default: all)
import 'dotenv/config';
import { pool } from '../db/pool.js';
import { RULES_VERSION } from '../lib/rules.js';

const limit = Number(process.argv[2] || 0);

async function main() {
  const limitClause = limit > 0 ? `LIMIT ${limit}` : '';
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT m.id
        FROM master_leads m
        WHERE m.status = 'INGESTED'
          AND m.hidden_from_combined = false
          AND NOT EXISTS (
            SELECT 1 FROM validation_jobs vj
             WHERE vj.master_lead_id = m.id AND vj.status IN ('PENDING','PROCESSING','RETRY')
          )
        ORDER BY m.created_at
        ${limitClause}
     )
     INSERT INTO validation_jobs (master_lead_id, status, rules_version)
     SELECT id, 'PENDING', $1 FROM candidates
     ON CONFLICT (master_lead_id) WHERE status IN ('PENDING','PROCESSING','RETRY') DO NOTHING
     RETURNING master_lead_id`,
    [RULES_VERSION]
  );

  if (rows.length) {
    await pool.query(
      `UPDATE master_leads SET status = 'READY_FOR_VALIDATION', updated_at = now()
        WHERE id = ANY($1) AND status = 'INGESTED'`,
      [rows.map((r) => r.master_lead_id)]
    );
  }

  console.log(`[bulk-revalidate] queued ${rows.length} historical lead(s) for validation`);
  await pool.end();
}

main().catch((err) => {
  console.error('[bulk-revalidate] failed:', err.message);
  process.exitCode = 1;
  pool.end();
});
