// Phase 4 verification (money-free): exercises the ACTUAL frontend Vercel proxy
// (api/leads.js) against the live local pipeline, proving it forwards the query,
// injects PUBLIC_API_KEY server-side, and returns CSV/JSON the SPA can render.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { ingestItems } from '../src/lib/ingest.js';
import { A_NFULL, A_MFULL, B_NFULL } from './sample-leads.mjs';

const require = createRequire(import.meta.url);
const NFULL_PROXY = '/Users/bellkimkeithonggon/Documents/Code/automations/techies/nfullswitch4businessfront/api/leads.js';
const MFULL_PROXY = '/Users/bellkimkeithonggon/Documents/Code/automations/techies/MFULL_FRONT_FINAL/api/leads.js';

const PORT = 4194;
let passed = 0;
function ok(name, cond) { assert.ok(cond, `FAILED: ${name}`); passed += 1; console.log(`  ✓ ${name}`); }

function fakeRes() {
  return {
    _status: 200, _headers: {}, _body: '',
    status(c) { this._status = c; return this; },
    setHeader(k, v) { this._headers[k] = v; },
    json(o) { this._body = JSON.stringify(o); return this; },
    send(b) { this._body = b; return this; },
    end(b) { this._body = b === undefined ? this._body : b; return this; }
  };
}

async function callProxy(proxy, url) {
  const req = { method: 'GET', url, headers: { host: '127.0.0.1' } };
  const res = fakeRes();
  await proxy(req, res);
  return res;
}

async function run() {
  assert.ok(process.env.PUBLIC_API_KEY, 'PUBLIC_API_KEY must be set (.env)');
  await pool.query('TRUNCATE raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs RESTART IDENTITY CASCADE');
  await ingestItems({ items: [{ source: 'NFULL', row: A_NFULL }, { source: 'NFULL', row: B_NFULL }], runSource: 'NFULL' });
  await ingestItems({ items: [{ source: 'MFULL', row: A_MFULL }], runSource: 'MFULL' });

  const server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });
  process.env.PIPELINE_BASE_URL = `http://127.0.0.1:${PORT}`;
  const nfullProxy = require(NFULL_PROXY);
  const mfullProxy = require(MFULL_PROXY);

  try {
    console.log('NFULL proxy: CSV passthrough');
    const csv = await callProxy(nfullProxy, '/api/leads?format=csv&source=BOTH');
    ok('status 200', csv._status === 200);
    ok('content-type is text/csv', /text\/csv/.test(csv._headers['Content-Type'] || ''));
    ok('CSV header present', csv._body.split('\n')[0].includes('Company Name'));
    ok('BOTH lead (ABC) present in CSV', csv._body.includes('ABC'));

    console.log('NFULL proxy: JSON + source filter forwarded');
    const json = await callProxy(nfullProxy, '/api/leads?source=NFULL');
    const parsed = JSON.parse(json._body);
    ok('NFULL-involved total = 2 (A, B)', parsed.total === 2);
    ok('leads carry source badge', parsed.leads.every((l) => l.source));

    console.log('MFULL proxy behaves identically');
    const mcsv = await callProxy(mfullProxy, '/api/leads?format=csv&source=MFULL');
    ok('MFULL proxy returns CSV 200', mcsv._status === 200 && mcsv._body.includes('Company Name'));

    console.log('proxy keeps the API key server-side / fails safe without env');
    const savedKey = process.env.PUBLIC_API_KEY;
    delete process.env.PUBLIC_API_KEY;
    const noKey = await callProxy(nfullProxy, '/api/leads');
    ok('500 when PUBLIC_API_KEY missing', noKey._status === 500);
    process.env.PUBLIC_API_KEY = savedKey;

    console.log(`\nPhase 4 proxy: ${passed} checks passed ✅`);
  } finally {
    server.close();
    await pool.end();
  }
}

run().catch((err) => { console.error('\n❌ proxy check failed:', err && (err.stack || err)); process.exitCode = 1; });
