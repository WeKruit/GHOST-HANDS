/**
 * Security Regression Tests: Blocker Detection (SEC-014 to SEC-023)
 *
 * Tests the BlockerDetector DOM-based detection of CAPTCHAs, login walls,
 * 2FA prompts, and bot checks using mocked Playwright pages.
 */

import { describe, test, expect, vi } from 'vitest';
import { BlockerDetector, type BlockerResult } from '../../../src/detection/BlockerDetector.js';
import type { Page } from 'playwright';

// ── Mock page factory ─────────────────────────────────────────────────────

/**
 * Creates a mock Playwright Page.
 *
 * Uses the same approach as the existing unit test: the evaluate function
 * detects selector-based calls (arg is an array) vs body-text calls (no arg).
 */
function createMockPage(
  selectorResults: Record<string, { visible: boolean }> = {},
  bodyText: string = '',
): Page {
  const evaluate = vi.fn().mockImplementation((fn: Function, arg?: any) => {
    if (Array.isArray(arg)) {
      // Selector-based patterns call
      const found: { selector: string; type: string; confidence: number; visible: boolean }[] = [];
      for (const p of arg) {
        if (selectorResults[p.selector]) {
          found.push({
            selector: p.selector,
            type: p.type,
            confidence: p.confidence,
            visible: selectorResults[p.selector].visible,
          });
        }
      }
      return Promise.resolve(found);
    }
    // Body text call
    return Promise.resolve(bodyText);
  });

  return { evaluate } as unknown as Page;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Security: Blocker Detection', () => {
  const detector = new BlockerDetector();

  // SEC-014: Clean page (no matches) returns null
  test('SEC-014: clean page returns null', async () => {
    const page = createMockPage({}, 'Welcome to our careers page. Browse open positions.');
    const result = await detector.detectBlocker(page);
    expect(result).toBeNull();
  });

  // SEC-015: reCAPTCHA iframe detected
  test('SEC-015: reCAPTCHA iframe detected', async () => {
    const page = createMockPage(
      { 'iframe[src*="recaptcha"]': { visible: true } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.confidence).toBe(0.95);
    expect(result!.selector).toBe('iframe[src*="recaptcha"]');
  });

  // SEC-016: hCaptcha iframe detected
  test('SEC-016: hCaptcha iframe detected', async () => {
    const page = createMockPage(
      { 'iframe[src*="hcaptcha"]': { visible: true } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.confidence).toBe(0.95);
  });

  // SEC-017: Cloudflare challenge detected via selector
  test('SEC-017: Cloudflare challenge detected', async () => {
    const page = createMockPage(
      { 'iframe[src*="challenges.cloudflare.com"]': { visible: true } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.confidence).toBe(0.95);
  });

  // SEC-018: Login form detected
  test('SEC-018: login form detected', async () => {
    const page = createMockPage(
      { 'form[action*="login"]': { visible: true } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('login');
    expect(result!.confidence).toBe(0.8);
  });

  // SEC-019: Password input detected
  test('SEC-019: password input detected', async () => {
    const page = createMockPage(
      { 'input[type="password"]': { visible: true } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('login');
    expect(result!.confidence).toBe(0.6);
  });

  // SEC-020: 2FA text detected via "two-factor auth" pattern
  test('SEC-020: 2FA text detected via body text', async () => {
    const page = createMockPage({}, 'Please enter your two-factor auth code');
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('2fa');
  });

  // SEC-021: Bot check detected via selector
  test('SEC-021: bot check detected via selector', async () => {
    const page = createMockPage(
      { '#challenge-running': { visible: true } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('bot_check');
    expect(result!.confidence).toBe(0.95);
  });

  // SEC-022: Hidden CAPTCHA — confidence reduced 50%
  test('SEC-022: hidden CAPTCHA confidence reduced 50%', async () => {
    const page = createMockPage(
      { 'iframe[src*="recaptcha"]': { visible: false } },
    );
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.confidence).toBe(0.95 * 0.5); // 0.475
  });

  // SEC-023: Multiple matches — highest confidence wins
  test('SEC-023: multiple matches — highest confidence wins', async () => {
    const page = createMockPage({
      'input[type="password"]': { visible: true },      // login 0.6
      'iframe[src*="recaptcha"]': { visible: true },     // captcha 0.95
    });
    const result = await detector.detectBlocker(page);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.confidence).toBe(0.95);
  });
});
