// Shadow-test comparison (doc Phase 6). Pulls what each source CSV currently
// serves and compares it against what the pipeline DB holds, so you can confirm
// nothing is missing before cutting techiesdata.site fully over to the pipeline.
//
// Usage: node src/shadow-compare.mjs
// Reads NFULL_CSV_URL/NFULL_API_KEY, MFULL_CSV_URL/MFULL_API_KEY, DATABASE_URL.
import 'dotenv/config';
import { pool } from './db/pool.js';
import { csvToObjects } from './lib/csv.js';
import { tagSourceOccurrences, toCanonical } from './lib/canonical.js';

const TIMEOUT_MS = Number(process.env.RECONCILE_TIMEOUT_MS || 20000);

async function sourceSnapshot(source, url, key) {
  if (!url) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    if (key) headers['X-API-Key'] = key;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = tagSourceOccurrences(source, csvToObjects(await res.text()));
    return {
      count: rows.length,
      sourceRecordIds: rows.map((row) => toCanonical(source, row).source_record_id)
    };
  } catch (err) {
    console.warn(`[shadow] source fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function missingCurrentRows(source, sourceRecordIds) {
  if (!sourceRecordIds?.length) return 0;
  const { rows } = await pool.query(`
    SELECT count(*) AS count
      FROM unnest($1::text[]) wanted(source_record_id)
     WHERE NOT EXISTS (
       SELECT 1
         FROM raw_leads r
         JOIN master_leads m ON m.id = r.master_lead_id
        WHERE r.source = $2::lead_source_name
          AND r.source_record_id = wanted.source_record_id
          AND m.hidden_from_combined = false
     )`, [sourceRecordIds, source]);
  return Number(rows[0].count);
}

async function dbCounts() {
  const { rows } = await pool.query(`
    WITH visible AS (
      SELECT * FROM master_leads WHERE hidden_from_combined = false
    ), visible_sources AS (
      SELECT ls.* FROM lead_sources ls JOIN visible m ON m.id = ls.master_lead_id
    ), visible_occurrences AS (
      SELECT r.* FROM raw_leads r JOIN visible m ON m.id = r.master_lead_id
    )
    SELECT
      (SELECT count(*) FROM visible_occurrences WHERE source = 'NFULL') AS nfull_occurrences,
      (SELECT count(*) FROM visible_occurrences WHERE source = 'MFULL') AS mfull_occurrences,
      (SELECT count(*) FROM visible) AS master_leads,
      (SELECT count(*) FROM (SELECT master_lead_id FROM visible_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=2) b) AS found_by_both,
      (SELECT count(*) FROM visible WHERE possible_duplicate_of IS NOT NULL) AS flagged_dupes,
      (SELECT count(*) FROM visible WHERE status='APPROVED') AS approved,
      (SELECT count(*) FROM visible WHERE status='REVIEW_REQUIRED') AS review,
      (SELECT count(*) FROM visible WHERE status='REJECTED') AS rejected,
      (SELECT count(*) FROM (SELECT master_lead_id FROM visible_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=1 AND max(source::text)='MFULL') x) AS mfull_only
  `);
  return rows[0];
}

function line(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function main() {
  const [nfullSrc, mfullSrc] = await Promise.all([
    sourceSnapshot('NFULL', process.env.NFULL_CSV_URL, process.env.NFULL_API_KEY),
    sourceSnapshot('MFULL', process.env.MFULL_CSV_URL, process.env.MFULL_API_KEY)
  ]);
  const [db, nfullMissing, mfullMissing] = await Promise.all([
    dbCounts(),
    missingCurrentRows('NFULL', nfullSrc?.sourceRecordIds),
    missingCurrentRows('MFULL', mfullSrc?.sourceRecordIds)
  ]);

  console.log('\n=== Shadow comparison: sources vs pipeline DB ===\n');
  console.log('Source CSV rows currently served:');
  line('NFULL CSV rows', nfullSrc?.count ?? 'n/a');
  line('MFULL live-window CSV rows', mfullSrc?.count ?? 'n/a');

  console.log('\nPipeline DB:');
  line('NFULL source rows ingested', db.nfull_occurrences);
  line('MFULL historical rows retained', db.mfull_occurrences);
  line('Combined output rows', db.master_leads);
  line('MFULL phones already in NFULL', db.found_by_both);
  line('MFULL-only rows added', db.mfull_only);
  line('Flagged possible duplicates', db.flagged_dupes);
  line('Approved / Review / Rejected', `${db.approved} / ${db.review} / ${db.rejected}`);

  console.log('\nCurrent source rows not yet captured:');
  if (nfullSrc != null) {
    line('NFULL missing from pipeline', nfullMissing === 0 ? '0 ✅' : `${nfullMissing} ⚠`);
  }
  if (mfullSrc != null) {
    line('MFULL missing from pipeline', mfullMissing === 0 ? '0 ✅' : `${mfullMissing} ⚠`);
  }
  const omittedMfull = Number(db.mfull_occurrences) - Number(db.found_by_both) - Number(db.mfull_only);
  line('Repeated MFULL phones omitted', Math.max(0, omittedMfull));
  console.log('\nMFULL DB history can be larger than its current CSV because captured rows');
  console.log('remain stored after the source deletes them at 24 hours. Any non-zero');
  console.log('missing count means the current source snapshot still needs capture.\n');

  await pool.end();
}

main().catch((err) => { console.error('[shadow] failed:', err.message); process.exitCode = 1; pool.end(); });
