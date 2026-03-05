#!/usr/bin/env bun
/**
 * Test Gmail verification automation without running a full job.
 *
 * Flow:
 * 1) Checks Google OAuth connection status for the user.
 * 2) If disconnected, prints OAuth consent URL and polls until connected.
 * 3) Queries Gmail for the latest verification signal (link or OTP).
 *
 * Usage:
 *   bun src/scripts/test-gmail-verification.ts --user-id=<uuid>
 *   bun src/scripts/test-gmail-verification.ts --user-id=<uuid> --login-email=user@gmail.com --require-signal
 */

import { getSupabaseClient } from '../db/client.js';
import {
  GmailApiProvider,
  GmailConnectionStore,
  createEmailTokenEncryptionFromEnv,
  getGoogleOAuthConfigFromEnv,
  MissingEmailConnectionError,
} from '../workers/emailVerification/index.js';

interface CliArgs {
  userId: string;
  apiBase: string;
  loginEmail: string | null;
  loginHint: string | null;
  returnTo: string | null;
  lookbackMinutes: number;
  waitSeconds: number;
  pollSeconds: number;
  skipOAuth: boolean;
  requireSignal: boolean;
}

interface GoogleAuthStatusResponse {
  provider: 'google';
  user_id: string;
  connected: boolean;
  email: string | null;
  connected_at: string | null;
  last_used_at: string | null;
}

interface GoogleAuthStartResponse {
  provider: 'google';
  user_id: string;
  auth_url: string;
  expires_in_seconds: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serviceSecret = process.env.GH_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('Missing GH_SERVICE_SECRET (required for /api/v1/gh/auth/google/* routes).');
  }
  await preflightApi(args.apiBase);

  log('Checking Gmail OAuth connection status...');
  const status = await ensureConnection(args, serviceSecret);

  const loginEmail = args.loginEmail || status.email;
  if (!loginEmail) {
    throw new Error(
      'No login email available. Pass --login-email=<email> or connect an account with an email address.',
    );
  }

  log(`Connected Gmail account: ${status.email || '(hidden)'}`);
  log(`Searching for verification messages to: ${loginEmail} (lookback: ${args.lookbackMinutes}m)`);

  const supabase = getSupabaseClient();
  const encryption = createEmailTokenEncryptionFromEnv();
  const tokenStore = new GmailConnectionStore({ supabase, encryption });
  const oauthConfig = getGoogleOAuthConfigFromEnv();

  const provider = new GmailApiProvider({
    userId: args.userId,
    tokenStore,
    oauthConfig: {
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
    },
  });

  const signal = await provider.findLatestVerificationSignal({
    loginEmail,
    lookbackMinutes: args.lookbackMinutes,
  });

  if (!signal) {
    const msg = `No verification signal found in the last ${args.lookbackMinutes} minute(s).`;
    if (args.requireSignal) {
      throw new Error(msg);
    }
    log(msg);
    log('Tip: trigger a fresh verification email on a target site, then rerun this script.');
    return;
  }

  log(`Signal found: kind=${signal.kind}, messageId=${signal.messageId || 'n/a'}`);
  if (signal.subject) log(`Subject: ${signal.subject}`);
  if (signal.from) log(`From: ${signal.from}`);
  if (signal.receivedAt) log(`Received: ${signal.receivedAt}`);
  if (signal.link) log(`Link: ${redactSensitiveUrl(signal.link)}`);
  if (signal.code) log(`Code: ${signal.code}`);
}

async function ensureConnection(args: CliArgs, serviceSecret: string): Promise<GoogleAuthStatusResponse> {
  let status = await fetchGoogleStatus(args, serviceSecret);
  if (status.connected) {
    return status;
  }

  if (args.skipOAuth) {
    throw new MissingEmailConnectionError();
  }

  const start = await fetchGoogleStart(args, serviceSecret);
  log('No existing Gmail connection for this user.');
  log('Open this URL and complete Google consent:');
  console.log(start.auth_url);
  log(`Waiting up to ${args.waitSeconds}s for OAuth callback...`);

  const deadline = Date.now() + args.waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(args.pollSeconds * 1000);
    status = await fetchGoogleStatus(args, serviceSecret);
    if (status.connected) {
      log('OAuth connection established.');
      return status;
    }
  }

  throw new Error(
    `Timed out waiting for Gmail connection after ${args.waitSeconds}s. ` +
    'Complete consent in the browser and rerun.',
  );
}

async function fetchGoogleStatus(args: CliArgs, serviceSecret: string): Promise<GoogleAuthStatusResponse> {
  const url = new URL('/api/v1/gh/auth/google/status', args.apiBase);
  url.searchParams.set('user_id', args.userId);
  return await fetchJson<GoogleAuthStatusResponse>(url.toString(), {
    method: 'GET',
    headers: {
      'X-GH-Service-Key': serviceSecret,
    },
  });
}

async function fetchGoogleStart(args: CliArgs, serviceSecret: string): Promise<GoogleAuthStartResponse> {
  const url = new URL('/api/v1/gh/auth/google/start', args.apiBase);
  url.searchParams.set('user_id', args.userId);
  if (args.loginHint) url.searchParams.set('login_hint', args.loginHint);
  if (args.returnTo) url.searchParams.set('return_to', args.returnTo);

  return await fetchJson<GoogleAuthStartResponse>(url.toString(), {
    method: 'GET',
    headers: {
      'X-GH-Service-Key': serviceSecret,
    },
  });
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  const data = raw ? safeParseJson(raw) : null;

  if (!response.ok) {
    if (response.status === 404 && url.includes('/api/v1/gh/auth/google/')) {
      throw new Error(
        `Route not found at ${url}. ` +
        'You are likely pointing at a non-GhostHands API or an older API process. ' +
        'Run the API from this branch and/or pass --api-base.',
      );
    }
    const errorJson = data && typeof data === 'object' ? JSON.stringify(data) : raw;
    throw new Error(`HTTP ${response.status} ${response.statusText} (${url}): ${errorJson}`);
  }

  return (data ?? {}) as T;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function redactSensitiveUrl(link: string): string {
  try {
    const url = new URL(link);
    const sensitiveKeys = ['token', 'code', 'otp', 'auth', 'key', 'state'];
    for (const [key] of url.searchParams.entries()) {
      if (sensitiveKeys.some((sensitiveKey) => key.toLowerCase().includes(sensitiveKey))) {
        url.searchParams.set(key, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return link;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const userId = readRequiredArg(argv, 'user-id');
  if (!isUuid(userId)) {
    throw new Error(`--user-id must be a UUID (got "${userId}")`);
  }
  const apiBase =
    readArg(argv, 'api-base') ||
    `http://localhost:${process.env.GH_API_PORT || '3100'}`;

  return {
    userId,
    apiBase,
    loginEmail: readArg(argv, 'login-email'),
    loginHint: readArg(argv, 'login-hint'),
    returnTo: readArg(argv, 'return-to'),
    lookbackMinutes: readPositiveIntArg(argv, 'lookback-minutes', 15),
    waitSeconds: readPositiveIntArg(argv, 'wait-seconds', 180),
    pollSeconds: readPositiveIntArg(argv, 'poll-seconds', 5),
    skipOAuth: hasFlag(argv, 'skip-oauth'),
    requireSignal: hasFlag(argv, 'require-signal'),
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

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(`--${flag}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function preflightApi(apiBase: string): Promise<void> {
  const healthUrl = new URL('/health', apiBase).toString();

  let response: Response;
  try {
    response = await fetch(healthUrl, { method: 'GET' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach API at ${apiBase} (${message}). ` +
      'Start GhostHands API and/or pass --api-base=<url>.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `API preflight failed at ${healthUrl}: HTTP ${response.status}. ` +
      'Ensure the GhostHands API is running from this repo/branch.',
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function log(message: string): void {
  console.log(`[gmail-test] ${message}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[gmail-test] FAILED: ${message}`);
  process.exit(1);
});
