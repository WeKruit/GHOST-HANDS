import { describe, expect, test, beforeEach } from 'bun:test';
import { BlockerDetector, type BlockerResult } from '../../detection/BlockerDetector.js';
import type { Page } from 'playwright';

/**
 * Creates a mock Playwright Page that returns controlled DOM query results.
 */
function createMockPage(opts: {
  selectorMatches?: { selector: string; visible: boolean }[];
  bodyText?: string;
}): Page {
  const { selectorMatches = [], bodyText = '' } = opts;

  return {
    evaluate: async (fn: Function, arg?: any) => {
      // Distinguish between the selector-based call and the text-based call
      // by checking whether an argument is passed
      if (arg !== undefined) {
        // Selector evaluation: arg is the patterns array
        const patterns = arg as { selector: string; type: string; confidence: number }[];
        const found: { selector: string; type: string; confidence: number; visible: boolean }[] = [];
        for (const p of patterns) {
          const match = selectorMatches.find((m) => m.selector === p.selector);
          if (match) {
            found.push({ ...p, visible: match.visible });
          }
        }
        return found;
      }
      // Text evaluation: return bodyText
      return bodyText;
    },
  } as unknown as Page;
}

describe('BlockerDetector', () => {
  let detector: BlockerDetector;

  beforeEach(() => {
    detector = new BlockerDetector();
  });

  describe('returns null when no blocker is present', () => {
    test('empty page', async () => {
      const page = createMockPage({});
      const result = await detector.detectBlocker(page);
      expect(result).toBeNull();
    });

    test('page with normal content', async () => {
      const page = createMockPage({ bodyText: 'Welcome to our careers page' });
      const result = await detector.detectBlocker(page);
      expect(result).toBeNull();
    });
  });

  describe('CAPTCHA detection', () => {
    test('detects reCAPTCHA iframe', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: 'iframe[src*="recaptcha"]', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
    });

    test('detects hCaptcha iframe', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: 'iframe[src*="hcaptcha"]', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('detects Cloudflare challenge iframe', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: 'iframe[src*="challenges.cloudflare.com"]', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
    });

    test('detects captcha from text pattern', async () => {
      const page = createMockPage({
        bodyText: 'Please verify you are a human before continuing.',
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('hidden captcha has reduced confidence', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: 'iframe[src*="recaptcha"]', visible: false }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeLessThan(0.9);
    });
  });

  describe('login detection', () => {
    test('detects login form by action', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: 'form[action*="login"]', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
    });

    test('detects password input', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: 'input[type="password"]', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
    });
  });

  describe('2FA detection', () => {
    test('detects two-factor auth text', async () => {
      const page = createMockPage({
        bodyText: 'Please enter your two-factor authentication code.',
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });

    test('detects verification code text', async () => {
      const page = createMockPage({
        bodyText: 'Enter the verification code sent to your phone.',
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });

    test('detects authenticator app text', async () => {
      const page = createMockPage({
        bodyText: 'Open your authenticator app and enter the code.',
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });
  });

  describe('bot check detection', () => {
    test('detects Cloudflare browser check by selector', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: '#challenge-running', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.95);
    });

    test('detects "checking your browser" text', async () => {
      const page = createMockPage({
        bodyText: 'Checking your browser before accessing the site.',
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
    });

    test('detects PerimeterX by selector', async () => {
      const page = createMockPage({
        selectorMatches: [{ selector: '#px-captcha', visible: true }],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
    });
  });

  describe('priority and confidence', () => {
    test('returns highest confidence match when multiple blockers found', async () => {
      const page = createMockPage({
        selectorMatches: [
          { selector: 'input[type="password"]', visible: true }, // login, 0.6
          { selector: 'iframe[src*="recaptcha"]', visible: true }, // captcha, 0.95
        ],
      });
      const result = await detector.detectBlocker(page);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
    });
  });
});
