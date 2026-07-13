import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env (or start docker-compose).');
}

// Render Postgres requires SSL; local docker does not. Detect by host.
const isLocal = /@(localhost|127\.0\.0\.1|db)[:/]/.test(connectionString);

export const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, committing on success and rolling back on error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
