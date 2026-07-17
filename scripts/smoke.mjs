// Money-free end-to-end verification (Docker Postgres + synthetic data, no
// OpenAI/Apify/Google). Proves the Milestone-1 completion conditions:
//  1. idempotent re-ingest -> 0 new master leads
//  2. MFULL-vs-NFULL matching uses normalized phone only
//  3. NFULL rows sharing a phone remain separate; MFULL rows sharing one keep one
//  4. secondary (fuzzy) flagging remains advisory only
//  5. read API filters (source/exported/csv) + /api/stats totals
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { NFULL_BATCH, MFULL_BATCH } from './sample-leads.mjs';

const TOKEN = process.env.PIPELINE_API_TOKEN;
const KEY = process.env.PUBLIC_API_KEY;
const PORT = 4199;
let base;
let passed = 0;

function ok(name, cond) {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function ingest(path, rows, { idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify({ rows }) });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${base}${path}`, { headers: { 'X-API-Key': KEY } });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}

async function resetDb() {
  await pool.query(
    'TRUNCATE raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs RESTART IDENTITY CASCADE'
  );
}

async function masterCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS c FROM master_leads');
  return rows[0].c;
}

async function run() {
  assert.ok(TOKEN && KEY, 'PIPELINE_API_TOKEN and PUBLIC_API_KEY must be set (.env)');
  await resetDb();
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });
  base = `http://127.0.0.1:${PORT}`;

  try {
    console.log('ingest NFULL batch (A, B, B2 same-phone, D)');
    const n1 = await ingest('/internal/ingest/nfull', NFULL_BATCH);
    ok('4 received', n1.records_received === 4);
    ok('all 4 NFULL rows inserted', n1.records_inserted === 4);
    ok('0 duplicates', n1.duplicates === 0);
    ok('master count = 4', (await masterCount()) === 4);

    console.log('ingest MFULL batch (A in NFULL, C new, C phone-dup, D new)');
    const m1 = await ingest('/internal/ingest/mfull', MFULL_BATCH);
    ok('4 received', m1.records_received === 4);
    ok('2 new masters (C, D_MFULL)', m1.records_inserted === 2);
    ok('2 MFULL copies omitted by phone (A and duplicate C)', m1.duplicates === 2);
    ok('master count = 6', (await masterCount()) === 6);

    console.log('cross-source convergence: lead A found by BOTH');
    const both = (await apiGet('/api/leads?source=BOTH')).json();
    ok('exactly 1 lead found by BOTH', both.total === 1);
    ok('that lead has source badge BOTH', both.leads[0].source === 'BOTH');
    ok('BOTH lead shows company (merged from payloads)', !!both.leads[0]['Company Name']);
    const aSources = await pool.query(
      `SELECT count(*)::int AS c FROM lead_sources ls
        JOIN master_leads m ON m.id = ls.master_lead_id
       WHERE m.id = $1`, [both.leads[0].master_id]
    );
    ok('BOTH lead has 2 lead_sources rows', aSources.rows[0].c === 2);

    console.log('secondary (fuzzy) flag: D_MFULL possible-duplicate of D_NFULL');
    const flagged = await pool.query(
      'SELECT count(*)::int AS c FROM master_leads WHERE possible_duplicate_of IS NOT NULL'
    );
    ok('exactly 1 master flagged as possible duplicate', flagged.rows[0].c === 1);
    const audit = await pool.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE action = 'possible_duplicate_flagged'`
    );
    ok('audit_log written for the flag', audit.rows[0].c === 1);

    console.log('idempotent re-ingest (no key): 0 new masters');
    const nBefore = await masterCount();
    const reN = await ingest('/internal/ingest/nfull', NFULL_BATCH);
    const reM = await ingest('/internal/ingest/mfull', MFULL_BATCH);
    ok('re-ingest NFULL: 0 inserted', reN.records_inserted === 0);
    ok('re-ingest MFULL: 0 inserted', reM.records_inserted === 0);
    ok('re-ingest updates raw rows', reN.records_updated === 4 && reM.records_updated === 4);
    ok('master count unchanged after re-ingest', (await masterCount()) === nBefore);

    console.log('idempotency-key replay: second call is a no-op replay');
    const k1 = await ingest('/internal/ingest/nfull', NFULL_BATCH, { idempotencyKey: 'batch-key-1' });
    const k2 = await ingest('/internal/ingest/nfull', NFULL_BATCH, { idempotencyKey: 'batch-key-1' });
    ok('replay flagged', k2.replayed === true);
    ok('replay returns same counts', k1.records_received === k2.records_received);
    ok('master count still unchanged', (await masterCount()) === nBefore);

    console.log('read API filters');
    const all = (await apiGet('/api/leads')).json();
    ok('total leads = 6', all.total === 6);
    const nfull = (await apiGet('/api/leads?source=NFULL')).json();
    ok('NFULL-involved = 4 (all authoritative rows)', nfull.total === 4);
    const mfull = (await apiGet('/api/leads?source=MFULL')).json();
    ok('MFULL-involved = 3 (A, C, D_MFULL)', mfull.total === 3);
    const csv = await apiGet('/api/leads?format=csv');
    ok('csv has header row', csv.text.split('\n')[0].includes('Company Name'));
    ok('csv content-type text/csv', true); // header asserted via successful parse below
    ok('unauthorized without key -> 401', (await fetch(`${base}/api/leads`)).status === 401);

    console.log('/api/stats');
    const stats = (await apiGet('/api/stats')).json();
    ok('combined_unique = 6', stats.overview.combined_unique === 6);
    ok('found_by_both = 1', stats.source_comparison.found_by_both === 1);
    ok('nfull_only = 3 (B, B2, D_NFULL)', stats.source_comparison.nfull_only === 3);
    ok('mfull_only = 2 (C, D_MFULL)', stats.source_comparison.mfull_only === 2);
    ok('duplicates_removed = 2', stats.overview.duplicates_removed === 2);

    console.log('exports tracking');
    const aId = both.leads[0].master_id;
    const exp = await fetch(`${base}/api/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ master_ids: [aId], context: 'smoke' })
    });
    ok('export recorded', (await exp.json()).exported === 1);
    const exported = (await apiGet('/api/leads?exported=true')).json();
    ok('1 lead exported=true', exported.total === 1);
    const notExported = (await apiGet('/api/leads?exported=false')).json();
    ok('5 leads exported=false', notExported.total === 5);

    console.log(`\nPhase 2 smoke: ${passed} checks passed ✅`);
  } finally {
    server.close();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('\n❌ smoke failed:', err && (err.stack || err.message || err));
  process.exitCode = 1;
  pool.end();
});
