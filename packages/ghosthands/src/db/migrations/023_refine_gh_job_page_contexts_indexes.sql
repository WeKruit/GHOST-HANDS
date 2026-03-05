-- Migration 023: refine page context storage metadata and indexing

ALTER TABLE gh_job_page_contexts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP INDEX IF EXISTS idx_gh_job_page_contexts_context_gin;
