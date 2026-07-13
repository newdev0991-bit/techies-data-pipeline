// Shadow-test comparison (doc Phase 6). Pulls what each source CSV currently
// serves and compares it against what the pipeline DB holds, so you can confirm
// nothing is missing before cutting techiesdata.site fully over to the pipeline.
//
// Usage: node src/shadow-compare.mjs
// Reads NFULL_CSV_URL/NFULL_API_KEY, MFULL_CSV_URL/MFULL_API_KEY, DATABASE_URL.
import 'dotenv/config';
import { pool } from './db/pool.js';
import { csvToObjects } from './lib/csv.js';

const TIMEOUT_MS = Number(process.env.RECONCILE_TIMEOUT_MS || 20000);

async function sourceCount(url, key) {
  if (!url) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    if (key) headers['X-API-Key'] = key;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return csvToObjects(await res.text()).length;
  } catch (err) {
    console.warn(`[shadow] source fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function dbCounts() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM lead_sources WHERE source = 'NFULL') AS nfull_occurrences,
      (SELECT count(*) FROM lead_sources WHERE source = 'MFULL') AS mfull_occurrences,
      (SELECT count(*) FROM master_leads) AS master_leads,
      (SELECT count(*) FROM (SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=2) b) AS found_by_both,
      (SELECT count(*) FROM master_leads WHERE possible_duplicate_of IS NOT NULL) AS flagged_dupes,
      (SELECT count(*) FROM master_leads WHERE status='APPROVED') AS approved,
      (SELECT count(*) FROM master_leads WHERE status='REVIEW_REQUIRED') AS review,
      (SELECT count(*) FROM master_leads WHERE status='REJECTED') AS rejected
  `);
  return rows[0];
}

function line(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function main() {
  const [nfullSrc, mfullSrc] = await Promise.all([
    sourceCount(process.env.NFULL_CSV_URL, process.env.NFULL_API_KEY),
    sourceCount(process.env.MFULL_CSV_URL, process.env.MFULL_API_KEY)
  ]);
  const db = await dbCounts();

  console.log('\n=== Shadow comparison: sources vs pipeline DB ===\n');
  console.log('Source CSV rows currently served:');
  line('NFULL CSV rows', nfullSrc ?? 'n/a');
  line('MFULL CSV rows', mfullSrc ?? 'n/a');

  console.log('\nPipeline DB:');
  line('NFULL occurrences (lead_sources)', db.nfull_occurrences);
  line('MFULL occurrences (lead_sources)', db.mfull_occurrences);
  line('Unique master leads', db.master_leads);
  line('Found by BOTH', db.found_by_both);
  line('Flagged possible duplicates', db.flagged_dupes);
  line('Approved / Review / Rejected', `${db.approved} / ${db.review} / ${db.rejected}`);

  console.log('\nDeltas (source served − pipeline has):');
  if (nfullSrc != null) {
    const d = nfullSrc - Number(db.nfull_occurrences);
    line('NFULL missing from pipeline', d === 0 ? '0 ✅' : `${d} ⚠`);
  }
  if (mfullSrc != null) {
    const d = mfullSrc - Number(db.mfull_occurrences);
    line('MFULL missing from pipeline', d === 0 ? '0 ✅' : `${d} ⚠`);
  }
  const dedupeSaved = Number(db.nfull_occurrences) + Number(db.mfull_occurrences) - Number(db.master_leads);
  line('Duplicate occurrences merged', dedupeSaved);
  console.log('\nA non-zero "missing" delta means the pipeline has not yet ingested');
  console.log('everything the source serves — run reconcile or check push before cutover.\n');

  await pool.end();
}

main().catch((err) => { console.error('[shadow] failed:', err.message); process.exitCode = 1; pool.end(); });
