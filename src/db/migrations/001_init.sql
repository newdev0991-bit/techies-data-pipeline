-- Milestone 1 schema: the single source of truth.
-- Tables: raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs.
-- (Milestone 2 adds validation_jobs / validation_results / lead_evidence in 002.)

-- ---------- Enums ----------
CREATE TYPE lead_source_name AS ENUM ('NFULL', 'MFULL');

-- Only M1 statuses now; 002 extends this with the validation statuses via ALTER TYPE.
CREATE TYPE lead_status AS ENUM ('INGESTED', 'DUPLICATE_CHECKED');

-- ---------- pipeline_runs ----------
-- One row per import run (push batch or reconciliation pull). Doc section 9.
CREATE TABLE pipeline_runs (
  id                 bigserial PRIMARY KEY,
  source             lead_source_name,          -- null for mixed /batch runs
  idempotency_key    text UNIQUE,               -- re-sending the same key returns stored counts
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  records_received   integer NOT NULL DEFAULT 0,
  records_inserted   integer NOT NULL DEFAULT 0,
  records_updated    integer NOT NULL DEFAULT 0,
  duplicates         integer NOT NULL DEFAULT 0,
  errors             integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'RUNNING',  -- RUNNING | COMPLETED | FAILED
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ---------- master_leads ----------
-- One row per real-world lead (deduplicated). Canonical fields from doc section 1.
CREATE TABLE master_leads (
  id                    bigserial PRIMARY KEY,
  status                lead_status NOT NULL DEFAULT 'INGESTED',

  -- canonical lead (doc section 1)
  post_id               text,          -- extracted Facebook post id, when derivable
  url                   text,          -- original Facebook proof URL (as received)
  owner_name            text,          -- page / profile name, when known
  message               text,          -- original post text (Lead Statement)
  post_timestamp        timestamptz,   -- when the post was made (MFULL: Lead Posting Date)
  scrape_timestamp      timestamptz,   -- when the source collected it (Timestamp)
  business_name         text,          -- Company Name
  phone                 text,          -- primary phone as received
  email                 text,          -- always null for these sources today
  postcode              text,
  location              text,          -- town/city (+ county when present)

  -- dedup fingerprints (normalized)
  norm_permalink        text,          -- normalized Facebook permalink (see fburl.js)
  norm_phone            text,          -- E.164 UK phone (see phone.js)
  fingerprint           text,          -- composite secondary-match fingerprint

  -- secondary/fuzzy match flag: points at the master this MIGHT duplicate.
  -- Never auto-merged/deleted (doc section 3) — surfaced for human review.
  possible_duplicate_of bigint REFERENCES master_leads(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Exact-dedup keys: partial-unique so multiple NULLs are allowed but a present
-- value is globally unique, enabling INSERT ... ON CONFLICT upserts.
CREATE UNIQUE INDEX ux_master_post_id       ON master_leads (post_id)       WHERE post_id       IS NOT NULL;
CREATE UNIQUE INDEX ux_master_norm_permalink ON master_leads (norm_permalink) WHERE norm_permalink IS NOT NULL;
CREATE UNIQUE INDEX ux_master_norm_phone     ON master_leads (norm_phone)     WHERE norm_phone     IS NOT NULL;
CREATE INDEX ix_master_status               ON master_leads (status);
CREATE INDEX ix_master_created_at           ON master_leads (created_at);
CREATE INDEX ix_master_fingerprint          ON master_leads (fingerprint) WHERE fingerprint IS NOT NULL;

-- ---------- raw_leads ----------
-- One row per source OCCURRENCE, stored untouched. Doc: keep raw_payload so no
-- source-specific info is lost. Unique (source, source_record_id) => idempotent.
CREATE TABLE raw_leads (
  id                bigserial PRIMARY KEY,
  source            lead_source_name NOT NULL,
  source_record_id  text NOT NULL,             -- synthesized (sha256) - see canonical.js
  master_lead_id    bigint REFERENCES master_leads(id),
  raw_payload       jsonb NOT NULL,            -- full original row keyed by verbose headers
  pipeline_run_id   bigint REFERENCES pipeline_runs(id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_record_id)
);

CREATE INDEX ix_raw_master ON raw_leads (master_lead_id);

-- ---------- lead_sources ----------
-- Which sources found a given master lead. A master with both an NFULL and an
-- MFULL row = "found by BOTH" (doc section 3). Never delete the second source.
CREATE TABLE lead_sources (
  id               bigserial PRIMARY KEY,
  master_lead_id   bigint NOT NULL REFERENCES master_leads(id) ON DELETE CASCADE,
  source           lead_source_name NOT NULL,
  source_record_id text NOT NULL,
  raw_lead_id      bigint REFERENCES raw_leads(id),
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (master_lead_id, source)
);

CREATE INDEX ix_lead_sources_master ON lead_sources (master_lead_id);
CREATE INDEX ix_lead_sources_source ON lead_sources (source);

-- ---------- exports ----------
-- Tracks which leads were downloaded / delivered. Doc section 1 + 7.
CREATE TABLE exports (
  id              bigserial PRIMARY KEY,
  master_lead_id  bigint NOT NULL REFERENCES master_leads(id) ON DELETE CASCADE,
  exported_at     timestamptz NOT NULL DEFAULT now(),
  context         text
);

CREATE INDEX ix_exports_master ON exports (master_lead_id);

-- ---------- audit_logs ----------
-- Important changes and manual overrides. Doc section 1 + 9.
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,           -- e.g. 'master_lead'
  entity_id   text,
  action      text NOT NULL,           -- e.g. 'possible_duplicate_flagged'
  actor       text,                    -- 'system' | user email
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_entity ON audit_logs (entity, entity_id);
