-- Migration 018: Add 'mastra' to execution_mode CHECK constraint
-- Adds 'mastra' to allowed execution_mode values (backward compatible).

-- UP
ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_automation_jobs_execution_mode_check
    CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'));

-- DOWN (rollback)
-- ALTER TABLE gh_automation_jobs
--   DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;
-- ALTER TABLE gh_automation_jobs
--   ADD CONSTRAINT gh_automation_jobs_execution_mode_check
--     CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply'));
