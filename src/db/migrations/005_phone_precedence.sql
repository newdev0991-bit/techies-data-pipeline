-- NFULL is the authoritative source. Keep masters created by the previous
-- global URL/phone policy for audit/history, but remove them from the combined
-- read model before the corrected phone-policy backfill is ingested.
ALTER TABLE master_leads
  ADD COLUMN IF NOT EXISTS hidden_from_combined boolean NOT NULL DEFAULT false;

ALTER TABLE master_leads
  ADD COLUMN IF NOT EXISTS hidden_reason text;

ALTER TABLE master_leads
  ADD COLUMN IF NOT EXISTS superseded_by_nfull bigint REFERENCES master_leads(id);

-- On an existing installation every master present when this migration first
-- runs was built with the retired global dedup policy. A fresh database has no
-- rows here, so this is naturally a no-op.
UPDATE master_leads
   SET hidden_from_combined = true,
       hidden_reason = 'LEGACY_GLOBAL_DEDUP',
       updated_at = now()
 WHERE hidden_from_combined = false
   AND dedup_key NOT LIKE 'nfull-row:%'
   AND dedup_key NOT LIKE 'mfull-phone:%'
   AND dedup_key NOT LIKE 'mfull-row:%';

-- Hidden legacy masters must not consume validator/API spend after cutover.
UPDATE validation_jobs vj
   SET status = 'FAILED',
       last_error = 'Cancelled: master hidden by phone-policy cutover',
       locked_at = NULL,
       locked_by = NULL,
       updated_at = now()
  FROM master_leads m
 WHERE m.id = vj.master_lead_id
   AND m.hidden_from_combined = true
   AND vj.status IN ('PENDING', 'PROCESSING', 'RETRY');

CREATE INDEX IF NOT EXISTS ix_master_visible
  ON master_leads (created_at DESC, id DESC)
  WHERE hidden_from_combined = false;
