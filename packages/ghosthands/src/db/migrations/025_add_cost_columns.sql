-- Migration 025: Add cost-tracking columns to gh_automation_jobs
-- These columns have been referenced in finalization.ts and JobExecutor.ts
-- but were never added to the schema — writes were silently dropped by
-- PostgREST (unknown columns stripped from PATCH requests).
--
-- Columns:
--   llm_cost_cents  — Total LLM cost in cents (Math.round(totalCost * 100))
--   action_count    — Number of browser actions executed
--   total_tokens    — Sum of input + output LLM tokens

-- UP

ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS llm_cost_cents INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS action_count   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens   INTEGER DEFAULT 0;

-- Index for cost analytics queries (per-user cost views, monthly reports)
CREATE INDEX IF NOT EXISTS idx_gh_jobs_cost
  ON gh_automation_jobs (user_id, llm_cost_cents)
  WHERE llm_cost_cents > 0;

-- Primary backfill from result_data.cost (most authoritative source).
-- result_data.cost is set atomically in the same .update() call as the
-- job status, so it always reflects the final attempt's cost snapshot.
UPDATE gh_automation_jobs
SET
  llm_cost_cents = COALESCE(ROUND((result_data->'cost'->>'total_cost_usd')::NUMERIC * 100)::INTEGER, 0),
  action_count   = COALESCE((result_data->'cost'->>'action_count')::INTEGER, 0),
  total_tokens   = COALESCE((result_data->'cost'->>'input_tokens')::INTEGER, 0)
               + COALESCE((result_data->'cost'->>'output_tokens')::INTEGER, 0)
WHERE llm_cost_cents = 0
  AND result_data->'cost' IS NOT NULL
  AND status IN ('completed', 'failed', 'awaiting_review');

-- Fallback backfill from gh_job_events for jobs without result_data.cost.
-- Uses DISTINCT ON to pick the latest cost_recorded event per job,
-- avoiding non-deterministic row selection when multiple events exist.
UPDATE gh_automation_jobs j
SET
  llm_cost_cents = COALESCE(ROUND((e.metadata->>'total_cost')::NUMERIC * 100)::INTEGER, 0),
  action_count   = COALESCE((e.metadata->>'action_count')::INTEGER, 0),
  total_tokens   = COALESCE((e.metadata->>'input_tokens')::INTEGER, 0)
               + COALESCE((e.metadata->>'output_tokens')::INTEGER, 0)
FROM (
  SELECT DISTINCT ON (job_id) *
  FROM gh_job_events
  WHERE event_type = 'cost_recorded'
  ORDER BY job_id, created_at DESC
) e
WHERE e.job_id = j.id
  AND j.llm_cost_cents = 0
  AND j.status IN ('completed', 'failed', 'awaiting_review');

-- DOWN (rollback)
-- DROP INDEX IF EXISTS idx_gh_jobs_cost;
-- ALTER TABLE gh_automation_jobs
--   DROP COLUMN IF EXISTS llm_cost_cents,
--   DROP COLUMN IF EXISTS action_count,
--   DROP COLUMN IF EXISTS total_tokens;
