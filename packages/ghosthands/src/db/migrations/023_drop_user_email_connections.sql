-- Migration 023: Remove dedicated Gmail connection table
--
-- Moves Gmail OAuth token ciphertext from gh_user_email_connections into
-- gh_user_credentials under platform='google', then drops the old table.

DO $$
BEGIN
  IF to_regclass('public.gh_user_email_connections') IS NULL THEN
    RAISE NOTICE 'gh_user_email_connections does not exist; skipping migration 023.';
    RETURN;
  END IF;

  IF to_regclass('public.gh_user_credentials') IS NULL THEN
    RAISE EXCEPTION 'gh_user_credentials is required before migration 023 can run.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gh_user_credentials'
      AND column_name = 'encrypted_value'
  ) THEN
    RAISE EXCEPTION 'gh_user_credentials.encrypted_value is required for migration 023.';
  END IF;

  -- Refresh token row
  INSERT INTO public.gh_user_credentials (
    user_id,
    platform,
    credential_type,
    encrypted_value,
    encryption_key_id,
    expires_at,
    last_used_at,
    is_valid,
    created_at
  )
  SELECT
    ec.user_id,
    'google',
    'gmail_refresh_token',
    ec.encrypted_refresh_token,
    ec.encryption_key_id,
    NULL,
    ec.last_used_at,
    TRUE,
    COALESCE(ec.connected_at, NOW())
  FROM public.gh_user_email_connections ec
  WHERE ec.revoked_at IS NULL
  ON CONFLICT (user_id, platform, credential_type)
  DO UPDATE
  SET
    encrypted_value = EXCLUDED.encrypted_value,
    encryption_key_id = EXCLUDED.encryption_key_id,
    expires_at = EXCLUDED.expires_at,
    last_used_at = COALESCE(EXCLUDED.last_used_at, last_used_at),
    is_valid = TRUE;

  -- Access token row (optional)
  INSERT INTO public.gh_user_credentials (
    user_id,
    platform,
    credential_type,
    encrypted_value,
    encryption_key_id,
    expires_at,
    last_used_at,
    is_valid,
    created_at
  )
  SELECT
    ec.user_id,
    'google',
    'gmail_access_token',
    ec.encrypted_access_token,
    ec.encryption_key_id,
    ec.access_token_expires_at,
    ec.last_used_at,
    TRUE,
    COALESCE(ec.connected_at, NOW())
  FROM public.gh_user_email_connections ec
  WHERE ec.revoked_at IS NULL
    AND ec.encrypted_access_token IS NOT NULL
  ON CONFLICT (user_id, platform, credential_type)
  DO UPDATE
  SET
    encrypted_value = EXCLUDED.encrypted_value,
    encryption_key_id = EXCLUDED.encryption_key_id,
    expires_at = EXCLUDED.expires_at,
    last_used_at = COALESCE(EXCLUDED.last_used_at, last_used_at),
    is_valid = TRUE;

  DROP TABLE IF EXISTS public.gh_user_email_connections CASCADE;
END $$;
