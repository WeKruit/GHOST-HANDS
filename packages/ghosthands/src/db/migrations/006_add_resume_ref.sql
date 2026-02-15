-- Migration 006: Add resume reference to gh_automation_jobs
-- resume_ref: JSONB containing resume source info (storage_path, s3_key, or download_url)

ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS resume_ref JSONB;
