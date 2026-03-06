import crypto from 'node:crypto';

export interface GoogleOAuthStatePayload {
  userId: string;
  iat: number;
  exp: number;
  returnTo?: string;
  loginHint?: string;
  nonce?: string;
}

export function resolveGoogleOAuthStateSecret(): string {
  return process.env.GH_GOOGLE_OAUTH_STATE_SECRET
    || process.env.GH_GOOGLE_OAUTH_CLIENT_SECRET
    || '';
}

export function createGoogleOAuthStateToken(
  payload: GoogleOAuthStatePayload,
  secret: string,
): string {
  if (!secret) {
    throw new Error('Missing GH_GOOGLE_OAUTH_STATE_SECRET (or GH_GOOGLE_OAUTH_CLIENT_SECRET fallback).');
  }

  const bodyJson = JSON.stringify(payload);
  const body = toBase64Url(Buffer.from(bodyJson, 'utf8'));
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

export function verifyGoogleOAuthStateToken(
  token: string,
  secret: string,
): GoogleOAuthStatePayload {
  if (!secret) {
    throw new Error('Missing GH_GOOGLE_OAUTH_STATE_SECRET (or GH_GOOGLE_OAUTH_CLIENT_SECRET fallback).');
  }

  const [body, signature] = token.split('.');
  if (!body || !signature) {
    throw new Error('Invalid OAuth state token format');
  }

  const expected = sign(body, secret);
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error('Invalid OAuth state signature');
  }

  const payloadJson = fromBase64Url(body).toString('utf8');
  const payload = JSON.parse(payloadJson) as GoogleOAuthStatePayload;

  if (!payload.userId) {
    throw new Error('OAuth state payload missing userId');
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    throw new Error('OAuth state token expired');
  }

  return payload;
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64');
}
