import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { shell } from 'electron';
import http from 'http';
import type { AuthSession } from '../shared/types';

let supabase: SupabaseClient | null = null;
let currentSession: Session | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Singleton Supabase client for the Electron main process */
export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY environment variable');
    }
    supabase = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    });
  }
  return supabase;
}

/** Convert a Supabase Session to the renderer-safe AuthSession */
function toAuthSession(session: Session): AuthSession {
  const user = session.user;
  return {
    accessToken: session.access_token,
    user: {
      id: user.id,
      email: user.email ?? '',
      name: user.user_metadata?.full_name || user.user_metadata?.name,
      avatarUrl: user.user_metadata?.avatar_url,
    },
    expiresAt: session.expires_at ?? 0,
  };
}

/** Schedule a token refresh 60 seconds before expiry */
function scheduleRefresh(): void {
  clearRefreshTimer();
  if (!currentSession?.expires_at) return;

  const expiresAtMs = currentSession.expires_at * 1000;
  const refreshInMs = expiresAtMs - Date.now() - 60_000;
  if (refreshInMs <= 0) {
    // Already close to expiry — refresh immediately
    refreshAccessToken();
    return;
  }

  refreshTimer = setTimeout(() => refreshAccessToken(), refreshInMs);
}

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

async function refreshAccessToken(): Promise<void> {
  if (!currentSession?.refresh_token) return;
  try {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.refreshSession({
      refresh_token: currentSession.refresh_token,
    });
    if (error || !data.session) {
      currentSession = null;
      return;
    }
    currentSession = data.session;
    scheduleRefresh();
  } catch {
    // Refresh failed silently — user will need to re-authenticate
    currentSession = null;
  }
}

/**
 * Sign in with Google OAuth.
 * Opens the system browser for Google sign-in, catches the redirect on a local server.
 */
export async function signInWithGoogle(): Promise<{ session: AuthSession | null; error?: string }> {
  return new Promise((resolve) => {
    const client = getSupabaseClient();

    // Create a temporary HTTP server to receive the OAuth callback
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const errorParam = url.searchParams.get('error');

      if (errorParam) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Sign-in failed. You can close this tab.</h2></body></html>');
        server.close();
        resolve({ session: null, error: errorParam });
        return;
      }

      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>No authorization code received. You can close this tab.</h2></body></html>');
        server.close();
        resolve({ session: null, error: 'No authorization code received' });
        return;
      }

      try {
        const { data, error } = await client.auth.exchangeCodeForSession(code);

        if (error || !data.session) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed. You can close this tab.</h2></body></html>');
          server.close();
          resolve({ session: null, error: error?.message ?? 'Failed to exchange code' });
          return;
        }

        currentSession = data.session;
        scheduleRefresh();

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Signed in successfully! You can close this tab and return to GhostHands.</h2></body></html>');
        server.close();
        resolve({ session: toAuthSession(data.session) });
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Something went wrong. You can close this tab.</h2></body></html>');
        server.close();
        resolve({ session: null, error: err.message });
      }
    });

    // Listen on a random available port
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        resolve({ session: null, error: 'Failed to start local server' });
        return;
      }

      const port = addr.port;
      const redirectTo = `http://127.0.0.1:${port}/callback`;

      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      if (error || !data.url) {
        server.close();
        resolve({ session: null, error: error?.message ?? 'Failed to generate OAuth URL' });
        return;
      }

      shell.openExternal(data.url);

      // Auto-close after 5 minutes if no callback received
      setTimeout(() => {
        server.close();
        resolve({ session: null, error: 'Sign-in timed out' });
      }, 5 * 60 * 1000);
    });
  });
}

/** Sign out and clear session */
export async function signOut(): Promise<void> {
  clearRefreshTimer();
  if (currentSession) {
    try {
      const client = getSupabaseClient();
      await client.auth.signOut();
    } catch {
      // Best-effort sign out
    }
  }
  currentSession = null;
}

/** Get the current in-memory session (if any) */
export function getSession(): AuthSession | null {
  if (!currentSession) return null;
  return toAuthSession(currentSession);
}

/** Get the access token for API calls */
export function getAccessToken(): string | null {
  return currentSession?.access_token ?? null;
}

/** Get the refresh token for persistence */
export function getRefreshToken(): string | null {
  return currentSession?.refresh_token ?? null;
}

/** Try to restore a session from a stored refresh token */
export async function tryRestoreSession(refreshToken: string): Promise<AuthSession | null> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return null;

    currentSession = data.session;
    scheduleRefresh();
    return toAuthSession(data.session);
  } catch {
    return null;
  }
}
