/**
 * HTML Fixture-based Integration Tests for BlockerDetector
 *
 * Loads real HTML files in a Playwright browser and runs detectBlocker()
 * against the live DOM. This catches issues that mock-based unit tests miss:
 * - Selectors that don't actually match real HTML structures
 * - Text patterns that false-positive on realistic page content
 * - Visibility detection on real rendered elements
 *
 * NOTE: Fixture filenames avoid "captcha" to prevent the URL-pattern detector
 * from matching file:// paths (which wouldn't happen in production).
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import * as path from 'path';
import { BlockerDetector } from '../../../src/detection/BlockerDetector.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/html');

let browser: Browser;
let detector: BlockerDetector;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  detector = new BlockerDetector();
});

afterAll(async () => {
  await browser?.close();
});

/** Load an HTML fixture file into a fresh page */
async function loadFixture(filename: string): Promise<Page> {
  const page = await browser.newPage();
  const filePath = path.join(FIXTURES_DIR, filename);
  await page.goto(`file://${filePath}`, { waitUntil: 'domcontentloaded' });
  return page;
}

// ── reCAPTCHA checkbox page ──────────────────────────────────────────────

describe('fixture: reCAPTCHA checkbox', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('recap-cb.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('detects reCAPTCHA as captcha blocker', async () => {
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('source is DOM-based', async () => {
    const result = await detector.detectBlocker(page);
    expect(result!.source).toBe('dom');
  });
});

// ── reCAPTCHA audio challenge page ───────────────────────────────────────

describe('fixture: reCAPTCHA audio challenge', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('recap-aud.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('detects audio CAPTCHA as captcha blocker', async () => {
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
  });

  test('confidence is high (multiple signals)', async () => {
    const result = await detector.detectBlocker(page);
    // .rc-audiochallenge (0.95), #audio-source (0.9), text patterns — should pick highest
    expect(result!.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

// ── hCaptcha with audio ─────────────────────────────────────────────────

describe('fixture: hCaptcha audio', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('hcap-audio.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('detects hCaptcha audio as captcha blocker', async () => {
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
  });

  test('high confidence from .h-captcha selector', async () => {
    const result = await detector.detectBlocker(page);
    expect(result!.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

// ── Clean job posting (NO blocker) ──────────────────────────────────────

describe('fixture: clean job posting (no blocker)', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('clean-job-posting.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('does NOT detect a blocker on a clean job page with audio/video', async () => {
    const result = await detector.detectBlocker(page);
    expect(result).toBeNull();
  });
});

// ── Cloudflare challenge ────────────────────────────────────────────────

describe('fixture: Cloudflare challenge', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('cf-challenge.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('detects Cloudflare challenge page', async () => {
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    // Turnstile iframe (captcha 0.95) and #challenge-running (bot_check 0.95) both match;
    // captcha wins by array position. Both are valid classifications for Cloudflare.
    expect(['captcha', 'bot_check']).toContain(result!.type);
    expect(result!.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

// ── Login wall ──────────────────────────────────────────────────────────

describe('fixture: login wall', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('login-wall.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('detects login wall', async () => {
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('login');
  });

  test('high confidence from multiple signals', async () => {
    const result = await detector.detectBlocker(page);
    // form[action*="signin"], input[type="password"], #login-form, text patterns
    expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

// ── 2FA prompt ──────────────────────────────────────────────────────────

describe('fixture: 2FA prompt', () => {
  let page: Page;

  beforeAll(async () => {
    page = await loadFixture('2fa-prompt.html');
  });

  afterAll(async () => {
    await page?.close();
  });

  test('detects 2FA prompt', async () => {
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('2fa');
  });

  test('confidence is meaningful', async () => {
    const result = await detector.detectBlocker(page);
    expect(result!.confidence).toBeGreaterThanOrEqual(0.7);
  });
});
