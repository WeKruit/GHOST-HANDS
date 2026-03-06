#!/usr/bin/env bun
/**
 * Local signup + email verification test site.
 *
 * Purpose:
 * - Create an account
 * - Send a verification code email
 * - Verify by entering the code
 *
 * This is meant to exercise GhostHands Gmail verification automation against a
 * realistic account-creation flow.
 *
 * Usage:
 *   bun src/scripts/test-verification-site.ts
 *   bun src/scripts/test-verification-site.ts --port=3311
 *
 * Required env for real email sending:
 *   GH_TEST_MAIL_SMTP_USER
 *   GH_TEST_MAIL_SMTP_PASS
 *
 * Optional env:
 *   GH_TEST_MAIL_SMTP_HOST=smtp.gmail.com
 *   GH_TEST_MAIL_SMTP_PORT=465
 *   GH_TEST_MAIL_FROM=<defaults to GH_TEST_MAIL_SMTP_USER>
 *   GH_TEST_MAIL_SMTP_SECURE=true
 *   GH_TEST_GOOGLE_CODE_MODE=numeric|phrase (default: numeric)
 */

import * as tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Context, Hono } from 'hono';

const DEFAULT_PORT = 3311;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 6;

const TOY_APP_TEMPLATE_PATH = join(__dirname, '../../toy-job-app/index.html');
const EMAIL_VERIFICATION_TEMPLATE_PATH = join(__dirname, '../../toy-job-app/email-verification-site.html');
const TOY_APP_TEMPLATE = readFileSync(TOY_APP_TEMPLATE_PATH, 'utf8');
const EMAIL_VERIFICATION_TEMPLATE = readFileSync(EMAIL_VERIFICATION_TEMPLATE_PATH, 'utf8');

interface PendingSignup {
  fullName: string;
  email: string;
  password: string;
  code: string;
  createdAtMs: number;
  expiresAtMs: number;
  attempts: number;
}

interface PendingGoogleLogin {
  email: string;
  code: string;
  createdAtMs: number;
  expiresAtMs: number;
  attempts: number;
}

interface AccountRecord {
  id: string;
  fullName: string;
  email: string;
  verifiedAt: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

type GoogleCodeMode = 'numeric' | 'phrase';

const pendingSignups = new Map<string, PendingSignup>();
const verifiedAccounts = new Map<string, AccountRecord>();
const pendingGoogleLogins = new Map<string, PendingGoogleLogin>();
const verifiedGoogleLogins = new Set<string>();

const app = new Hono();

app.get('/', (c) => {
  const defaultEmail = process.env.TEST_GMAIL_EMAIL || '';
  const html = renderTemplateWithDefaultEmail(TOY_APP_TEMPLATE, defaultEmail);
  return c.html(html);
});

app.get('/email-verification', (c) => {
  const defaultEmail = process.env.TEST_GMAIL_EMAIL || '';
  const html = renderTemplateWithDefaultEmail(EMAIL_VERIFICATION_TEMPLATE, defaultEmail);
  return c.html(html);
});

app.get('/health', (c) => {
  return c.json({
    ok: true,
    pending_count: pendingSignups.size,
    verified_count: verifiedAccounts.size,
    pending_google_count: pendingGoogleLogins.size,
    verified_google_count: verifiedGoogleLogins.size,
    now: new Date().toISOString(),
  });
});

app.post('/api/signup', async (c) => {
  const body = await readJsonBody(c);
  const fullName = asString(body.fullName);
  const emailRaw = asString(body.email);
  const password = asString(body.password);
  const email = normalizeEmail(emailRaw);

  if (!fullName) return c.json({ error: 'fullName is required' }, 422);
  if (!email) return c.json({ error: 'email is required' }, 422);
  if (!looksLikeEmail(email)) return c.json({ error: 'email must be valid' }, 422);
  if (password.length < 8) return c.json({ error: 'password must be at least 8 characters' }, 422);

  if (verifiedAccounts.has(email)) {
    return c.json({ error: 'An account with this email is already verified. Use a different email.' }, 409);
  }

  let smtpConfig: SmtpConfig;
  try {
    smtpConfig = getSmtpConfigFromEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({
      error: message,
      help: 'Set SMTP env vars, then retry signup.',
    }, 500);
  }

  const code = generateVerificationCode();
  const now = Date.now();
  const pending: PendingSignup = {
    fullName,
    email,
    password,
    code,
    createdAtMs: now,
    expiresAtMs: now + CODE_TTL_MS,
    attempts: 0,
  };
  pendingSignups.set(email, pending);

  try {
    await sendVerificationEmail({
      smtp: smtpConfig,
      to: email,
      fullName,
      code,
      expiresMinutes: Math.floor(CODE_TTL_MS / 60_000),
    });
  } catch (err) {
    pendingSignups.delete(email);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to send verification email: ${message}` }, 500);
  }

  console.log(`[verify-site] sent verification code to ${email}`);
  return c.json({
    ok: true,
    email,
    message: 'Verification code sent',
    expires_in_seconds: Math.floor(CODE_TTL_MS / 1000),
  });
});

app.post('/api/verify', async (c) => {
  const body = await readJsonBody(c);
  const emailRaw = asString(body.email);
  const codeInput = asString(body.code).trim();
  const email = normalizeEmail(emailRaw);

  if (!email) return c.json({ error: 'email is required' }, 422);
  if (!codeInput) return c.json({ error: 'code is required' }, 422);

  const pending = pendingSignups.get(email);
  if (!pending) {
    return c.json({ error: 'No pending signup found for this email. Create account first.' }, 404);
  }

  if (Date.now() > pending.expiresAtMs) {
    pendingSignups.delete(email);
    return c.json({ error: 'Verification code expired. Request a new code.' }, 410);
  }

  if (pending.attempts >= MAX_VERIFY_ATTEMPTS) {
    pendingSignups.delete(email);
    return c.json({ error: 'Too many attempts. Request a new code.' }, 429);
  }

  if (normalizeVerificationCode(codeInput) !== normalizeVerificationCode(pending.code)) {
    pending.attempts += 1;
    return c.json({
      error: 'Incorrect verification code',
      attempts_remaining: Math.max(0, MAX_VERIFY_ATTEMPTS - pending.attempts),
    }, 401);
  }

  pendingSignups.delete(email);
  const account: AccountRecord = {
    id: crypto.randomUUID(),
    fullName: pending.fullName,
    email: pending.email,
    verifiedAt: new Date().toISOString(),
  };
  verifiedAccounts.set(email, account);

  return c.json({
    ok: true,
    account,
  });
});

app.post('/api/auth/google/start', async (c) => {
  const body = await readJsonBody(c);
  const emailRaw = asString(body.email);
  const email = normalizeEmail(emailRaw);

  if (!email) return c.json({ error: 'email is required' }, 422);
  if (!looksLikeEmail(email)) return c.json({ error: 'email must be valid' }, 422);

  try {
    await issueGoogleVerificationCode(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }

  return c.json({
    ok: true,
    email,
    message: 'Google verification code sent',
    expires_in_seconds: Math.floor(CODE_TTL_MS / 1000),
  });
});

app.post('/api/auth/google/resend', async (c) => {
  const body = await readJsonBody(c);
  const emailRaw = asString(body.email);
  const email = normalizeEmail(emailRaw);

  if (!email) return c.json({ error: 'email is required' }, 422);
  if (!looksLikeEmail(email)) return c.json({ error: 'email must be valid' }, 422);

  try {
    await issueGoogleVerificationCode(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }

  return c.json({
    ok: true,
    email,
    message: 'Google verification code resent',
    expires_in_seconds: Math.floor(CODE_TTL_MS / 1000),
  });
});

app.post('/api/auth/google/verify', async (c) => {
  const body = await readJsonBody(c);
  const emailRaw = asString(body.email);
  const codeInput = asString(body.code).trim();
  const email = normalizeEmail(emailRaw);

  if (!email) return c.json({ error: 'email is required' }, 422);
  if (!codeInput) return c.json({ error: 'code is required' }, 422);

  if (verifiedGoogleLogins.has(email)) {
    return c.json({ ok: true, email, connected: true, already_verified: true });
  }

  const pending = pendingGoogleLogins.get(email);
  if (!pending) {
    return c.json({ error: 'No pending Google sign-in found for this email. Start sign-in first.' }, 404);
  }

  if (Date.now() > pending.expiresAtMs) {
    pendingGoogleLogins.delete(email);
    return c.json({ error: 'Verification code expired. Request a new code.' }, 410);
  }

  if (pending.attempts >= MAX_VERIFY_ATTEMPTS) {
    pendingGoogleLogins.delete(email);
    return c.json({ error: 'Too many attempts. Request a new code.' }, 429);
  }

  if (normalizeVerificationCode(codeInput) !== normalizeVerificationCode(pending.code)) {
    pending.attempts += 1;
    return c.json({
      error: 'Incorrect verification code',
      attempts_remaining: Math.max(0, MAX_VERIFY_ATTEMPTS - pending.attempts),
    }, 401);
  }

  pendingGoogleLogins.delete(email);
  verifiedGoogleLogins.add(email);

  return c.json({
    ok: true,
    connected: true,
    email,
  });
});

app.get('/api/auth/google/status', (c) => {
  const email = normalizeEmail(c.req.query('email') || '');
  if (!email) {
    return c.json({ error: 'email is required' }, 422);
  }
  return c.json({
    ok: true,
    email,
    connected: verifiedGoogleLogins.has(email),
    pending: pendingGoogleLogins.has(email),
  });
});

const port = parsePort();
console.log(`\n  Toy job app + verification test site running at http://localhost:${port}\n`);
console.log('  Flow: Continue with Google -> email code -> verify -> application form.\n');
console.log(`  Legacy page remains at http://localhost:${port}/email-verification\n`);

export default {
  port,
  fetch: app.fetch,
};

function parsePort(): number {
  const arg = process.argv.find((a) => a.startsWith('--port='));
  if (!arg) return DEFAULT_PORT;
  const parsed = Number.parseInt(arg.slice('--port='.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function generateVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function resolveGoogleCodeMode(): GoogleCodeMode {
  const raw = (process.env.GH_TEST_GOOGLE_CODE_MODE || 'numeric').trim().toLowerCase();
  if (['phrase', 'words', 'text', 'nonnumeric'].includes(raw)) {
    return 'phrase';
  }
  return 'numeric';
}

function generateGoogleVerificationCode(mode: GoogleCodeMode): string {
  if (mode === 'numeric') {
    return generateVerificationCode();
  }

  const words = [
    'amber', 'cinder', 'orchid', 'falcon', 'maple', 'river',
    'sable', 'vertex', 'copper', 'harbor', 'lunar', 'willow',
    'pioneer', 'jetstream', 'canyon', 'zenith', 'solstice', 'meadow',
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)]!;
  return `${pick()} ${pick()} ${pick()}`;
}

function normalizeVerificationCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function issueGoogleVerificationCode(email: string): Promise<void> {
  const smtp = getSmtpConfigFromEnv();
  const mode = resolveGoogleCodeMode();
  const code = generateGoogleVerificationCode(mode);
  const now = Date.now();
  pendingGoogleLogins.set(email, {
    email,
    code,
    createdAtMs: now,
    expiresAtMs: now + CODE_TTL_MS,
    attempts: 0,
  });

  try {
    await sendGoogleLoginVerificationEmail({
      smtp,
      to: email,
      code,
      expiresMinutes: Math.floor(CODE_TTL_MS / 60_000),
    });
  } catch (err) {
    pendingGoogleLogins.delete(email);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to send Google verification email: ${message}`);
  }

  console.log(`[verify-site] sent Google login verification code to ${email} (mode=${mode}, code="${code}")`);
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (typeof body !== 'object' || body === null) return {};
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getSmtpConfigFromEnv(): SmtpConfig {
  const host = (process.env.GH_TEST_MAIL_SMTP_HOST || 'smtp.gmail.com').trim();
  const portRaw = (process.env.GH_TEST_MAIL_SMTP_PORT || '465').trim();
  const secureRaw = (process.env.GH_TEST_MAIL_SMTP_SECURE || 'true').trim().toLowerCase();
  const user = (process.env.GH_TEST_MAIL_SMTP_USER || '').trim();
  const pass = process.env.GH_TEST_MAIL_SMTP_PASS || '';
  const from = (process.env.GH_TEST_MAIL_FROM || user).trim();

  const port = Number.parseInt(portRaw, 10);
  const secure = secureRaw !== 'false';

  const missing: string[] = [];
  if (!user) missing.push('GH_TEST_MAIL_SMTP_USER');
  if (!pass) missing.push('GH_TEST_MAIL_SMTP_PASS');
  if (!from) missing.push('GH_TEST_MAIL_FROM (or GH_TEST_MAIL_SMTP_USER)');
  if (!host) missing.push('GH_TEST_MAIL_SMTP_HOST');
  if (!Number.isFinite(port) || port <= 0) missing.push('GH_TEST_MAIL_SMTP_PORT');

  if (missing.length > 0) {
    throw new Error(`Missing/invalid SMTP env: ${missing.join(', ')}`);
  }
  if (!secure) {
    throw new Error('Only TLS SMTP is supported in this test script (set GH_TEST_MAIL_SMTP_SECURE=true).');
  }

  return { host, port, secure, user, pass, from };
}

async function sendVerificationEmail(opts: {
  smtp: SmtpConfig;
  to: string;
  fullName: string;
  code: string;
  expiresMinutes: number;
}): Promise<void> {
  const subject = 'Your verification code';
  const text = [
    `Hi ${opts.fullName || 'there'},`,
    '',
    `Your security code is: ${opts.code}`,
    '',
    'Enter this verification code on the signup page to finish account creation.',
    `This code expires in ${opts.expiresMinutes} minutes.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  await smtpSend({
    config: opts.smtp,
    to: opts.to,
    subject,
    text,
  });
}

async function sendGoogleLoginVerificationEmail(opts: {
  smtp: SmtpConfig;
  to: string;
  code: string;
  expiresMinutes: number;
}): Promise<void> {
  const subject = 'Google sign-in verification code';
  const text = [
    'Google sign-in verification requested.',
    '',
    `Your verification code is: ${opts.code}`,
    '',
    'Enter this code on the login page to continue your application.',
    `This code expires in ${opts.expiresMinutes} minutes.`,
  ].join('\n');

  await smtpSend({
    config: opts.smtp,
    to: opts.to,
    subject,
    text,
  });
}

async function smtpSend(opts: {
  config: SmtpConfig;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const socket = await connectTls(opts.config.host, opts.config.port);
  const reader = createSmtpReader(socket);

  try {
    await expectResponse(reader, [220], 'initial greeting');
    await sendCommand(socket, reader, 'EHLO localhost', [250], 'EHLO');
    await sendCommand(socket, reader, 'AUTH LOGIN', [334], 'AUTH LOGIN');
    await sendCommand(socket, reader, b64(opts.config.user), [334], 'AUTH username');
    await sendCommand(socket, reader, b64(opts.config.pass), [235], 'AUTH password');
    await sendCommand(
      socket,
      reader,
      `MAIL FROM:<${extractAddress(opts.config.from)}>`,
      [250],
      'MAIL FROM',
    );
    await sendCommand(
      socket,
      reader,
      `RCPT TO:<${extractAddress(opts.to)}>`,
      [250, 251],
      'RCPT TO',
    );
    await sendCommand(socket, reader, 'DATA', [354], 'DATA');

    const raw = buildEmailMessage({
      from: opts.config.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    socket.write(`${raw}\r\n.\r\n`);
    await expectResponse(reader, [250], 'message body');
    await sendCommand(socket, reader, 'QUIT', [221], 'QUIT');
  } finally {
    socket.end();
  }
}

function connectTls(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
    });

    const onError = (err: unknown) => {
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    socket.setTimeout(20_000, () => {
      onError(new Error('SMTP connection timed out'));
    });

    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function createSmtpReader(socket: tls.TLSSocket) {
  let buffer = '';
  let ended = false;
  let socketError: Error | null = null;
  const waiters: Array<() => void> = [];

  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    notify();
  });
  socket.on('end', () => {
    ended = true;
    notify();
  });
  socket.on('close', () => {
    ended = true;
    notify();
  });
  socket.on('error', (err) => {
    socketError = err instanceof Error ? err : new Error(String(err));
    notify();
  });

  function notify(): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter();
    }
  }

  async function readLine(): Promise<string> {
    while (true) {
      const idx = buffer.indexOf('\r\n');
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        return line;
      }

      if (socketError) throw socketError;
      if (ended) throw new Error('SMTP connection closed unexpectedly');
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  async function readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];

    while (true) {
      const line = await readLine();
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) continue;
      const code = Number.parseInt(match[1], 10);
      if (match[2] === ' ') {
        return { code, lines };
      }
    }
  }

  return { readResponse };
}

async function sendCommand(
  socket: tls.TLSSocket,
  reader: { readResponse: () => Promise<SmtpResponse> },
  command: string,
  expectedCodes: number[],
  label: string,
): Promise<void> {
  socket.write(`${command}\r\n`);
  await expectResponse(reader, expectedCodes, label, command);
}

async function expectResponse(
  reader: { readResponse: () => Promise<SmtpResponse> },
  expectedCodes: number[],
  label: string,
  command?: string,
): Promise<void> {
  const response = await reader.readResponse();
  if (expectedCodes.includes(response.code)) return;

  const details = response.lines.join(' | ');
  const cmd = command ? ` after "${command}"` : '';
  throw new Error(`SMTP ${label}${cmd} failed (code ${response.code}): ${details}`);
}

function buildEmailMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
}): string {
  const headers = [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
  ];

  const body = dotStuff(input.text).replace(/\r?\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim();
}

function dotStuff(text: string): string {
  return text.replace(/^\./gm, '..');
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function extractAddress(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] || trimmed).trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplateWithDefaultEmail(template: string, email: string): string {
  return template.replace(/__DEFAULT_EMAIL__/g, escapeHtml(email));
}
