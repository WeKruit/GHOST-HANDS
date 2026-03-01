-- Migration 019: Callback deduplication table
-- Prevents duplicate callback emissions under retries/resume races (AD-5).

-- UP
CREATE TABLE IF NOT EXISTS gh_callback_dedupe (
  job_id      UUID        NOT NULL,
  event_type  TEXT        NOT NULL,
  nonce       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, event_type, nonce)
);

-- Index for cleanup queries (retention)
CREATE INDEX IF NOT EXISTS idx_gh_callback_dedupe_created
  ON gh_callback_dedupe (created_at);

-- RLS: service-role only
ALTER TABLE gh_callback_dedupe ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access
CREATE POLICY gh_callback_dedupe_service_all
  ON gh_callback_dedupe
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- DOWN (rollback)
-- DROP POLICY IF EXISTS gh_callback_dedupe_service_all ON gh_callback_dedupe;
-- DROP TABLE IF EXISTS gh_callback_dedupe;
