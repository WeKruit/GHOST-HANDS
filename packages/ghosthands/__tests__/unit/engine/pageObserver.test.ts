import { describe, expect, test, beforeEach, mock } from 'bun:test';
import {
  PageObserver,
  detectPlatform,
  generateUrlPattern,
  detectPageType,
} from '../../../src/engine/PageObserver';
import type { PageObservation, ObservedElement } from '../../../src/engine/types';
import type { StagehandObserver } from '../../../src/engine/StagehandObserver';
import type { Page } from 'playwright';

// --- Mock Page Factory ---

interface MockPageOptions {
  url?: string;
  bodyHtml?: string;
  forms?: Array<{
    selector: string;
    action?: string;
    method?: string;
    fields: Array<{
      selector: string;
      label?: string;
      type: string;
      name?: string;
      required?: boolean;
      placeholder?: string;
    }>;
  }>;
  buttons?: Array<{
    selector: string;
    text: string;
    type?: string;
    disabled?: boolean;
  }>;
  navigation?: Array<{
    selector: string;
    text: string;
    href?: string;
  }>;
  domMarkers?: Record<string, boolean>;
  /** Raw tag structure for fingerprinting */
  tagStructure?: string;
}

function createMockPage(opts: MockPageOptions = {}): Page {
  const url = opts.url ?? 'https://boards.greenhouse.io/company/jobs/12345/apply';
  const forms = opts.forms ?? [];
  const buttons = opts.buttons ?? [];
  const navigation = opts.navigation ?? [];
  const domMarkers = opts.domMarkers ?? {};
  const tagStructure = opts.tagStructure ?? 'html>head>body>main>form>input+input+button';

  const evaluateImpl = mock(async (fn: any, ...args: any[]) => {
    // The evaluate function receives serialized arguments
    const fnStr = fn.toString();

    // Form extraction
    if (fnStr.includes('querySelectorAll') && fnStr.includes('form')) {
      return forms;
    }
    // Button extraction
    if (fnStr.includes('button') && fnStr.includes('submit')) {
      return buttons;
    }
    // Navigation extraction
    if (fnStr.includes('nav') && fnStr.includes('href')) {
      return navigation;
    }
    // DOM markers
    if (fnStr.includes('marker')) {
      return domMarkers;
    }
    // Tag structure for fingerprinting
    if (fnStr.includes('tagName') || fnStr.includes('structure') || fnStr.includes('fingerprint')) {
      return tagStructure;
    }
    // Page type detection
    if (fnStr.includes('pageType') || fnStr.includes('confirmation') || fnStr.includes('step')) {
      return null;
    }

    return null;
  });

  return {
    url: mock(() => url),
    evaluate: evaluateImpl,
    $$eval: mock(async (selector: string, fn: any) => {
      if (selector === 'form') return forms;
      if (selector.includes('button')) return buttons;
      if (selector.includes('nav')) return navigation;
      return [];
    }),
  } as unknown as Page;
}

// --- Tests ---

describe('PageObserver', () => {
  describe('detectPlatform()', () => {
    test('detects workday from URL', () => {
      expect(detectPlatform('https://company.myworkdayjobs.com/en-US/careers/job/12345')).toBe('workday');
    });

    test('detects workday from wd1 URL', () => {
      expect(detectPlatform('https://company.wd1.myworkdaysite.com/en-US/External/job/12345')).toBe('workday');
    });

    test('detects greenhouse from URL', () => {
      expect(detectPlatform('https://boards.greenhouse.io/company/jobs/12345')).toBe('greenhouse');
    });

    test('detects greenhouse job-boards', () => {
      expect(detectPlatform('https://job-boards.greenhouse.io/company/jobs/12345')).toBe('greenhouse');
    });

    test('detects lever from URL', () => {
      expect(detectPlatform('https://jobs.lever.co/company/12345')).toBe('lever');
    });

    test('detects icims from URL', () => {
      expect(detectPlatform('https://company.icims.com/jobs/12345/apply')).toBe('icims');
    });

    test('detects taleo from URL', () => {
      expect(detectPlatform('https://company.taleo.net/careersection/apply')).toBe('taleo');
    });

    test('detects smartrecruiters from URL', () => {
      expect(detectPlatform('https://jobs.smartrecruiters.com/Company/12345')).toBe('smartrecruiters');
    });

    test('detects linkedin from URL', () => {
      expect(detectPlatform('https://www.linkedin.com/jobs/view/12345')).toBe('linkedin');
    });

    test('returns "other" for unknown platforms', () => {
      expect(detectPlatform('https://example.com/careers/apply')).toBe('other');
    });
  });

  describe('generateUrlPattern()', () => {
    test('replaces numeric IDs with wildcard', () => {
      expect(generateUrlPattern('https://boards.greenhouse.io/company/jobs/12345')).toBe(
        'boards.greenhouse.io/company/jobs/*',
      );
    });

    test('replaces UUIDs with wildcard', () => {
      expect(generateUrlPattern('https://example.com/jobs/a1b2c3d4-e5f6-7890-abcd-ef1234567890/apply')).toBe(
        'example.com/jobs/*/apply',
      );
    });

    test('handles Workday URLs', () => {
      const result = generateUrlPattern('https://company.myworkdayjobs.com/en-US/careers/job/New-York/Software-Engineer_12345');
      // Locale wildcarded, ID-suffixed segments wildcarded, city preserved
      expect(result).toBe('*.myworkdayjobs.com/*/careers/job/New-York/*');
    });

    test('handles query parameters by stripping them', () => {
      expect(generateUrlPattern('https://boards.greenhouse.io/company/jobs/12345?source=linkedin')).toBe(
        'boards.greenhouse.io/company/jobs/*',
      );
    });

    test('preserves path structure', () => {
      expect(generateUrlPattern('https://jobs.lever.co/company/some-uuid-here/apply')).toBe(
        'jobs.lever.co/company/some-uuid-here/apply',
      );
    });
  });

  describe('detectPageType()', () => {
    test('detects form page from form elements', async () => {
      // detectPageType uses page.evaluate with an inline function that runs in browser.
      // In tests, we mock evaluate to return the expected page type directly.
      const page = {
        url: mock(() => 'https://example.com/apply'),
        evaluate: mock(async () => 'form'),
      } as unknown as Page;

      const result = await detectPageType(page);
      expect(result).toBe('form');
    });

    test('returns "unknown" for empty page', async () => {
      const page = {
        url: mock(() => 'https://example.com'),
        evaluate: mock(async () => 'unknown'),
      } as unknown as Page;

      const result = await detectPageType(page);
      expect(result).toBe('unknown');
    });

    test('returns "unknown" when evaluate throws', async () => {
      const page = {
        url: mock(() => 'https://example.com'),
        evaluate: mock(async () => { throw new Error('page crashed'); }),
      } as unknown as Page;

      const result = await detectPageType(page);
      expect(result).toBe('unknown');
    });
  });

  describe('observe()', () => {
    test('returns PageObservation with platform, url, urlPattern', async () => {
      const page = createMockPage({
        url: 'https://boards.greenhouse.io/acme/jobs/12345/apply',
        forms: [{
          selector: 'form',
          fields: [
            { selector: 'input[name="first_name"]', type: 'text', name: 'first_name' },
          ],
        }],
        buttons: [
          { selector: 'button[type="submit"]', text: 'Submit Application' },
        ],
        navigation: [],
        tagStructure: 'html>head>body>main>form>input+button',
      });

      const observer = new PageObserver();
      const result = await observer.observe(page);

      expect(result.platform).toBe('greenhouse');
      expect(result.url).toBe('https://boards.greenhouse.io/acme/jobs/12345/apply');
      expect(result.urlPattern).toBe('boards.greenhouse.io/acme/jobs/*/apply');
    });

    test('includes forms, buttons, and navigation in output', async () => {
      const page = createMockPage({
        forms: [{
          selector: 'form#apply',
          action: '/submit',
          method: 'POST',
          fields: [
            { selector: 'input[name="email"]', type: 'email', name: 'email', required: true },
          ],
        }],
        buttons: [
          { selector: 'button.submit', text: 'Apply', type: 'submit' },
        ],
        navigation: [
          { selector: 'a.next', text: 'Next Step', href: '/step-2' },
        ],
      });

      const observer = new PageObserver();
      const result = await observer.observe(page);

      expect(result.forms).toHaveLength(1);
      expect(result.forms[0].fields).toHaveLength(1);
      expect(result.buttons).toHaveLength(1);
      expect(result.buttons[0].text).toBe('Apply');
      expect(result.navigation).toHaveLength(1);
    });

    test('generates fingerprint and structureHash', async () => {
      const page = createMockPage({
        tagStructure: 'html>head>body>main>form>input+input+button',
      });

      const observer = new PageObserver();
      const result = await observer.observe(page);

      expect(result.fingerprint).toBeTruthy();
      expect(typeof result.fingerprint).toBe('string');
      expect(result.structureHash).toBeTruthy();
      expect(typeof result.structureHash).toBe('string');
    });

    test('fingerprint is deterministic for same structure', async () => {
      const page1 = createMockPage({
        tagStructure: 'html>body>form>input+button',
      });
      const page2 = createMockPage({
        tagStructure: 'html>body>form>input+button',
      });

      const observer = new PageObserver();
      const r1 = await observer.observe(page1);
      const r2 = await observer.observe(page2);

      expect(r1.structureHash).toBe(r2.structureHash);
    });
  });

  // ── StagehandObserver integration ──────────────────────────────────

  describe('Stagehand enrichment', () => {
    function createMockStagehand(
      elements: ObservedElement[],
      initialized = true,
    ): StagehandObserver {
      return {
        isInitialized: mock(() => initialized),
        observe: mock(async (_instruction: string) => elements),
        init: mock(async () => {}),
        stop: mock(async () => {}),
      } as unknown as StagehandObserver;
    }

    test('enriches buttons with Stagehand observations', async () => {
      const page = createMockPage({
        buttons: [
          { selector: 'button#submit', text: 'Submit' },
        ],
      });
      const stagehand = createMockStagehand([
        { selector: 'button#submit', description: 'Submit', action: 'click' },
        { selector: '[data-testid="save-draft"]', description: 'Save Draft', action: 'click' },
      ]);

      const observer = new PageObserver();
      const result = await observer.observe(page, stagehand);

      // Should have the original button + the new one from Stagehand
      expect(result.buttons).toHaveLength(2);
      expect(result.buttons[1].selector).toBe('[data-testid="save-draft"]');
      expect(result.buttons[1].text).toBe('Save Draft');
    });

    test('does not duplicate buttons already found by DOM analysis', async () => {
      const page = createMockPage({
        buttons: [
          { selector: 'button#submit', text: 'Submit' },
        ],
      });
      const stagehand = createMockStagehand([
        { selector: 'button#submit', description: 'Submit button', action: 'click' },
      ]);

      const observer = new PageObserver();
      const result = await observer.observe(page, stagehand);

      expect(result.buttons).toHaveLength(1);
    });

    test('skips non-click Stagehand observations', async () => {
      const page = createMockPage({ buttons: [] });
      const stagehand = createMockStagehand([
        { selector: '#email', description: 'Email field', action: 'fill' },
        { selector: 'button#go', description: 'Go', action: 'click' },
      ]);

      const observer = new PageObserver();
      const result = await observer.observe(page, stagehand);

      // Only the click observation should be added as a button
      expect(result.buttons).toHaveLength(1);
      expect(result.buttons[0].text).toBe('Go');
    });

    test('works without StagehandObserver (undefined)', async () => {
      const page = createMockPage({
        buttons: [{ selector: 'button', text: 'Apply' }],
      });

      const observer = new PageObserver();
      const result = await observer.observe(page, undefined);

      expect(result.buttons).toHaveLength(1);
    });

    test('falls back gracefully when Stagehand is not initialized', async () => {
      const page = createMockPage({
        buttons: [{ selector: 'button', text: 'Apply' }],
      });
      const stagehand = createMockStagehand([], false);

      const observer = new PageObserver();
      const result = await observer.observe(page, stagehand);

      expect(result.buttons).toHaveLength(1);
      expect((stagehand.observe as any).mock.calls.length).toBe(0);
    });

    test('falls back gracefully when Stagehand throws', async () => {
      const page = createMockPage({
        buttons: [{ selector: 'button', text: 'Apply' }],
      });
      const stagehand = {
        isInitialized: mock(() => true),
        observe: mock(async () => { throw new Error('Stagehand CDP disconnected'); }),
      } as unknown as StagehandObserver;

      const observer = new PageObserver();
      const result = await observer.observe(page, stagehand);

      // Should still have DOM buttons even though Stagehand failed
      expect(result.buttons).toHaveLength(1);
      expect(result.buttons[0].text).toBe('Apply');
    });
  });

  // ── BlockerDetector integration ────────────────────────────────────

  describe('detectBlocker()', () => {
    test('delegates to BlockerDetector', async () => {
      // Create a page that triggers CAPTCHA detection
      const page = {
        url: mock(() => 'https://example.com'),
        evaluate: mock(async (fn: any, arg?: any) => {
          if (Array.isArray(arg)) {
            // Selector patterns — simulate reCAPTCHA iframe found
            return arg
              .filter((p: any) => p.selector === 'iframe[src*="recaptcha"]')
              .map((p: any) => ({ ...p, visible: true }));
          }
          // Body text call
          return '';
        }),
      } as unknown as Page;

      const observer = new PageObserver();
      const blocker = await observer.detectBlocker(page);

      expect(blocker).not.toBeNull();
      expect(blocker!.type).toBe('captcha');
      expect(blocker!.confidence).toBe(0.95);
    });

    test('returns null when no blocker detected', async () => {
      const page = {
        url: mock(() => 'https://example.com'),
        evaluate: mock(async (fn: any, arg?: any) => {
          if (Array.isArray(arg)) return [];
          return 'Welcome to our job board';
        }),
      } as unknown as Page;

      const observer = new PageObserver();
      const blocker = await observer.detectBlocker(page);

      expect(blocker).toBeNull();
    });
  });
});
