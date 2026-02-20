import { describe, expect, test, vi } from 'vitest';
import { BlockerDetector, type BlockerType } from '../../../src/detection/BlockerDetector.js';
import type { Page } from 'playwright';

// ── Mock page factory ─────────────────────────────────────────────────────

/**
 * Creates a mock Playwright Page that simulates DOM queries and body text.
 *
 * @param selectorHits - Map of CSS selectors to { visible } indicating which
 *   selectors exist in the DOM and whether they are visible.
 * @param bodyText - The text content of document.body.innerText.
 */
function createMockPage(
  selectorHits: Record<string, { visible: boolean }> = {},
  bodyText = '',
): Page {
  const evaluate = vi.fn().mockImplementation((fn: Function, arg?: any) => {
    // Detect which evaluate call this is based on the argument
    if (Array.isArray(arg)) {
      // Selector-based patterns call: arg is the patterns array
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
    // Body text call: no arg, returns body innerText
    return Promise.resolve(bodyText);
  });

  return { evaluate } as unknown as Page;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('BlockerDetector', () => {
  const detector = new BlockerDetector();

  // ── No blockers ─────────────────────────────────────────────────────

  describe('when page has no blockers', () => {
    test('returns null for a clean page', async () => {
      const page = createMockPage({}, 'Welcome to our job board. Apply now!');
      const result = await detector.detectBlocker(page);
      expect(result).toBeNull();
    });

    test('returns null for empty page', async () => {
      const page = createMockPage({}, '');
      const result = await detector.detectBlocker(page);
      expect(result).toBeNull();
    });
  });

  // ── CAPTCHA detection ───────────────────────────────────────────────

  describe('CAPTCHA detection', () => {
    test('detects reCAPTCHA iframe', async () => {
      const page = createMockPage(
        { 'iframe[src*="recaptcha"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
      expect(result!.selector).toBe('iframe[src*="recaptcha"]');
    });

    test('detects hCaptcha iframe', async () => {
      const page = createMockPage(
        { 'iframe[src*="hcaptcha"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
    });

    test('detects .g-recaptcha class', async () => {
      const page = createMockPage(
        { '.g-recaptcha': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects .h-captcha class', async () => {
      const page = createMockPage(
        { '.h-captcha': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects #captcha element', async () => {
      const page = createMockPage(
        { '#captcha': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.7);
    });

    test('detects Cloudflare challenge iframe', async () => {
      const page = createMockPage(
        { 'iframe[src*="challenges.cloudflare.com"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
    });

    test('detects CAPTCHA from text: "verify you are human"', async () => {
      const page = createMockPage({}, 'Please verify you are a human to continue.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('detects CAPTCHA from text: "prove you\'re not a robot"', async () => {
      const page = createMockPage({}, "Please prove you're not a robot");
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('detects CAPTCHA from text: "please complete the security check"', async () => {
      const page = createMockPage({}, 'Please complete the security check to proceed.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('reduces confidence for hidden CAPTCHA elements', async () => {
      const page = createMockPage(
        { 'iframe[src*="recaptcha"]': { visible: false } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      // Hidden: 0.95 * 0.5 = 0.475
      expect(result!.confidence).toBe(0.475);
    });
  });

  // ── Audio CAPTCHA detection ───────────────────────────────────────

  describe('audio CAPTCHA detection', () => {
    test('detects .rc-audiochallenge selector', async () => {
      const page = createMockPage(
        { '.rc-audiochallenge': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
      expect(result!.selector).toBe('.rc-audiochallenge');
    });

    test('detects #audio-source selector', async () => {
      const page = createMockPage(
        { '#audio-source': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects audio[src*="captcha"] selector', async () => {
      const page = createMockPage(
        { 'audio[src*="captcha"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.85);
    });

    test('detects button[aria-label*="audio"] selector (lower confidence)', async () => {
      const page = createMockPage(
        { 'button[aria-label*="audio"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.7);
    });

    test('detects "press play and type what you hear" text', async () => {
      const page = createMockPage({}, 'Press play and type what you hear.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects "listen and type the numbers" text', async () => {
      const page = createMockPage({}, 'Listen and type the numbers you hear.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects "audio challenge" text as captcha', async () => {
      const page = createMockPage({}, 'Complete the audio challenge to continue.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.85);
    });

    test('detects "switch to audio" text (lower confidence)', async () => {
      const page = createMockPage({}, 'Switch to audio if you cannot solve the visual challenge.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.7);
    });

    test('does NOT false-positive on regular audio elements', async () => {
      const page = createMockPage({}, 'Listen to our company podcast. Play audio interview with CEO.');
      const result = await detector.detectBlocker(page);

      expect(result).toBeNull();
    });
  });

  // ── Login detection ─────────────────────────────────────────────────

  describe('login detection', () => {
    test('detects form[action*="login"]', async () => {
      const page = createMockPage(
        { 'form[action*="login"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
      expect(result!.confidence).toBe(0.8);
    });

    test('detects form[action*="signin"]', async () => {
      const page = createMockPage(
        { 'form[action*="signin"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
    });

    test('detects password input field', async () => {
      const page = createMockPage(
        { 'input[type="password"]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
      expect(result!.confidence).toBe(0.6);
    });

    test('detects #login-form', async () => {
      const page = createMockPage(
        { '#login-form': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('login');
      expect(result!.confidence).toBe(0.85);
    });
  });

  // ── 2FA detection ───────────────────────────────────────────────────

  describe('2FA detection', () => {
    test('detects "two-factor auth" text', async () => {
      const page = createMockPage({}, 'Two-factor authentication is required for your account.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });

    test('detects "verification code" text', async () => {
      const page = createMockPage({}, 'Please enter the verification code sent to your email.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
    });

    test('detects "authenticator app" text', async () => {
      const page = createMockPage({}, 'Open your authenticator app and enter the code.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
      expect(result!.confidence).toBe(0.85);
    });

    test('detects "enter the code sent to" text', async () => {
      const page = createMockPage({}, 'Enter the code sent to your phone number ending in 1234.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('2fa');
      expect(result!.confidence).toBe(0.8);
    });
  });

  // ── Bot check detection ─────────────────────────────────────────────

  describe('bot check detection', () => {
    test('detects #challenge-running', async () => {
      const page = createMockPage(
        { '#challenge-running': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.95);
    });

    test('detects Cloudflare browser verification', async () => {
      const page = createMockPage(
        { '.cf-browser-verification': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects PerimeterX captcha', async () => {
      const page = createMockPage(
        { '#px-captcha': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.9);
    });

    test('detects DataDome element', async () => {
      const page = createMockPage(
        { '[data-datadome]': { visible: true } },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.85);
    });

    test('detects "checking your browser" text', async () => {
      const page = createMockPage({}, 'Checking your browser before accessing the site...');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.85);
    });

    test('detects "access denied" text (lower confidence)', async () => {
      const page = createMockPage({}, 'Access denied. You do not have permission.');
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('bot_check');
      expect(result!.confidence).toBe(0.5);
    });
  });

  // ── Confidence ordering ─────────────────────────────────────────────

  describe('confidence ordering', () => {
    test('returns highest confidence match when multiple patterns hit', async () => {
      const page = createMockPage(
        {
          'input[type="password"]': { visible: true },      // login 0.6
          'iframe[src*="recaptcha"]': { visible: true },     // captcha 0.95
        },
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
    });

    test('prefers visible selector over text match', async () => {
      const page = createMockPage(
        { 'iframe[src*="recaptcha"]': { visible: true } },
        'Please complete the security check',
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      // Selector confidence 0.95 > text confidence 0.75
      expect(result!.confidence).toBe(0.95);
      expect(result!.selector).toBe('iframe[src*="recaptcha"]');
    });

    test('prefers text match over hidden selector when text is higher confidence', async () => {
      const page = createMockPage(
        { '#captcha': { visible: false } }, // 0.7 * 0.5 = 0.35
        "Verify you're a human", // 0.8
      );
      const result = await detector.detectBlocker(page);

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.8);
    });
  });

  // ── Observe classification: audio CAPTCHA ─────────────────────────

  describe('classifyObservedElements — audio CAPTCHA', () => {
    test('classifies "audio challenge" observed element as captcha', () => {
      const result = detector.classifyObservedElements([
        { description: 'Audio challenge play button', selector: '#recaptcha-audio-button', method: 'click', arguments: [] },
      ]);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('classifies "press play type" observed element as captcha', () => {
      const result = detector.classifyObservedElements([
        { description: 'Press play and type what you hear', selector: '.rc-audiochallenge-instructions', method: 'click', arguments: [] },
      ]);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });

    test('classifies "listen type numbers" observed element as captcha', () => {
      const result = detector.classifyObservedElements([
        { description: 'Listen and type the numbers', selector: '.audio-captcha-prompt', method: 'click', arguments: [] },
      ]);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
    });
  });
});
