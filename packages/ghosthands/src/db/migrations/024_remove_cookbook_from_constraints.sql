-- Migration 024: Remove cookbook values from CHECK constraints
-- The cookbook system has been removed. Clean up DB constraints to match.
--
-- execution_mode: remove 'cookbook_only'
-- final_mode: remove 'cookbook', add 'mastra'

-- UP
ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_automation_jobs_execution_mode_check
    CHECK (execution_mode IN ('auto', 'ai_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'));

ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_final_mode_check;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_automation_jobs_final_mode_check
    CHECK (final_mode IN ('magnitude', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'));

-- DOWN (rollback)
-- ALTER TABLE gh_automation_jobs
--   DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;
-- ALTER TABLE gh_automation_jobs
--   ADD CONSTRAINT gh_automation_jobs_execution_mode_check
--     CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'));
-- ALTER TABLE gh_automation_jobs
--   DROP CONSTRAINT IF EXISTS gh_automation_jobs_final_mode_check;
-- ALTER TABLE gh_automation_jobs
--   ADD CONSTRAINT gh_automation_jobs_final_mode_check
--     CHECK (final_mode IN ('cookbook', 'magnitude', 'hybrid', 'smart_apply', 'agent_apply'));
