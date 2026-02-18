-- Migration 013: Worker registry table
-- Sprint 5: Track connected workers for fleet monitoring, affinity routing,
-- and graceful deregistration when VALET terminates sandboxes.
--
-- Each worker UPSERTs on startup and heartbeats every 30s.
-- VALET can query this to see fleet status or deregister workers.

-- UP
CREATE TABLE IF NOT EXISTS gh_worker_registry (
    worker_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'offline')),
    target_worker_id TEXT,            -- sandbox UUID from VALET
    ec2_instance_id TEXT,             -- from EC2 metadata or env
    ec2_ip TEXT,                      -- from EC2 metadata or env
    current_job_id UUID REFERENCES gh_automation_jobs(id),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    jobs_completed INTEGER NOT NULL DEFAULT 0,
    jobs_failed INTEGER NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_gh_worker_registry_status
    ON gh_worker_registry(status);

CREATE INDEX IF NOT EXISTS idx_gh_worker_registry_target
    ON gh_worker_registry(target_worker_id);

-- DOWN (rollback)
-- DROP INDEX IF EXISTS idx_gh_worker_registry_target;
-- DROP INDEX IF EXISTS idx_gh_worker_registry_status;
-- DROP TABLE IF EXISTS gh_worker_registry;
