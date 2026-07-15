// Read-only diagnostic: verify each configured source's Google auth + sheet read
// using the SAME code the pipeline uses (sourceConfigs + readSheetRows). Reports
// row counts + mapping coverage only — never dumps lead data. No writes, no cost.
import 'dotenv/config';
import { sourceConfigs, readSheetRows, listSheetTitles } from '../src/lib/sheets.js';
import { toCanonical } from '../src/lib/canonical.js';

const cfgs = sourceConfigs();
console.log('Configured sources:', cfgs.map((c) => c.name).join(', ') || 'NONE (check *_SPREADSHEET_ID + token env)');

let anyFail = false;
for (const cfg of cfgs) {
  const auth = cfg.saJson ? 'service-account' : cfg.tokenJson ? 'oauth' : 'none';
  console.log(`\n=== ${cfg.name}  (sheet ${String(cfg.spreadsheetId).slice(0, 10)}…, range "${cfg.range}", auth ${auth}) ===`);
  try {
    const rows = await readSheetRows(cfg);
    console.log(`  ✓ read ${rows.length} data rows from Google`);
    if (rows.length) {
      const name = rows.filter((r) => toCanonical(cfg.name, r).business_name).length;
      const url = rows.filter((r) => toCanonical(cfg.name, r).norm_permalink).length;
      const phone = rows.filter((r) => toCanonical(cfg.name, r).norm_phone).length;
      console.log(`  ✓ maps to canonical: business_name ${name}/${rows.length}, proof URL ${url}/${rows.length}, phone ${phone}/${rows.length}`);
    }
  } catch (err) {
    anyFail = true;
    console.log(`  ❌ ${err.message}`);
    // Help diagnose bad tab names by listing the real ones.
    try {
      const titles = await listSheetTitles(cfg);
      console.log(`     available tabs: ${titles.map((t) => `"${t}"`).join(', ')}`);
      console.log(`     → set ${cfg.name}_SHEET_RANGE to  <tab name>!A1:Z  (use the exact tab above)`);
    } catch (e2) {
      console.log(`     (could not list tabs: ${e2.message})`);
    }
  }
}
console.log('\n(read-only — no data shown, no writes, no cost)');
process.exitCode = anyFail ? 1 : 0;
