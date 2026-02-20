/**
 * Unit Tests: BlockerDetector — observe()-based detection and detectWithAdapter()
 *
 * Tests the enhanced BlockerDetector that uses adapter observe() for richer detection.
 * Covers: classifyObservedElements, detectWithAdapter, source field, combined detection.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';
import {
  BlockerDetector,
  type BlockerResult,
  type BlockerType,
  type DetectionSource,
} from '../../../src/detection/BlockerDetector.js';
import type { BrowserAutomationAdapter, ObservedElement } from '../../../src/adapters/types.js';
import type { Page } from 'playwright';

// ── Mock adapter factory ──────────────────────────────────────────────────

function createMockAdapter(opts: {
  observeResult?: ObservedElement[];
  observeThrows?: boolean;
  selectorHits?: Record<string, { visible: boolean }>;
  bodyText?: string;
  hasObserve?: boolean;
}): BrowserAutomationAdapter {
  const selectorHits = opts.selectorHits ?? {};
  const bodyText = opts.bodyText ?? '';

  const evaluate = vi.fn().mockImplementation((_fn: Function, arg?: any) => {
    if (Array.isArray(arg)) {
      const found: { selector: string; type: string; confidence: number; visible: boolean }[] = [];
      for (const p of arg) {
        if (selectorHits[p.selector]) {
          found.push({
            selector: p.selector,
            type: p.type,
            confidence: p.confidence,
            visible: selectorHits[p.selector].visible,
          });
        }
      }
      return Promise.resolve(found);
    }
    return Promise.resolve(bodyText);
  });

  const page = { evaluate } as unknown as Page;

  const adapter: any = {
    type: 'mock',
    page,
    start: vi.fn(),
    stop: vi.fn(),
    isActive: vi.fn(() => true),
    isConnected: vi.fn(() => true),
    act: vi.fn(),
    extract: vi.fn(),
    navigate: vi.fn(),
    getCurrentUrl: vi.fn(async () => 'https://example.com'),
    screenshot: vi.fn(async () => Buffer.from('fake-png')),
    registerCredentials: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn(() => false),
  };

  if (opts.hasObserve !== false) {
    if (opts.observeThrows) {
      adapter.observe = vi.fn().mockRejectedValue(new Error('observe failed'));
    } else {
      adapter.observe = vi.fn().mockResolvedValue(opts.observeResult ?? []);
    }
  }

  return adapter as BrowserAutomationAdapter;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BlockerDetector — observe-based detection', () => {
  const detector = new BlockerDetector();

  // ── classifyObservedElements ───────────────────────────────────────

  describe('classifyObservedElements', () => {
    test('returns null when no elements match', () => {
      const elements: ObservedElement[] = [
        { selector: '#submit', description: 'Submit application button', method: 'click', arguments: [] },
        { selector: '#name', description: 'Name input field', method: 'fill', arguments: [] },
      ];
      expect(detector.classifyObservedElements(elements)).toBeNull();
    });

    test('detects CAPTCHA from observed element description', () => {
      const elements: ObservedElement[] = [
        { selector: '.recaptcha-checkbox', description: 'reCAPTCHA checkbox "I\'m not a robot"', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.source).toBe('observe');
      expect(result!.observedElements).toEqual(elements);
    });

    test('detects hCaptcha from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '.hcaptcha-frame', description: 'hCaptcha verification frame', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('detects Turnstile from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '.cf-turnstile', description: 'Cloudflare Turnstile challenge widget', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('detects login wall from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '#signin-button', description: 'Sign in to your account button', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
    });

    test('detects 2FA from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '#code-input', description: 'Enter your two-factor authentication code', method: 'fill', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });

    test('detects SMS code prompt', () => {
      const elements: ObservedElement[] = [
        { selector: '#sms-code', description: 'Enter the SMS code sent to your phone', method: 'fill', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });

    test('detects bot check from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '#verify', description: 'Please verify you are human before continuing', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
    });

    test('detects rate limiting from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '.error-message', description: 'Too many requests. Please wait and try again.', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('rate_limited');
    });

    test('detects visual verification (slider) from observed element', () => {
      const elements: ObservedElement[] = [
        { selector: '.slider-handle', description: 'Slide to verify your identity', method: 'click', arguments: [] },
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('verification');
    });

    test('returns highest confidence match from multiple elements', () => {
      const elements: ObservedElement[] = [
        { selector: '#login', description: 'Sign in button', method: 'click', arguments: [] }, // login 0.75
        { selector: '.captcha', description: 'reCAPTCHA widget', method: 'click', arguments: [] }, // captcha 0.9
      ];
      const result = detector.classifyObservedElements(elements);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });
  });

  // ── detectWithAdapter ──────────────────────────────────────────────

  describe('detectWithAdapter', () => {
    test('returns null when no blockers detected by either method', async () => {
      const adapter = createMockAdapter({
        observeResult: [],
        bodyText: 'Welcome to our careers page.',
      });

      const result = await detector.detectWithAdapter(adapter);
      expect(result).toBeNull();
    });

    test('returns DOM result immediately for high-confidence blocker (skips observe)', async () => {
      const adapter = createMockAdapter({
        selectorHits: { 'iframe[src*="recaptcha"]': { visible: true } },
        observeResult: [
          { selector: '.recaptcha', description: 'reCAPTCHA widget', method: 'click', arguments: [] },
        ],
      });

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
      expect(result!.source).toBe('dom');
      // observe should NOT have been called since DOM confidence >= 0.8
      expect((adapter as any).observe).not.toHaveBeenCalled();
    });

    test('falls through to observe when DOM has low confidence', async () => {
      const adapter = createMockAdapter({
        selectorHits: { 'input[type="password"]': { visible: true } }, // 0.6 < 0.8 threshold
        observeResult: [
          { selector: '#signin', description: 'Sign in to continue button', method: 'click', arguments: [] },
        ],
      });

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect((adapter as any).observe).toHaveBeenCalled();
    });

    test('uses observe result when DOM finds nothing', async () => {
      const adapter = createMockAdapter({
        observeResult: [
          { selector: '.captcha-frame', description: 'reCAPTCHA verification frame', method: 'click', arguments: [] },
        ],
      });

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.source).toBe('observe');
    });

    test('combines DOM and observe results of same type for higher confidence', async () => {
      const adapter = createMockAdapter({
        selectorHits: { '#captcha': { visible: true } }, // captcha 0.7
        observeResult: [
          { selector: '.recaptcha', description: 'reCAPTCHA widget visible', method: 'click', arguments: [] },
        ],
      });

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.source).toBe('combined');
      // Combined: 0.7 + 0.9 * 0.3 = 0.97
      expect(result!.confidence).toBeGreaterThan(0.7);
      expect(result!.confidence).toBeLessThanOrEqual(1.0);
    });

    test('returns higher confidence result when types differ', async () => {
      const adapter = createMockAdapter({
        selectorHits: { 'input[type="password"]': { visible: true } }, // login 0.6
        observeResult: [
          { selector: '.recaptcha', description: 'reCAPTCHA widget', method: 'click', arguments: [] }, // captcha 0.9
        ],
      });

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.source).toBe('observe');
    });

    test('handles observe() throwing gracefully', async () => {
      const adapter = createMockAdapter({
        observeThrows: true,
        selectorHits: { 'input[type="password"]': { visible: true } },
      });

      // Should not throw, should return the DOM result
      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
      expect(result!.source).toBe('dom');
    });

    test('handles adapter without observe() method', async () => {
      const adapter = createMockAdapter({
        hasObserve: false,
        selectorHits: { 'iframe[src*="recaptcha"]': { visible: true } },
      });

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.source).toBe('dom');
    });

    test('handles adapter without observe() and no DOM matches', async () => {
      const adapter = createMockAdapter({
        hasObserve: false,
        bodyText: 'Clean page content',
      });

      const result = await detector.detectWithAdapter(adapter);
      expect(result).toBeNull();
    });

    test('observe() returning undefined is treated as no results', async () => {
      const adapter = createMockAdapter({
        bodyText: 'Clean page content',
      });
      (adapter as any).observe = vi.fn().mockResolvedValue(undefined);

      const result = await detector.detectWithAdapter(adapter);
      expect(result).toBeNull();
    });
  });

  // ── New blocker types ─────────────────────────────────────────────

  describe('new blocker types via DOM text patterns', () => {
    test('detects rate limiting: "too many requests"', async () => {
      const page = createMockAdapter({ bodyText: 'Error: Too many requests. Please slow down.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('rate_limited');
    });

    test('detects rate limiting: "rate limited"', async () => {
      const page = createMockAdapter({ bodyText: 'You have been rate limited. Try again in 60 seconds.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('rate_limited');
    });

    test('detects visual verification: "select all images with"', async () => {
      const page = createMockAdapter({ bodyText: 'Select all images with traffic lights.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('verification');
    });

    test('detects visual verification: "slide to verify"', async () => {
      const page = createMockAdapter({ bodyText: 'Slide to verify that you are human.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('verification');
    });

    test('detects login text: "sign in to continue"', async () => {
      const page = createMockAdapter({ bodyText: 'Please sign in to continue to your account.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
    });

    test('detects login text: "session expired"', async () => {
      const page = createMockAdapter({ bodyText: 'Your session has expired. Please log in again.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
    });

    test('detects bot check: "are you a bot"', async () => {
      const page = createMockAdapter({ bodyText: 'Are you a bot? Complete this challenge.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
    });

    test('detects CAPTCHA text: "I\'m not a robot"', async () => {
      const page = createMockAdapter({ bodyText: "Check the box: I'm not a robot" }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('detects FunCaptcha selector', async () => {
      const adapter = createMockAdapter({
        selectorHits: { '#FunCaptcha': { visible: true } },
      });
      const result = await detector.detectBlocker(adapter.page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.85);
    });

    test('detects 2FA: "email verification"', async () => {
      const page = createMockAdapter({ bodyText: 'We sent an email verification code to your inbox.' }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });
  });

  // ── Source field on DOM detection ──────────────────────────────────

  describe('source field', () => {
    test('DOM-only detection sets source to "dom"', async () => {
      const page = createMockAdapter({
        selectorHits: { 'iframe[src*="recaptcha"]': { visible: true } },
      }).page;
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.source).toBe('dom');
    });
  });
});
