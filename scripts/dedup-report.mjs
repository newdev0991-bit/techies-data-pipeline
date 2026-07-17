// Human-readable dedup report: shows the single-source-of-truth result after
// ingesting real NFULL + MFULL data — how many leads each source found, how many
// are the SAME lead found by both, and a few concrete examples.
import 'dotenv/config';
import { pool } from '../src/db/pool.js';

async function main() {
  const c = (await pool.query(`
    WITH visible AS (
      SELECT * FROM master_leads WHERE hidden_from_combined = false
    ), visible_sources AS (
      SELECT ls.* FROM lead_sources ls JOIN visible m ON m.id = ls.master_lead_id
    ), visible_occurrences AS (
      SELECT r.* FROM raw_leads r JOIN visible m ON m.id = r.master_lead_id
    )
    SELECT
      (SELECT count(*) FROM visible_sources WHERE source='NFULL') AS nfull_rows,
      (SELECT count(*) FROM visible_occurrences WHERE source='MFULL') AS mfull_raw_rows,
      (SELECT count(*) FROM visible) AS combined_rows,
      (SELECT count(*) FROM (SELECT master_lead_id FROM visible_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=2) x) AS both,
      (SELECT count(*) FROM (SELECT master_lead_id FROM visible_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=1 AND max(source::text)='NFULL') x) AS nfull_only,
      (SELECT count(*) FROM (SELECT master_lead_id FROM visible_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=1 AND max(source::text)='MFULL') x) AS mfull_only,
      (SELECT count(*) FROM visible WHERE possible_duplicate_of IS NOT NULL) AS flagged
  `)).rows[0];

  const examples = (await pool.query(`
    SELECT m.business_name, m.norm_phone, m.norm_permalink
      FROM master_leads m
      JOIN lead_sources ls ON ls.master_lead_id = m.id
     WHERE m.hidden_from_combined = false
     GROUP BY m.id
     HAVING count(DISTINCT ls.source) = 2
     ORDER BY m.id
     LIMIT 10
  `)).rows;

  const repeatedMfull = Math.max(0, Number(c.mfull_raw_rows) - Number(c.both) - Number(c.mfull_only));

  console.log('\n=== NFULL-first phone-matching report ===\n');
  console.log(`  NFULL rows retained:    ${c.nfull_rows}`);
  console.log(`  MFULL source rows:      ${c.mfull_raw_rows}`);
  console.log(`  ---`);
  console.log(`  Combined output rows:   ${c.combined_rows}`);
  console.log(`  Repeated MFULL phones ignored: ${repeatedMfull}`);
  console.log(`  ---`);
  console.log(`  NFULL only:             ${c.nfull_only}`);
  console.log(`  MFULL-only rows added:  ${c.mfull_only}`);
  console.log(`  MFULL phones in NFULL:  ${c.both}   <- MFULL copy not added`);
  console.log(`  Advisory fuzzy flags (never merged): ${c.flagged}`);

  if (examples.length) {
    console.log('\n  Examples of MFULL phone matches already present in NFULL:');
    for (const e of examples) {
      console.log(`    • ${e.business_name || '(no name)'}  [phone ${e.norm_phone || '(missing)'}]`);
    }
  } else {
    console.log('\n  (No cross-source matches yet — expected if the two sources have distinct leads.)');
  }
  console.log('');
  await pool.end();
}

main().catch((err) => { console.error('[dedup-report] failed:', err.message); process.exitCode = 1; pool.end(); });
