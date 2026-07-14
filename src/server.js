// Web service: internal ingestion API + public read API + health.
// (The validation worker is a separate process, src/worker.js, added in M2.)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool } from './db/pool.js';
import { ingestRouter } from './routes/ingest.js';
import { pipelineRouter } from './routes/pipeline.js';
import { publicRouter } from './routes/publicLeads.js';
import { internalRouter } from './routes/internal.js';

const app = express();
const PORT = process.env.PORT || 4100;

const allowlist = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server / curl
    return allowlist.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Idempotency-Key']
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (err) {
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

app.use('/internal/ingest', ingestRouter);
app.use('/internal/pipeline', pipelineRouter);
app.use('/internal', internalRouter);
app.use('/api', publicRouter);

app.get('/', (_req, res) => res.json({ service: 'techies-data-pipeline', ok: true }));

// Export the app so tests can import it without binding a port.
export { app };

// Only listen when run directly (not when imported by the smoke test).
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  app.listen(PORT, () => {
    console.log(`[pipeline] listening on ${PORT}. CORS allowlist:`, allowlist);
  });
}
