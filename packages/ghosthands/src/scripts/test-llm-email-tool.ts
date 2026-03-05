#!/usr/bin/env bun
/**
 * LLM + Gmail tool visibility test.
 *
 * Verifies that an LLM can call a tool that reads the most recent Gmail message
 * via the per-user Gmail OAuth connection.
 *
 * Usage:
 *   bun src/scripts/test-llm-email-tool.ts --user-id=<uuid>
 *   bun src/scripts/test-llm-email-tool.ts --user-id=<uuid> --login-email=<email> --model=claude-haiku-4-5@20251001
 */

import { getSupabaseClient } from '../db/client.js';
import {
  GmailConnectionStore,
  createEmailTokenEncryptionFromEnv,
  getGoogleOAuthConfigFromEnv,
  refreshGoogleAccessToken,
} from '../workers/emailVerification/index.js';

interface CliArgs {
  userId: string;
  loginEmail: string | null;
  model: string;
  lookbackMinutes: number;
  maxBodyChars: number;
  maxTurns: number;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicContentBlockText {
  type: 'text';
  text: string;
}

interface AnthropicContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthropicContentBlock = AnthropicContentBlockText | AnthropicContentBlockToolUse;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<AnthropicContentBlock | AnthropicContentBlockToolResult>;
}

interface AnthropicResponse {
  id: string;
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: string | null;
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
  headers?: GmailHeader[];
  body?: {
    data?: string;
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

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_MAX_BODY_CHARS = 8000;
const DEFAULT_MAX_TURNS = 4;
const MIN_TOKEN_TTL_SECONDS = 60;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY.');
  }

  const supabase = getSupabaseClient();
  const encryption = createEmailTokenEncryptionFromEnv();
  const tokenStore = new GmailConnectionStore({ supabase, encryption });

  const connection = await tokenStore.getConnection(args.userId);
  if (!connection) {
    throw new Error(`No Gmail OAuth connection found for user ${args.userId}. Run test:gmail-verification first.`);
  }

  const userEmail = await tokenStore.getUserEmail(args.userId).catch(() => null);
  const loginEmail = args.loginEmail || userEmail || connection.emailAddress;
  if (!loginEmail) {
    throw new Error('No login email available. Pass --login-email=<email>.');
  }

  const oauthConfig = getGoogleOAuthConfigFromEnv();

  log(`Connected account email: ${userEmail || connection.emailAddress || '(unknown)'}`);
  log(`Using model: ${args.model}`);
  log(`Tool lookback window: ${args.lookbackMinutes} minute(s)`);
  log('Running LLM tool-call test...');

  const tool: AnthropicTool = {
    name: 'get_most_recent_email',
    description: 'Fetch the most recent Gmail message and return subject, sender, timestamp, and decoded body text.',
    input_schema: {
      type: 'object',
      properties: {
        lookback_minutes: {
          type: 'integer',
          minimum: 1,
          maximum: 24 * 60,
          description: 'How far back to search in minutes.',
        },
        query: {
          type: 'string',
          description: 'Optional Gmail search query to narrow results.',
        },
      },
      required: [],
    },
  };

  const messages: AnthropicMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            'Use the get_most_recent_email tool exactly once. Then output:\n' +
            'SUBJECT: <subject>\n' +
            'FROM: <from>\n' +
            'RECEIVED_AT: <iso-or-empty>\n' +
            'BODY_PREVIEW: <a short quote from the email body>\n' +
            'TOOL_SUCCESS: yes\n' +
            'If the tool fails, set TOOL_SUCCESS: no and explain why.',
        },
      ],
    },
  ];

  let toolCalls = 0;
  let finalText = '';

  for (let i = 0; i < args.maxTurns; i++) {
    const response = await callAnthropic({
      apiKey,
      model: args.model,
      tools: [tool],
      messages,
      maxTokens: 700,
    });

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is AnthropicContentBlockToolUse => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      finalText = response.content
        .filter((block): block is AnthropicContentBlockText => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      break;
    }

    const toolResults: AnthropicContentBlockToolResult[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCalls += 1;
      const input = isObject(toolUse.input) ? toolUse.input : {};
      const lookbackMinutes = readPositiveInt(input.lookback_minutes, args.lookbackMinutes);
      const query = typeof input.query === 'string' ? input.query.trim() || undefined : undefined;

      try {
        const email = await fetchMostRecentEmail({
          tokenStore,
          oauthClientId: oauthConfig.clientId,
          oauthClientSecret: oauthConfig.clientSecret,
          userId: args.userId,
          loginEmail,
          lookbackMinutes,
          maxBodyChars: args.maxBodyChars,
          query,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(email),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: JSON.stringify({ error: message }),
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) {
    throw new Error(`LLM did not produce a final answer within ${args.maxTurns} turns.`);
  }

  log(`Tool calls made: ${toolCalls}`);
  console.log('\n----- LLM OUTPUT START -----');
  console.log(finalText);
  console.log('----- LLM OUTPUT END -----\n');
}

async function fetchMostRecentEmail(opts: {
  tokenStore: GmailConnectionStore;
  oauthClientId: string;
  oauthClientSecret: string;
  userId: string;
  loginEmail: string;
  lookbackMinutes: number;
  maxBodyChars: number;
  query?: string;
}): Promise<Record<string, unknown>> {
  const accessToken = await ensureAccessToken({
    tokenStore: opts.tokenStore,
    userId: opts.userId,
    clientId: opts.oauthClientId,
    clientSecret: opts.oauthClientSecret,
  });

  const lookbackHours = Math.max(1, Math.ceil(opts.lookbackMinutes / 60));

  const queryParts = [
    opts.loginEmail ? `to:${opts.loginEmail}` : '',
    opts.query || '',
    `newer_than:${lookbackHours}h`,
  ].filter(Boolean);

  const primaryQuery = queryParts.join(' ');

  let list = await listMessages(accessToken, primaryQuery);
  if (!list.messages?.length) {
    // Fallback: no mailbox constraint.
    list = await listMessages(accessToken, [opts.query || '', `newer_than:${lookbackHours}h`].filter(Boolean).join(' '));
  }
  if (!list.messages?.length) {
    // Final fallback: latest inbox message regardless of lookback/query.
    list = await listMessages(accessToken, '');
  }

  const messageId = list.messages?.[0]?.id;
  if (!messageId) {
    throw new Error('No Gmail messages found for this account.');
  }

  const message = await getMessage(accessToken, messageId);
  const decodedText = extractMessageText(message);
  const subject = getHeader(message.payload?.headers, 'subject') || '';
  const from = getHeader(message.payload?.headers, 'from') || '';
  const receivedAt = toIsoTimestamp(message.internalDate, getHeader(message.payload?.headers, 'date'));

  const truncated = decodedText.length > opts.maxBodyChars;

  return {
    message_id: message.id,
    thread_id: message.threadId || null,
    subject,
    from,
    received_at: receivedAt,
    snippet: message.snippet || '',
    body_text: truncated ? decodedText.slice(0, opts.maxBodyChars) : decodedText,
    body_text_truncated: truncated,
    query_used: primaryQuery,
  };
}

async function ensureAccessToken(opts: {
  tokenStore: GmailConnectionStore;
  userId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const connection = await opts.tokenStore.getConnection(opts.userId);
  if (!connection) {
    throw new Error(`No Gmail OAuth connection found for user ${opts.userId}.`);
  }

  const expiresSoon = shouldRefresh(connection.accessTokenExpiresAt);
  if (connection.accessToken && !expiresSoon) {
    return connection.accessToken;
  }

  if (!connection.refreshToken) {
    throw new Error('Missing Gmail refresh token for this user.');
  }

  const refreshed = await refreshGoogleAccessToken({
    config: {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
    },
    refreshToken: connection.refreshToken,
  });

  if (!refreshed.access_token) {
    throw new Error('Google refresh response missing access_token');
  }

  const expiresAt = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    : connection.accessTokenExpiresAt;

  await opts.tokenStore.updateAccessToken({
    userId: opts.userId,
    accessToken: refreshed.access_token,
    accessTokenExpiresAt: expiresAt,
    tokenScope: refreshed.scope || connection.tokenScope,
    tokenType: refreshed.token_type || connection.tokenType,
  });

  return refreshed.access_token;
}

async function listMessages(accessToken: string, query: string): Promise<GmailMessageListResponse> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('maxResults', '1');
  if (query.trim()) {
    url.searchParams.set('q', query.trim());
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Gmail list messages failed (${response.status}): ${safeJson(payload)}`);
  }

  return (payload || {}) as GmailMessageListResponse;
}

async function getMessage(accessToken: string, messageId: string): Promise<GmailMessageResponse> {
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

async function callAnthropic(opts: {
  apiKey: string;
  model: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  maxTokens: number;
}): Promise<AnthropicResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: normalizeModel(opts.model),
      max_tokens: opts.maxTokens,
      temperature: 0,
      tools: opts.tools,
      messages: opts.messages,
    }),
  });

  const raw = await response.text();
  const payload = raw ? safeParseJson(raw) : null;

  if (!response.ok) {
    throw new Error(`Anthropic API error (${response.status}): ${safeJson(payload)}`);
  }

  return payload as AnthropicResponse;
}

function normalizeModel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_MODEL;
  // Accept convenience form: claude-haiku-4-5@20251001
  return trimmed.replace('@', '-');
}

function parseArgs(argv: string[]): CliArgs {
  const userId = readRequiredArg(argv, 'user-id');
  if (!isUuid(userId)) {
    throw new Error(`--user-id must be a UUID (got "${userId}")`);
  }

  return {
    userId,
    loginEmail: readArg(argv, 'login-email'),
    model: readArg(argv, 'model') || DEFAULT_MODEL,
    lookbackMinutes: readPositiveIntArg(argv, 'lookback-minutes', DEFAULT_LOOKBACK_MINUTES),
    maxBodyChars: readPositiveIntArg(argv, 'max-body-chars', DEFAULT_MAX_BODY_CHARS),
    maxTurns: readPositiveIntArg(argv, 'max-turns', DEFAULT_MAX_TURNS),
  };
}

function readRequiredArg(argv: string[], flag: string): string {
  const value = readArg(argv, flag);
  if (!value) {
    throw new Error(`Missing required argument --${flag}=<value>`);
  }
  return value;
}

function readArg(argv: string[], flag: string): string | null {
  const match = argv.find((arg) => arg.startsWith(`--${flag}=`));
  if (!match) return null;
  const value = match.split('=').slice(1).join('=').trim();
  return value || null;
}

function readPositiveIntArg(argv: string[], flag: string, fallback: number): number {
  const raw = readArg(argv, flag);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${flag} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

function readPositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const rounded = Math.floor(raw);
  return rounded > 0 ? rounded : fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shouldRefresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;
  const expiresTs = Date.parse(expiresAt);
  if (Number.isNaN(expiresTs)) return true;
  return expiresTs - Date.now() <= MIN_TOKEN_TTL_SECONDS * 1000;
}

function getHeader(headers: GmailHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === target)?.value;
}

function toIsoTimestamp(internalDate: string | undefined, fallbackDateHeader: string | undefined): string | undefined {
  if (internalDate) {
    const ts = Number.parseInt(internalDate, 10);
    if (Number.isFinite(ts)) {
      return new Date(ts).toISOString();
    }
  }

  if (fallbackDateHeader) {
    const parsed = Date.parse(fallbackDateHeader);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return undefined;
}

function extractMessageText(message: GmailMessageResponse): string {
  const subject = getHeader(message.payload?.headers, 'subject') || '';
  const snippet = message.snippet || '';
  const parts = collectMessageText(message.payload);
  return [subject, snippet, parts.join('\n')].filter(Boolean).join('\n');
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
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function log(message: string): void {
  console.log(`[llm-email-test] ${message}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[llm-email-test] FAILED: ${message}`);
  process.exit(1);
});
