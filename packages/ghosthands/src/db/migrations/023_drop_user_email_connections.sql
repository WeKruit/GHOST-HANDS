-- Migration 023: Replace gh_user_email_connections with gh_user_google_tokens
--
-- Why:
-- - We no longer persist Gmail address in token storage.
-- - User email is taken from the canonical users/auth record.
--
-- What this does:
-- 1) Create gh_user_google_tokens (if missing).
-- 2) Copy active token ciphertext from gh_user_email_connections (if it exists).
-- 3) Drop gh_user_email_connections.

CREATE TABLE IF NOT EXISTS gh_user_google_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gh_user_google_tokens_active
  ON gh_user_google_tokens(user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE gh_user_google_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only for google tokens" ON gh_user_google_tokens;
CREATE POLICY "Service role only for google tokens"
  ON gh_user_google_tokens FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_gh_user_google_tokens_updated_at ON gh_user_google_tokens;
CREATE TRIGGER update_gh_user_google_tokens_updated_at
  BEFORE UPDATE ON gh_user_google_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DO $$
BEGIN
  IF to_regclass('public.gh_user_email_connections') IS NOT NULL THEN
    INSERT INTO public.gh_user_google_tokens (
      user_id,
      encrypted_refresh_token,
      encrypted_access_token,
      access_token_expires_at,
      token_scope,
      token_type,
      encryption_key_id,
      connected_at,
      last_used_at,
      revoked_at
    )
    SELECT
      ec.user_id,
      ec.encrypted_refresh_token,
      ec.encrypted_access_token,
      ec.access_token_expires_at,
      ec.token_scope,
      ec.token_type,
      ec.encryption_key_id,
      COALESCE(ec.connected_at, NOW()),
      ec.last_used_at,
      ec.revoked_at
    FROM public.gh_user_email_connections ec
    ON CONFLICT (user_id)
    DO UPDATE
    SET
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      token_scope = EXCLUDED.token_scope,
      token_type = EXCLUDED.token_type,
      encryption_key_id = EXCLUDED.encryption_key_id,
      connected_at = EXCLUDED.connected_at,
      last_used_at = EXCLUDED.last_used_at,
      revoked_at = EXCLUDED.revoked_at;

    DROP TABLE IF EXISTS public.gh_user_email_connections CASCADE;
  END IF;
END $$;
