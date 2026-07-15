-- Set-based bulk ingestion needs ONE conflict target for master_leads (the old
-- design conflicted on any of 3 partial-unique indexes, which can't be expressed
-- in a single ON CONFLICT for a bulk INSERT ... SELECT). We add a single
-- `dedup_key` (normalized permalink, else post_id, else phone, else source id)
-- as the canonical identity, make it unique, and relax the other three indexes to
-- plain (non-unique) lookup indexes.

ALTER TABLE master_leads ADD COLUMN IF NOT EXISTS dedup_key text;

-- Backfill any existing rows (there are none in a fresh DB, but be safe).
UPDATE master_leads
   SET dedup_key = COALESCE(norm_permalink, post_id, norm_phone, 'mid:' || id::text)
 WHERE dedup_key IS NULL;

-- Drop the unique partial indexes; recreate as plain indexes (still useful for
-- lookups, no longer enforce single-key uniqueness).
DROP INDEX IF EXISTS ux_master_post_id;
DROP INDEX IF EXISTS ux_master_norm_permalink;
DROP INDEX IF EXISTS ux_master_norm_phone;

CREATE INDEX IF NOT EXISTS ix_master_post_id        ON master_leads (post_id)        WHERE post_id        IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_master_norm_permalink ON master_leads (norm_permalink) WHERE norm_permalink IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_master_norm_phone     ON master_leads (norm_phone)     WHERE norm_phone     IS NOT NULL;

-- The one dedup key: unique, drives ON CONFLICT for bulk upserts.
CREATE UNIQUE INDEX IF NOT EXISTS ux_master_dedup_key ON master_leads (dedup_key);
