-- Migration 026: Application reports — structured record of what the worker submitted
--
-- Stores a per-job flat report of every field filled during an application,
-- queryable by VALET UI for the Application Tracker feature.
-- Data is populated during job finalization from PageContextSession.
--
-- Key points:
-- - One row per job (unique on job_id)
-- - fields_submitted is a JSONB array of {prompt_text, value, question_type, source, ...}
-- - Best-effort write — report failures never block job finalization
-- - RLS: service role full access (workers write), authenticated users read own

-- UP

CREATE TABLE IF NOT EXISTS gh_application_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES gh_automation_jobs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  valet_task_id   TEXT,

  -- Application metadata
  job_url         TEXT NOT NULL,
  company_name    TEXT,
  job_title       TEXT,
  platform        TEXT,

  -- Resume used
  resume_ref      TEXT,

  -- What the worker submitted (core payload)
  -- Array of { prompt_text, value, question_type, source, answer_mode, confidence, required, section_label, state }
  fields_submitted JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Summary counts
  total_fields       INTEGER NOT NULL DEFAULT 0,
  fields_filled      INTEGER NOT NULL DEFAULT 0,
  fields_failed      INTEGER NOT NULL DEFAULT 0,
  fields_unresolved  INTEGER NOT NULL DEFAULT 0,

  -- Submission outcome
  status          TEXT NOT NULL DEFAULT 'completed',
  submitted       BOOLEAN NOT NULL DEFAULT false,
  result_summary  TEXT,

  -- Cost
  llm_cost_cents  INTEGER,
  action_count    INTEGER,
  total_tokens    INTEGER,

  -- Screenshots
  screenshot_urls JSONB DEFAULT '[]'::jsonb,

  -- Timestamps
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_app_reports_job
  ON gh_application_reports(job_id);

CREATE INDEX IF NOT EXISTS idx_gh_app_reports_user
  ON gh_application_reports(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_app_reports_valet_task
  ON gh_application_reports(valet_task_id)
  WHERE valet_task_id IS NOT NULL;

-- RLS
ALTER TABLE gh_application_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on gh_application_reports"
  ON gh_application_reports FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- DOWN (rollback — commented)
-- DROP TABLE IF EXISTS gh_application_reports;
