-- Migration 003: Remove fixed job_type constraint for extensibility
-- Allow any string job_type (validated at API layer via Zod)
ALTER TABLE gh_automation_jobs DROP CONSTRAINT IF EXISTS gh_automation_jobs_job_type_check;
