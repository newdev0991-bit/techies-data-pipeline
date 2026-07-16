-- Store Address 1 + Phone 2 on the master lead so the read API can build the full
-- display CSV from master columns alone — no per-row raw_payload fetch (that made
-- the full-dataset CSV transfer 16k JSON blobs and time out). Backfilled at
-- re-ingest from Google.
ALTER TABLE master_leads ADD COLUMN IF NOT EXISTS address1 text;
ALTER TABLE master_leads ADD COLUMN IF NOT EXISTS phone2 text;
