// Read-only: enumerate every tab (with grid size) in each configured source
// spreadsheet, so we can find which tab holds the full data and set the range
// with the exact tab name (casing + trailing chars). No lead data, no writes.
import 'dotenv/config';
import { sourceConfigs, listSheetsMeta } from '../src/lib/sheets.js';

const cfgs = sourceConfigs();
if (!cfgs.length) {
  console.error('No sources configured (need NFULL_/MFULL_SPREADSHEET_ID + token env).');
  process.exit(1);
}

for (const cfg of cfgs) {
  const auth = cfg.saJson ? 'service-account' : 'oauth';
  console.log(`\n=== ${cfg.name}  (spreadsheet ${String(cfg.spreadsheetId).slice(0, 12)}…, auth ${auth}) ===`);
  console.log(`  currently configured range: ${cfg.range}`);
  try {
    const tabs = await listSheetsMeta(cfg);
    for (const t of tabs) {
      console.log(`  • "${t.title}"   grid ${t.rowCount} rows × ${t.columnCount} cols`);
    }
    console.log(`  → to target a tab, set ${cfg.name}_SHEET_RANGE to  <exact tab name>!A1:Z`);
    console.log('    (if the tab name itself ends in "!", you need a DOUBLE "!" before A1:Z)');
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
    if (/invalid_grant/i.test(err.message)) {
      console.log('     → token expired/revoked. Regenerate a fresh OAuth token into .env.');
    }
  }
}
console.log('\n(read-only — tab metadata only, no lead data, no writes, no cost)');
