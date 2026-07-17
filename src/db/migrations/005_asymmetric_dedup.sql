-- Asymmetric NFULL-base dedup: keep EVERY NFULL row (never dedup a source against
-- itself), and drop an MFULL row only if it already exists in NFULL.
--
-- Two pieces are needed on top of the existing schema:
--   (a) a PER-ROW master identity so nothing collapses within a source. `dedup_key`
--       now holds a full-row hash (see canonical.js) and its existing unique index
--       `ux_master_dedup_key` keeps re-ingest idempotent — no schema change needed.
--   (b) a content `match_key` (permalink → post_id → phone) + the originating
--       `source`, so MFULL rows can be compared against the set of NFULL match_keys.

ALTER TABLE master_leads ADD COLUMN IF NOT EXISTS match_key text;
ALTER TABLE master_leads ADD COLUMN IF NOT EXISTS source   lead_source_name;

-- Fast "does this MFULL match_key already exist in NFULL?" lookup during ingest.
CREATE INDEX IF NOT EXISTS ix_master_nfull_matchkey
  ON master_leads (match_key) WHERE source = 'NFULL' AND match_key IS NOT NULL;
