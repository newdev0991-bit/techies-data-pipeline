// Ingest a local CSV file into the running pipeline (for manual/real-data tests,
// e.g. a CSV exported from the MFULL site that can't be pulled headlessly yet).
//
// Usage: node scripts/ingest-file.mjs <NFULL|MFULL> <path-to-csv> [pipelineBaseUrl]
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { csvToObjects } from '../src/lib/csv.js';
import { tagSourceOccurrences } from '../src/lib/canonical.js';

const source = (process.argv[2] || '').toUpperCase();
const path = process.argv[3];
const base = (process.argv[4] || process.env.PIPELINE_BASE_URL || `http://localhost:${process.env.PORT || 4100}`).replace(/\/$/, '');
const TOKEN = process.env.PIPELINE_API_TOKEN;
const BATCH = Number(process.env.PIPELINE_PUSH_BATCH_SIZE || 100);

if (!['NFULL', 'MFULL'].includes(source) || !path) {
  console.error('Usage: node scripts/ingest-file.mjs <NFULL|MFULL> <path-to-csv> [pipelineBaseUrl]');
  process.exit(1);
}

async function main() {
  if (!TOKEN) { console.error('PIPELINE_API_TOKEN not set'); process.exit(1); }
  const text = await readFile(path, 'utf8');
  const rows = tagSourceOccurrences(source, csvToObjects(text));
  console.log(`[ingest-file] ${source}: ${rows.length} rows from ${path} -> ${base}`);

  let received = 0; let inserted = 0; let duplicates = 0; let errors = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(`${base}/internal/ingest/${source.toLowerCase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ rows: chunk })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`[ingest-file] batch failed HTTP ${res.status}:`, json); errors += chunk.length; continue; }
    received += json.records_received || 0;
    inserted += json.records_inserted || 0;
    duplicates += json.duplicates || 0;
    errors += json.errors || 0;
  }
  console.log(`[ingest-file] ${source} done: received=${received} inserted=${inserted} duplicates=${duplicates} errors=${errors}`);
}

main().catch((err) => { console.error('[ingest-file] failed:', err.message); process.exitCode = 1; });
