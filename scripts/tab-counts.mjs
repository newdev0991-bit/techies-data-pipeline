// Read-only diagnostic: for every tab in each configured source spreadsheet, count
// the ACTUAL populated rows (rows with any non-empty value in cols A–C), so we can
// see where the real lead volume lives (grid size ≠ populated rows). No writes, no cost.
import 'dotenv/config';
import { sourceConfigs, listSheetsMeta, readRawValues } from '../src/lib/sheets.js';

for (const cfg of sourceConfigs()) {
  console.log(`\n=== ${cfg.name}  (spreadsheet ${String(cfg.spreadsheetId).slice(0, 12)}…) ===`);
  let tabs = [];
  try {
    tabs = await listSheetsMeta(cfg);
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
    continue;
  }
  for (const t of tabs) {
    try {
      const vals = await readRawValues({ ...cfg, range: `${t.title}!A:C` });
      const populated = vals.filter((r) => (r || []).some((c) => c != null && String(c).trim() !== '')).length;
      const dataRows = Math.max(0, populated - 1); // minus a header row
      console.log(`  • "${t.title}"   ~${populated} populated rows (≈${dataRows} data rows)   [grid ${t.rowCount}]`);
    } catch (err) {
      console.log(`  • "${t.title}"   ❌ ${err.message}`);
    }
  }
}
console.log('\n(read-only — counts only, no lead data shown, no writes, no cost)');
