// Tiny forward-only migration runner: applies every migrations/*.sql file in
// filename order exactly once, tracked in the schema_migrations table. No ORM.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, withTransaction } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet() {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  await ensureTrackingTable();
  const applied = await appliedSet();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] applying ${file} ...`);
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    count += 1;
  }

  if (count === 0) console.log('[migrate] up to date, nothing to apply.');
  else console.log(`[migrate] applied ${count} migration(s).`);

  await pool.end();
}

run().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exitCode = 1;
  pool.end();
});
