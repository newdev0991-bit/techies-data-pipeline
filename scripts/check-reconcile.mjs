// Phase 3 verification (money-free, no Google): stands up the pipeline web server
// plus a tiny local "source" HTTP server that returns synthetic NFULL/MFULL CSVs
// behind an X-API-Key, then runs the reconciliation cron and asserts the leads
// landed (deduplicated) in Postgres. Also proves per-source outage isolation.
import 'dotenv/config';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EXPECTED_HEADERS } from '../src/lib/canonical.js';

const KEY_TOKEN = process.env.PIPELINE_API_TOKEN;
assert.ok(KEY_TOKEN, 'PIPELINE_API_TOKEN must be set (.env)');

const PIPELINE_PORT = 4197;
const SOURCE_PORT = 4196;
const SOURCE_KEY = 'source-secret';

let passed = 0;
function ok(name, cond) { assert.ok(cond, `FAILED: ${name}`); passed += 1; console.log(`  ✓ ${name}`); }

function toCsv(objs, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...objs.map((o) => headers.map((h) => esc(o[h])).join(','))].join('\n');
}

// Synthetic CSVs. NFULL emits its 9 columns; MFULL includes lead A too (same
// proof URL) so reconciliation should converge them to one master.
const NFULL_ROWS = [
  { 'Lead Statement': 'Grand opening!', 'Timestamp': '2026-07-12 09:00', 'Company Name': 'ABC Café',
    'Phone Number': '01234 567890', 'Address 1 (Road/Street/Lane/Park/Industrial Estate)': '10 High St',
    'Address 2 (Village/Town/City)': 'Birkenhead', 'Phone 2': '',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH41 5LH',
    'Lead Proof URL': 'https://www.facebook.com/abccafe/posts/1000000000000001?fbclid=x' },
  { 'Lead Statement': 'We moved', 'Timestamp': '2026-07-12 10:00', 'Company Name': 'Beacon Beauty',
    'Phone Number': '07123 456789', 'Address 1 (Road/Street/Lane/Park/Industrial Estate)': 'Oak Rd',
    'Address 2 (Village/Town/City)': 'Chester', 'Phone 2': '',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH1 1AA',
    'Lead Proof URL': 'https://www.facebook.com/beacon/posts/2222' }
];
const MFULL_ROWS = [
  { 'Timestamp': '2026-07-12 08:40', 'Company Name': 'ABC Cafe Ltd', 'Phone Number': '+44 1234 567890',
    'Industry Type': 'Hospitality',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH41 5LH',
    'Address 1 (Road/Street/Lane/Park/Industrial Estate)': '10 High St',
    'Address 2 (Village/Town/City)': 'Birkenhead', 'County': 'Merseyside',
    'Lead Proof URL': 'https://m.facebook.com/abccafe/posts/1000000000000001',
    'Lead Statement': 'Grand opening!' }
];

async function startPipeline() {
  process.env.PORT = String(PIPELINE_PORT);
  const { app } = await import('../src/server.js');
  const { pool } = await import('../src/db/pool.js');
  await pool.query('TRUNCATE raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs RESTART IDENTITY CASCADE');
  const server = await new Promise((r) => { const s = app.listen(PIPELINE_PORT, () => r(s)); });
  return { server, pool };
}

// Local source server: /nfull.csv OK, /mfull.csv OK, /down.csv simulates outage.
function startSourceServer() {
  const server = http.createServer((req, res) => {
    if (req.headers['x-api-key'] !== SOURCE_KEY) { res.writeHead(401); return res.end('unauthorized'); }
    if (req.url.startsWith('/nfull.csv')) { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(toCsv(NFULL_ROWS, EXPECTED_HEADERS)); }
    if (req.url.startsWith('/mfull.csv')) {
      const headers = Object.keys(MFULL_ROWS[0]);
      res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(toCsv(MFULL_ROWS, headers));
    }
    res.writeHead(500); return res.end('boom');
  });
  return new Promise((r) => server.listen(SOURCE_PORT, () => r(server)));
}

async function run() {
  const { server: pipeline, pool } = await startPipeline();
  const sourceServer = await startSourceServer();
  try {
    // Point reconcile at our local source server. MFULL URL is the /down endpoint
    // for the first pass to prove NFULL still succeeds when MFULL is down.
    process.env.PIPELINE_BASE_URL = `http://127.0.0.1:${PIPELINE_PORT}`;
    process.env.NFULL_CSV_URL = `http://127.0.0.1:${SOURCE_PORT}/nfull.csv`;
    process.env.NFULL_API_KEY = SOURCE_KEY;
    process.env.MFULL_CSV_URL = `http://127.0.0.1:${SOURCE_PORT}/down.csv`;
    process.env.MFULL_API_KEY = SOURCE_KEY;

    const { main } = await import('../src/reconcile.js');

    console.log('reconcile pass 1: NFULL ok, MFULL down (outage isolation)');
    await main();
    let masters = (await pool.query('SELECT count(*)::int c FROM master_leads')).rows[0].c;
    ok('NFULL leads ingested despite MFULL being down', masters === 2);

    console.log('reconcile pass 2: MFULL restored -> converges lead A');
    process.env.MFULL_CSV_URL = `http://127.0.0.1:${SOURCE_PORT}/mfull.csv`;
    // reconcile.js read SOURCES at import; re-import a fresh module instance.
    const fresh = await import(`../src/reconcile.js?ts=${Date.now()}`);
    await fresh.main();
    masters = (await pool.query('SELECT count(*)::int c FROM master_leads')).rows[0].c;
    ok('still 2 masters (A converged, not duplicated)', masters === 2);
    const both = await pool.query(
      `SELECT count(*)::int c FROM (SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=2) x`
    );
    ok('lead A now found by BOTH sources', both.rows[0].c === 1);

    console.log('reconcile pass 3: idempotent re-run adds nothing');
    const fresh2 = await import(`../src/reconcile.js?ts=${Date.now()}b`);
    await fresh2.main();
    masters = (await pool.query('SELECT count(*)::int c FROM master_leads')).rows[0].c;
    ok('master count unchanged on repeat reconcile', masters === 2);

    console.log(`\nPhase 3 reconcile: ${passed} checks passed ✅`);
  } finally {
    pipeline.close();
    sourceServer.close();
    await pool.end();
  }
}

run().catch((err) => { console.error('\n❌ reconcile check failed:', err && (err.stack || err)); process.exitCode = 1; });
