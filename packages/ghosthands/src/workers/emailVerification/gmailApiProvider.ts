import { MissingEmailConnectionError, TokenRefreshFailedError } from './errors.js';
import { refreshGoogleAccessToken, type GoogleOAuthConfig } from './googleOAuth.js';
import type { EmailProvider, EmailSearchOptions, VerificationSignal } from './types.js';
import type { GmailConnectionStore } from './tokenStore.js';

interface GmailApiProviderOptions {
  userId: string;
  tokenStore: GmailConnectionStore;
  oauthConfig: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>;
  maxCandidates?: number;
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    data?: string;
    size?: number;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessageResponse {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

const DEFAULT_MAX_CANDIDATES = 5;
const MIN_TOKEN_TTL_SECONDS = 60;

export class GmailApiProvider implements EmailProvider {
  private readonly userId: string;
  private readonly tokenStore: GmailConnectionStore;
  private readonly oauthConfig: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>;
  private readonly maxCandidates: number;

  constructor(options: GmailApiProviderOptions) {
    this.userId = options.userId;
    this.tokenStore = options.tokenStore;
    this.oauthConfig = options.oauthConfig;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  }

  async findLatestVerificationSignal(options: EmailSearchOptions): Promise<VerificationSignal | null> {
    const accessToken = await this.ensureAccessToken();
    const query = buildVerificationQuery(options.loginEmail, options.lookbackMinutes);
    const list = await this.listMessages(accessToken, query);
    const messageIds = (list.messages || []).map((message) => message.id).slice(0, this.maxCandidates);

    for (const messageId of messageIds) {
      const message = await this.getMessage(accessToken, messageId);
      const bodyText = extractMessageText(message);
      const subject = getHeader(message.payload?.headers, 'subject');
      const from = getHeader(message.payload?.headers, 'from');
      const receivedAt = toIsoTimestamp(message.internalDate, getHeader(message.payload?.headers, 'date'));

      const signal = detectSignal(bodyText, {
        id: message.id,
        subject,
        from,
        receivedAt,
      });
      if (signal) {
        await this.tokenStore.markUsed(this.userId);
        return signal;
      }
    }

    return null;
  }

  private async ensureAccessToken(): Promise<string> {
    const connection = await this.tokenStore.getConnection(this.userId);
    if (!connection) {
      throw new MissingEmailConnectionError();
    }

    const expiresSoon = shouldRefresh(connection.accessTokenExpiresAt);
    if (connection.accessToken && !expiresSoon) {
      return connection.accessToken;
    }

    if (!connection.refreshToken) {
      throw new TokenRefreshFailedError('Missing Gmail refresh token for user');
    }

    const refreshed = await refreshGoogleAccessToken({
      config: this.oauthConfig,
      refreshToken: connection.refreshToken,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TokenRefreshFailedError(msg);
    });

    if (!refreshed.access_token) {
      throw new TokenRefreshFailedError('Google refresh response missing access_token');
    }

    const expiresAt = refreshed.expires_in
      ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
      : connection.accessTokenExpiresAt;

    await this.tokenStore.updateAccessToken({
      userId: this.userId,
      accessToken: refreshed.access_token,
      accessTokenExpiresAt: expiresAt,
      tokenScope: refreshed.scope || connection.tokenScope,
      tokenType: refreshed.token_type || connection.tokenType,
    });

    return refreshed.access_token;
  }

  private async listMessages(accessToken: string, query: string): Promise<GmailMessageListResponse> {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(this.maxCandidates));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Gmail message list failed (${response.status}): ${safeJson(payload)}`);
    }

    return (payload || {}) as GmailMessageListResponse;
  }

  private async getMessage(accessToken: string, messageId: string): Promise<GmailMessageResponse> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set('format', 'full');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Gmail message read failed (${response.status}): ${safeJson(payload)}`);
    }

    return payload as GmailMessageResponse;
  }
}

function shouldRefresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const expiresTs = Date.parse(expiresAt);
  if (Number.isNaN(expiresTs)) return true;
  const remainingMs = expiresTs - Date.now();
  return remainingMs <= MIN_TOKEN_TTL_SECONDS * 1000;
}

function buildVerificationQuery(loginEmail: string, lookbackMinutes: number): string {
  const lookbackHours = Math.max(1, Math.ceil(lookbackMinutes / 60));
  const mailbox = loginEmail ? `to:${loginEmail}` : '';
  return [
    mailbox,
    '(verify OR verification OR confirm OR activation OR otp OR "one-time" OR "sign in" OR "security code")',
    `newer_than:${lookbackHours}h`,
  ].filter(Boolean).join(' ');
}

function detectSignal(
  text: string,
  meta: { id: string; subject?: string; from?: string; receivedAt?: string },
): VerificationSignal | null {
  if (!text) return null;

  const link = extractVerificationLink(text);
  if (link) {
    return {
      kind: 'link',
      messageId: meta.id,
      subject: meta.subject,
      from: meta.from,
      receivedAt: meta.receivedAt,
      link,
      rawText: text,
    };
  }

  const code = extractOtp(text);
  if (code) {
    return {
      kind: 'otp',
      messageId: meta.id,
      subject: meta.subject,
      from: meta.from,
      receivedAt: meta.receivedAt,
      code,
      rawText: text,
    };
  }

  return null;
}

function extractVerificationLink(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s<>")]+/gi) || [];
  if (urls.length === 0) return null;
  const preferred = urls.find((url) => /verify|verification|confirm|activate|magic|token|signin|sign-in|account/i.test(url));
  return preferred ?? urls[0] ?? null;
}

function extractOtp(text: string): string | null {
  const focused = text.match(/(?:verification|security|one[-\s]?time|otp|code)\D{0,24}([A-Z0-9]{4,10})/i);
  if (focused?.[1]) return focused[1];
  const numeric = text.match(/\b(\d{4,8})\b/);
  if (numeric?.[1]) return numeric[1];
  return null;
}

function extractMessageText(message: GmailMessageResponse): string {
  const subject = getHeader(message.payload?.headers, 'subject') || '';
  const snippet = message.snippet || '';
  const bodyParts = collectMessageText(message.payload);
  return [subject, snippet, bodyParts.join('\n')].filter(Boolean).join('\n');
}

function collectMessageText(part: GmailMessagePart | undefined): string[] {
  if (!part) return [];

  const output: string[] = [];
  const mime = (part.mimeType || '').toLowerCase();

  if (part.body?.data && (mime.includes('text/plain') || mime.includes('text/html') || !mime)) {
    const decoded = decodeBase64Url(part.body.data);
    if (decoded) {
      output.push(mime.includes('text/html') ? stripHtml(decoded) : decoded);
    }
  }

  for (const child of part.parts || []) {
    output.push(...collectMessageText(child));
  }

  return output;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getHeader(headers: GmailHeader[] | undefined, name: string): string | undefined {
  if (!headers || headers.length === 0) return undefined;
  const found = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  const value = found?.value?.trim();
  return value || undefined;
}

function toIsoTimestamp(internalDate?: string, headerDate?: string): string | undefined {
  if (internalDate) {
    const millis = Number.parseInt(internalDate, 10);
    if (Number.isFinite(millis) && millis > 0) {
      return new Date(millis).toISOString();
    }
  }
  if (headerDate) {
    const ts = Date.parse(headerDate);
    if (!Number.isNaN(ts)) {
      return new Date(ts).toISOString();
    }
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
