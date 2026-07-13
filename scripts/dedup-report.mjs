// Human-readable dedup report: shows the single-source-of-truth result after
// ingesting real NFULL + MFULL data — how many leads each source found, how many
// are the SAME lead found by both, and a few concrete examples.
import 'dotenv/config';
import { pool } from '../src/db/pool.js';

async function main() {
  const c = (await pool.query(`
    SELECT
      (SELECT count(*) FROM lead_sources WHERE source='NFULL') AS nfull_occ,
      (SELECT count(*) FROM lead_sources WHERE source='MFULL') AS mfull_occ,
      (SELECT count(*) FROM master_leads) AS masters,
      (SELECT count(*) FROM (SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=2) x) AS both,
      (SELECT count(*) FROM (SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=1 AND max(source::text)='NFULL') x) AS nfull_only,
      (SELECT count(*) FROM (SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source)=1 AND max(source::text)='MFULL') x) AS mfull_only,
      (SELECT count(*) FROM master_leads WHERE possible_duplicate_of IS NOT NULL) AS flagged
  `)).rows[0];

  const examples = (await pool.query(`
    SELECT m.business_name, m.norm_phone, m.norm_permalink
      FROM master_leads m
      JOIN lead_sources ls ON ls.master_lead_id = m.id
     GROUP BY m.id
     HAVING count(DISTINCT ls.source) = 2
     ORDER BY m.id
     LIMIT 10
  `)).rows;

  const merged = Number(c.nfull_occ) + Number(c.mfull_occ) - Number(c.masters);

  console.log('\n=== Single source of truth — real-data dedup report ===\n');
  console.log(`  NFULL found:            ${c.nfull_occ} leads`);
  console.log(`  MFULL found:            ${c.mfull_occ} leads`);
  console.log(`  ---`);
  console.log(`  Unique master leads:    ${c.masters}`);
  console.log(`  Duplicate copies merged:${String(merged).padStart(7)}`);
  console.log(`  ---`);
  console.log(`  NFULL only:             ${c.nfull_only}`);
  console.log(`  MFULL only:             ${c.mfull_only}`);
  console.log(`  Found by BOTH:          ${c.both}   <- proves the same lead came from both sources`);
  console.log(`  Fuzzy possible-dupes flagged for review: ${c.flagged}`);

  if (examples.length) {
    console.log('\n  Examples of leads found by BOTH NFULL and MFULL:');
    for (const e of examples) {
      const key = e.norm_permalink ? `permalink ${e.norm_permalink}` : (e.norm_phone ? `phone ${e.norm_phone}` : 'fuzzy');
      console.log(`    • ${e.business_name || '(no name)'}  [matched on ${key}]`);
    }
  } else {
    console.log('\n  (No cross-source matches yet — expected if the two sources have distinct leads.)');
  }
  console.log('');
  await pool.end();
}

main().catch((err) => { console.error('[dedup-report] failed:', err.message); process.exitCode = 1; pool.end(); });
