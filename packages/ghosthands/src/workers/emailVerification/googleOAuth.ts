export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export interface GmailProfileResponse {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

const GOOGLE_AUTH_BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export const DEFAULT_GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export function getGoogleOAuthConfigFromEnv(): GoogleOAuthConfig {
  const clientId = process.env.GH_GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GH_GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GH_GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Missing Google OAuth config. Set GH_GOOGLE_OAUTH_CLIENT_ID, GH_GOOGLE_OAUTH_CLIENT_SECRET, GH_GOOGLE_OAUTH_REDIRECT_URI.',
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

export function buildGoogleOAuthAuthorizeUrl(params: {
  config: GoogleOAuthConfig;
  state: string;
  loginHint?: string;
  scopes?: string[];
}): string {
  const scopes = params.scopes && params.scopes.length > 0 ? params.scopes : DEFAULT_GOOGLE_SCOPES;

  const url = new URL(GOOGLE_AUTH_BASE_URL);
  url.searchParams.set('client_id', params.config.clientId);
  url.searchParams.set('redirect_uri', params.config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', params.state);
  if (params.loginHint) {
    url.searchParams.set('login_hint', params.loginHint);
  }

  return url.toString();
}

export async function exchangeGoogleCodeForTokens(params: {
  config: GoogleOAuthConfig;
  code: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.config.clientId,
    client_secret: params.config.clientSecret,
    redirect_uri: params.config.redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${safeJson(payload)}`);
  }

  return payload as GoogleTokenResponse;
}

export async function refreshGoogleAccessToken(params: {
  config: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>;
  refreshToken: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: params.config.clientId,
    client_secret: params.config.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Google token refresh failed (${response.status}): ${safeJson(payload)}`);
  }

  return payload as GoogleTokenResponse;
}

export async function fetchGmailProfile(accessToken: string): Promise<GmailProfileResponse> {
  const response = await fetch(GOOGLE_GMAIL_PROFILE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Gmail profile fetch failed (${response.status}): ${safeJson(payload)}`);
  }

  if (!payload || typeof payload.emailAddress !== 'string' || !payload.emailAddress) {
    throw new Error('Gmail profile response missing emailAddress');
  }

  return payload as GmailProfileResponse;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
