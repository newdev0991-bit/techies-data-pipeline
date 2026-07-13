// Ingestion orchestration: rows -> canonical -> raw_leads upsert -> dedup into
// master_leads + lead_sources -> pipeline_run counts (doc sections 2, 3, 9).
// Each row is processed in its own transaction so one bad row never fails the
// whole batch (doc section 8: don't retry a whole scrape when one record fails).
import { withTransaction } from '../db/pool.js';
import { toCanonical } from './canonical.js';
import { findOrCreateMaster } from './dedup.js';
import { startRun, finishRun } from './pipelineRuns.js';
import { RULES_VERSION } from './rules.js';

const MAX_BATCH = 500; // hard safety cap; sources should send 25–100 (doc section 8)

// Backfill policy (plan): only leads collected at/after the cutover auto-queue for
// validation. Historical rows stay INGESTED until bulk-revalidate is run. Read at
// call time so tests/env changes take effect without re-import.
function shouldEnqueue(canonical) {
  const raw = process.env.PIPELINE_CUTOVER_AT;
  if (!raw) return false; // no cutover configured -> never auto-queue (cost-safe)
  const cutover = new Date(raw);
  if (Number.isNaN(cutover.getTime())) return false;
  const t = canonical.scrape_timestamp ? new Date(canonical.scrape_timestamp) : null;
  return !!t && !Number.isNaN(t.getTime()) && t >= cutover;
}

// Create a PENDING validation job for a new post-cutover master (idempotent via
// the partial-unique active-job index). Sets the lead to READY_FOR_VALIDATION.
async function enqueueValidation(client, masterId) {
  await client.query(
    `INSERT INTO validation_jobs (master_lead_id, status, rules_version)
     VALUES ($1, 'PENDING', $2)
     ON CONFLICT (master_lead_id) WHERE status IN ('PENDING','PROCESSING','RETRY')
     DO NOTHING`,
    [masterId, RULES_VERSION]
  );
  await client.query(
    `UPDATE master_leads SET status = 'READY_FOR_VALIDATION', updated_at = now()
      WHERE id = $1 AND status = 'INGESTED'`,
    [masterId]
  );
}

async function ingestOneRow(runId, source, row) {
  return withTransaction(async (client) => {
    const c = toCanonical(source, row);

    // 1. Store the untouched source occurrence (idempotent on source_record_id).
    const rawRes = await client.query(
      `INSERT INTO raw_leads (source, source_record_id, raw_payload, pipeline_run_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source, source_record_id)
       DO UPDATE SET received_at = now(), pipeline_run_id = EXCLUDED.pipeline_run_id
       RETURNING id, (xmax = 0) AS raw_inserted`,
      [source, c.source_record_id, c.raw_payload, runId]
    );
    const rawId = rawRes.rows[0].id;
    const rawInserted = rawRes.rows[0].raw_inserted;

    // 2. Find or create the deduplicated master lead.
    const { masterId, created, flaggedDuplicateOf } = await findOrCreateMaster(client, c);

    // 3. Link the raw occurrence to its master.
    await client.query('UPDATE raw_leads SET master_lead_id = $2 WHERE id = $1', [rawId, masterId]);

    // 4. Record which source found this master (idempotent per (master, source)).
    await client.query(
      `INSERT INTO lead_sources (master_lead_id, source, source_record_id, raw_lead_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (master_lead_id, source)
       DO UPDATE SET last_seen = now(), raw_lead_id = EXCLUDED.raw_lead_id`,
      [masterId, source, c.source_record_id, rawId]
    );

    // 5. For a brand-new post-cutover master, queue it for validation (Milestone 2).
    let enqueued = false;
    if (created && shouldEnqueue(c)) {
      await enqueueValidation(client, masterId);
      enqueued = true;
    }

    return { masterId, created, rawInserted, flaggedDuplicateOf, enqueued };
  });
}

/**
 * Ingest a list of { source, row } items under one pipeline_run.
 * Returns the doc section-9 counts (with `replayed: true` for idempotent replay).
 */
export async function ingestItems({ items, runSource = null, idempotencyKey = null }) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  if (items.length > MAX_BATCH) throw new Error(`batch too large (${items.length} > ${MAX_BATCH})`);

  const { run, existing } = await startRun({ source: runSource, idempotencyKey });
  if (!run) {
    // Idempotent replay: same key seen before -> return stored counts, do nothing.
    return {
      run_id: existing.id,
      status: existing.status,
      records_received: existing.records_received,
      records_inserted: existing.records_inserted,
      records_updated: existing.records_updated,
      duplicates: existing.duplicates,
      errors: existing.errors,
      replayed: true
    };
  }

  let inserted = 0;
  let updated = 0;
  let duplicates = 0;
  let errors = 0;
  let flagged = 0;
  let jobsCreated = 0;
  const errorSamples = [];

  for (const item of items) {
    try {
      const r = await ingestOneRow(run.id, item.source, item.row);
      if (r.created) inserted += 1;
      else duplicates += 1;
      if (!r.rawInserted) updated += 1;
      if (r.flaggedDuplicateOf) flagged += 1;
      if (r.enqueued) jobsCreated += 1;
    } catch (err) {
      errors += 1;
      if (errorSamples.length < 5) errorSamples.push(err.message);
    }
  }

  const counts = {
    records_received: items.length,
    records_inserted: inserted,
    records_updated: updated,
    duplicates,
    errors,
    status: errors > 0 && inserted === 0 && duplicates === 0 ? 'FAILED' : 'COMPLETED',
    detail: { possible_duplicates_flagged: flagged, validation_jobs_created: jobsCreated, error_samples: errorSamples }
  };
  await finishRun(run.id, counts);

  return { run_id: run.id, ...counts, replayed: false };
}
