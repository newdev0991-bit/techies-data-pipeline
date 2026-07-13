# Setup & Deployment Runbook

Step-by-step guide to take the central pipeline from "built + verified locally" to
"live single source of truth." Every step lists **exactly what you must provide or
do** — nothing here happens automatically. Steps are ordered and safe: the old
flows keep working (flags off) until the final cutover.

Legend: 🧑 = you do it · 🤖 = Claude/CLI does it · 💷 = may cost money.

---

## Stage A — Prove it locally on real data (no cost)

Goal: watch real NFULL + MFULL leads deduplicate into one database.

- **A1** 🧑 In `techies-data-pipeline/.env` set:
  - `NFULL_CSV_URL=https://<your-nfull-backend>/most_recent_leads_with_hyperlinks.csv`
  - `NFULL_API_KEY=<your NFULL backend API_KEY>`
  (Leave `PIPELINE_API_TOKEN` / `PUBLIC_API_KEY` at dev defaults.)
- **A2** 🧑 Export MFULL's current leads to a CSV from the live MFULL site
  (login → Generate Leads → Download). Note the absolute file path.
  *(MFULL can't be pulled headlessly until Stage C deploys its branch.)*
- **A3** 🤖 Reset DB + start pipeline, then:
  ```bash
  docker compose up -d && npm run migrate
  PIPELINE_CUTOVER_AT=2999-01-01T00:00:00Z npm start &      # future cutover => no validation
  npm run reconcile                                         # pulls NFULL live
  node scripts/ingest-file.mjs MFULL /path/to/mfull.csv     # ingests MFULL export
  npm run dedup-report                                      # shows NFULL-only / MFULL-only / BOTH
  npm run shadow-compare
  ```
- **A4** ✅ Success = `dedup-report` shows a sane split and any genuinely-shared
  leads under "Found by BOTH." No OpenAI/Apify calls happen.

---

## Stage B — Provision the pipeline on Render (no cost until traffic)

- **B1** 🧑 Push `techies-data-pipeline` to a new GitHub repo.
- **B2** 🧑 In Render: **New → Blueprint**, point at that repo. `render.yaml`
  creates: Postgres `techies-pipeline-db`, web `techies-data-pipeline`,
  worker `techies-pipeline-worker`, cron `techies-pipeline-reconcile`.
  Render auto-generates `PIPELINE_API_TOKEN` and `PUBLIC_API_KEY`.
- **B3** 🧑 Set the remaining web env vars in the Render dashboard:
  - `ALLOWED_ORIGINS` = your two frontend origins (comma-separated)
  - `PIPELINE_CUTOVER_AT` = the moment you go live (ISO, e.g. today 00:00Z)
- **B4** 🤖/🧑 First deploy runs `npm run migrate` automatically (preDeploy).
  Verify `GET https://<pipeline>/health` returns `{ ok: true, db: true }`.
- **B5** 🧑 Copy the generated `PIPELINE_API_TOKEN` and `PUBLIC_API_KEY` — you'll
  paste them into the other services next.

---

## Stage C — Connect the two lead-source backends (push + reconcile)

For **each** backend (`nfullswitch4businessback`, `MFULL_BACK_FINAL`):

- **C1** 🧑 Merge/deploy its `feat/central-pipeline-integration` branch.
- **C2** 🧑 Set env vars on its Render service:
  - `PIPELINE_INGEST_URL=https://<pipeline>/internal/ingest`
  - `PIPELINE_API_TOKEN=<from B5>`
  - `PIPELINE_PUSH_ENABLED=1`
  - (MFULL only) `API_KEY=<a secret you choose>` — enables headless CSV pulls.
- **C3** 🧑 On the pipeline **cron** service set:
  - `NFULL_CSV_URL`, `NFULL_API_KEY`
  - `MFULL_CSV_URL`, `MFULL_API_KEY` (= the MFULL `API_KEY` from C2)
- **C4** ✅ Trigger each backend's Generate Leads once; confirm rows land via
  `GET https://<pipeline>/internal/pipeline/status` (Bearer `PIPELINE_API_TOKEN`).

---

## Stage D — Turn on validation 💷 (Milestone 2)

- **D1** 🧑 Set `TECHIES_VALIDATOR_URL` on the pipeline **worker** to your existing
  `techies-validator-backend` URL. (The validator keeps its own OpenAI/Apify/
  Facebook secrets — nothing duplicated.)
- **D2** From cutover onward, **new** leads auto-validate. Historical leads stay
  `INGESTED` until you choose to spend on them:
  ```bash
  # on the pipeline (or via Render shell), start small:
  npm run bulk-revalidate 20      # queue 20 historical leads
  ```
- **D3** ✅ Watch `GET /api/stats` → `validation` counts (approved/review/rejected)
  and `GET /internal/pipeline/status` for the queue. Cost stays bounded by the
  cutover + the bulk-revalidate limit.

---

## Stage E — Point the website(s) at the pipeline

For techiesdata.site (`nfullswitch4businessfront`) and the MFULL app
(`MFULL_FRONT_FINAL`):

- **E1** 🧑 Deploy its `feat/central-pipeline-integration` branch to Vercel.
- **E2** 🧑 In the Vercel project settings (server-side, NOT `VITE_`):
  - `PIPELINE_BASE_URL=https://<pipeline>`
  - `PUBLIC_API_KEY=<from B5>`
- **E3** 🧑 Set client env `VITE_LEADS_SOURCE` (`BOTH` | `NFULL` | `MFULL`) and,
  when ready to cut over, `VITE_USE_CENTRAL_API=1`. Leaving it `0` keeps the old
  Google-Sheet path (for shadow testing).

---

## Stage F — Shadow test, then cut over (doc Phase 6)

- **F1** 🤖/🧑 With push + reconcile live but `VITE_USE_CENTRAL_API=0`, run
  `npm run shadow-compare` (env pointed at prod DB + source CSVs). Confirm the
  "missing from pipeline" deltas are ~0.
- **F2** 🧑 Flip one frontend's `VITE_USE_CENTRAL_API=1`; verify the site shows the
  same/again-better leads (now deduplicated, with source badges).
- **F3** ✅ Only after outputs match and every published lead links back to its
  original proof, cut the second app over too. Keep the old backends running as
  data producers — do not shut anything off (doc Phase 6).

---

## Quick reference — who holds which secret

| Secret | Lives on | Given to |
| --- | --- | --- |
| `PIPELINE_API_TOKEN` | pipeline (generated) | both Flask backends, cron |
| `PUBLIC_API_KEY` | pipeline (generated) | both Vercel frontends (server-side) |
| MFULL `API_KEY` | MFULL backend (you choose) | pipeline cron (`MFULL_API_KEY`) |
| NFULL `API_KEY` | NFULL backend (existing) | pipeline cron (`NFULL_API_KEY`) |
| OpenAI/Apify/Facebook | techies-validator-backend (existing) | — (not duplicated) |
| Google OAuth token | each source backend (existing) | — |

Never commit real secrets. `.env` is gitignored; use Render/Vercel dashboards.
