-- Migration 022: persist merged page context snapshots for application runs

CREATE TABLE IF NOT EXISTS gh_job_page_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES gh_automation_jobs(id) ON DELETE CASCADE,
  mastra_run_id TEXT NOT NULL,
  page_sequence INTEGER NOT NULL,
  page_id UUID NOT NULL,
  url TEXT NOT NULL,
  page_type TEXT NOT NULL,
  page_title TEXT,
  status TEXT NOT NULL,
  entry_fingerprint TEXT NOT NULL,
  latest_fingerprint TEXT NOT NULL,
  required_total INTEGER NOT NULL DEFAULT 0,
  required_resolved INTEGER NOT NULL DEFAULT 0,
  required_unresolved INTEGER NOT NULL DEFAULT 0,
  optional_risky INTEGER NOT NULL DEFAULT 0,
  low_confidence_resolved INTEGER NOT NULL DEFAULT 0,
  ambiguous_grouped INTEGER NOT NULL DEFAULT 0,
  page_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  entered_at TIMESTAMPTZ NOT NULL,
  exited_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_job_page_contexts_job_sequence
  ON gh_job_page_contexts(job_id, page_sequence);

CREATE INDEX IF NOT EXISTS idx_gh_job_page_contexts_mastra_run
  ON gh_job_page_contexts(mastra_run_id);

CREATE INDEX IF NOT EXISTS idx_gh_job_page_contexts_job
  ON gh_job_page_contexts(job_id, created_at DESC);
