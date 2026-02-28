/**
 * LayerHand — Abstract base class for the three-layer execution engine.
 *
 * Each layer implements the same 5-method contract:
 *   observe()    — Discover fields on the page
 *   process()    — Match fields to user data
 *   execute()    — Fill/click/interact with fields
 *   review()     — Verify actions were applied correctly
 *   throwError() — Classify and wrap errors
 *
 * Concrete implementations:
 *   DOMHand       ($0/action)     — Pure DOM injection, zero LLM
 *   StagehandHand ($0.0005/action) — Stagehand a11y observe + DOM fill
 *   MagnitudeHand ($0.005/action)  — Full GUI agent with vision LLM
 */

import type { Page } from 'playwright';
import type {
  LayerId,
  LayerContext,
  V3ObservationResult,
  FieldMatch,
  PlannedAction,
  ExecutionResult,
  ReviewResult,
  LayerError,
  ErrorCategory,
  BlockerInfo,
} from './types';

export abstract class LayerHand {
  // ── Abstract Properties ─────────────────────────────────────────────

  /** Unique layer identifier */
  abstract readonly id: LayerId;

  /** Human-readable name for logging */
  abstract readonly displayName: string;

  /** Cost per action in USD */
  abstract readonly costPerAction: number;

  /** Whether this layer requires LLM calls */
  abstract readonly requiresLLM: boolean;

  // ── Core Contract — 6 Methods ───────────────────────────────────────

  /**
   * Observe the current page to discover form fields and interactive elements.
   *
   * - DOMHand: Full-page scroll+extract via page.evaluate (free)
   * - StagehandHand: Stagehand observe() + DOM merge + boundingBox (cheap LLM)
   * - MagnitudeHand: Screenshot + StagehandObserver (expensive LLM)
   */
  abstract observe(ctx: LayerContext): Promise<V3ObservationResult>;

  /**
   * Match observed fields to user profile data.
   *
   * - DOMHand: 7-strategy heuristic cascade (zero LLM)
   * - StagehandHand: Heuristic + Stagehand description matching
   * - MagnitudeHand: Heuristic + LLM vision inference
   */
  abstract process(observation: V3ObservationResult, ctx: LayerContext): Promise<FieldMatch[]>;

  /**
   * Execute planned actions on the page (fill, click, select, etc.).
   *
   * - DOMHand: nativeInputValueSetter + dispatchEvent
   * - StagehandHand: DOM injection first, Stagehand act() fallback
   * - MagnitudeHand: Magnitude act() or exec() for direct actions
   */
  abstract execute(actions: PlannedAction[], ctx: LayerContext): Promise<ExecutionResult[]>;

  /**
   * Review executed actions by reading back DOM values.
   *
   * - DOMHand: DOM value readback + fuzzy compare
   * - StagehandHand: DOM readback + a11y tree check
   * - MagnitudeHand: DOM readback + screenshot comparison
   */
  abstract review(
    actions: PlannedAction[],
    results: ExecutionResult[],
    ctx: LayerContext,
  ): Promise<ReviewResult[]>;

  /**
   * Classify and wrap errors into LayerError.
   * Determines whether to retry, escalate, or abort.
   */
  abstract throwError(error: unknown, ctx: LayerContext): LayerError;

  // ── Shared Utilities ────────────────────────────────────────────────
  // Inherited by all three layers

  /**
   * Scroll an element into the viewport before interacting with it.
   */
  protected async scrollIntoView(page: Page, selector: string): Promise<void> {
    try {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
        }
      }, selector);
      // Small delay for scroll to settle
      await page.waitForTimeout(100);
    } catch {
      // Non-fatal: element may be visible already
    }
  }

  /**
   * Wait for the page to settle (no pending network requests, no animations).
   */
  async waitForPageSettled(page: Page, timeoutMs = 3000): Promise<void> {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      // Wait for network idle (short timeout — don't block too long)
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 2000) }).catch(() => {});
    } catch {
      // Timeout is acceptable — page may have persistent connections
    }
  }

  /**
   * Quick blocker detection via DOM heuristics (free, no LLM).
   * Checks for common CAPTCHA, login, and verification patterns.
   */
  protected async detectBlockers(page: Page): Promise<BlockerInfo[]> {
    return page.evaluate(() => {
      const blockers: Array<{
        category: 'captcha' | 'login' | '2fa' | 'bot_check' | 'rate_limited' | 'verification';
        confidence: number;
        selector?: string;
        description: string;
      }> = [];

      // CAPTCHA detection
      const captchaSelectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '.g-recaptcha',
        '#captcha',
        '[data-sitekey]',
      ];
      for (const sel of captchaSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          blockers.push({
            category: 'captcha',
            confidence: 0.95,
            selector: sel,
            description: `CAPTCHA detected: ${sel}`,
          });
          break;
        }
      }

      // Login detection
      const loginSelectors = [
        'form[action*="login"]',
        'form[action*="signin"]',
        'input[type="password"]:not([autocomplete="new-password"])',
      ];
      const url = window.location.href.toLowerCase();
      if (url.includes('/login') || url.includes('/signin') || url.includes('/sso')) {
        blockers.push({
          category: 'login',
          confidence: 0.9,
          description: `Login page detected: ${url}`,
        });
      } else {
        for (const sel of loginSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            blockers.push({
              category: 'login',
              confidence: 0.7,
              selector: sel,
              description: `Login form detected: ${sel}`,
            });
            break;
          }
        }
      }

      // Bot check / Cloudflare
      const bodyText = document.body?.innerText?.toLowerCase() ?? '';
      if (
        bodyText.includes('checking your browser') ||
        bodyText.includes('please verify you are a human') ||
        bodyText.includes('just a moment')
      ) {
        blockers.push({
          category: 'bot_check',
          confidence: 0.8,
          description: 'Bot check page detected from body text',
        });
      }

      return blockers;
    });
  }

  /**
   * Generate a unique field ID from selector and label.
   */
  protected generateFieldId(selector: string, label: string): string {
    const hash = `${selector}::${label}`.split('').reduce((acc, char) => {
      return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
    }, 0);
    return `f_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Classify an error into an ErrorCategory.
   */
  protected classifyError(error: unknown): ErrorCategory {
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (msg.includes('not found') || msg.includes('no element') || msg.includes('no such element')) {
      return 'element_not_found';
    }
    if (msg.includes('not visible') || msg.includes('hidden') || msg.includes('display: none')) {
      return 'element_not_visible';
    }
    if (msg.includes('not interactable') || msg.includes('disabled') || msg.includes('readonly')) {
      return 'element_not_interactable';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'timeout';
    }
    if (msg.includes('navigation') || msg.includes('navigate')) {
      return 'navigation_failed';
    }
    if (msg.includes('budget') || msg.includes('cost limit')) {
      return 'budget_exceeded';
    }
    if (msg.includes('disconnect') || msg.includes('target closed') || msg.includes('crashed')) {
      return 'browser_disconnected';
    }
    return 'unknown';
  }
}
