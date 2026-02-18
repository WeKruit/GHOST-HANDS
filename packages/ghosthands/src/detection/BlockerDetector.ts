/**
 * BlockerDetector — Dual-mode detection of CAPTCHAs, login walls, 2FA prompts, and bot checks.
 *
 * Pass 1: Fast DOM-based detection via page.evaluate() (cheap, synchronous).
 * Pass 2: Adapter observe()-based detection when DOM finds nothing but context
 *         suggests a blocker may exist (page navigation, form submit, action failure).
 *
 * Works with any BrowserAutomationAdapter that implements observe().
 */

import type { Page } from 'playwright';
import type { BrowserAutomationAdapter, ObservedElement } from '../adapters/types.js';

export type BlockerType = 'captcha' | 'login' | '2fa' | 'bot_check' | 'rate_limit' | 'visual_verification';

export type DetectionSource = 'dom' | 'observe' | 'combined';

export interface BlockerResult {
  type: BlockerType;
  /** 0-1 confidence score */
  confidence: number;
  /** CSS selector that matched, if applicable */
  selector?: string;
  /** Human-readable description of what was detected */
  details: string;
  /** How the blocker was detected */
  source: DetectionSource;
  /** Elements found by observe(), if applicable */
  observedElements?: ObservedElement[];
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
  { type: 'captcha', selector: 'iframe[src*="funcaptcha"]', confidence: 0.9 },
  { type: 'captcha', selector: '#FunCaptcha', confidence: 0.85 },

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

  // -- Visual verification --
  { type: 'visual_verification', selector: '.slider-captcha', confidence: 0.85 },
  { type: 'visual_verification', selector: '[data-slider-captcha]', confidence: 0.85 },
];

// Text patterns checked against document.body.innerText
const TEXT_PATTERNS: { type: BlockerType; pattern: RegExp; confidence: number }[] = [
  // -- CAPTCHA text --
  { type: 'captcha', pattern: /please complete the (security |captcha )?check/i, confidence: 0.75 },
  { type: 'captcha', pattern: /verify you('re| are) (a )?human/i, confidence: 0.8 },
  { type: 'captcha', pattern: /prove you('re| are) not a robot/i, confidence: 0.8 },
  { type: 'captcha', pattern: /i('|')m not a robot/i, confidence: 0.85 },
  { type: 'captcha', pattern: /cloudflare.*turnstile/i, confidence: 0.8 },

  // -- 2FA --
  { type: '2fa', pattern: /two[- ]?factor auth/i, confidence: 0.85 },
  { type: '2fa', pattern: /verification code/i, confidence: 0.7 },
  { type: '2fa', pattern: /authenticator app/i, confidence: 0.85 },
  { type: '2fa', pattern: /enter the code sent to/i, confidence: 0.8 },
  { type: '2fa', pattern: /security code/i, confidence: 0.6 },
  { type: '2fa', pattern: /email verification/i, confidence: 0.7 },

  // -- Login text --
  { type: 'login', pattern: /sign in to continue/i, confidence: 0.85 },
  { type: 'login', pattern: /session (has )?expired/i, confidence: 0.8 },
  { type: 'login', pattern: /please (log|sign) ?in/i, confidence: 0.75 },

  // -- Bot check text --
  { type: 'bot_check', pattern: /checking your browser/i, confidence: 0.85 },
  { type: 'bot_check', pattern: /just a moment/i, confidence: 0.5 },
  { type: 'bot_check', pattern: /please wait while we verify/i, confidence: 0.8 },
  { type: 'bot_check', pattern: /access denied/i, confidence: 0.5 },
  { type: 'bot_check', pattern: /blocked by.*security/i, confidence: 0.7 },
  { type: 'bot_check', pattern: /are you a (ro)?bot/i, confidence: 0.85 },
  { type: 'bot_check', pattern: /please verify you('re| are) human/i, confidence: 0.85 },

  // -- Rate limiting --
  { type: 'rate_limit', pattern: /too many requests/i, confidence: 0.9 },
  { type: 'rate_limit', pattern: /please try again later/i, confidence: 0.65 },
  { type: 'rate_limit', pattern: /rate limit(ed)?/i, confidence: 0.85 },
  { type: 'rate_limit', pattern: /429/i, confidence: 0.5 },

  // -- Visual verification text --
  { type: 'visual_verification', pattern: /select all images with/i, confidence: 0.9 },
  { type: 'visual_verification', pattern: /slide to (verify|unlock)/i, confidence: 0.85 },
  { type: 'visual_verification', pattern: /audio challenge/i, confidence: 0.8 },
  { type: 'visual_verification', pattern: /drag the (slider|puzzle)/i, confidence: 0.85 },
];

/** Keywords in observe() element descriptions that map to blocker types */
const OBSERVE_CLASSIFICATION: { pattern: RegExp; type: BlockerType; confidence: number }[] = [
  // CAPTCHA
  { pattern: /recaptcha/i, type: 'captcha', confidence: 0.9 },
  { pattern: /hcaptcha/i, type: 'captcha', confidence: 0.9 },
  { pattern: /captcha/i, type: 'captcha', confidence: 0.8 },
  { pattern: /turnstile/i, type: 'captcha', confidence: 0.85 },
  { pattern: /funcaptcha/i, type: 'captcha', confidence: 0.85 },
  { pattern: /not a robot/i, type: 'captcha', confidence: 0.85 },

  // Login
  { pattern: /sign.?in|log.?in/i, type: 'login', confidence: 0.75 },
  { pattern: /password/i, type: 'login', confidence: 0.7 },
  { pattern: /session expired/i, type: 'login', confidence: 0.8 },

  // 2FA
  { pattern: /two.?factor|2fa|mfa/i, type: '2fa', confidence: 0.85 },
  { pattern: /verification code/i, type: '2fa', confidence: 0.8 },
  { pattern: /authenticator/i, type: '2fa', confidence: 0.85 },
  { pattern: /sms code/i, type: '2fa', confidence: 0.8 },

  // Bot check
  { pattern: /checking.*browser/i, type: 'bot_check', confidence: 0.8 },
  { pattern: /verify.*human/i, type: 'bot_check', confidence: 0.85 },
  { pattern: /bot detection/i, type: 'bot_check', confidence: 0.85 },
  { pattern: /browser fingerprint/i, type: 'bot_check', confidence: 0.8 },

  // Rate limiting
  { pattern: /too many requests/i, type: 'rate_limit', confidence: 0.9 },
  { pattern: /rate limit/i, type: 'rate_limit', confidence: 0.85 },
  { pattern: /try again later/i, type: 'rate_limit', confidence: 0.7 },

  // Visual verification
  { pattern: /select.*images?/i, type: 'visual_verification', confidence: 0.85 },
  { pattern: /slider|slide/i, type: 'visual_verification', confidence: 0.8 },
  { pattern: /puzzle/i, type: 'visual_verification', confidence: 0.75 },
  { pattern: /audio challenge/i, type: 'visual_verification', confidence: 0.8 },
];

const OBSERVE_INSTRUCTION =
  'Look for CAPTCHAs, login walls, verification challenges, 2FA prompts, rate limiting messages, or bot detection on this page. Report any blocking elements that prevent normal interaction.';

export class BlockerDetector {
  /**
   * Detect if the current page shows a blocker using DOM inspection only.
   * Returns the highest-confidence match, or null if none found.
   *
   * This is the original fast-path detection (cheap, no LLM calls).
   */
  async detectBlocker(page: Page): Promise<BlockerResult | null> {
    const matches = await this.runDOMDetection(page);
    if (matches.length === 0) return null;

    matches.sort((a, b) => b.confidence - a.confidence);
    return matches[0];
  }

  /**
   * Detect blockers using both DOM inspection and the adapter's observe() method.
   *
   * Strategy:
   * 1. Run fast DOM detection first.
   * 2. If DOM finds a high-confidence blocker (>= 0.8), return immediately.
   * 3. Otherwise, run observe() for richer vision-based detection.
   * 4. Combine results from both passes for highest confidence.
   */
  async detectWithAdapter(adapter: BrowserAutomationAdapter): Promise<BlockerResult | null> {
    // Pass 1: Fast DOM detection
    const domMatches = await this.runDOMDetection(adapter.page);

    // If DOM found a high-confidence blocker, return immediately (skip observe)
    const bestDOM = domMatches.length > 0
      ? domMatches.sort((a, b) => b.confidence - a.confidence)[0]
      : null;

    if (bestDOM && bestDOM.confidence >= 0.8) {
      return bestDOM;
    }

    // Pass 2: observe()-based detection
    const observeResult = await this.runObserveDetection(adapter);

    // No results from either pass
    if (!bestDOM && !observeResult) return null;

    // Only DOM result
    if (bestDOM && !observeResult) return bestDOM;

    // Only observe result
    if (!bestDOM && observeResult) return observeResult;

    // Both found something — combine for higher confidence
    if (bestDOM && observeResult && bestDOM.type === observeResult.type) {
      // Same type from both sources: boost confidence
      const combinedConfidence = Math.min(1.0, bestDOM.confidence + observeResult.confidence * 0.3);
      return {
        type: bestDOM.type,
        confidence: combinedConfidence,
        selector: bestDOM.selector,
        details: `${bestDOM.details} | ${observeResult.details}`,
        source: 'combined',
        observedElements: observeResult.observedElements,
      };
    }

    // Different types — return the higher confidence one
    if (bestDOM && observeResult) {
      return bestDOM.confidence >= observeResult.confidence ? bestDOM : observeResult;
    }

    return null;
  }

  /**
   * Run DOM-based detection (selector patterns + text patterns).
   */
  private async runDOMDetection(page: Page): Promise<BlockerResult[]> {
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
        source: 'dom',
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
          source: 'dom',
        });
      }
    }

    return matches;
  }

  /**
   * Run observe()-based detection using the adapter.
   * Returns the best match from observed elements, or null.
   */
  private async runObserveDetection(adapter: BrowserAutomationAdapter): Promise<BlockerResult | null> {
    if (!adapter.observe) return null;

    let elements: ObservedElement[] | undefined;
    try {
      elements = await adapter.observe(OBSERVE_INSTRUCTION);
    } catch {
      // observe() may fail if the page is in an unusual state; fall through
      return null;
    }

    if (!elements || elements.length === 0) return null;

    return this.classifyObservedElements(elements);
  }

  /**
   * Classify observed elements into a BlockerResult by matching element
   * descriptions against known blocker patterns.
   */
  classifyObservedElements(elements: ObservedElement[]): BlockerResult | null {
    let bestMatch: { type: BlockerType; confidence: number; element: ObservedElement } | null = null;

    for (const element of elements) {
      const text = `${element.description} ${element.selector}`;
      for (const { pattern, type, confidence } of OBSERVE_CLASSIFICATION) {
        if (pattern.test(text)) {
          if (!bestMatch || confidence > bestMatch.confidence) {
            bestMatch = { type, confidence, element };
          }
        }
      }
    }

    if (!bestMatch) return null;

    return {
      type: bestMatch.type,
      confidence: bestMatch.confidence,
      selector: bestMatch.element.selector,
      details: `Observed element: ${bestMatch.element.description}`,
      source: 'observe',
      observedElements: elements,
    };
  }
}
