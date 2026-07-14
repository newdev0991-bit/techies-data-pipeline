# Setup & Deployment Runbook ($0 free-tier)

Takes the pipeline live for **$0** — Supabase free Postgres + Render free web +
GitHub Actions cron — without leaning on the memory-constrained NFULL backend
(the pipeline reads Google Sheets directly). Every step says what you provide.

Legend: 🧑 = you · 🤖 = Claude/CLI · 💷 = costs money.

---

## Stage 0 — Local sanity (already done, re-runnable)
```bash
docker compose up -d && npm run migrate
npm run check:contract && npm run smoke && npm run smoke:validation
```

## Stage 1 — Supabase free Postgres
- **1a** 🧑 Create a free project at supabase.com. Copy the **connection string**
  (Project → Settings → Database → Connection string → URI; the pooled `:6543`
  "Transaction" URI is fine).
- **1b** 🤖/🧑 Apply the schema from your machine:
  ```bash
  DATABASE_URL="postgres://…supabase…:6543/postgres?pgbouncer=true&sslmode=require" npm run migrate
  ```
  Verify tables exist in the Supabase Table editor.

## Stage 2 — GitHub repo for the pipeline
- 🧑 **Decide the home** (Render connects to it). Recommended: create empty repo
  `techies-data-pipeline` under the account your Render uses; add `newdev0991-bit`
  as collaborator → 🤖 pushes it. (Or 🤖 hosts it under `newdev0991-bit`.)
- 🤖 Also pushes the 4 `feat/central-pipeline-integration` branches (has access).

## Stage 3 — Render free web service
- **3a** 🧑 New → **Web Service** → the pipeline repo → Instance type **Free**.
  Build `npm install`, start `npm run start`, health check `/health`.
  (Or use the Blueprint / `render.yaml`.) Render generates `PIPELINE_API_TOKEN`
  and `PUBLIC_API_KEY`.
- **3b** 🧑 Set env vars:
  - `DATABASE_URL` = the Supabase URI from 1a
  - `ALLOWED_ORIGINS` = your two frontend origins
  - `PIPELINE_CUTOVER_AT` = when you go live (ISO)
  - `NFULL_SPREADSHEET_ID`, `NFULL_SHEET_RANGE` (e.g. `Real Time Leads (Dup Checker)!A1:O`)
  - `MFULL_SPREADSHEET_ID`, `MFULL_SHEET_RANGE` (e.g. `ReaL Time Data--!A1:Z`)
  - **Google auth (preferred: Service Account)** — create a service account, share
    both sheets with its `client_email` (Viewer), set `GOOGLE_SA_JSON` (or per-source
    `NFULL_GOOGLE_SA_JSON` / `MFULL_GOOGLE_SA_JSON`). Avoids weekly token expiry.
    *(OAuth fallback: `*_GOOGLE_OAUTH_TOKEN_JSON`, but "testing"-mode refresh tokens
    expire ~weekly → `invalid_grant`.)*
  - `TECHIES_VALIDATOR_URL` (Stage 5) — can leave unset until then
- **3c** ✅ `GET https://<pipeline>/health` → `{ok,db:true}`.

## Stage 4 — Free scheduler (GitHub Actions)
- 🧑 In the pipeline repo → Settings → Secrets and variables → Actions, add:
  - `PIPELINE_BASE_URL` = `https://<pipeline>.onrender.com`
  - `PIPELINE_API_TOKEN` = the value Render generated
- 🤖 `.github/workflows/pipeline-tick.yml` then fires every ~30 min: wakes the
  free web service and runs one tick (ingest from Google + validate a batch).
  🧑 Run it once manually (Actions → pipeline-tick → Run workflow) to seed data.
- ✅ `GET /internal/pipeline/status` (Bearer token) shows rows per source;
  `GET /api/leads?source=BOTH` and `/api/stats` show dedup + source comparison.

## Stage 5 — Turn on validation 💷 (start with ONE lead)
- 🧑 Set `TECHIES_VALIDATOR_URL` on the web service = your techies-validator-backend.
- 🧑 First live proof for pennies (Render Shell, or locally against Supabase):
  `npm run bulk-revalidate 1` → then trigger a tick → inspect `validation_results`.
  Scale up once it looks right. New post-cutover leads auto-validate each tick.

## Stage 6 — Point the frontends at the pipeline (Vercel)
- 🧑 Deploy each frontend's `feat/central-pipeline-integration` branch. Set
  server-side env `PIPELINE_BASE_URL` + `PUBLIC_API_KEY`. Keep
  `VITE_USE_CENTRAL_API=0` first, run `npm run shadow-compare`, then flip to `1`
  on techiesdata.site (NFULL front), verify, then the MFULL app. Keep the old
  backends running as collectors — cut nothing off (doc Phase 6).

---

## Notes
- **No RAM bump needed**: ingestion reads Google directly; the NFULL backend never
  serves 31k rows for ingestion.
- **Cold start**: the free web service sleeps when idle; the 30-min tick's
  keep-warm ping and the frontend proxy both wake it (first hit is slow).
- **Migrations** run from your machine against `DATABASE_URL` (free plan has no
  preDeploy step). Re-run after any new `src/db/migrations/*.sql`.
- **Secrets** live in Render/Supabase/GitHub/Vercel dashboards — never commit them.
