/**
 * PageObserver — Discovers page structure without LLM calls.
 *
 * Detects platform (workday, greenhouse, lever, etc.), page type (form, login, etc.),
 * enumerates forms/buttons/navigation, and produces a deterministic structure fingerprint
 * for cookbook matching.
 *
 * Zero LLM calls: all detection is URL-pattern and DOM-based.
 */

import type { Page } from 'playwright';
import type {
  PageObservation,
  FormObservation,
  ButtonObservation,
  NavObservation,
} from './types';
import type { StagehandObserver } from './StagehandObserver';
import { BlockerDetector, type BlockerResult } from '../detection/BlockerDetector';

// ── Platform Detection ─────────────────────────────────────────────────

const PLATFORM_PATTERNS: Array<{ platform: string; patterns: RegExp[] }> = [
  { platform: 'workday', patterns: [/\.myworkdayjobs\.com/, /\.wd\d\.myworkdaysite\.com/] },
  { platform: 'greenhouse', patterns: [/boards\.greenhouse\.io/, /job-boards\.greenhouse\.io/] },
  { platform: 'lever', patterns: [/jobs\.lever\.co/] },
  { platform: 'icims', patterns: [/\.icims\.com/] },
  { platform: 'taleo', patterns: [/\.taleo\.net/] },
  { platform: 'smartrecruiters', patterns: [/jobs\.smartrecruiters\.com/] },
  { platform: 'linkedin', patterns: [/linkedin\.com\/jobs/] },
];

export function detectPlatform(url: string): string {
  for (const { platform, patterns } of PLATFORM_PATTERNS) {
    if (patterns.some((p) => p.test(url))) return platform;
  }
  return 'other';
}

// ── URL Pattern Generation ─────────────────────────────────────────────

export function generateUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname;

    // Replace subdomains with wildcard for workday
    if (/\.myworkdayjobs\.com$/.test(host)) {
      host = '*.myworkdayjobs.com';
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const wildcarded = segments.map((seg) => {
      // Replace numeric IDs
      if (/^\d+$/.test(seg)) return '*';
      // Replace UUIDs
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '*';
      // Replace locale codes like en-US
      if (/^[a-z]{2}-[A-Z]{2}$/.test(seg) && host.includes('myworkday')) return '*';
      // Replace Workday-style suffixed IDs like Software-Engineer_12345
      if (/_\d+$/.test(seg)) return '*';
      return seg;
    });

    return `${host}/${wildcarded.join('/')}`;
  } catch {
    return url;
  }
}

// ── Page Type Detection ────────────────────────────────────────────────

export async function detectPageType(page: Page): Promise<string> {
  try {
    const result = await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      const hasForm = forms.length > 0;
      const hasFileInput = !!document.querySelector('input[type="file"]');
      const hasPasswordInput = !!document.querySelector('input[type="password"]');
      const bodyText = document.body?.innerText?.toLowerCase() ?? '';

      // Login page
      if (hasPasswordInput && (bodyText.includes('sign in') || bodyText.includes('log in'))) {
        return 'login';
      }

      // Confirmation page
      if (
        bodyText.includes('application submitted') ||
        bodyText.includes('thank you for applying') ||
        bodyText.includes('successfully submitted')
      ) {
        return 'confirmation';
      }

      // Error page
      if (
        bodyText.includes('page not found') ||
        bodyText.includes('404') ||
        bodyText.includes('error occurred')
      ) {
        return 'error';
      }

      // Multi-step form
      const stepIndicators = document.querySelectorAll(
        '[class*="step"], [class*="progress"], [data-step], [aria-current="step"]',
      );
      if (hasForm && stepIndicators.length > 0) {
        return 'multi-step';
      }

      // Regular form
      if (hasForm) return 'form';

      return 'unknown';
    });
    return result ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Structure Fingerprinting ───────────────────────────────────────────

async function extractStructure(page: Page): Promise<string> {
  try {
    const structure = await page.evaluate(() => {
      function walk(el: Element, depth: number): string {
        if (depth > 5) return '';
        const tag = el.tagName.toLowerCase();
        const children = Array.from(el.children);
        if (children.length === 0) return tag;
        const childStrs = children.map((c) => walk(c, depth + 1)).filter(Boolean);
        return `${tag}>${childStrs.join('+')}`;
      }
      const body = document.body;
      if (!body) return '';
      return walk(body, 0);
    });
    return structure ?? '';
  } catch {
    return '';
  }
}

function hashString(str: string): string {
  // Simple deterministic hash (djb2)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── DOM Extraction ─────────────────────────────────────────────────────

async function extractForms(page: Page): Promise<FormObservation[]> {
  try {
    return await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      return Array.from(forms).map((form) => {
        const fields = Array.from(
          form.querySelectorAll('input, select, textarea'),
        ).map((el) => {
          const input = el as HTMLInputElement;
          const label = form.querySelector(`label[for="${input.id}"]`);
          return {
            selector: input.name
              ? `${input.tagName.toLowerCase()}[name="${input.name}"]`
              : input.tagName.toLowerCase(),
            label: label?.textContent?.trim(),
            type: input.type || input.tagName.toLowerCase(),
            name: input.name || undefined,
            required: input.required || undefined,
            placeholder: input.placeholder || undefined,
          };
        });

        return {
          selector: form.id ? `form#${form.id}` : 'form',
          action: form.action || undefined,
          method: form.method?.toUpperCase() || undefined,
          fields,
        };
      });
    });
  } catch {
    return [];
  }
}

async function extractButtons(page: Page): Promise<ButtonObservation[]> {
  try {
    return await page.evaluate(() => {
      const btns = document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]',
      );
      return Array.from(btns).map((el) => {
        const btn = el as HTMLButtonElement;
        return {
          selector: btn.id
            ? `button#${btn.id}`
            : btn.className
              ? `button.${btn.className.split(' ')[0]}`
              : 'button',
          text: btn.textContent?.trim() || btn.getAttribute('value') || '',
          type: btn.type || undefined,
          disabled: btn.disabled || undefined,
        };
      });
    });
  } catch {
    return [];
  }
}

async function extractNavigation(page: Page): Promise<NavObservation[]> {
  try {
    return await page.evaluate(() => {
      const links = document.querySelectorAll('nav a, [role="navigation"] a');
      return Array.from(links).slice(0, 20).map((el) => {
        const link = el as HTMLAnchorElement;
        return {
          selector: link.id ? `a#${link.id}` : `a[href="${link.getAttribute('href')}"]`,
          text: link.textContent?.trim() || '',
          href: link.href || undefined,
        };
      });
    });
  } catch {
    return [];
  }
}

// ── PageObserver ───────────────────────────────────────────────────────

export class PageObserver {
  private blockerDetector: BlockerDetector;

  constructor() {
    this.blockerDetector = new BlockerDetector();
  }

  /**
   * Observe the current page and return a structured PageObservation.
   * No LLM calls from PageObserver itself — Stagehand may make its own.
   *
   * @param page - Playwright Page instance
   * @param stagehandObserver - Optional StagehandObserver for enriched element discovery
   */
  async observe(page: Page, stagehandObserver?: StagehandObserver): Promise<PageObservation> {
    const url = page.url();
    const platform = detectPlatform(url);
    const urlPattern = generateUrlPattern(url);
    const pageType = await detectPageType(page);

    const [forms, domButtons, navigation, structure] = await Promise.all([
      extractForms(page),
      extractButtons(page),
      extractNavigation(page),
      extractStructure(page),
    ]);

    // Enrich buttons with Stagehand observations when available
    const buttons = await enrichButtonsWithStagehand(domButtons, stagehandObserver);

    const structureHash = hashString(structure);
    const fingerprint = `${platform}:${pageType}:${structureHash}`;

    return {
      url,
      platform,
      pageType,
      fingerprint,
      forms,
      buttons,
      navigation,
      urlPattern,
      structureHash,
    };
  }

  /**
   * Detect blockers (CAPTCHA, login walls, 2FA, bot checks) on the page.
   * Delegates to BlockerDetector from Sprint 1.
   */
  async detectBlocker(page: Page): Promise<BlockerResult | null> {
    return this.blockerDetector.detectBlocker(page);
  }
}

// ── Stagehand enrichment ──────────────────────────────────────────────

async function enrichButtonsWithStagehand(
  domButtons: ButtonObservation[],
  stagehandObserver?: StagehandObserver,
): Promise<ButtonObservation[]> {
  if (!stagehandObserver?.isInitialized()) return domButtons;

  try {
    const observed = await stagehandObserver.observe('find all clickable buttons and submit elements');
    const enriched = [...domButtons];

    for (const obs of observed) {
      if (obs.action === 'click' && !enriched.some((b) => b.selector === obs.selector)) {
        enriched.push({
          selector: obs.selector,
          text: obs.description,
        });
      }
    }

    return enriched;
  } catch {
    // Stagehand failure is non-fatal — DOM results are sufficient
    return domButtons;
  }
}
