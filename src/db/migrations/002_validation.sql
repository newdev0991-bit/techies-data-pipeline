-- Milestone 2: validation queue, results, and evidence.
-- The worker does cheap deterministic pre-checks then calls the existing
-- techies-validator-backend; evidence is stored separately from the decision.

-- Extend the lead lifecycle with the validation statuses (doc section 4).
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'READY_FOR_VALIDATION';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'VALIDATING';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'PUBLISHED';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'EXPORTED';

CREATE TYPE job_status AS ENUM (
  'PENDING', 'PROCESSING', 'COMPLETED', 'RETRY', 'FAILED', 'MANUAL_REVIEW'
);

-- ---------- validation_jobs ----------
-- Postgres-backed queue. Claimed with FOR UPDATE SKIP LOCKED (doc section 4).
CREATE TABLE validation_jobs (
  id              bigserial PRIMARY KEY,
  master_lead_id  bigint NOT NULL REFERENCES master_leads(id) ON DELETE CASCADE,
  status          job_status NOT NULL DEFAULT 'PENDING',
  attempt_count   integer NOT NULL DEFAULT 0,
  locked_at       timestamptz,
  locked_by       text,
  next_retry_at   timestamptz,
  last_error      text,
  rules_version   text,
  prompt_version  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One active (non-terminal) job per master lead at a time.
CREATE UNIQUE INDEX ux_active_job_per_master
  ON validation_jobs (master_lead_id)
  WHERE status IN ('PENDING', 'PROCESSING', 'RETRY');
CREATE INDEX ix_jobs_claimable ON validation_jobs (status, next_retry_at);

-- ---------- lead_evidence ----------
-- Layer B output (Facebook post freshness/history), stored SEPARATELY from the
-- AI decision (doc section 5B). Reused across retries to avoid repeat Apify calls.
CREATE TABLE lead_evidence (
  id              bigserial PRIMARY KEY,
  master_lead_id  bigint NOT NULL REFERENCES master_leads(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'validator', -- validator | mock | none
  post_exists     boolean,
  post_text       text,
  author          text,
  post_date       text,
  previous_posts  jsonb,
  raw             jsonb,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (master_lead_id)
);

-- ---------- validation_results ----------
-- The decision (doc section 5C schema) + provenance. One row per completed
-- validation attempt that produced a decision.
CREATE TABLE validation_results (
  id                     bigserial PRIMARY KEY,
  master_lead_id         bigint NOT NULL REFERENCES master_leads(id) ON DELETE CASCADE,
  job_id                 bigint REFERENCES validation_jobs(id) ON DELETE SET NULL,
  decision               text NOT NULL,   -- APPROVED | REVIEW_REQUIRED | REJECTED
  score                  integer,
  confidence             real,
  lead_type              text,
  intent                 text,
  business_status        text,
  contact_status         text,
  is_residential         boolean,
  is_promotional         boolean,
  requires_manual_review boolean,
  reasons                jsonb,
  extracted              jsonb,
  layer                  text,            -- 'deterministic' | 'ai'
  rules_version          text,
  prompt_version         text,
  model                  text,
  prompt_tokens          integer,
  completion_tokens      integer,
  ai_cost_usd            numeric(10, 6),
  raw                    jsonb,           -- full validator response for traceability
  validated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_results_master ON validation_results (master_lead_id);
CREATE INDEX ix_results_decision ON validation_results (decision);
