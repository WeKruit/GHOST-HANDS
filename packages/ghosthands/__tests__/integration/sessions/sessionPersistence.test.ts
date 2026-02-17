/**
 * Session Persistence — Real Integration Test
 *
 * Tests the full session lifecycle against real Supabase + real browser:
 *   1. Try loading existing session from DB — if valid, skip login
 *   2. If no session: login to Gmail → capture storageState → save to DB
 *   3. Verify load/decrypt round-trip
 *   4. Open NEW browser with loaded session → verify still logged in
 *
 * IMPORTANT: This test KEEPS the session in the DB after running.
 * This avoids repeated fresh logins which trigger Google bot detection.
 * On subsequent runs, Step 1 loads the saved session and skips login entirely.
 *
 * Prerequisites:
 *   - Migration 008_gh_browser_sessions.sql applied to Supabase
 *   - .env has: SUPABASE_URL, SUPABASE_SERVICE_KEY, GH_CREDENTIAL_KEY
 *   - .env has: TEST_GMAIL_EMAIL, TEST_GMAIL_PASSWORD
 *
 * Run:
 *   bun test __tests__/integration/sessions/sessionPersistence.test.ts
 */

import { describe, test, expect, afterAll } from 'vitest';
import { chromium, type BrowserContext, type Browser } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { SessionManager } from '../../../src/sessions/SessionManager.js';
import { CredentialEncryption } from '../../../src/db/encryption.js';

// ── Config from env ──────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const GH_CREDENTIAL_KEY = process.env.GH_CREDENTIAL_KEY!;
const TEST_EMAIL = process.env.TEST_GMAIL_EMAIL!;
const TEST_PASSWORD = process.env.TEST_GMAIL_PASSWORD!;

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'; // fake UUID for test
const GMAIL_URL = 'https://mail.google.com';

// Validate env before running
function checkEnv() {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!GH_CREDENTIAL_KEY) missing.push('GH_CREDENTIAL_KEY');
  if (!TEST_EMAIL) missing.push('TEST_GMAIL_EMAIL');
  if (!TEST_PASSWORD) missing.push('TEST_GMAIL_PASSWORD');
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}. Check packages/ghosthands/.env`);
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const encryption = new CredentialEncryption({
  primaryKeyHex: GH_CREDENTIAL_KEY,
  primaryKeyId: 1,
});

const sessionManager = new SessionManager({ supabase, encryption });

// Track browsers for cleanup
const browsers: Browser[] = [];

afterAll(async () => {
  // NOTE: We intentionally do NOT clear the session from DB.
  // Keeping it avoids repeated fresh logins that trigger Google bot detection.
  // The session persists for future test runs — that's the whole point.
  for (const b of browsers) {
    await b.close().catch(() => {});
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch({ headless: false }); // visible so you can watch
  browsers.push(browser);
  return browser;
}

async function loginToGmail(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto('https://accounts.google.com/signin');

  // Enter email
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.click('#identifierNext');

  // Enter password
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('#passwordNext');

  // Wait for Gmail to load (or Google account page)
  await page.waitForURL(/mail\.google\.com|myaccount\.google\.com/, { timeout: 30000 });
  console.log('[Test] Logged into Gmail. Current URL:', page.url());
}

async function isLoggedIntoGoogle(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded' });

  // Give it time to redirect
  await page.waitForTimeout(5000);

  const url = page.url();
  console.log('[Test] Session check URL:', url);

  // If we land on Gmail inbox (not sign-in page), session is valid
  const isLoggedIn = url.includes('mail.google.com/mail') && !url.includes('accounts.google.com');
  return isLoggedIn;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Session Persistence (real Supabase + real browser)', () => {
  checkEnv();

  let sessionState: Record<string, unknown> | null = null;
  let freshLogin = false;

  test('Step 1: Load existing session or login fresh', async () => {
    // Try loading an existing session first (from previous test run)
    const existing = await sessionManager.loadSession(TEST_USER_ID, GMAIL_URL);

    if (existing) {
      console.log('[Test] Found existing session in DB — skipping login');
      const cookies = (existing as any).cookies || [];
      console.log('[Test] Existing session has', cookies.length, 'cookies');
      sessionState = existing;
      freshLogin = false;

      // Verify it's actually still valid by opening a browser
      const browser = await launchBrowser();
      const context = await browser.newContext({ storageState: existing as any });
      const valid = await isLoggedIntoGoogle(context);
      await browser.close();

      if (valid) {
        console.log('[Test] Existing session is still valid');
        expect(valid).toBe(true);
        return;
      }

      // Session expired — need fresh login
      console.log('[Test] Existing session expired — doing fresh login');
    } else {
      console.log('[Test] No existing session — doing fresh login');
    }

    // Fresh login needed
    freshLogin = true;
    const browser = await launchBrowser();
    const context = await browser.newContext();

    await loginToGmail(context);

    const state = await context.storageState();
    sessionState = state as unknown as Record<string, unknown>;

    console.log('[Test] Captured storageState:', {
      cookies: (state.cookies || []).length,
      origins: (state.origins || []).length,
    });

    expect(state.cookies.length).toBeGreaterThan(0);

    // Save immediately so session persists even if later steps fail
    await sessionManager.saveSession(TEST_USER_ID, GMAIL_URL, sessionState);
    console.log('[Test] Session saved to gh_browser_sessions');

    await browser.close();
  }, 60000); // 60s timeout for login

  test('Step 2: Verify session exists in DB', async () => {
    const { data, error } = await supabase
      .from('gh_browser_sessions')
      .select('id, domain, encryption_key_id, created_at, last_used_at')
      .eq('user_id', TEST_USER_ID)
      .eq('domain', 'mail.google.com')
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.domain).toBe('mail.google.com');
    console.log('[Test] DB row verified:', {
      domain: data!.domain,
      encryption_key_id: data!.encryption_key_id,
      last_used_at: data!.last_used_at,
    });
  }, 15000);

  test('Step 3: Load session from Supabase (decrypt round-trip)', async () => {
    const loaded = await sessionManager.loadSession(TEST_USER_ID, GMAIL_URL);

    expect(loaded).not.toBeNull();
    expect(loaded).toHaveProperty('cookies');
    expect(loaded).toHaveProperty('origins');

    const loadedCookies = (loaded as any).cookies || [];
    console.log('[Test] Session loaded and decrypted successfully:', {
      cookies: loadedCookies.length,
      origins: ((loaded as any).origins || []).length,
    });

    expect(loadedCookies.length).toBeGreaterThan(0);
  }, 15000);

  test('Step 4: Open NEW browser with loaded session — verify still logged in', async () => {
    const loaded = await sessionManager.loadSession(TEST_USER_ID, GMAIL_URL);
    expect(loaded).not.toBeNull();

    // Launch a BRAND NEW browser with the stored session
    const browser = await launchBrowser();
    const context = await browser.newContext({
      storageState: loaded as any,
    });

    const loggedIn = await isLoggedIntoGoogle(context);
    console.log('[Test] Session restored in new browser — logged in:', loggedIn);

    expect(loggedIn).toBe(true);

    // Refresh session after successful verification
    const freshState = await context.storageState();
    await sessionManager.saveSession(
      TEST_USER_ID,
      GMAIL_URL,
      freshState as unknown as Record<string, unknown>,
    );
    console.log('[Test] Session refreshed in DB after verification');

    await browser.close();
  }, 30000);
});
