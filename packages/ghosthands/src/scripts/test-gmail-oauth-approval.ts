#!/usr/bin/env bun
/**
 * Test whether a specific Gmail address is approved to authorize this project's
 * Google OAuth app.
 *
 * Flow:
 * 1) Optional: disconnect existing Gmail OAuth connection for the user.
 * 2) Start OAuth with login_hint=<email> and return_to=<local callback>.
 * 3) Wait for callback + poll connection status.
 * 4) Report pass/fail for the exact email under test.
 *
 * Usage:
 *   bun src/scripts/test-gmail-oauth-approval.ts --user-id=<uuid> --email=<gmail>
 *   bun src/scripts/test-gmail-oauth-approval.ts --user-id=<uuid> --email=<gmail> --disconnect-first
 *
 * Notes:
 * - Requires GH_SERVICE_SECRET and running API.
 * - This validates tester access / OAuth consent behavior for the configured
 *   GH_GOOGLE_OAUTH_CLIENT_ID project in this GhostHands API process.
 */

import { createServer, type Server } from 'node:http';

interface CliArgs {
  userId: string;
  email: string;
  apiBase: string;
  waitSeconds: number;
  pollSeconds: number;
  disconnectFirst: boolean;
  callbackHost: string;
  callbackPort: number;
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

interface CallbackResult {
  connected: boolean;
  error: string | null;
}

interface CallbackListener {
  returnTo: string;
  getLatest: () => CallbackResult | null;
  waitForResult: (timeoutMs: number) => Promise<CallbackResult | null>;
  close: () => Promise<void>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const serviceSecret = process.env.GH_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error('Missing GH_SERVICE_SECRET (required for /api/v1/gh/auth/google/* routes).');
  }

  await preflightApi(args.apiBase);

  const emailLower = args.email.toLowerCase();

  log(`Testing Gmail OAuth approval for: ${args.email}`);
  log(`User ID: ${args.userId}`);

  const existing = await fetchGoogleStatus(args, serviceSecret);
  if (existing.connected && !args.disconnectFirst) {
    log(
      `User already has a connected Gmail account (${existing.email || 'unknown'}). ` +
      'For a clean approval test, rerun with --disconnect-first.',
    );
  }

  if (args.disconnectFirst) {
    log('Disconnecting existing Gmail OAuth connection first...');
    await disconnectGoogle(args, serviceSecret);
  }

  const callback = await startCallbackListener({
    host: args.callbackHost,
    port: args.callbackPort,
  });

  try {
    const start = await fetchGoogleStart(args, serviceSecret, {
      loginHint: args.email,
      returnTo: callback.returnTo,
    });

    log('Open this URL in a browser and continue with the TEST email account:');
    console.log(start.auth_url);
    log(`Waiting up to ${args.waitSeconds}s for OAuth callback and connection status...`);

    const deadline = Date.now() + args.waitSeconds * 1000;
    let statusConnected = false;
    let latestStatusEmail: string | null = null;

    while (Date.now() < deadline) {
      const status = await fetchGoogleStatus(args, serviceSecret);
      latestStatusEmail = status.email;
      if (status.connected && status.email && status.email.toLowerCase() === emailLower) {
        statusConnected = true;
        break;
      }
      await sleep(args.pollSeconds * 1000);
    }

    const callbackResult = callback.getLatest();
    const finalStatus = await fetchGoogleStatus(args, serviceSecret);

    if (finalStatus.connected && finalStatus.email && finalStatus.email.toLowerCase() === emailLower) {
      log(`PASS: OAuth approved and connected as ${finalStatus.email}`);
      return;
    }

    if (callbackResult && !callbackResult.connected) {
      const msg = callbackResult.error || 'OAuth denied';
      if (/hasn.?t given you access|currently being tested|not been verified/i.test(msg)) {
        throw new Error(
          `FAIL: ${args.email} is not approved for this OAuth client/project.\n` +
          `Google error: ${msg}`,
        );
      }
      throw new Error(`FAIL: OAuth callback returned failure: ${msg}`);
    }

    if (statusConnected) {
      throw new Error(
        `FAIL: OAuth connected, but connected Gmail is ${latestStatusEmail || finalStatus.email || 'unknown'} ` +
        `instead of requested ${args.email}.`,
      );
    }

    const callbackHint = callback.getLatest();
    if (callbackHint && !callbackHint.connected) {
      throw new Error(`FAIL: ${callbackHint.error || 'OAuth callback returned failure.'}`);
    }

    throw new Error(
      `Timed out after ${args.waitSeconds}s without successful connection for ${args.email}. ` +
      'If Google showed "Access blocked", the email is not approved in OAuth testing users.',
    );
  } finally {
    await callback.close();
  }
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

async function fetchGoogleStart(
  args: CliArgs,
  serviceSecret: string,
  opts: { loginHint: string; returnTo: string },
): Promise<GoogleAuthStartResponse> {
  const url = new URL('/api/v1/gh/auth/google/start', args.apiBase);
  url.searchParams.set('user_id', args.userId);
  url.searchParams.set('login_hint', opts.loginHint);
  url.searchParams.set('return_to', opts.returnTo);

  return await fetchJson<GoogleAuthStartResponse>(url.toString(), {
    method: 'GET',
    headers: {
      'X-GH-Service-Key': serviceSecret,
    },
  });
}

async function disconnectGoogle(args: CliArgs, serviceSecret: string): Promise<void> {
  const url = new URL('/api/v1/gh/auth/google/disconnect', args.apiBase);
  url.searchParams.set('user_id', args.userId);
  await fetchJson(url.toString(), {
    method: 'POST',
    headers: {
      'X-GH-Service-Key': serviceSecret,
    },
  });
}

async function fetchJson<T = unknown>(url: string, init: RequestInit): Promise<T> {
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

function startCallbackListener(opts: { host: string; port: number }): Promise<CallbackListener> {
  return new Promise((resolve, reject) => {
    let latestResult: CallbackResult | null = null;
    let settleWaiter: ((result: CallbackResult) => void) | null = null;

    const server = createServer((req, res) => {
      try {
        const hostHeader = req.headers.host || `${opts.host}:${opts.port}`;
        const url = new URL(req.url || '/', `http://${hostHeader}`);

        if (url.pathname !== '/oauth-result') {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('Not found');
          return;
        }

        const connected = url.searchParams.get('gh_gmail_connected') === '1';
        const error = url.searchParams.get('gh_gmail_error');

        latestResult = { connected, error: error || null };
        if (settleWaiter) {
          const waiter = settleWaiter;
          settleWaiter = null;
          waiter(latestResult);
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          connected
            ? '<h1>OAuth connected</h1><p>You can return to terminal.</p>'
            : `<h1>OAuth failed</h1><p>${escapeHtml(error || 'unknown_error')}</p><p>Return to terminal.</p>`,
        );
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(`Callback parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    server.once('error', (err) => reject(err));
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine callback server address'));
        return;
      }

      const returnTo = `http://${opts.host}:${address.port}/oauth-result`;
      const listener: CallbackListener = {
        returnTo,
        getLatest: () => latestResult,
        waitForResult: (timeoutMs: number) => waitForCallbackResult(timeoutMs, () => latestResult, (cb) => { settleWaiter = cb; }),
        close: () => closeServer(server),
      };
      resolve(listener);
    });
  });
}

function waitForCallbackResult(
  timeoutMs: number,
  getLatest: () => CallbackResult | null,
  setWaiter: (waiter: (result: CallbackResult) => void) => void,
): Promise<CallbackResult | null> {
  const immediate = getLatest();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(getLatest()), timeoutMs);
    setWaiter((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function parseArgs(argv: string[]): CliArgs {
  const userId = readRequiredArg(argv, 'user-id');
  if (!isUuid(userId)) {
    throw new Error(`--user-id must be a UUID (got "${userId}")`);
  }

  const email = readRequiredArg(argv, 'email');
  if (!looksLikeEmail(email)) {
    throw new Error(`--email must look like an email address (got "${email}")`);
  }

  return {
    userId,
    email,
    apiBase: readArg(argv, 'api-base') || `http://localhost:${process.env.GH_API_PORT || '3100'}`,
    waitSeconds: readPositiveIntArg(argv, 'wait-seconds', 180),
    pollSeconds: readPositiveIntArg(argv, 'poll-seconds', 5),
    disconnectFirst: hasFlag(argv, 'disconnect-first'),
    callbackHost: readArg(argv, 'callback-host') || '127.0.0.1',
    callbackPort: readPositiveIntArg(argv, 'callback-port', 8788),
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

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function log(message: string): void {
  console.log(`[gmail-approval-test] ${message}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[gmail-approval-test] FAILED: ${message}`);
  process.exit(1);
});
