// Scheduled reconciliation (Render cron, ~every 15 min). Pulls each source's CSV
// (with its API key) and re-ingests it, catching records a push may have missed
// after a restart. Sources are independent: one being down never stops the other
// (doc sections 2 + 9). Dedup makes re-ingesting the whole CSV safe/idempotent.
import 'dotenv/config';
import { csvToObjects } from './lib/csv.js';
import { tagSourceOccurrences } from './lib/canonical.js';

const TOKEN = process.env.PIPELINE_API_TOKEN;
const BATCH = Number(process.env.PIPELINE_PUSH_BATCH_SIZE || 100);
const TIMEOUT_MS = Number(process.env.RECONCILE_TIMEOUT_MS || 20000);

function normalizeBase(b) {
  const base = b || `http://localhost:${process.env.PORT || 4100}`;
  const trimmed = base.replace(/\/$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
const BASE = normalizeBase(process.env.PIPELINE_BASE_URL);

const SOURCES = [
  { name: 'NFULL', url: process.env.NFULL_CSV_URL, key: process.env.NFULL_API_KEY },
  { name: 'MFULL', url: process.env.MFULL_CSV_URL, key: process.env.MFULL_API_KEY }
];

async function fetchCsv(url, key) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    if (key) headers['X-API-Key'] = key;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function postBatch(source, rows) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/internal/ingest/${source.toLowerCase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ rows }),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function reconcileSource(src) {
  if (!src.url) { console.log(`[reconcile] ${src.name}: no CSV URL configured, skipping`); return; }
  try {
    const csv = await fetchCsv(src.url, src.key);
    const objects = tagSourceOccurrences(src.name, csvToObjects(csv));
    if (objects.length === 0) { console.log(`[reconcile] ${src.name}: 0 rows`); return; }

    let received = 0; let inserted = 0; let duplicates = 0; let errors = 0;
    for (let i = 0; i < objects.length; i += BATCH) {
      const chunk = objects.slice(i, i + BATCH);
      const r = await postBatch(src.name, chunk);
      received += r.records_received || 0;
      inserted += r.records_inserted || 0;
      duplicates += r.duplicates || 0;
      errors += r.errors || 0;
    }
    console.log(`[reconcile] ${src.name}: received=${received} inserted=${inserted} duplicates=${duplicates} errors=${errors}`);
  } catch (err) {
    // Independent per-source failure: log and continue with the other source.
    console.error(`[reconcile] ${src.name} FAILED: ${err.message}`);
  }
}

export async function main() {
  if (!TOKEN) { console.error('[reconcile] PIPELINE_API_TOKEN not set'); process.exitCode = 1; return; }
  console.log(`[reconcile] starting against ${BASE}`);
  for (const src of SOURCES) {
    await reconcileSource(src); // sequential; independent try/catch inside
  }
  console.log('[reconcile] done');
}

// Only auto-run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('reconcile.js')) {
  main();
}
