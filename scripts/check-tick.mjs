// Verify POST /internal/tick (free-tier scheduler endpoint): auth, param handling,
// and the validation batch path — against the MOCK validator (no cost). The
// direct-Google ingest path is covered by valuesToRows unit tests + a separate
// live read-only test; here sources are unconfigured so ingest is a no-op.
import 'dotenv/config';
import assert from 'node:assert/strict';

const MOCK_PORT = 4602;
process.env.PIPELINE_CUTOVER_AT = '2020-01-01T00:00:00Z';
process.env.TECHIES_VALIDATOR_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.WORKER_MAX_ATTEMPTS = '2';
process.env.WORKER_RETRY_BASE_MIN = '0';
process.env.PORT = '4193';
// Ensure no real Google config -> tick ingest is a no-op for this test.
delete process.env.NFULL_SPREADSHEET_ID;
delete process.env.MFULL_SPREADSHEET_ID;

const { app } = await import('../src/server.js');
const { pool } = await import('../src/db/pool.js');
const { ingestItems } = await import('../src/lib/ingest.js');
const { startMockValidator } = await import('./mock-validator.mjs');
const { A_NFULL, B_NFULL } = await import('./sample-leads.mjs');

const TOKEN = process.env.PIPELINE_API_TOKEN;
let passed = 0;
function ok(n, c) { assert.ok(c, `FAILED: ${n}`); passed += 1; console.log(`  ✓ ${n}`); }

async function tick(body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch('http://127.0.0.1:4193/internal/tick', {
    method: 'POST', headers, body: JSON.stringify(body || {})
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function run() {
  await pool.query('TRUNCATE raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs, validation_jobs, validation_results, lead_evidence RESTART IDENTITY CASCADE');
  await ingestItems({ items: [{ source: 'NFULL', row: A_NFULL }, { source: 'NFULL', row: B_NFULL }], runSource: 'NFULL' });

  const mock = await startMockValidator(MOCK_PORT);
  const server = await new Promise((r) => { const s = app.listen(4193, () => r(s)); });
  try {
    ok('unauthorized tick -> 401', (await tick({}, false)).status === 401);

    const pending = (await pool.query("SELECT count(*)::int c FROM validation_jobs WHERE status='PENDING'")).rows[0].c;
    ok('2 jobs enqueued at ingest (post-cutover)', pending === 2);

    const r = await tick({ ingest: false, validate: 5 });
    ok('tick 200', r.status === 200);
    ok('tick validated the 2 pending jobs', r.json.validated === 2);
    ok('tick did no ingest (no sources configured)', Array.isArray(r.json.ingest) && r.json.ingest.length === 0);

    const missingMfull = await tick({ sources: ['MFULL'], validate: 0 });
    ok('explicit unconfigured MFULL capture reports failure',
      missingMfull.status === 200 && missingMfull.json.ok === false &&
      missingMfull.json.errors.some((e) => e.includes('MFULL: source is not configured')));

    const invalidSource = await tick({ sources: ['OTHER'], validate: 0 });
    ok('invalid source selector -> 400', invalidSource.status === 400);

    const decided = (await pool.query("SELECT count(*)::int c FROM master_leads WHERE status IN ('APPROVED','REVIEW_REQUIRED','REJECTED')")).rows[0].c;
    ok('both leads now have decisions', decided === 2);

    const again = await tick({ ingest: false, validate: 5 });
    ok('second tick is a no-op (queue empty)', again.json.validated === 0);

    console.log(`\nTick orchestration: ${passed} checks passed ✅`);
  } finally {
    server.close();
    mock.close();
    await pool.end();
  }
}

run().catch((err) => { console.error('\n❌ tick check failed:', err && (err.stack || err)); process.exitCode = 1; pool.end(); });
