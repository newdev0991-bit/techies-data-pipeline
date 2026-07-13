// Milestone 2 verification (money-free): runs the worker against the MOCK
// validator and drives synthetic leads through the full 3-layer flow, asserting
// APPROVED / REVIEW_REQUIRED / REJECTED, deterministic reject (no AI call),
// AI-vs-rules disagreement, evidence storage, and retry -> dead-letter.
import 'dotenv/config';
import assert from 'node:assert/strict';

const MOCK_PORT = 4601;
// Configure the worker BEFORE importing it (module-level constants).
process.env.PIPELINE_CUTOVER_AT = '2020-01-01T00:00:00Z';
process.env.TECHIES_VALIDATOR_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.WORKER_MAX_ATTEMPTS = '2';
process.env.WORKER_RETRY_BASE_MIN = '0'; // immediate retries so drain completes

const { pool } = await import('../src/db/pool.js');
const { ingestItems } = await import('../src/lib/ingest.js');
const { drainQueue } = await import('../src/worker.js');
const { startMockValidator } = await import('./mock-validator.mjs');

let passed = 0;
function ok(name, cond) { assert.ok(cond, `FAILED: ${name}`); passed += 1; console.log(`  ✓ ${name}`); }

const now = '2026-07-13 09:00:00';
function lead(company, statement, url, phone = '01234 567890') {
  return {
    'Lead Statement': statement, 'Timestamp': now, 'Company Name': company,
    'Phone Number': phone,
    'Address 1 (Road/Street/Lane/Park/Industrial Estate)': '1 Test St',
    'Address 2 (Village/Town/City)': 'Chester', 'Phone 2': '',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH1 1AA',
    'Lead Proof URL': url
  };
}

// Distinct phones so leads don't dedup on norm_phone (they're different businesses).
const LEADS = [
  lead('ABC Cafe', 'Grand opening this Saturday!', 'https://www.facebook.com/abc/posts/9001', '01234 500001'),     // APPROVED
  lead('Beacon Beauty', 'We have moved to new premises', 'https://www.facebook.com/bb/posts/9002', '01234 500002'), // REVIEW (score 60)
  lead('Corner Bistro', 'Check out our new menu', 'https://www.facebook.com/cb/posts/9003', '01234 500003'),        // REJECTED (verdict BAD)
  lead('Edu Academy', 'Grand opening of our new school', 'https://www.facebook.com/edu/posts/9004', '01234 500004'),// disagreement -> REVIEW
  lead('NoProof Ltd', 'We are opening soon', '', '01234 500005'),                                                    // deterministic reject
  lead('Boom Co', 'Now open for business', 'https://www.facebook.com/boom/posts/9006', '01234 500006')              // retry -> FAILED
];

async function statusOf(company) {
  const { rows } = await pool.query(
    `SELECT status FROM master_leads WHERE business_name = $1 LIMIT 1`, [company]
  );
  return rows[0]?.status;
}
async function resultOf(company) {
  const { rows } = await pool.query(
    `SELECT vr.* FROM validation_results vr
       JOIN master_leads m ON m.id = vr.master_lead_id
      WHERE m.business_name = $1 ORDER BY vr.id DESC LIMIT 1`, [company]
  );
  return rows[0];
}

async function run() {
  await pool.query('TRUNCATE raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs, validation_jobs, validation_results, lead_evidence RESTART IDENTITY CASCADE');
  const mock = await startMockValidator(MOCK_PORT);
  try {
    const ing = await ingestItems({ items: LEADS.map((row) => ({ source: 'NFULL', row })), runSource: 'NFULL' });
    ok('all 6 leads ingested as new masters', ing.records_inserted === 6);
    ok('6 validation jobs auto-queued (post-cutover)', ing.detail.validation_jobs_created === 6);

    const handled = await drainQueue();
    ok('worker handled all queued jobs (incl. retries)', handled >= 6);

    ok('ABC -> APPROVED', (await statusOf('ABC Cafe')) === 'APPROVED');
    ok('Beacon -> REVIEW_REQUIRED (score 60)', (await statusOf('Beacon Beauty')) === 'REVIEW_REQUIRED');
    ok('Corner -> REJECTED (verdict BAD)', (await statusOf('Corner Bistro')) === 'REJECTED');
    ok('Edu -> REVIEW_REQUIRED (AI/rules disagreement)', (await statusOf('Edu Academy')) === 'REVIEW_REQUIRED');
    ok('NoProof -> REJECTED', (await statusOf('NoProof Ltd')) === 'REJECTED');

    const noProof = await resultOf('NoProof Ltd');
    ok('NoProof rejected by DETERMINISTIC layer (no AI spend)', noProof.layer === 'deterministic');
    ok('NoProof reason is missing proof', JSON.stringify(noProof.reasons).includes('missing_or_invalid_proof'));

    const abc = await resultOf('ABC Cafe');
    ok('ABC result stored by AI layer', abc.layer === 'ai');
    ok('ABC lead_type COMMERCIAL_COT', abc.lead_type === 'COMMERCIAL_COT');
    ok('ABC score 88', abc.score === 88);

    const edu = await resultOf('Edu Academy');
    ok('Edu flagged requires_manual_review', edu.requires_manual_review === true);
    ok('Edu reasons mention disagreement', JSON.stringify(edu.reasons).toLowerCase().includes('manual review'));

    const evidence = await pool.query(`SELECT count(*)::int c FROM lead_evidence`);
    ok('evidence stored separately from decisions', evidence.rows[0].c >= 4);

    const boomJob = await pool.query(
      `SELECT vj.status, vj.attempt_count FROM validation_jobs vj
         JOIN master_leads m ON m.id = vj.master_lead_id WHERE m.business_name = 'Boom Co'`
    );
    ok('Boom job dead-lettered as FAILED', boomJob.rows[0].status === 'FAILED');
    ok('Boom retried up to max attempts', boomJob.rows[0].attempt_count === 2);
    ok('Boom lead surfaced for review after dead-letter', (await statusOf('Boom Co')) === 'REVIEW_REQUIRED');

    console.log(`\nMilestone 2 validation smoke: ${passed} checks passed ✅`);
  } finally {
    mock.close();
    await pool.end();
  }
}

run().catch((err) => { console.error('\n❌ validation smoke failed:', err && (err.stack || err)); process.exitCode = 1; });
