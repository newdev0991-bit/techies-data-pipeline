// Validation worker (Render background worker). Claims jobs from the Postgres
// queue with FOR UPDATE SKIP LOCKED and runs the 3-layer validation:
//   A. deterministic pre-checks (cheap reject)            -> lib/rules.js
//   B. Facebook evidence via techies-validator-backend    -> /fetch-results
//   C. AI decision via techies-validator-backend          -> /analyze
// Evidence is stored separately and reused on retry. Decisions map onto the doc
// section-5C schema. Retries with backoff; dead-letters after max attempts.
import 'dotenv/config';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pool } from './db/pool.js';
import { runDeterministicChecks, RULES_VERSION } from './lib/rules.js';
import { mapValidatorToDecision } from './lib/decision.js';
import { fetchEvidence, analyzeLead } from './lib/validatorClient.js';
import { mergePayloads } from './lib/leadRow.js';

const WORKER_ID = `${os.hostname?.() || 'worker'}-${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS || 4);
const RETRY_BASE_MIN = Number(process.env.WORKER_RETRY_BASE_MIN ?? 5); // 0 => immediate (tests)
const PROMPT_VERSION = process.env.PROMPT_VERSION || 'validator-remote';

function validatorUrl() {
  return (process.env.TECHIES_VALIDATOR_URL || '').replace(/\/$/, '');
}

let shuttingDown = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- queue ops ----
async function claimJob() {
  const { rows } = await pool.query(
    `WITH j AS (
       SELECT id FROM validation_jobs
        WHERE status IN ('PENDING','RETRY')
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE validation_jobs vj
        SET status = 'PROCESSING', locked_at = now(), locked_by = $1,
            attempt_count = attempt_count + 1, updated_at = now()
       FROM j WHERE vj.id = j.id
       RETURNING vj.*`,
    [WORKER_ID]
  );
  return rows[0] || null;
}

async function setMasterStatus(masterId, status) {
  await pool.query('UPDATE master_leads SET status = $2, updated_at = now() WHERE id = $1', [masterId, status]);
}

async function finishJob(jobId, status) {
  await pool.query(
    `UPDATE validation_jobs SET status = $2, locked_at = NULL, locked_by = NULL, updated_at = now() WHERE id = $1`,
    [jobId, status]
  );
}

async function storeResult(masterId, jobId, d, extra = {}) {
  await pool.query(
    `INSERT INTO validation_results
       (master_lead_id, job_id, decision, score, confidence, lead_type, intent,
        business_status, contact_status, is_residential, is_promotional,
        requires_manual_review, reasons, extracted, layer, rules_version,
        prompt_version, model, prompt_tokens, completion_tokens, ai_cost_usd, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      masterId, jobId, d.decision, d.score ?? null, d.confidence ?? null, d.lead_type ?? null,
      d.intent ?? null, d.business_status ?? null, d.contact_status ?? null,
      d.is_residential ?? null, d.is_promotional ?? null, d.requires_manual_review ?? null,
      JSON.stringify(d.reasons ?? []), JSON.stringify(d.extracted ?? {}),
      extra.layer ?? 'ai', RULES_VERSION, extra.prompt_version ?? PROMPT_VERSION,
      extra.model ?? null, extra.prompt_tokens ?? null, extra.completion_tokens ?? null,
      extra.ai_cost_usd ?? null, extra.raw ? JSON.stringify(extra.raw) : null
    ]
  );
}

async function getEvidence(masterId) {
  const { rows } = await pool.query('SELECT * FROM lead_evidence WHERE master_lead_id = $1', [masterId]);
  return rows[0] || null;
}

async function storeEvidence(masterId, ev, provider) {
  const { rows } = await pool.query(
    `INSERT INTO lead_evidence (master_lead_id, provider, post_exists, post_text, author, post_date, previous_posts, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (master_lead_id) DO UPDATE
       SET provider = EXCLUDED.provider, post_exists = EXCLUDED.post_exists, post_text = EXCLUDED.post_text,
           author = EXCLUDED.author, post_date = EXCLUDED.post_date, previous_posts = EXCLUDED.previous_posts,
           raw = EXCLUDED.raw, collected_at = now()
     RETURNING *`,
    [
      masterId, provider,
      ev?.success !== false && ev?.status !== 'not_found',
      ev?.postText ?? null, ev?.rawData?.author ?? null, ev?.postDate ?? null,
      JSON.stringify(ev?.previousPosts ?? []), JSON.stringify(ev ?? {})
    ]
  );
  return rows[0];
}

// ---- job processing ----
async function processJob(job) {
  const master = (await pool.query('SELECT * FROM master_leads WHERE id = $1', [job.master_lead_id])).rows[0];
  if (!master) { await finishJob(job.id, 'COMPLETED'); return; }

  await setMasterStatus(master.id, 'VALIDATING');

  // Layer A — deterministic reject (no validator spend).
  const pre = runDeterministicChecks(master);
  if (pre.decision === 'REJECTED') {
    await storeResult(master.id, job.id, {
      decision: 'REJECTED', score: 0, confidence: 1,
      lead_type: 'UNKNOWN', intent: 'LOW', business_status: 'UNKNOWN',
      contact_status: master.phone ? 'CONTACT_FOUND' : 'NO_CONTACT',
      is_residential: false, is_promotional: false, requires_manual_review: false,
      reasons: [`Deterministic reject: ${pre.reason}`],
      extracted: { business_name: master.business_name, phone: master.phone, email: null, postcode: master.postcode }
    }, { layer: 'deterministic' });
    await setMasterStatus(master.id, 'REJECTED');
    await finishJob(job.id, 'COMPLETED');
    return;
  }

  const payloads = (await pool.query('SELECT raw_payload FROM raw_leads WHERE master_lead_id = $1', [master.id]))
    .rows.map((r) => r.raw_payload);
  const leadRow = mergePayloads(payloads);

  // Layer B — evidence (reuse existing to avoid repeat Apify calls).
  let evidence = await getEvidence(master.id);
  if (!evidence && validatorUrl()) {
    try {
      const ev = await fetchEvidence(validatorUrl(), leadRow);
      evidence = await storeEvidence(master.id, ev, 'validator');
    } catch (err) {
      // Evidence is best-effort; proceed to AI without it (matches the old UI).
      console.warn(`[worker] evidence failed for master ${master.id}: ${err.message}`);
    }
  }
  if (evidence?.raw) leadRow.fetchResults = evidence.raw;

  // Layer C — AI decision (throws on transient error -> retry).
  const vresp = await analyzeLead(validatorUrl(), leadRow);
  const decision = mapValidatorToDecision(vresp, { master, flags: pre.flags });

  await storeResult(master.id, job.id, decision, { layer: 'ai', raw: vresp, prompt_version: PROMPT_VERSION });
  await setMasterStatus(master.id, decision.decision);
  await finishJob(job.id, decision.decision === 'REVIEW_REQUIRED' ? 'MANUAL_REVIEW' : 'COMPLETED');
}

async function handleFailure(job, err) {
  const msg = String(err?.message || err).slice(0, 500);
  if (job.attempt_count >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE validation_jobs SET status = 'FAILED', last_error = $2, locked_at = NULL, locked_by = NULL, updated_at = now() WHERE id = $1`,
      [job.id, msg]
    );
    // Surface dead-lettered leads for a human rather than leaving them VALIDATING.
    await setMasterStatus(job.master_lead_id, 'REVIEW_REQUIRED');
    console.error(`[worker] job ${job.id} DEAD-LETTERED after ${job.attempt_count} attempts: ${msg}`);
  } else {
    const minutes = job.attempt_count * RETRY_BASE_MIN;
    await pool.query(
      `UPDATE validation_jobs
          SET status = 'RETRY', next_retry_at = now() + ($2 || ' minutes')::interval,
              last_error = $3, locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE id = $1`,
      [job.id, String(minutes), msg]
    );
    console.warn(`[worker] job ${job.id} retry ${job.attempt_count}/${MAX_ATTEMPTS} in ${minutes}m: ${msg}`);
  }
}

/** Claim and process a single job. Returns true if a job was handled. */
export async function runOnce() {
  const job = await claimJob();
  if (!job) return false;
  try {
    await processJob(job);
  } catch (err) {
    await handleFailure(job, err);
  }
  return true;
}

/** Drain all currently-claimable jobs (used by tests). */
export async function drainQueue(maxIterations = 1000) {
  let handled = 0;
  for (let i = 0; i < maxIterations; i++) {
    // eslint-disable-next-line no-await-in-loop
    const did = await runOnce();
    if (!did) break;
    handled += 1;
  }
  return handled;
}

async function main() {
  if (!validatorUrl()) { console.error('[worker] TECHIES_VALIDATOR_URL not set'); process.exit(1); }
  console.log(`[worker] ${WORKER_ID} polling every ${POLL_MS}ms (validator: ${validatorUrl()})`);
  const stop = () => { shuttingDown = true; console.log('[worker] shutdown requested; finishing current job...'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!shuttingDown) {
    let did = false;
    try { did = await runOnce(); }
    catch (err) { console.error('[worker] loop error:', err.message); }
    if (!shuttingDown && !did) await sleep(POLL_MS); // idle
  }
  await pool.end();
  console.log('[worker] stopped cleanly');
}

if (process.argv[1] && process.argv[1].endsWith('worker.js')) {
  main();
}
