// Set-based bulk ingestion: rows -> canonical -> a staging temp table -> a handful
// of set-based SQL statements per chunk (raw upsert, NFULL master upsert, MFULL
// filtered-against-NFULL upsert, link, lead_sources). Asymmetric rule: keep every
// NFULL row; drop an MFULL row only if its match_key already exists in NFULL. This
// keeps round-trips ~constant per chunk (per-row was ~0.8s/row over a remote DB).
import { withTransaction } from '../db/pool.js';
import { toCanonical } from './canonical.js';
import { fingerprint } from './fingerprint.js';
import { startRun, finishRun } from './pipelineRuns.js';
import { RULES_VERSION } from './rules.js';

const MAX_BATCH = 50000;                       // hard safety cap on one call
const CHUNK = Number(process.env.INGEST_CHUNK || 1000);

function cutoverAt() {
  const raw = process.env.PIPELINE_CUTOVER_AT;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const STG_COLS = [
  'source', 'source_record_id', 'dedup_key', 'match_key', 'post_id', 'url', 'owner_name', 'message',
  'post_timestamp', 'scrape_timestamp', 'business_name', 'phone', 'phone2', 'email',
  'postcode', 'address1', 'location', 'norm_permalink', 'norm_phone', 'fingerprint', 'raw_payload'
];

async function ingestChunk(client, runId, canonicals) {
  // Build one array per staging column for a single unnest-based bulk insert.
  const c = Object.fromEntries(STG_COLS.map((k) => [k, []]));
  for (const x of canonicals) {
    c.source.push(x.source);
    c.source_record_id.push(x.source_record_id);
    c.dedup_key.push(x.dedup_key);
    c.match_key.push(x.match_key);
    c.post_id.push(x.post_id);
    c.url.push(x.url);
    c.owner_name.push(x.owner_name);
    c.message.push(x.message);
    c.post_timestamp.push(x.post_timestamp);
    c.scrape_timestamp.push(x.scrape_timestamp);
    c.business_name.push(x.business_name);
    c.phone.push(x.phone);
    c.phone2.push(x.phone2);
    c.email.push(x.email);
    c.postcode.push(x.postcode);
    c.address1.push(x.address1);
    c.location.push(x.location);
    c.norm_permalink.push(x.norm_permalink);
    c.norm_phone.push(x.norm_phone);
    c.fingerprint.push(fingerprint(x));
    c.raw_payload.push(JSON.stringify(x.raw_payload));
  }

  await client.query(`
    CREATE TEMP TABLE stg (
      source lead_source_name, source_record_id text, dedup_key text, match_key text, post_id text,
      url text, owner_name text, message text, post_timestamp timestamptz,
      scrape_timestamp timestamptz, business_name text, phone text, phone2 text,
      email text, postcode text, address1 text, location text, norm_permalink text,
      norm_phone text, fingerprint text, raw_payload jsonb
    ) ON COMMIT DROP`);

  await client.query(
    `INSERT INTO stg SELECT * FROM unnest(
       $1::lead_source_name[], $2::text[], $3::text[], $4::text[], $5::text[],
       $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::timestamptz[],
       $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[],
       $17::text[], $18::text[], $19::text[], $20::text[], $21::jsonb[])`,
    STG_COLS.map((k) => c[k])
  );

  // 1. raw_leads: one row per source occurrence (dedupe within-chunk by key).
  const rawRes = await client.query(
    `INSERT INTO raw_leads (source, source_record_id, raw_payload, pipeline_run_id)
     SELECT DISTINCT ON (source, source_record_id) source, source_record_id, raw_payload, $1
       FROM stg ORDER BY source, source_record_id
     ON CONFLICT (source, source_record_id) DO UPDATE SET received_at = now(), pipeline_run_id = EXCLUDED.pipeline_run_id
     RETURNING (xmax = 0) AS inserted`,
    [runId]
  );
  const rawInserted = rawRes.rows.filter((r) => r.inserted).length;
  const rawUpdated = rawRes.rows.length - rawInserted;

  // 2. master_leads — ASYMMETRIC rule (one master per distinct row; dedup_key is a
  //    per-row hash so nothing collapses within a source):
  //    (2a) keep EVERY NFULL row; (2b) keep an MFULL row only when its match_key is
  //    NULL or not already present among NFULL masters. NFULL is inserted first so
  //    (2b) compares against a complete NFULL base (even within one mixed chunk).
  const masterCols = `dedup_key, source, match_key, post_id, url, owner_name, message, post_timestamp,
        scrape_timestamp, business_name, phone, phone2, email, postcode, address1, location,
        norm_permalink, norm_phone, fingerprint, status`;
  const masterSel = `dedup_key, source, match_key, post_id, url, owner_name, message, post_timestamp,
        scrape_timestamp, business_name, phone, phone2, email, postcode, address1, location,
        norm_permalink, norm_phone, fingerprint, 'INGESTED'`;

  const nfullRes = await client.query(
    `INSERT INTO master_leads (${masterCols})
     SELECT DISTINCT ON (dedup_key) ${masterSel}
       FROM stg WHERE source = 'NFULL' ORDER BY dedup_key
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`
  );

  const mfullRes = await client.query(
    `INSERT INTO master_leads (${masterCols})
     SELECT DISTINCT ON (dedup_key) ${masterSel}
       FROM stg s
      WHERE s.source = 'MFULL'
        AND (s.match_key IS NULL
             OR NOT EXISTS (SELECT 1 FROM master_leads n WHERE n.source = 'NFULL' AND n.match_key = s.match_key))
      ORDER BY dedup_key
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`
  );

  const newMasterIds = [...nfullRes.rows, ...mfullRes.rows].map((r) => r.id);
  const inserted = newMasterIds.length;

  // 3. link raw_leads -> master via dedup_key.
  await client.query(
    `UPDATE raw_leads r SET master_lead_id = m.id
       FROM stg s JOIN master_leads m ON m.dedup_key = s.dedup_key
      WHERE r.source = s.source AND r.source_record_id = s.source_record_id
        AND r.master_lead_id IS DISTINCT FROM m.id`
  );

  // 4. lead_sources: which sources found each master (dedupe within-chunk).
  await client.query(
    `INSERT INTO lead_sources (master_lead_id, source, source_record_id, raw_lead_id)
     SELECT DISTINCT ON (m.id, s.source) m.id, s.source, s.source_record_id, r.id
       FROM stg s
       JOIN master_leads m ON m.dedup_key = s.dedup_key
       JOIN raw_leads r ON r.source = s.source AND r.source_record_id = s.source_record_id
      ORDER BY m.id, s.source
     ON CONFLICT (master_lead_id, source) DO UPDATE SET last_seen = now(), raw_lead_id = EXCLUDED.raw_lead_id`
  );

  // 5. count MFULL rows dropped because they already exist in NFULL (asymmetric rule).
  //    (Replaces the old fuzzy possible_duplicate flag, which the new model retires.)
  const omitRes = await client.query(
    `SELECT count(*)::int AS omitted FROM stg s
      WHERE s.source = 'MFULL' AND s.match_key IS NOT NULL
        AND EXISTS (SELECT 1 FROM master_leads n WHERE n.source = 'NFULL' AND n.match_key = s.match_key)`
  );
  const mfullOmitted = omitRes.rows[0].omitted;

  // 6. enqueue validation for NEW post-cutover masters (backfill policy).
  let jobsCreated = 0;
  const cutover = cutoverAt();
  if (cutover && newMasterIds.length) {
    const jobRes = await client.query(
      `INSERT INTO validation_jobs (master_lead_id, status, rules_version)
       SELECT id, 'PENDING', $2 FROM master_leads
        WHERE id = ANY($1) AND scrape_timestamp IS NOT NULL AND scrape_timestamp >= $3
       ON CONFLICT (master_lead_id) WHERE status IN ('PENDING','PROCESSING','RETRY') DO NOTHING
       RETURNING master_lead_id`,
      [newMasterIds, RULES_VERSION, cutover]
    );
    jobsCreated = jobRes.rowCount;
    if (jobsCreated) {
      await client.query(
        `UPDATE master_leads SET status = 'READY_FOR_VALIDATION'
          WHERE id = ANY($1) AND status = 'INGESTED'`,
        [jobRes.rows.map((r) => r.master_lead_id)]
      );
    }
  }

  return { received: canonicals.length, inserted, rawUpdated, mfullOmitted, jobsCreated };
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
    return {
      run_id: existing.id, status: existing.status,
      records_received: existing.records_received, records_inserted: existing.records_inserted,
      records_updated: existing.records_updated, duplicates: existing.duplicates,
      errors: existing.errors, detail: existing.detail, replayed: true
    };
  }

  // Ingest all NFULL rows before any MFULL, so the "MFULL exists in NFULL" check
  // always sees a complete NFULL base — even when a single batch mixes both sources.
  const canonicals = items.map((it) => toCanonical(it.source, it.row))
    .sort((a, b) => (a.source === 'NFULL' ? 0 : 1) - (b.source === 'NFULL' ? 0 : 1));

  let received = 0; let inserted = 0; let updated = 0; let mfullOmitted = 0; let jobsCreated = 0; let errors = 0;
  const errorSamples = [];

  for (let i = 0; i < canonicals.length; i += CHUNK) {
    const chunk = canonicals.slice(i, i + CHUNK);
    try {
      const r = await withTransaction((client) => ingestChunk(client, run.id, chunk));
      received += r.received; inserted += r.inserted; updated += r.rawUpdated;
      mfullOmitted += r.mfullOmitted; jobsCreated += r.jobsCreated;
    } catch (err) {
      errors += chunk.length;
      if (errorSamples.length < 5) errorSamples.push(err.message);
    }
  }

  const duplicates = received - inserted;
  const counts = {
    records_received: items.length,
    records_inserted: inserted,
    records_updated: updated,
    duplicates,
    errors,
    status: errors > 0 && inserted === 0 ? 'FAILED' : 'COMPLETED',
    detail: { mfull_omitted: mfullOmitted, validation_jobs_created: jobsCreated, error_samples: errorSamples }
  };
  await finishRun(run.id, counts);
  return { run_id: run.id, ...counts, replayed: false };
}
