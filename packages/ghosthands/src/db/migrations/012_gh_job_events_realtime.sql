-- Migration 012: Enable Supabase Realtime on gh_job_events
-- Required for VALET UI to subscribe to live event streams (mode switching, actions, thinking)
--
-- Prerequisites: gh_job_events table must already exist (created in base schema)

-- Add gh_job_events to the supabase_realtime publication so INSERT events
-- are broadcast to Realtime subscribers.
ALTER PUBLICATION supabase_realtime ADD TABLE gh_job_events;

-- Index for efficient Realtime filter by job_id (Supabase Realtime uses
-- the filter clause to narrow the postgres logical replication stream).
CREATE INDEX IF NOT EXISTS idx_gh_job_events_job_id_created
  ON gh_job_events(job_id, created_at DESC);

-- Composite index for event timeline queries (mode_selected, mode_switched, etc.)
CREATE INDEX IF NOT EXISTS idx_gh_job_events_type_job
  ON gh_job_events(event_type, job_id);
