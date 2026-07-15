// One-shot full ingest of every configured source directly from Google into the
// current DATABASE_URL. Useful for the initial backfill / manual refresh.
import 'dotenv/config';
import { sourceConfigs, readSheetRows } from '../src/lib/sheets.js';
import { ingestItems } from '../src/lib/ingest.js';
import { pool } from '../src/db/pool.js';

const cfgs = sourceConfigs();
if (!cfgs.length) { console.error('No sources configured (check *_SPREADSHEET_ID + tokens).'); process.exit(1); }

for (const cfg of cfgs) {
  const t0 = Date.now();
  const rows = await readSheetRows(cfg);
  const readMs = Date.now() - t0;
  const t1 = Date.now();
  const r = await ingestItems({ items: rows.map((row) => ({ source: cfg.name, row })), runSource: cfg.name });
  const ingMs = Date.now() - t1;
  console.log(`${cfg.name}: read ${rows.length} rows (${(readMs / 1000).toFixed(1)}s), ingested (${(ingMs / 1000).toFixed(1)}s) => inserted ${r.records_inserted}, duplicates ${r.duplicates}, jobs ${r.detail.validation_jobs_created}`);
}
await pool.end();
