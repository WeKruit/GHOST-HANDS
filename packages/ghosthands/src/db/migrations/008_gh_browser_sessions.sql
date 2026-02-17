-- Migration 008: gh_browser_sessions
-- Stores encrypted Playwright storageState (cookies, localStorage) for session persistence.
-- Allows workers to reuse authenticated browser sessions across job runs.

CREATE TABLE IF NOT EXISTS gh_browser_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  domain TEXT NOT NULL,
  encrypted_state TEXT NOT NULL,
  encryption_key_id INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  UNIQUE(user_id, domain)
);

-- Index for fast lookups by user + domain
CREATE INDEX IF NOT EXISTS idx_gh_browser_sessions_user_domain
  ON gh_browser_sessions(user_id, domain);

-- RLS
ALTER TABLE gh_browser_sessions ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (workers run with service key)
CREATE POLICY "service_role_full_access" ON gh_browser_sessions
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Auto-update last_used_at
CREATE OR REPLACE FUNCTION gh_update_session_last_used()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_used_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gh_browser_sessions_last_used
  BEFORE UPDATE ON gh_browser_sessions
  FOR EACH ROW
  EXECUTE FUNCTION gh_update_session_last_used();
