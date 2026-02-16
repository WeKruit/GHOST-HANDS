/**
 * BlockerDetector — DOM-based detection of CAPTCHAs, login walls, 2FA prompts, and bot checks.
 *
 * Uses page.evaluate() for DOM queries (no screenshots).
 * Returns null when no blocker is detected, or a BlockerResult with type and confidence.
 */

import type { Page } from 'playwright';

export type BlockerType = 'captcha' | 'login' | '2fa' | 'bot_check';

export interface BlockerResult {
  type: BlockerType;
  /** 0-1 confidence score */
  confidence: number;
  /** CSS selector that matched, if applicable */
  selector?: string;
  /** Human-readable description of what was detected */
  details: string;
}

interface DOMMatch {
  type: BlockerType;
  selector: string;
  details: string;
  /** Base confidence when the selector matches */
  confidence: number;
}

// Selector-based patterns evaluated inside page.evaluate()
const SELECTOR_PATTERNS: Omit<DOMMatch, 'details'>[] = [
  // -- CAPTCHA --
  { type: 'captcha', selector: 'iframe[src*="recaptcha"]', confidence: 0.95 },
  { type: 'captcha', selector: 'iframe[src*="hcaptcha"]', confidence: 0.95 },
  { type: 'captcha', selector: '.g-recaptcha', confidence: 0.9 },
  { type: 'captcha', selector: '.h-captcha', confidence: 0.9 },
  { type: 'captcha', selector: '#captcha', confidence: 0.7 },
  { type: 'captcha', selector: '[data-captcha]', confidence: 0.7 },
  { type: 'captcha', selector: 'iframe[src*="challenges.cloudflare.com"]', confidence: 0.95 },

  // -- Login --
  { type: 'login', selector: 'form[action*="login"]', confidence: 0.8 },
  { type: 'login', selector: 'form[action*="signin"]', confidence: 0.8 },
  { type: 'login', selector: 'form[action*="sign-in"]', confidence: 0.8 },
  { type: 'login', selector: 'input[type="password"]', confidence: 0.6 },
  { type: 'login', selector: '#login-form', confidence: 0.85 },
  { type: 'login', selector: '[data-testid="login-form"]', confidence: 0.85 },

  // -- Bot check --
  { type: 'bot_check', selector: '#challenge-running', confidence: 0.95 },
  { type: 'bot_check', selector: '#cf-challenge-running', confidence: 0.95 },
  { type: 'bot_check', selector: '.cf-browser-verification', confidence: 0.9 },
  { type: 'bot_check', selector: '#px-captcha', confidence: 0.9 },
  { type: 'bot_check', selector: '[data-datadome]', confidence: 0.85 },
];

// Text patterns checked against document.body.innerText
const TEXT_PATTERNS: { type: BlockerType; pattern: RegExp; confidence: number }[] = [
  // -- CAPTCHA text --
  { type: 'captcha', pattern: /please complete the (security |captcha )?check/i, confidence: 0.75 },
  { type: 'captcha', pattern: /verify you('re| are) (a )?human/i, confidence: 0.8 },
  { type: 'captcha', pattern: /prove you('re| are) not a robot/i, confidence: 0.8 },

  // -- 2FA --
  { type: '2fa', pattern: /two[- ]?factor auth/i, confidence: 0.85 },
  { type: '2fa', pattern: /verification code/i, confidence: 0.7 },
  { type: '2fa', pattern: /authenticator app/i, confidence: 0.85 },
  { type: '2fa', pattern: /enter the code sent to/i, confidence: 0.8 },
  { type: '2fa', pattern: /security code/i, confidence: 0.6 },

  // -- Bot check text --
  { type: 'bot_check', pattern: /checking your browser/i, confidence: 0.85 },
  { type: 'bot_check', pattern: /just a moment/i, confidence: 0.5 },
  { type: 'bot_check', pattern: /please wait while we verify/i, confidence: 0.8 },
  { type: 'bot_check', pattern: /access denied/i, confidence: 0.5 },
  { type: 'bot_check', pattern: /blocked by.*security/i, confidence: 0.7 },
];

export class BlockerDetector {
  /**
   * Detect if the current page shows a blocker.
   * Returns the highest-confidence match, or null if none found.
   */
  async detectBlocker(page: Page): Promise<BlockerResult | null> {
    const matches: BlockerResult[] = [];

    // 1. Check selector-based patterns via page.evaluate
    const selectorResults = await page.evaluate((patterns: { selector: string; type: string; confidence: number }[]) => {
      const found: { selector: string; type: string; confidence: number; visible: boolean }[] = [];
      for (const p of patterns) {
        const el = document.querySelector(p.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          found.push({ ...p, visible });
        }
      }
      return found;
    }, SELECTOR_PATTERNS.map(p => ({ selector: p.selector, type: p.type, confidence: p.confidence })));

    for (const result of selectorResults) {
      // Visible elements get full confidence; hidden ones get reduced
      const confidence = result.visible ? result.confidence : result.confidence * 0.5;
      matches.push({
        type: result.type as BlockerType,
        confidence,
        selector: result.selector,
        details: `Matched selector: ${result.selector} (visible=${result.visible})`,
      });
    }

    // 2. Check text patterns against page body text
    const bodyText = await page.evaluate(() => {
      return document.body?.innerText?.substring(0, 5000) || '';
    });

    for (const { type, pattern, confidence } of TEXT_PATTERNS) {
      if (pattern.test(bodyText)) {
        matches.push({
          type,
          confidence,
          details: `Matched text pattern: ${pattern.source}`,
        });
      }
    }

    if (matches.length === 0) return null;

    // Return the highest-confidence match
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches[0];
  }
}
