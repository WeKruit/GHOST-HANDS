-- Migration 024: Remove cookbook values from CHECK constraints
-- The cookbook system has been removed. Clean up DB constraints to match.
--
-- execution_mode: remove 'cookbook_only' (migrate existing rows to 'auto')
-- final_mode: remove 'cookbook', add 'mastra' (migrate existing rows to 'magnitude')

-- UP

-- Step 1: Migrate existing rows with legacy cookbook values BEFORE adding new constraints
UPDATE gh_automation_jobs SET execution_mode = 'auto' WHERE execution_mode = 'cookbook_only';
UPDATE gh_automation_jobs SET final_mode = 'magnitude' WHERE final_mode = 'cookbook';

-- Step 2: Replace constraints
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
-- UPDATE gh_automation_jobs SET execution_mode = 'cookbook_only' WHERE execution_mode = 'auto' AND metadata->>'legacy_cookbook' = 'true';
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
