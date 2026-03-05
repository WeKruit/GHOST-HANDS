import crypto from 'node:crypto';
import { Context, Hono } from 'hono';
import { getSupabaseClient } from '../../db/client.js';
import {
  buildGoogleOAuthAuthorizeUrl,
  exchangeGoogleCodeForTokens,
  fetchGmailProfile,
  getGoogleOAuthConfigFromEnv,
} from '../../workers/emailVerification/googleOAuth.js';
import {
  createGoogleOAuthStateToken,
  resolveGoogleOAuthStateSecret,
  verifyGoogleOAuthStateToken,
} from '../../workers/emailVerification/oauthState.js';
import { createEmailTokenEncryptionFromEnv, GmailConnectionStore } from '../../workers/emailVerification/tokenStore.js';
import { getAuth } from '../middleware/auth.js';

const STATE_TTL_SECONDS = 10 * 60;

export function createGoogleAuthRoutes(): Hono {
  const auth = new Hono();

  auth.get('/start', async (c) => {
    const authContext = getAuth(c);
    const targetUserId = authContext.type === 'user' ? authContext.userId : c.req.query('user_id');
    if (!targetUserId) {
      return c.json({ error: 'validation_error', message: 'user_id is required' }, 422);
    }

    const oauthConfig = getGoogleOAuthConfigFromEnv();
    const stateSecret = resolveGoogleOAuthStateSecret();
    const now = Math.floor(Date.now() / 1000);
    const returnTo = sanitizeReturnTo(c.req.query('return_to'));
    const loginHint = c.req.query('login_hint') || undefined;

    const state = createGoogleOAuthStateToken({
      userId: targetUserId,
      iat: now,
      exp: now + STATE_TTL_SECONDS,
      nonce: crypto.randomUUID(),
      returnTo,
      loginHint,
    }, stateSecret);

    const authUrl = buildGoogleOAuthAuthorizeUrl({
      config: oauthConfig,
      state,
      loginHint,
    });

    return c.json({
      provider: 'google',
      user_id: targetUserId,
      auth_url: authUrl,
      expires_in_seconds: STATE_TTL_SECONDS,
    });
  });

  auth.get('/status', async (c) => {
    const authContext = getAuth(c);
    const targetUserId = authContext.type === 'user' ? authContext.userId : c.req.query('user_id');
    if (!targetUserId) {
      return c.json({ error: 'validation_error', message: 'user_id is required' }, 422);
    }

    const store = buildTokenStore();
    const connection = await store.getConnection(targetUserId);
    return c.json({
      provider: 'google',
      user_id: targetUserId,
      connected: Boolean(connection),
      email: connection?.emailAddress || null,
      connected_at: connection?.connectedAt || null,
      last_used_at: connection?.lastUsedAt || null,
    });
  });

  auth.post('/disconnect', async (c) => {
    const authContext = getAuth(c);
    const targetUserId = authContext.type === 'user' ? authContext.userId : c.req.query('user_id');
    if (!targetUserId) {
      return c.json({ error: 'validation_error', message: 'user_id is required' }, 422);
    }

    const store = buildTokenStore();
    await store.revokeConnection(targetUserId);
    return c.json({
      provider: 'google',
      user_id: targetUserId,
      disconnected: true,
    });
  });

  return auth;
}

export function createGoogleOAuthPublicRoutes(): Hono {
  const publicRoutes = new Hono();

  publicRoutes.get('/callback', async (c) => {
    const oauthError = c.req.query('error');
    const oauthErrorDescription = c.req.query('error_description');
    const code = c.req.query('code');
    const stateToken = c.req.query('state');

    if (!stateToken) {
      return c.json({ error: 'invalid_request', message: 'Missing OAuth state' }, 400);
    }

    let statePayload: ReturnType<typeof verifyGoogleOAuthStateToken>;
    try {
      statePayload = verifyGoogleOAuthStateToken(stateToken, resolveGoogleOAuthStateSecret());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'invalid_state', message }, 400);
    }

    if (oauthError) {
      const message = oauthErrorDescription || oauthError;
      return maybeRedirect(c, statePayload.returnTo, false, message);
    }

    if (!code) {
      return maybeRedirect(c, statePayload.returnTo, false, 'Missing authorization code');
    }

    try {
      const oauthConfig = getGoogleOAuthConfigFromEnv();
      const tokenStore = buildTokenStore();
      const tokens = await exchangeGoogleCodeForTokens({
        config: oauthConfig,
        code,
      });

      if (!tokens.access_token) {
        throw new Error('Google token response missing access_token');
      }

      const gmailProfile = await fetchGmailProfile(tokens.access_token);
      const existing = await tokenStore.getConnection(statePayload.userId);
      const refreshToken = tokens.refresh_token || existing?.refreshToken;
      if (!refreshToken) {
        throw new Error('Google did not return a refresh token. Please retry consent with prompt=consent.');
      }

      const accessTokenExpiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined;

      await tokenStore.upsertConnection({
        userId: statePayload.userId,
        emailAddress: gmailProfile.emailAddress,
        refreshToken,
        accessToken: tokens.access_token,
        accessTokenExpiresAt,
        tokenScope: tokens.scope,
        tokenType: tokens.token_type,
      });

      return maybeRedirect(c, statePayload.returnTo, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return maybeRedirect(c, statePayload.returnTo, false, message);
    }
  });

  return publicRoutes;
}

function buildTokenStore(): GmailConnectionStore {
  const supabase = getSupabaseClient();
  const encryption = createEmailTokenEncryptionFromEnv();
  return new GmailConnectionStore({ supabase, encryption });
}

function sanitizeReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function maybeRedirect(c: Context, returnTo: string | undefined, success: boolean, error?: string) {
  if (!returnTo) {
    if (success) {
      return c.json({ success: true, connected: true });
    }
    return c.json({ success: false, connected: false, error: error || 'oauth_failed' }, 400);
  }

  const url = new URL(returnTo);
  url.searchParams.set('gh_gmail_connected', success ? '1' : '0');
  if (!success && error) {
    url.searchParams.set('gh_gmail_error', error.slice(0, 200));
  }
  return c.redirect(url.toString(), 302);
}
