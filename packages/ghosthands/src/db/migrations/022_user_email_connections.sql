-- Migration 022: Per-user Gmail OAuth connections
--
-- Supports operator-owned OAuth client + per-user Gmail tokens.
-- Tokens are encrypted in application code before insertion.

CREATE TABLE IF NOT EXISTS gh_user_email_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  email_address TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  encrypted_access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  token_scope TEXT,
  token_type TEXT,
  encryption_key_id TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT gh_user_email_connections_provider_check
    CHECK (provider IN ('google')),
  CONSTRAINT gh_user_email_connections_unique_user_provider
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_gh_user_email_connections_active
  ON gh_user_email_connections(user_id, provider)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gh_user_email_connections_email
  ON gh_user_email_connections(email_address);

ALTER TABLE gh_user_email_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only for email connections" ON gh_user_email_connections;
CREATE POLICY "Service role only for email connections"
  ON gh_user_email_connections FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_gh_user_email_connections_updated_at ON gh_user_email_connections;
CREATE TRIGGER update_gh_user_email_connections_updated_at
  BEFORE UPDATE ON gh_user_email_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
