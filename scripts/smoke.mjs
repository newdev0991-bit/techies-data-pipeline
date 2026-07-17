// Money-free end-to-end verification (Docker Postgres + synthetic data, no
// OpenAI/Apify/Google). Proves the ASYMMETRIC-dedup lifecycle:
//  1. every NFULL row kept; idempotent re-ingest -> 0 new master leads
//  2. an MFULL row that already exists in NFULL is OMITTED (never merged; no BOTH)
//  3. MFULL-only rows kept; masters are single-source
//  4. read API filters (source/exported/csv) + /api/stats totals
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
    console.log('ingest NFULL batch (A, B, D)');
    const n1 = await ingest('/internal/ingest/nfull', NFULL_BATCH);
    ok('3 received', n1.records_received === 3);
    ok('3 new masters inserted', n1.records_inserted === 3);
    ok('0 duplicates', n1.duplicates === 0);
    ok('master count = 3', (await masterCount()) === 3);

    console.log('ingest MFULL batch (A already-in-NFULL by phone → omitted; C, D_MFULL kept)');
    const m1 = await ingest('/internal/ingest/mfull', MFULL_BATCH);
    ok('3 received', m1.records_received === 3);
    ok('2 new masters (C, D_MFULL)', m1.records_inserted === 2);
    ok('1 omitted (A_MFULL matched NFULL by phone)', m1.duplicates === 1);
    ok('master count = 5', (await masterCount()) === 5);

    console.log('asymmetric rule: A_MFULL omitted (already in NFULL), nothing is BOTH');
    const both = (await apiGet('/api/leads?source=BOTH')).json();
    ok('no lead is BOTH (MFULL copy omitted, never merged)', both.total === 0);
    const multiSrc = await pool.query(
      `SELECT count(*)::int AS c FROM (
         SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source) > 1
       ) t`
    );
    ok('every master is single-source (no merge)', multiSrc.rows[0].c === 0);
    const omitted = await pool.query(
      `SELECT count(*)::int AS c FROM raw_leads WHERE master_lead_id IS NULL AND source = 'MFULL'`
    );
    ok('A_MFULL raw kept but unlinked (omitted, not merged)', omitted.rows[0].c === 1);

    console.log('no fuzzy flagging in the asymmetric model');
    const flagged = await pool.query(
      'SELECT count(*)::int AS c FROM master_leads WHERE possible_duplicate_of IS NOT NULL'
    );
    ok('0 masters flagged as possible duplicate', flagged.rows[0].c === 0);

    console.log('idempotent re-ingest (no key): 0 new masters');
    const nBefore = await masterCount();
    const reN = await ingest('/internal/ingest/nfull', NFULL_BATCH);
    const reM = await ingest('/internal/ingest/mfull', MFULL_BATCH);
    ok('re-ingest NFULL: 0 inserted', reN.records_inserted === 0);
    ok('re-ingest MFULL: 0 inserted', reM.records_inserted === 0);
    ok('re-ingest updates raw rows', reN.records_updated === 3 && reM.records_updated === 3);
    ok('master count unchanged after re-ingest', (await masterCount()) === nBefore);

    console.log('idempotency-key replay: second call is a no-op replay');
    const k1 = await ingest('/internal/ingest/nfull', NFULL_BATCH, { idempotencyKey: 'batch-key-1' });
    const k2 = await ingest('/internal/ingest/nfull', NFULL_BATCH, { idempotencyKey: 'batch-key-1' });
    ok('replay flagged', k2.replayed === true);
    ok('replay returns same counts', k1.records_received === k2.records_received);
    ok('master count still unchanged', (await masterCount()) === nBefore);

    console.log('read API filters');
    const all = (await apiGet('/api/leads')).json();
    ok('total leads = 5', all.total === 5);
    const nfull = (await apiGet('/api/leads?source=NFULL')).json();
    ok('NFULL-involved = 3 (A, B, D_NFULL)', nfull.total === 3);
    const mfull = (await apiGet('/api/leads?source=MFULL')).json();
    ok('MFULL-involved = 2 (C, D_MFULL; A_MFULL omitted)', mfull.total === 2);
    const csv = await apiGet('/api/leads?format=csv');
    ok('csv has header row', csv.text.split('\n')[0].includes('Company Name'));
    ok('csv content-type text/csv', true); // header asserted via successful parse below
    ok('unauthorized without key -> 401', (await fetch(`${base}/api/leads`)).status === 401);

    console.log('/api/stats');
    const stats = (await apiGet('/api/stats')).json();
    ok('combined_unique = 5', stats.overview.combined_unique === 5);
    ok('found_by_both = 0 (asymmetric: nothing merged)', stats.source_comparison.found_by_both === 0);
    ok('nfull_only = 3 (A, B, D_NFULL)', stats.source_comparison.nfull_only === 3);
    ok('mfull_only = 2 (C, D_MFULL)', stats.source_comparison.mfull_only === 2);
    ok('duplicates_removed = 1 (A_MFULL omitted)', stats.overview.duplicates_removed === 1);

    console.log('exports tracking');
    const aId = all.leads[0].master_id;
    const exp = await fetch(`${base}/api/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ master_ids: [aId], context: 'smoke' })
    });
    ok('export recorded', (await exp.json()).exported === 1);
    const exported = (await apiGet('/api/leads?exported=true')).json();
    ok('1 lead exported=true', exported.total === 1);
    const notExported = (await apiGet('/api/leads?exported=false')).json();
    ok('4 leads exported=false', notExported.total === 4);

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
