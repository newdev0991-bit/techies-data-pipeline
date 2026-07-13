# CLAUDE.md — techies-data-pipeline

Guidance for Claude Code when working in this repo. See the workspace-root
`../CLAUDE.md` for how this fits the three products, and
`../Techies-Automation Plan.docx` for the original spec (section numbers below
refer to it).

## What this is

The neutral central service that makes one Postgres DB the single source of
truth for NFULL + MFULL leads. Plain-JS ESM (Node ≥20), Express, `pg` driver,
**no ORM**. Plain SQL migrations applied by a tiny runner. Mirrors
`techies-validator-backend`'s single-purpose, dependency-light style.

Three processes share this codebase:
- **web** (`src/server.js`) — ingestion API + public read API.
- **cron** (`src/reconcile.js`) — 15-min reconciliation pull.
- **worker** (`src/worker.js`) — validation queue processor (Milestone 2).

## Architecture / data flow

1. Both backends POST rows (keyed by the exact verbose Google-Sheet headers) to
   `/internal/ingest/{nfull,mfull,batch}`.
2. `lib/canonical.js` maps each row to one canonical lead shape (doc §1) and
   synthesizes a deterministic `source_record_id` (sha256 of source + normalized
   permalink; row-hash fallback). **These verbose header strings are a shared
   contract with `techies-validator-backend` — never rename them.**
3. `lib/ingest.js` upserts `raw_leads` (idempotent on `(source, source_record_id)`),
   then `lib/dedup.js` finds-or-creates the `master_lead`.
4. Exact dedup uses three partial-unique indexes (`post_id`, `norm_permalink`,
   `norm_phone`) via `INSERT ... ON CONFLICT DO NOTHING` (race-safe). Secondary
   fuzzy matches (business + postcode via `lib/fingerprint.js`) are **flagged**
   in `master_leads.possible_duplicate_of` for review — never auto-merged or
   deleted (doc §3).
5. `lead_sources` records which sources found each master; two rows = `BOTH`.
6. `routes/publicLeads.js` serves deduplicated leads shaped with the 9 display
   columns both frontends render (`EXPECTED_HEADERS` in `canonical.js`), merging
   each master's raw payloads so a BOTH lead shows the richest available fields.

## Conventions

- **Pure modules** (`fburl.js`, `phone.js`, `fingerprint.js`, `canonical.js`) do
  no I/O and are covered by `scripts/check-contract.mjs` — keep them pure.
- DB access goes through `db/pool.js` (`query` / `withTransaction`). Each ingest
  row runs in its own transaction so one bad row can't fail a whole batch (doc §8).
- Add schema changes as a **new** `src/db/migrations/NNN_*.sql` file (forward-only);
  never edit an applied migration. `migrate.js` tracks them in `schema_migrations`.
- Auth: internal routes use `requireBearer` (PIPELINE_API_TOKEN); public routes
  use `requireApiKey` (PUBLIC_API_KEY). Both timing-safe.

## Milestone 2 — validation (built)

`src/worker.js` claims jobs (`FOR UPDATE SKIP LOCKED`) and runs three layers:
`lib/rules.js` (deterministic reject, no spend) → `lib/validatorClient.js`
`/fetch-results` (evidence, stored in `lead_evidence`) → `/analyze` (AI), whose
response is mapped onto the doc §5C schema by `lib/decision.js` and written to
`validation_results`. We **reuse** `techies-validator-backend` — do not duplicate
its prompt/Apify/OpenAI logic here. Jobs are auto-created at ingest only for leads
collected at/after `PIPELINE_CUTOVER_AT`; historical leads are queued on demand via
`npm run bulk-revalidate`. Retries back off (`WORKER_RETRY_BASE_MIN`) and
dead-letter to `FAILED` after `WORKER_MAX_ATTEMPTS`.

## Verification (money-free, required before shipping changes)

```bash
docker compose up -d && npm run migrate
npm run check:contract     # pure modules
npm run smoke              # Milestone 1: ingest/dedup/read lifecycle
npm run check:reconcile    # reconciliation cron + source outage isolation
npm run check:proxy        # frontend read-proxy path
npm run smoke:validation   # Milestone 2: worker 3-layer flow (vs mock validator)
```

`scripts/sample-leads.mjs` is **synthetic** — never commit real lead data. No test
touches OpenAI/Apify/Google; the worker runs against `scripts/mock-validator.mjs`.
Live validation only happens once `TECHIES_VALIDATOR_URL` points at the real
validator (deploy time).
