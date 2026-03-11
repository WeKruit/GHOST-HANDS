-- Add 'mastra_decision' to the execution_mode CHECK constraint.
-- This allows the decision-engine Mastra workflow to be activated per-job.

ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_automation_jobs_execution_mode_check
    CHECK (execution_mode IN ('auto', 'ai_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra', 'mastra_decision'));

-- Rollback:
--   ALTER TABLE gh_automation_jobs
--     DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;
--   ALTER TABLE gh_automation_jobs
--     ADD CONSTRAINT gh_automation_jobs_execution_mode_check
--       CHECK (execution_mode IN ('auto', 'ai_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'));
