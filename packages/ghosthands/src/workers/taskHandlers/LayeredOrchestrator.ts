import { z } from 'zod';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PlatformConfig, PageState, PageType, ScannedField, ScanResult } from './platforms/types.js';
import type { CostTracker } from '../costControl.js';
import type { ProgressTracker } from '../progressTracker.js';
import { ProgressStep } from '../progressTracker.js';
import { findBestAnswer } from './platforms/genericConfig.js';

// ============================================================================
// Constants
// ============================================================================

const PAGE_TRANSITION_WAIT_MS = 3_000;
const MIN_LLM_GAP_MS = 5_000;

// MagnitudeHand (Phase 2.75)
const MAGNITUDE_HAND_BUDGET_CAP = 0.50;
const MAGNITUDE_HAND_MAX_FIELDS = 15;
const MAGNITUDE_HAND_ACT_TIMEOUT_MS = 30_000;
const MAGNITUDE_HAND_MIN_REMAINING_BUDGET = 0.02;

// ============================================================================
// Types
// ============================================================================

export interface OrchestratorParams {
  adapter: BrowserAutomationAdapter;
  /** Secondary LLM adapter (Stagehand) for cheap Phase 2 fill — shares Magnitude's browser via CDP */
  llmAdapter?: BrowserAutomationAdapter;
  config: PlatformConfig;
  costTracker: CostTracker;
  progress: ProgressTracker;
  maxPages?: number;
}

export interface RunParams {
  userProfile: Record<string, any>;
  qaMap: Record<string, string>;
  dataPrompt: string;
  resumePath?: string | null;
}

export interface OrchestratorResult {
  success: boolean;
  pagesProcessed: number;
  domFilled: number;
  llmFilled: number;
  magnitudeFilled: number;
  totalFields: number;
  awaitingUserReview: boolean;
  keepBrowserOpen?: boolean;
  error?: string;
  finalPage?: string;
  platform?: string;
}

// ============================================================================
// LayeredOrchestrator
// ============================================================================

/**
 * Three-layer form-filling orchestrator.
 *
 * Drives a multi-page job application through sequential phases:
 *   Phase 0: SCAN      — discover all fields via config.scanPageFields()
 *   Phase 1: DOM FILL  — fill matched fields programmatically ($0)
 *   Phase 2: LLM FILL  — scroll + adapter.act() for remaining fields ($0.0005/action)
 *   Phase 2.75: MAGNITUDE HAND — per-field GUI agent fallback ($0.005+/action)
 *   Phase 3: ADVANCE   — click Next/Continue
 *
 * Between phases, checks for blockers (CAPTCHA, login walls) and enforces
 * budget constraints. Stuck detection prevents infinite loops on SPAs.
 */
export class LayeredOrchestrator {
  private readonly adapter: BrowserAutomationAdapter;
  /** Secondary adapter for cheap LLM fill (Stagehand). Falls back to primary adapter if not provided. */
  private readonly llmAdapter: BrowserAutomationAdapter;
  private readonly config: PlatformConfig;
  private readonly costTracker: CostTracker;
  private readonly progress: ProgressTracker;
  private readonly maxPages: number;

  private lastLlmCallTime = 0;
  private loginAttempted = false;
  /** Tracks whether we already clicked Apply — prevents SPA re-detection as job_listing */
  private applyClicked = false;

  // Cumulative stats across all pages
  private totalDomFilled = 0;
  private totalLlmFilled = 0;
  private totalMagnitudeFilled = 0;
  private totalFieldsSeen = 0;

  constructor(params: OrchestratorParams) {
    this.adapter = params.adapter;
    this.llmAdapter = params.llmAdapter ?? params.adapter;
    this.config = params.config;
    this.costTracker = params.costTracker;
    this.progress = params.progress;
    this.maxPages = params.maxPages ?? 15;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async run(params: RunParams): Promise<OrchestratorResult> {
    const { userProfile, qaMap, dataPrompt, resumePath } = params;
    const adapter = this.adapter;
    const config = this.config;

    // Auto-attach resume to any file dialog (use named handler for cleanup)
    let filechooserHandler: ((chooser: any) => Promise<void>) | null = null;
    if (resumePath) {
      const rp = resumePath;
      filechooserHandler = async (chooser: any) => {
        try {
          console.log('[Orchestrator] File chooser opened — attaching resume');
          await chooser.setFiles(rp);
        } catch (err) {
          console.warn(`[Orchestrator] Failed to attach resume: ${err instanceof Error ? err.message : err}`);
        }
      };
      adapter.page.on('filechooser', filechooserHandler);
    }

    let pagesProcessed = 0;
    let lastPageSignature = '';
    let samePageCount = 0;
    const MAX_SAME_PAGE = 3;

    try {
      while (pagesProcessed < this.maxPages) {
        pagesProcessed++;

        await this.waitForPageSettled();
        await this.dismissCookieBanner();

        // Detect current page type
        const pageState = await this.detectPage();
        const currentPageUrl = await adapter.getCurrentUrl();
        console.log(`[Orchestrator] Page ${pagesProcessed}: ${pageState.page_type} (title: ${pageState.page_title || 'N/A'})`);

        // Stuck detection
        const contentFingerprint = await this.getPageFingerprint();
        const pageSignature = `${currentPageUrl}|${contentFingerprint}`;
        if (pageSignature === lastPageSignature) {
          samePageCount++;
          if (samePageCount >= MAX_SAME_PAGE) {
            console.warn(`[Orchestrator] Stuck on same page for ${samePageCount} iterations — stopping.`);
            await this.progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            return this.buildResult(true, pagesProcessed, true, 'stuck');
          }
        } else {
          samePageCount = 0;
          lastPageSignature = pageSignature;
        }

        // Route based on page type
        switch (pageState.page_type) {
          case 'job_listing':
            await this.handleJobListing();
            break;

          case 'login':
          case 'google_signin':
            await this.handleLogin(userProfile);
            this.loginAttempted = true;
            break;

          case 'verification_code':
            await this.handleVerificationCode();
            break;

          case 'phone_2fa':
            await this.handlePhone2FA();
            break;

          case 'account_creation':
            if (!this.loginAttempted) {
              console.log('[Orchestrator] Account creation detected but login not yet attempted — trying login first.');
              await this.handleLogin(userProfile);
              this.loginAttempted = true;
              break;
            }
            await this.handleAccountCreation(dataPrompt, userProfile);
            break;

          case 'review':
            await this.progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            console.log('\n' + '='.repeat(70));
            console.log('[Orchestrator] APPLICATION FILLED SUCCESSFULLY');
            console.log('[Orchestrator] Stopped at REVIEW page — NOT submitting.');
            console.log('='.repeat(70) + '\n');
            return this.buildResult(true, pagesProcessed, true, 'review');

          case 'confirmation':
            console.warn('[Orchestrator] Unexpected: landed on confirmation page');
            return this.buildResult(true, pagesProcessed, false, 'confirmation');

          case 'error':
            return {
              ...this.buildResult(false, pagesProcessed, false, 'error'),
              error: `Application error page: ${pageState.error_message || 'Unknown error'}`,
            };

          default: {
            // ALL form pages
            if (
              (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload') &&
              config.needsCustomExperienceHandler && config.handleExperiencePage
            ) {
              await this.progress.setStep(ProgressStep.UPLOADING_RESUME);
              await config.handleExperiencePage(adapter, userProfile, dataPrompt);
              const advanced = await this.advanceAfterCustomHandler(pageState.page_type);
              if (advanced === 'review') break; // Main loop will re-detect
              if (advanced === 'navigated') {
                await this.waitForPageSettled();
                break;
              }
              // Fall through: re-detect page for recovery
              break;
            }

            const step = (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload')
              ? ProgressStep.UPLOADING_RESUME
              : ProgressStep.FILLING_FORM;
            await this.progress.setStep(step);

            const fillPrompt = config.buildPagePrompt(pageState.page_type, dataPrompt);
            const result = await this.fillPage(fillPrompt, qaMap, pageState.page_type, resumePath, 0, 0, dataPrompt);

            if (result === 'review') {
              await this.progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
              console.log('\n' + '='.repeat(70));
              console.log('[Orchestrator] Stopped at REVIEW page — NOT submitting.');
              console.log('='.repeat(70) + '\n');
              return this.buildResult(true, pagesProcessed, true, 'review');
            }
            break;
          }
        }
      }

      // Hit max pages
      console.warn(`[Orchestrator] Reached max page limit (${this.maxPages})`);
      await this.progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
      return this.buildResult(true, pagesProcessed, true, 'max_pages_reached');

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] Error on page ${pagesProcessed}: ${msg}`);
      return {
        ...this.buildResult(false, pagesProcessed, false, 'error'),
        keepBrowserOpen: pagesProcessed > 2,
        error: msg,
      };
    } finally {
      // Clean up filechooser listener to avoid duplicates
      if (filechooserHandler) {
        try { adapter.page.off('filechooser', filechooserHandler); } catch (err) {
          console.warn(`[Orchestrator] Failed to remove filechooser listener: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // ==========================================================================
  // Page Detection — 4-tier delegation
  // ==========================================================================

  private async detectPage(): Promise<PageState> {
    const adapter = this.adapter;
    const config = this.config;
    const currentUrl = await adapter.getCurrentUrl();

    // Tier 1: URL-based
    const urlResult = config.detectPageByUrl(currentUrl);
    if (urlResult) {
      // SPA override: if we already clicked Apply and detection says job_listing,
      // the page scrolled to an inline form (e.g. Greenhouse). Reclassify.
      if (this.applyClicked && urlResult.page_type === 'job_listing') {
        console.log('[Orchestrator] Apply already clicked — reclassifying job_listing as questions (SPA)');
        return { page_type: 'questions' as PageType, page_title: 'Application Form' };
      }
      return urlResult;
    }

    // Tier 2: Minimal DOM checks
    const obviousResult = await this.detectObviousPage(currentUrl);
    if (obviousResult) return obviousResult;

    // Tier 2.5: Platform-specific DOM detection
    const domResult = await config.detectPageByDOM(adapter);
    if (domResult) {
      // SPA override: prevent re-detection as job_listing after Apply click
      if (this.applyClicked && domResult.page_type === 'job_listing') {
        console.log('[Orchestrator] Apply already clicked — reclassifying job_listing as questions (SPA)');
        return { page_type: 'questions' as PageType, page_title: 'Application Form' };
      }
      console.log(`[Orchestrator] DOM detection classified page as: ${domResult.page_type}`);
      return domResult;
    }

    // Tier 3: LLM classification
    try {
      const healthy = await this.isPageHealthy();
      if (!healthy) {
        console.warn('[Orchestrator] Page appears broken — using DOM fallback.');
        const fallbackType = await config.classifyByDOMFallback(adapter);
        return { page_type: fallbackType, page_title: 'broken_page' };
      }

      const urlHints: string[] = [];
      if (currentUrl.includes('signin') || currentUrl.includes('login') || currentUrl.includes('accounts.google.com')) {
        urlHints.push('The URL indicates this is a login/sign-in page.');
      }
      if (currentUrl.includes('review') || currentUrl.includes('summary')) {
        urlHints.push('The URL indicates this may be a review/summary page.');
      }
      if (currentUrl.includes('job') || currentUrl.includes('position') || currentUrl.includes('career')) {
        urlHints.push('The URL is job-related.');
      }
      if (currentUrl.includes('apply')) {
        urlHints.push('The URL contains "apply" — this could be the application form or a job listing with an Apply button.');
      }

      const classificationPrompt = config.buildClassificationPrompt(urlHints);
      await this.throttleLlm();
      const llmResult = await adapter.extract(classificationPrompt, config.pageStateSchema);
      console.log(`[Orchestrator] LLM classified page as: ${llmResult.page_type}`);

      // SPA override: prevent re-detection as job_listing after Apply click
      if (this.applyClicked && llmResult.page_type === 'job_listing') {
        console.log('[Orchestrator] Apply already clicked — reclassifying job_listing as questions (SPA)');
        return { page_type: 'questions' as PageType, page_title: 'Application Form' };
      }

      // SAFETY: account_creation override — if 5+ form fields, it's a form page
      if (llmResult.page_type === 'account_creation') {
        const formFieldCount = await adapter.page.evaluate(() => {
          return document.querySelectorAll(
            'input[type="text"]:not([readonly]):not([disabled]), ' +
            'input[type="email"]:not([readonly]):not([disabled]), ' +
            'input[type="tel"]:not([readonly]):not([disabled]), ' +
            'textarea:not([readonly]):not([disabled]), ' +
            'select:not([disabled]), ' +
            '[role="combobox"]:not([aria-disabled="true"])'
          ).length;
        });
        if (formFieldCount >= 5) {
          console.log(`[Orchestrator] LLM said "account_creation" but page has ${formFieldCount} fields — overriding to "questions"`);
          return { ...llmResult, page_type: 'questions' as PageType };
        }
      }

      // SAFETY: review override — if editable fields present, it's still a form
      if (llmResult.page_type === 'review') {
        const hasEditableFields = await adapter.page.evaluate(() => {
          return document.querySelectorAll(
            'input[type="text"]:not([readonly]):not([disabled]), ' +
            'input[type="email"]:not([readonly]):not([disabled]), ' +
            'input[type="tel"]:not([readonly]):not([disabled]), ' +
            'textarea:not([readonly]):not([disabled]), ' +
            'select:not([disabled]), ' +
            '[role="combobox"]:not([aria-disabled="true"]), ' +
            '[role="radiogroup"], ' +
            '[role="radio"]:not([aria-checked="true"])'
          ).length > 0;
        });
        if (hasEditableFields) {
          console.log('[Orchestrator] LLM said "review" but page has editable fields — overriding to "questions"');
          return { ...llmResult, page_type: 'questions' as PageType };
        }
        const isReallyReview = await this.verifyReviewPage();
        if (!isReallyReview) {
          console.log('[Orchestrator] Review verification failed — overriding to "questions"');
          return { ...llmResult, page_type: 'questions' as PageType };
        }
      }

      return llmResult;
    } catch (error) {
      console.warn(`[Orchestrator] LLM page detection failed: ${error}`);

      // Tier 4: DOM fallback
      const fallbackType = await config.classifyByDOMFallback(adapter);
      if (fallbackType !== 'unknown') {
        console.log(`[Orchestrator] DOM fallback classified page as: ${fallbackType}`);
      }
      return { page_type: fallbackType, page_title: fallbackType === 'unknown' ? 'N/A' : fallbackType };
    }
  }

  private async detectObviousPage(currentUrl: string): Promise<PageState | null> {
    const adapter = this.adapter;

    if (currentUrl.includes('accounts.google.com')) {
      return { page_type: 'google_signin', page_title: 'Google Sign-In', has_sign_in_with_google: true };
    }

    const obvious = await adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const hasPasswordField = passwordFields.length > 0;
      const hasConfirmPassword = passwordFields.length > 1;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const isCreateAccountHeading = headingText.includes('create account')
        || headingText.includes('register')
        || headingText.includes('sign up');
      const hasConfirmation = bodyText.includes('thank you for applying')
        || bodyText.includes('application received')
        || bodyText.includes('successfully submitted')
        || bodyText.includes('application has been submitted');
      const formFieldCount = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), ' +
        'input[type="email"]:not([readonly]):not([disabled]), ' +
        'input[type="tel"]:not([readonly]):not([disabled]), ' +
        'textarea:not([readonly]):not([disabled]), ' +
        'select:not([disabled]), ' +
        '[role="combobox"]:not([aria-disabled="true"])'
      ).length;
      return { hasPasswordField, hasConfirmPassword, isCreateAccountHeading, hasConfirmation, formFieldCount };
    });

    if (obvious.hasConfirmation) {
      return { page_type: 'confirmation', page_title: 'Confirmation' };
    }

    if (obvious.hasPasswordField && !obvious.hasConfirmPassword && !obvious.isCreateAccountHeading
        && !this.loginAttempted && obvious.formFieldCount < 5) {
      return { page_type: 'login', page_title: 'Sign-In' };
    }

    return null;
  }

  // ==========================================================================
  // Page Handlers
  // ==========================================================================

  private async handleJobListing(): Promise<void> {
    const adapter = this.adapter;
    console.log('[Orchestrator] On job listing page, clicking Apply...');

    await adapter.page.evaluate(() => {
      document.querySelectorAll('a[target="_blank"]').forEach(a => {
        a.removeAttribute('target');
      });
    });

    const urlBefore = await adapter.getCurrentUrl();
    await this.throttleLlm();
    const result = await adapter.act(
      'Click the "Apply" or "Apply Now" button to start the job application. ' +
      'Your ONLY task is to click the apply button — nothing else. ' +
      'After clicking, report the task as done immediately. ' +
      'The page will navigate away — that is expected.',
    );

    if (!result.success) {
      const urlAfter = await adapter.getCurrentUrl();
      if (urlAfter !== urlBefore) {
        console.log('[Orchestrator] Apply button clicked — page navigated. Continuing...');
      } else {
        throw new Error(`Failed to click Apply button: ${result.message}`);
      }
    }

    this.applyClicked = true;
    await this.waitForPageSettled();
  }

  private async handleLogin(profile: Record<string, any>): Promise<void> {
    const adapter = this.adapter;
    const config = this.config;

    if (config.handleLogin) {
      await config.handleLogin(adapter, profile);
      return;
    }

    const currentUrl = await adapter.getCurrentUrl();
    const email = profile.email || '';

    // Google SSO path
    if (currentUrl.includes('accounts.google.com')) {
      await this.handleGoogleSignIn(email, profile.password);
      return;
    }

    // Non-Google login
    console.log('[Orchestrator] On login page, looking for sign-in options...');
    const password = profile.password || process.env.TEST_GMAIL_PASSWORD || '';

    // Check for Google SSO button
    const hasGoogleSSO = await adapter.page.evaluate(() => {
      const els = document.querySelectorAll('a, button, [role="button"], [role="link"]');
      for (const el of els) {
        const text = (el.textContent || '').toLowerCase();
        if (text.includes('google') && (text.includes('sign in') || text.includes('continue') || text.includes('log in'))) return true;
        const img = el.querySelector('img[src*="google" i], img[alt*="google" i]');
        if (img) return true;
      }
      return false;
    });

    if (hasGoogleSSO) {
      console.log('[Orchestrator] Google SSO button found — clicking...');
      const ssoResult = await adapter.act('Click the "Sign in with Google" button, Google icon/logo button, or "Continue with Google" option. Click ONLY ONE button, then report done.');
      if (!ssoResult.success) {
        console.warn(`[Orchestrator] Google SSO click failed: ${ssoResult.message} — continuing anyway.`);
      }
      await this.waitForPageSettled();
      return;
    }

    // Native email/password login
    console.log('[Orchestrator] No Google SSO — trying email/password login...');

    const formState = await adapter.page.evaluate(() => {
      const hasEmail = !!document.querySelector(
        'input[type="email"]:not([disabled]), input[autocomplete="email"]:not([disabled]), ' +
        'input[name*="email" i]:not([disabled]), input[name*="user" i]:not([disabled])'
      );
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const hasPassword = passwordFields.length > 0;
      const isCreateAccountForm = passwordFields.length > 1;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const hasCreateAccountHeading = headingText.includes('create account')
        || headingText.includes('register') || headingText.includes('sign up');
      const signInLink = Array.from(
        document.querySelectorAll('a, button, [role="tab"], [role="button"], [role="link"]')
      ).find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'sign in' || text === 'log in' || text === 'login'
          || text.includes('already have an account');
      });
      return {
        hasEmail, hasPassword,
        isCreateAccountForm: isCreateAccountForm || hasCreateAccountHeading,
        hasSignInLink: !!signInLink,
      };
    });

    // If on Create Account form with Sign In link, switch to login view
    if (formState.isCreateAccountForm && formState.hasSignInLink) {
      console.log('[Orchestrator] On Create Account form — clicking Sign In link...');
      const clicked = await adapter.page.evaluate(() => {
        const els = document.querySelectorAll('a, button, [role="tab"], [role="button"], [role="link"]');
        for (const el of els) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (text === 'sign in' || text === 'log in' || text === 'login'
            || text.includes('already have an account')) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        await adapter.page.waitForTimeout(1500);
        const newState = await adapter.page.evaluate(() => {
          const hasEmail = !!document.querySelector(
            'input[type="email"]:not([disabled]), input[autocomplete="email"]:not([disabled]), ' +
            'input[name*="email" i]:not([disabled]), input[name*="user" i]:not([disabled])'
          );
          const hasPassword = !!document.querySelector('input[type="password"]:not([disabled])');
          return { hasEmail, hasPassword };
        });
        formState.hasEmail = newState.hasEmail;
        formState.hasPassword = newState.hasPassword;
        formState.isCreateAccountForm = false;
      }
    }

    if (formState.hasEmail || formState.hasPassword) {
      const fillAndSubmit = async (pw: string) => {
        if (formState.hasEmail) {
          await adapter.page.evaluate((e: string) => {
            const sels = [
              'input[type="email"]', 'input[autocomplete="email"]',
              'input[name*="email" i]', 'input[name*="user" i]',
              'input[id*="email" i]', 'input[id*="user" i]',
            ];
            for (const sel of sels) {
              const input = document.querySelector<HTMLInputElement>(sel + ':not([disabled])');
              if (input && input.getBoundingClientRect().width > 0) {
                input.focus();
                input.value = e;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
          }, email);
        }

        if (formState.hasPassword && pw) {
          await adapter.page.evaluate((p: string) => {
            const input = document.querySelector<HTMLInputElement>('input[type="password"]:not([disabled])');
            if (input && input.getBoundingClientRect().width > 0) {
              input.focus();
              input.value = p;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, pw);
        }

        await adapter.page.waitForTimeout(300);

        const clicked = await adapter.page.evaluate(() => {
          const TEXTS = ['sign in', 'log in', 'login', 'submit', 'continue', 'next'];
          const btns = document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]');
          for (const btn of btns) {
            const text = (btn.textContent || (btn as HTMLInputElement).value || '').trim().toLowerCase();
            if (TEXTS.some(t => text === t || (text.length < 30 && text.includes(t)))) {
              btn.click();
              return true;
            }
          }
          const form = document.querySelector('form');
          if (form) { form.requestSubmit(); return true; }
          return false;
        });

        if (!clicked) {
          const submitResult = await adapter.act('Click the "Sign In", "Log In", "Next", or "Continue" button. Click ONLY ONE button.');
          if (!submitResult.success) {
            console.warn(`[Orchestrator] Login submit click failed: ${submitResult.message}`);
          }
        }

        await adapter.page.waitForTimeout(3000);
        await this.waitForPageSettled();
      };

      const checkLoginError = async (): Promise<string | null> => {
        return adapter.page.evaluate(() => {
          const patterns = ['incorrect', 'invalid', 'wrong', 'not found', "doesn't exist", 'does not exist',
            'failed', 'try again', 'not recognized', 'no account', 'unable to sign'];
          const alertEls = document.querySelectorAll(
            '[role="alert"], .error, .alert-error, .alert-danger, ' +
            '[class*="error-msg"], [class*="error-message"], [class*="errorMessage"]'
          );
          for (const el of alertEls) {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const text = (el.textContent || '').trim().toLowerCase();
            if (text && patterns.some(p => text.includes(p))) return text.substring(0, 200);
          }
          return null;
        });
      };

      // Try login with base password
      await fillAndSubmit(password);

      let loginError: string | null = null;
      if (formState.hasPassword) {
        loginError = await checkLoginError();

        if (loginError) {
          console.log(`[Orchestrator] Login failed: "${loginError}" — navigating to account creation...`);
          const clickedCreate = await adapter.page.evaluate(() => {
            const TEXTS = ['create account', 'sign up', 'register', 'create an account',
              "don't have an account", 'new user', 'get started', 'join now'];
            const els = document.querySelectorAll('a, button, [role="button"], [role="link"], span');
            for (const el of els) {
              const text = (el.textContent || '').trim().toLowerCase();
              if (TEXTS.some(t => text.includes(t))) {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (!clickedCreate) {
            const createResult = await adapter.act('The login failed. Look for a "Create Account", "Sign Up", "Register", or "Don\'t have an account?" link and click it. Click ONLY ONE link.');
            if (!createResult.success) {
              console.warn(`[Orchestrator] Create account link click failed: ${createResult.message}`);
            }
          }
          await this.waitForPageSettled();
        }
      }
      return;
    }

    // No form fields — use LLM
    const loginResult = await adapter.act(
      'This is a login page. First, look for a "Sign In" or "Log In" button and click it. Only if there is no sign-in option, click a "Create Account" or "Sign Up" link instead. Click ONLY ONE button, then report done.',
    );
    if (!loginResult.success) {
      console.warn(`[Orchestrator] Login LLM fallback failed: ${loginResult.message}`);
    }
    await this.waitForPageSettled();
  }

  private async handleGoogleSignIn(email: string, userPassword?: string): Promise<void> {
    const adapter = this.adapter;
    const password = userPassword || process.env.TEST_GMAIL_PASSWORD || '';
    if (!password) {
      console.warn('[Orchestrator] No password available for Google sign-in — password entry will fail if required.');
    }

    console.log('[Orchestrator] On Google sign-in page...');

    const googlePageType = await adapter.page.evaluate(`
      (() => {
        const targetEmail = ${JSON.stringify(email)}.toLowerCase();
        let hasVisiblePassword = false;
        let hasVisibleEmail = false;
        document.querySelectorAll('input[type="password"]').forEach(el => {
          if (hasVisiblePassword) return;
          if (el.getAttribute('aria-hidden') === 'true') return;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) hasVisiblePassword = true;
        });
        document.querySelectorAll('input[type="email"]').forEach(el => {
          if (hasVisibleEmail) return;
          if (el.getAttribute('aria-hidden') === 'true') return;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) hasVisibleEmail = true;
        });
        if (hasVisiblePassword) return { type: 'password_entry' };
        if (hasVisibleEmail) return { type: 'email_entry' };
        const bodyText = document.body.innerText.toLowerCase();
        const buttons = document.querySelectorAll('button, div[role="button"]');
        const hasContinue = Array.from(buttons).some(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          return t === 'continue' || t === 'confirm' || t === 'allow';
        });
        if (hasContinue && (bodyText.includes(targetEmail) || bodyText.includes('confirm') || bodyText.includes('signing in'))) {
          return { type: 'confirmation' };
        }
        const accountLinks = document.querySelectorAll('[data-email], [data-identifier]');
        for (const el of accountLinks) {
          const addr = (el.getAttribute('data-email') || el.getAttribute('data-identifier') || '').toLowerCase();
          if (addr === targetEmail) return { type: 'account_chooser' };
        }
        if (bodyText.includes('choose an account') || bodyText.includes('select an account')) {
          return { type: 'account_chooser' };
        }
        return { type: 'unknown' };
      })()
    `) as { type: string };

    if (googlePageType.type === 'confirmation') {
      console.log('[Orchestrator] Google confirmation — clicking Continue...');
      const clicked = await adapter.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const t = (btn.textContent || '').trim().toLowerCase();
          if (t === 'continue' || t === 'confirm' || t === 'allow') {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) {
        const confirmResult = await adapter.act('Click the "Continue" or "Confirm" button to proceed with Google sign-in.');
        if (!confirmResult.success) {
          console.warn(`[Orchestrator] Google confirm click failed: ${confirmResult.message}`);
        }
      }
      await adapter.page.waitForTimeout(2000);
      return;
    }

    if (googlePageType.type === 'account_chooser') {
      const clicked = await adapter.page.evaluate((targetEmail: string) => {
        const byAttr = document.querySelector(`[data-email="${targetEmail}" i], [data-identifier="${targetEmail}" i]`);
        if (byAttr) { (byAttr as HTMLElement).click(); return true; }
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          if (el.textContent?.toLowerCase().includes(targetEmail.toLowerCase()) && el.children.length < 5) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, email);
      if (!clicked) {
        const chooserResult = await adapter.act(`Click on the account "${email}" to sign in with it.`);
        if (!chooserResult.success) {
          console.warn(`[Orchestrator] Google account chooser click failed: ${chooserResult.message}`);
        }
      }
      await adapter.page.waitForTimeout(2000);
      return;
    }

    if (googlePageType.type === 'email_entry') {
      const emailInput = adapter.page.locator('input[type="email"]:visible').first();
      await emailInput.fill(email);
      await adapter.page.waitForTimeout(300);
      await this.clickNextOnGooglePage();
      await adapter.page.waitForTimeout(2000);
      return;
    }

    if (googlePageType.type === 'password_entry') {
      if (!password) {
        console.warn('[Orchestrator] Google password page but no password available — cannot proceed.');
        throw new Error('Google sign-in requires a password in user_data.password or TEST_GMAIL_PASSWORD env var');
      }
      const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
      await passwordInput.fill(password);
      await adapter.page.waitForTimeout(300);
      await this.clickNextOnGooglePage();
      await adapter.page.waitForTimeout(2000);
      return;
    }

    // Unknown Google page — LLM fallback
    const passwordHint = password
      ? `- If you see a "Password" field, type the password and click "Next".`
      : `- If you see a "Password" field, report the task as done (no password available).`;
    const googleResult = await adapter.act(
      `This is a Google sign-in page. Move through the sign-in flow for "${email}":
- If you see a "Continue", "Confirm", or "Allow" button, click it to proceed.
- If you see the account "${email}" listed, click on it to select it.
- If you see an "Email or phone" field, type "${email}" and click "Next".
${passwordHint}
- If you see a CAPTCHA or image challenge, report the task as done.
Click only ONE button, then report the task as done.`,
    );
    if (!googleResult.success) {
      console.warn(`[Orchestrator] Google sign-in LLM fallback failed: ${googleResult.message}`);
    }
    await adapter.page.waitForTimeout(2000);
  }

  private async handleVerificationCode(): Promise<void> {
    const adapter = this.adapter;
    console.log('[Orchestrator] Verification code required — checking Gmail...');

    const gmailPage = await adapter.page.context().newPage();
    let code: string | null = null;

    try {
      await gmailPage.goto('https://mail.google.com', { waitUntil: 'domcontentloaded' });
      await gmailPage.waitForTimeout(3000);

      const bodyText = await gmailPage.evaluate(() => document.body.innerText);
      const codeMatch = bodyText.match(
        /(?:verification|security|confirm|one-time|otp|2fa)\s*(?:code|pin|number)[:\s]*(\d{4,8})/i,
      ) ?? bodyText.match(
        /(\d{4,8})\s*(?:is your|is the)\s*(?:verification|security|confirm)/i,
      );

      if (codeMatch) code = codeMatch[1];
    } finally {
      await gmailPage.close();
    }

    if (!code) throw new Error('Could not find verification code in Gmail');

    console.log(`[Orchestrator] Found verification code (${code.length} digits)`);
    const enterResult = await adapter.act(
      `Enter the verification code "${code}" into the verification code input field, then click the "Next", "Verify", "Continue", or "Submit" button. Report the task as done after clicking.`,
    );
    if (!enterResult.success) throw new Error(`Failed to enter verification code: ${enterResult.message}`);
    await this.waitForPageSettled();
  }

  private async handlePhone2FA(): Promise<void> {
    const currentUrl = await this.adapter.getCurrentUrl();
    let challengeDesc: string;
    if (currentUrl.includes('recaptcha')) {
      challengeDesc = 'Captcha challenge requires human intervention';
    } else if (currentUrl.includes('ipp') || currentUrl.includes('/challenge/')) {
      challengeDesc = '2FA phone verification requires human intervention';
    } else {
      challengeDesc = '2FA security challenge requires human intervention';
    }
    console.log(`[Orchestrator] ${challengeDesc} at ${currentUrl}`);
    throw new Error(challengeDesc);
  }

  private async handleAccountCreation(dataPrompt: string, profile: Record<string, any>): Promise<void> {
    const adapter = this.adapter;
    console.log('[Orchestrator] Account creation page detected, filling in details...');

    const email = profile.email || '';
    const password = profile.password || process.env.TEST_GMAIL_PASSWORD || '';
    if (!password) {
      console.warn('[Orchestrator] No password available for account creation — cannot proceed.');
      throw new Error('Account creation requires a password in user_data.password or TEST_GMAIL_PASSWORD env var');
    }

    // DOM-fill email
    await adapter.page.evaluate((e: string) => {
      const sels = [
        'input[type="email"]', 'input[autocomplete="email"]',
        'input[data-automation-id*="email" i]',
        'input[name*="email" i]', 'input[id*="email" i]',
      ];
      for (const sel of sels) {
        const input = document.querySelector<HTMLInputElement>(sel + ':not([disabled])');
        if (input && input.getBoundingClientRect().width > 0 && !input.value?.trim()) {
          input.focus();
          input.value = e;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, email);

    // DOM-fill ALL password inputs
    await adapter.page.evaluate((pw: string) => {
      const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]:not([disabled])');
      for (const input of inputs) {
        if (input.getBoundingClientRect().width > 0) {
          input.focus();
          input.value = pw;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, password);

    await adapter.page.waitForTimeout(300);

    // LLM handles remaining fields
    const result = await adapter.act(
      `Fill out the remaining account creation fields, then click "Create Account", "Register", "Continue", or "Next".

The email and password fields should already be filled — do NOT clear or retype them.

HOW TO FILL:
- Fill name and other fields from the data mapping below.
- If there are checkboxes for terms/conditions or privacy policy, check them.
- Report the task as done after clicking the registration button.

${dataPrompt}`,
    );

    if (!result.success) {
      const hasPasswordField = await adapter.page.evaluate(() =>
        document.querySelectorAll('input[type="password"]').length > 0
      );
      if (!hasPasswordField) {
        console.log('[Orchestrator] act() reported failure but page moved past account creation — continuing.');
        return;
      }
      throw new Error(`Failed to create account: ${result.message}`);
    }

    await this.waitForPageSettled();
  }

  // ==========================================================================
  // Fill + Scroll Loop (Phases 0–3)
  // ==========================================================================

  private async fillPage(
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
    resumePath?: string | null,
    _depth = 0,
    _llmCallsCarried = 0,
    dataPrompt?: string,
  ): Promise<'navigated' | 'review' | 'complete'> {
    const adapter = this.adapter;
    const config = this.config;
    const costTracker = this.costTracker;
    const MAX_DEPTH = 3;
    const MAX_CYCLES = 5;
    const MAX_LLM_CALLS = 100;
    let llmCalls = _llmCallsCarried;

    if (_depth >= MAX_DEPTH) {
      console.warn(`[Orchestrator] [${pageLabel}] Hit max fill depth (${MAX_DEPTH}) — giving up.`);
      return 'complete';
    }
    let resumeUploaded = false;

    // Safety: check if this is actually the review page
    if (await this.checkIfReviewPage()) {
      console.log(`[Orchestrator] [${pageLabel}] SAFETY: This is the review page — skipping fill.`);
      return 'review';
    }

    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      // ── PHASE 0: SCAN ──
      console.log(`[Orchestrator] [${pageLabel}] Cycle ${cycle + 1} — scanning page...`);
      const scan = await config.scanPageFields(adapter);

      const emptyFields = scan.fields.filter(f => !f.currentValue || f.currentValue.trim() === '');
      const filledFields = scan.fields.filter(f => f.currentValue && f.currentValue.trim() !== '');
      this.totalFieldsSeen += scan.fields.length;
      console.log(`[Orchestrator] [${pageLabel}] Scan: ${scan.fields.length} total, ${emptyFields.length} empty, ${filledFields.length} filled`);

      if (emptyFields.length === 0) {
        console.log(`[Orchestrator] [${pageLabel}] No empty fields — advancing.`);
        break;
      }

      for (const f of emptyFields) {
        console.log(`[Orchestrator] [${pageLabel}]   [${f.kind}] "${f.label}" (${f.fillStrategy})${f.options ? ` opts: [${f.options.slice(0, 3).join(', ')}${f.options.length > 3 ? '...' : ''}]` : ''}`);
      }

      // ── PHASE 0.5: RESUME UPLOAD ──
      if (resumePath && !resumeUploaded) {
        const fileField = scan.fields.find(f => f.kind === 'file' && !f.currentValue);
        if (fileField) {
          const uploaded = await this.uploadResumeIfPresent(resumePath);
          if (uploaded) {
            resumeUploaded = true;
            fileField.filled = true;
          }
        }
        if (!resumeUploaded) {
          const uploadBtn = scan.fields.find(f => f.kind === 'upload_button' && !f.filled);
          if (uploadBtn) {
            console.log(`[Orchestrator] [${pageLabel}] Upload button found — clicking via LLM...`);
            try {
              await adapter.page.evaluate(
                (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
                uploadBtn.selector,
              );
              await adapter.page.waitForTimeout(300);
              const uploadClicked = await this.safeAct(
                'Click the resume/CV upload button or drag-and-drop area to open the file picker. ' +
                'Look for text like "Upload", "Attach", "Choose File", "Browse", "Add Resume", or a drag-and-drop zone. ' +
                'Click it ONCE, then report done immediately. Do NOT fill any other fields.',
                pageLabel);
              llmCalls++;
              if (uploadClicked) {
                await adapter.page.waitForTimeout(3000);
                resumeUploaded = true;
                uploadBtn.filled = true;
              } else {
                console.warn(`[Orchestrator] [${pageLabel}] Resume upload click reported failure — will retry on next cycle.`);
              }
            } catch (err) {
              console.warn(`[Orchestrator] [${pageLabel}] LLM resume upload click failed: ${err}`);
            }
          }
        }
      }

      // ── PHASE 1: DOM FILL ──
      let domFills = 0;
      const unfilled = scan.fields.filter(f => !f.filled && (!f.currentValue || f.currentValue.trim() === ''));
      console.log(`[Orchestrator] [${pageLabel}] Phase 1 (DOM fill): ${unfilled.length} unfilled fields, qaMap has ${Object.keys(qaMap).length} keys`);

      for (const field of unfilled) {
        if (field.kind === 'file' || field.kind === 'upload_button') continue;

        const answer = findBestAnswer(field.label, qaMap);
        if (!answer) {
          console.log(`[Orchestrator] [${pageLabel}]   DOM skip: no QA match for "${field.label}"`);
          continue;
        }

        field.matchedAnswer = answer;

        try {
          const success = await config.fillScannedField(adapter, field, answer);
          if (success) {
            field.filled = true;
            domFills++;
            this.totalDomFilled++;
            console.log(`[Orchestrator] [${pageLabel}] DOM-filled "${field.label}" (${field.kind})`);
          }
        } catch (err) {
          console.warn(`[Orchestrator] [${pageLabel}] DOM fill failed for "${field.label}": ${err}`);
        }
      }

      domFills += await config.checkRequiredCheckboxes(adapter);
      if (domFills > 0) {
        console.log(`[Orchestrator] [${pageLabel}] DOM filled ${domFills} field(s)`);
      }

      // ── PHASE 2: LLM FILL (Stagehand) ──
      const initialUnfilled = scan.fields.filter(f => !f.filled && (!f.currentValue || f.currentValue.trim() === '') && f.kind !== 'file' && f.kind !== 'upload_button');

      if (initialUnfilled.length > 0 && llmCalls < MAX_LLM_CALLS) {
        console.log(`[Orchestrator] [${pageLabel}] Phase 2 (LLM fill): ${initialUnfilled.length} fields remain, using ${this.llmAdapter === this.adapter ? 'Magnitude (fallback)' : 'Stagehand'}`);
        const llmFilled = await this.llmFillPhase(scan, fillPrompt, qaMap, pageLabel, llmCalls, MAX_LLM_CALLS);
        llmCalls += llmFilled.callsMade;
        this.totalLlmFilled += llmFilled.fieldsFilled;
      }

      // ── POST-WALK CLEANUP ──
      const postWalkUnfilled = scan.fields.filter(f =>
        !f.filled && (!f.currentValue || f.currentValue.trim() === '') &&
        f.kind !== 'file' && f.kind !== 'upload_button'
      );

      if (postWalkUnfilled.length > 0) {
        console.log(`[Orchestrator] [${pageLabel}] Post-walk cleanup: ${postWalkUnfilled.length} field(s) still unfilled`);
        const cleanupCalls = await this.postWalkCleanup(postWalkUnfilled, scan, config, qaMap, fillPrompt, pageLabel, llmCalls, MAX_LLM_CALLS);
        llmCalls += cleanupCalls;
      }

      // ── PHASE 2.75: MAGNITUDE HAND ──
      const magnitudeUnfilled = scan.fields.filter(f =>
        !f.filled &&
        (!f.currentValue || f.currentValue.trim() === '') &&
        f.kind !== 'file' && f.kind !== 'upload_button'
      );

      if (magnitudeUnfilled.length > 0) {
        console.log(`[Orchestrator] [${pageLabel}] ${magnitudeUnfilled.length} field(s) remain — invoking MagnitudeHand.`);

        const freshScan = await config.scanPageFields(adapter);
        for (const orig of scan.fields) {
          if (orig.filled) {
            const match = freshScan.fields.find(f => f.selector === orig.selector);
            if (match) match.filled = true;
          }
        }
        for (const f of freshScan.fields) {
          if (f.currentValue && f.currentValue.trim() !== '') f.filled = true;
          if (!f.filled) f.matchedAnswer = findBestAnswer(f.label, qaMap) || undefined;
        }

        try {
          const magnitudeFilled = await this.magnitudeHandPhase(freshScan, qaMap, dataPrompt || '', pageLabel);
          if (magnitudeFilled > 0) {
            console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand filled ${magnitudeFilled} field(s).`);
            this.totalMagnitudeFilled += magnitudeFilled;
          }
        } catch (err) {
          if (err instanceof Error && (err.message.includes('Budget exceeded') || err.message.includes('Action limit exceeded'))) {
            throw err;
          }
          console.warn(`[Orchestrator] [${pageLabel}] MagnitudeHand error: ${err}`);
        }
      }

      break; // Done filling, move to Phase 3
    }

    // ── PHASE 3: ADVANCE ──
    return this.advancePage(fillPrompt, qaMap, pageLabel, resumePath, _depth, llmCalls, dataPrompt);
  }

  // ==========================================================================
  // Phase 2: LLM Fill (viewport walk)
  // ==========================================================================

  private async llmFillPhase(
    scan: ScanResult,
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
    currentLlmCalls: number,
    maxLlmCalls: number,
  ): Promise<{ callsMade: number; fieldsFilled: number }> {
    // If Stagehand is available (separate from Magnitude), use per-field mode.
    // Stagehand act() handles ONE atomic action per call, so batch prompts don't work.
    if (this.llmAdapter !== this.adapter) {
      return this.llmFillPhasePerField(scan, qaMap, pageLabel, currentLlmCalls, maxLlmCalls);
    }

    // Fallback: Magnitude handles its own decomposition, so batch viewport walk is fine.
    return this.llmFillPhaseBatch(scan, fillPrompt, qaMap, pageLabel, currentLlmCalls, maxLlmCalls);
  }

  /**
   * Per-field LLM fill — designed for Stagehand which performs one action per act() call.
   * Scrolls each unfilled field into view and sends a focused single-field instruction.
   */
  private async llmFillPhasePerField(
    scan: ScanResult,
    qaMap: Record<string, string>,
    pageLabel: string,
    currentLlmCalls: number,
    maxLlmCalls: number,
  ): Promise<{ callsMade: number; fieldsFilled: number }> {
    const adapter = this.adapter;
    let callsMade = 0;
    let fieldsFilled = 0;

    const unfilled = scan.fields.filter(f =>
      !f.filled &&
      (!f.currentValue || f.currentValue.trim() === '') &&
      f.kind !== 'file' && f.kind !== 'upload_button'
    );

    // Dedup by normalized label — scanner may return duplicates for nested dropdown elements
    const attemptedLabels = new Set<string>();
    // Bail out to MagnitudeHand after consecutive failures
    const MAX_CONSECUTIVE_FAILURES = 3;
    let consecutiveFailures = 0;

    for (const field of unfilled) {
      if ((currentLlmCalls + callsMade) >= maxLlmCalls) break;

      // Too many consecutive failures → bail out, let MagnitudeHand handle the rest
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[Orchestrator] [${pageLabel}] Stagehand: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — handing off to MagnitudeHand`);
        break;
      }

      // Skip duplicate labels (e.g., "Country" appears 4x from nested dropdown elements)
      const normLabel = field.label.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normLabel && attemptedLabels.has(normLabel)) {
        field.filled = true; // mark so MagnitudeHand also skips it
        continue;
      }
      attemptedLabels.add(normLabel);

      const answer = field.matchedAnswer || findBestAnswer(field.label, qaMap);
      if (!answer && !field.isRequired) continue; // skip optional fields with no answer

      // Scroll field into view
      if (field.selector) {
        try {
          await adapter.page.evaluate(
            (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
            field.selector,
          );
          await adapter.page.waitForTimeout(300);
        } catch {}
      }

      // Build a focused single-field instruction
      const instruction = this.buildPerFieldPrompt(field, answer || undefined);
      console.log(`[Orchestrator] [${pageLabel}] Stagehand fill ${currentLlmCalls + callsMade + 1}/${maxLlmCalls}: "${field.label}" (${field.kind})${answer ? ` → "${answer}"` : ' → best judgment'}`);

      // Get value before
      let valueBefore = '';
      if (field.selector) {
        try {
          valueBefore = await adapter.page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return '';
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
            return el.textContent || '';
          }, field.selector) || '';
        } catch {}
      }

      try {
        const ok = await this.safeAct(instruction, pageLabel);
        callsMade++;

        if (!ok) {
          console.warn(`[Orchestrator] [${pageLabel}] Stagehand act() failed for "${field.label}"`);
          consecutiveFailures++;
          continue;
        }

        // Wait briefly for value to settle (dropdowns, async)
        await adapter.page.waitForTimeout(500);

        // Check if value changed
        let valueAfter = '';
        if (field.selector) {
          try {
            valueAfter = await adapter.page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (!el) return '';
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
              return el.textContent || '';
            }, field.selector) || '';
          } catch {}
        }

        if (valueAfter !== valueBefore && valueAfter.trim() !== '') {
          field.filled = true;
          fieldsFilled++;
          consecutiveFailures = 0; // reset on success
          console.log(`[Orchestrator] [${pageLabel}] Stagehand filled "${field.label}" ✓`);
        } else {
          consecutiveFailures++;
          console.log(`[Orchestrator] [${pageLabel}] Stagehand: no value change for "${field.label}" (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} failures)`);
        }
      } catch (err) {
        callsMade++;
        consecutiveFailures++;
        console.warn(`[Orchestrator] [${pageLabel}] Stagehand error on "${field.label}": ${err instanceof Error ? err.message : err}`);
      }

      await this.dismissOpenOverlays();
    }

    return { callsMade, fieldsFilled };
  }

  /**
   * Build a focused single-field instruction for Stagehand.
   */
  private buildPerFieldPrompt(field: ScannedField, answer?: string): string {
    const kindAction: Record<string, string> = {
      text: 'Type',
      select: 'Select',
      custom_dropdown: 'Select',
      radio: 'Select',
      aria_radio: 'Select',
      checkbox: 'Check',
      date: 'Type',
      contenteditable: 'Type',
    };

    const action = kindAction[field.kind] || 'Fill in';

    if (field.kind === 'custom_dropdown' || field.kind === 'select') {
      if (answer) {
        return `${action} "${answer}" from the "${field.label}" dropdown. Click the dropdown to open it, then find and click the option "${answer}". If it has a search input, type "${answer}" first, wait for matching options to appear, then click the match. Do NOT scroll the page.`;
      }
      const optionsHint = field.options?.length ? ` Available options: ${field.options.slice(0, 8).join(', ')}` : '';
      return `${action} the most reasonable option from the "${field.label}" dropdown.${optionsHint} Click the dropdown to open it, then click the best option. Do NOT scroll the page.`;
    }

    if (field.kind === 'radio' || field.kind === 'aria_radio') {
      if (answer) {
        return `Click the "${answer}" radio button for the "${field.label}" question. Do NOT scroll the page.`;
      }
      const optionsHint = field.options?.length ? ` Options: ${field.options.slice(0, 6).join(', ')}` : '';
      return `Select the most appropriate radio button for "${field.label}".${optionsHint} Do NOT scroll the page.`;
    }

    if (field.kind === 'checkbox') {
      return `Check the "${field.label}" checkbox. Do NOT scroll the page.`;
    }

    // Text, date, contenteditable
    if (answer) {
      return `Click on the "${field.label}" input field and type "${answer}". Make sure to clear any existing text first. Do NOT scroll the page.`;
    }
    return `Fill in the "${field.label}" input field with a reasonable value. Do NOT scroll the page.`;
  }

  /**
   * Batch viewport-walk LLM fill — used when Magnitude is the LLM adapter (handles its own decomposition).
   */
  private async llmFillPhaseBatch(
    scan: ScanResult,
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
    currentLlmCalls: number,
    maxLlmCalls: number,
  ): Promise<{ callsMade: number; fieldsFilled: number }> {
    const adapter = this.adapter;
    let callsMade = 0;
    let fieldsFilled = 0;

    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(400);

    const vpHeight = await adapter.page.evaluate(() => window.innerHeight);
    const totalHeight = await adapter.page.evaluate(() => document.documentElement.scrollHeight);
    const maxScrollPos = Math.max(0, totalHeight - vpHeight);
    let currentScrollPos = 0;
    const maxLLMScrollSteps = 10;
    let llmScrollSteps = 0;

    while (llmScrollSteps < maxLLMScrollSteps && (currentLlmCalls + callsMade) < maxLlmCalls) {
      const visibleFields = await this.scanVisibleUnfilledFields(qaMap);

      if (visibleFields.length > 0) {
        const groupContext = this.buildScanContextForLLM(visibleFields);
        const enrichedPrompt = `${fillPrompt}\n\nFIELDS VISIBLE IN CURRENT VIEWPORT (${visibleFields.length} field(s) detected by scan):\n${groupContext}\n\nFill the fields listed above. They are currently visible and empty. Use the expected values shown where provided.\n\nADDITIONALLY: If you see any other visible empty required fields on screen (marked with * or "required") that are NOT listed above, fill those too. Some custom dropdowns or non-standard UI components may not appear in the scan. For dropdowns that don't have a text input, click them to open, then select the correct option.\n\nCRITICAL: NEVER skip a [REQUIRED] field (marked with * or [REQUIRED]). If no exact data is available, use your best judgment to pick the most reasonable answer. For example, "Degree Status" → "Completed" or "Graduated", "Visa Status" → "Authorized to work", etc. Required fields MUST be filled.\n\nIMPORTANT — STUCK FIELD RULE: If you type a value into a dropdown/autocomplete field and NO matching options appear in the dropdown list, the value is NOT available. Do NOT retry the same field or retype the same value. Instead: select all text in the field, delete it to clear it, click somewhere else to close any popups, then move on to the next field. You get ONE attempt per field — if it doesn't match, clear it and move on.\n\nDROPDOWN NAVIGATION: For click-to-open dropdowns (not search/type fields) showing a long list of options where the option you need is not visible, you MAY press ArrowDown repeatedly to scroll through options within the dropdown, then press Enter or click to select. This scrolls within the dropdown only, not the page.\n\nDo NOT scroll the page or click Next.`;

        const perFieldBefore = await this.getPerFieldValues(visibleFields);
        const checkedBefore = await this.getCheckedCheckboxes();

        console.log(`[Orchestrator] [${pageLabel}] LLM call ${currentLlmCalls + callsMade + 1}/${maxLlmCalls} for ${visibleFields.length} visible field(s)`);
        let actSucceeded = false;
        try {
          actSucceeded = await this.safeAct(enrichedPrompt, pageLabel);
        } catch (actError) {
          console.warn(`[Orchestrator] [${pageLabel}] LLM act() failed: ${actError instanceof Error ? actError.message : actError}`);
        }
        callsMade++;

        await this.dismissOpenOverlays();
        await this.restoreUncheckedCheckboxes(checkedBefore);

        // Per-field comparison: only mark fields whose values actually changed
        const perFieldAfter = await this.getPerFieldValues(visibleFields);
        let anyChanged = false;
        for (let i = 0; i < visibleFields.length; i++) {
          const before = perFieldBefore[i] ?? '';
          const after = perFieldAfter[i] ?? '';
          if (after !== before && after.trim() !== '') {
            const match = scan.fields.find(sf => sf.selector === visibleFields[i].selector);
            if (match) {
              match.filled = true;
              fieldsFilled++;
            }
            anyChanged = true;
          }
        }
        if (anyChanged) {
          continue; // re-scan same viewport
        }

        // safeAct failed AND no DOM changes — stop retrying this viewport
        if (!actSucceeded) {
          break;
        }
      }

      if (currentScrollPos >= maxScrollPos) break;
      currentScrollPos = Math.min(currentScrollPos + Math.round(vpHeight * 0.7), maxScrollPos);
      await adapter.page.evaluate((y: number) => window.scrollTo(0, y), currentScrollPos);
      await adapter.page.waitForTimeout(400);
      llmScrollSteps++;
    }

    return { callsMade, fieldsFilled };
  }

  // ==========================================================================
  // Post-walk cleanup
  // ==========================================================================

  private async postWalkCleanup(
    postWalkUnfilled: ScannedField[],
    scan: ScanResult,
    config: PlatformConfig,
    qaMap: Record<string, string>,
    fillPrompt: string,
    pageLabel: string,
    llmCalls: number,
    maxLlmCalls: number,
  ): Promise<number> {
    const adapter = this.adapter;

    for (const field of postWalkUnfilled) {
      const answer = field.matchedAnswer || findBestAnswer(field.label, qaMap);
      if (!answer) continue;

      if (field.selector) {
        try {
          await adapter.page.evaluate(
            (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
            field.selector,
          );
          await adapter.page.waitForTimeout(300);
        } catch (err) {
          console.warn(`[Orchestrator] [${pageLabel}] Scroll to field failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      try {
        const ok = await config.fillScannedField(adapter, field, answer);
        if (ok) {
          field.filled = true;
          this.totalDomFilled++;
          console.log(`[Orchestrator] [${pageLabel}] Post-walk filled "${field.label}" (${field.kind})`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] [${pageLabel}] Post-walk DOM fill failed for "${field.label}": ${err}`);
      }
    }

    // Targeted LLM call(s) for remaining unfilled fields
    const stillUnfilled = postWalkUnfilled.filter(f => !f.filled);
    if (stillUnfilled.length === 0 || llmCalls >= maxLlmCalls) return 0;

    // Per-field mode for Stagehand
    if (this.llmAdapter !== this.adapter) {
      let cleanupCalls = 0;
      const maxCleanupCalls = Math.min(5, maxLlmCalls - llmCalls);
      for (const field of stillUnfilled) {
        if (cleanupCalls >= maxCleanupCalls) break;
        const answer = field.matchedAnswer || findBestAnswer(field.label, qaMap);
        if (!answer && !field.isRequired) continue;

        if (field.selector) {
          try {
            await adapter.page.evaluate(
              (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
              field.selector,
            );
            await adapter.page.waitForTimeout(300);
          } catch {}
        }

        const instruction = this.buildPerFieldPrompt(field, answer || undefined);
        console.log(`[Orchestrator] [${pageLabel}] Post-walk Stagehand: "${field.label}"`);
        try {
          const ok = await this.safeAct(instruction, pageLabel);
          cleanupCalls++;
          if (ok) {
            await adapter.page.waitForTimeout(500);
            // Check if value changed
            if (field.selector) {
              const val = await adapter.page.evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (!el) return '';
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
                return el.textContent || '';
              }, field.selector) || '';
              if (val.trim()) {
                field.filled = true;
                this.totalLlmFilled++;
                console.log(`[Orchestrator] [${pageLabel}] Post-walk Stagehand filled "${field.label}" ✓`);
              }
            }
          }
        } catch (err) {
          cleanupCalls++;
          console.warn(`[Orchestrator] [${pageLabel}] Post-walk Stagehand error: ${err instanceof Error ? err.message : err}`);
        }
        await this.dismissOpenOverlays();
      }
      return cleanupCalls;
    }

    // Batch mode for Magnitude fallback
    const target = stillUnfilled[0];
    if (target.selector) {
      try {
        await adapter.page.evaluate(
          (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
          target.selector,
        );
        await adapter.page.waitForTimeout(300);
      } catch (scrollErr) {
        console.warn(`[Orchestrator] [${pageLabel}] Scroll to field failed: ${scrollErr}`);
      }
    }

    const visibleFields = await this.scanVisibleUnfilledFields(qaMap);
    if (visibleFields.length > 0) {
      const groupContext = this.buildScanContextForLLM(visibleFields);
      const cleanupPrompt = `${fillPrompt}\n\nFIELDS VISIBLE IN CURRENT VIEWPORT (${visibleFields.length} field(s) detected by scan):\n${groupContext}\n\nFill the fields listed above. They are currently visible and empty. Use the expected values shown where provided.\n\nCRITICAL: NEVER skip a [REQUIRED] field (marked with * or [REQUIRED]). If no exact data is available, use your best judgment to pick the most reasonable answer.\n\nDo NOT scroll the page or click Next.`;

      console.log(`[Orchestrator] [${pageLabel}] Post-walk LLM cleanup for ${visibleFields.length} remaining field(s)`);
      try {
        const ok = await this.safeAct(cleanupPrompt, pageLabel);
        if (!ok) {
          console.warn(`[Orchestrator] [${pageLabel}] Post-walk LLM call reported failure`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] [${pageLabel}] Post-walk LLM call failed: ${err instanceof Error ? err.message : err}`);
      }
      return 1;
    }
    return 0;
  }

  // ==========================================================================
  // Phase 2.75: MagnitudeHand
  // ==========================================================================

  private async magnitudeHandPhase(
    scan: ScanResult,
    qaMap: Record<string, string>,
    dataPrompt: string,
    pageLabel: string,
  ): Promise<number> {
    const adapter = this.adapter;
    const costTracker = this.costTracker;

    const unfilled = scan.fields.filter(f =>
      !f.filled &&
      (!f.currentValue || f.currentValue.trim() === '') &&
      f.kind !== 'file' && f.kind !== 'upload_button'
    );

    if (unfilled.length === 0) return 0;

    // Budget gate
    const remaining = costTracker.getRemainingBudget();
    if (remaining < MAGNITUDE_HAND_MIN_REMAINING_BUDGET) {
      console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand: Budget too low ($${remaining.toFixed(4)}) — skipping.`);
      return 0;
    }

    const costBaseline = costTracker.getTaskBudget() - costTracker.getRemainingBudget();
    let fieldsFilled = 0;
    const fieldsToAttempt = unfilled.slice(0, MAGNITUDE_HAND_MAX_FIELDS);

    for (const field of fieldsToAttempt) {
      // Soft cap check
      const currentCost = costTracker.getTaskBudget() - costTracker.getRemainingBudget();
      const magnitudeSpent = currentCost - costBaseline;
      if (magnitudeSpent >= MAGNITUDE_HAND_BUDGET_CAP) {
        console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand: Soft cap reached ($${magnitudeSpent.toFixed(4)}) — stopping.`);
        break;
      }
      if (costTracker.getRemainingBudget() < MAGNITUDE_HAND_MIN_REMAINING_BUDGET) {
        console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand: Global budget exhausted — stopping.`);
        break;
      }

      // Scroll field into view
      if (field.selector) {
        try {
          await adapter.page.evaluate(
            (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
            field.selector,
          );
          await adapter.page.waitForTimeout(300);
        } catch (err) {
          console.warn(`[Orchestrator] [${pageLabel}] MagnitudeHand scroll to field failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      const answer = field.matchedAnswer || findBestAnswer(field.label, qaMap);
      const prompt = this.buildMagnitudeHandPrompt(field, answer || undefined, dataPrompt);
      console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand: Filling "${field.label}" (${field.kind})`);

      try {
        await this.throttleLlm();
        const result = await adapter.act(prompt, { timeoutMs: MAGNITUDE_HAND_ACT_TIMEOUT_MS });

        if (result.success) {
          field.filled = true;
          fieldsFilled++;
          console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand: Filled "${field.label}" OK (${result.durationMs}ms)`);
        } else {
          console.warn(`[Orchestrator] [${pageLabel}] MagnitudeHand: Failed "${field.label}": ${result.message}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Budget exceeded') || msg.includes('Action limit exceeded')) {
          console.warn(`[Orchestrator] [${pageLabel}] MagnitudeHand: Budget/action limit — stopping.`);
          throw err;
        }
        console.warn(`[Orchestrator] [${pageLabel}] MagnitudeHand: Error on "${field.label}": ${msg}`);
      }

      await this.dismissOpenOverlays();
    }

    console.log(`[Orchestrator] [${pageLabel}] MagnitudeHand: Filled ${fieldsFilled}/${fieldsToAttempt.length} field(s).`);
    return fieldsFilled;
  }

  // ==========================================================================
  // Phase 3: Advance Page
  // ==========================================================================

  private async advancePage(
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
    resumePath?: string | null,
    _depth = 0,
    llmCalls = 0,
    dataPrompt?: string,
  ): Promise<'navigated' | 'review' | 'complete'> {
    const adapter = this.adapter;
    const config = this.config;

    // Clean up scan attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-scan-idx]').forEach(el => el.removeAttribute('data-gh-scan-idx'));
    });

    // Scroll to bottom to find Next button
    await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await adapter.page.waitForTimeout(500);

    const urlBeforeClick = await adapter.getCurrentUrl();
    const fingerprintBeforeClick = await this.getPageFingerprint();
    const scrollBeforeClick = await adapter.page.evaluate(() => window.scrollY);

    const clickResult = await config.clickNextButton(adapter);
    if (clickResult === 'clicked') {
      console.log(`[Orchestrator] [${pageLabel}] Clicked Next via DOM.`);
      await adapter.page.waitForTimeout(2000);

      const hasErrors = await config.detectValidationErrors(adapter);
      if (hasErrors) {
        console.log(`[Orchestrator] [${pageLabel}] Validation errors after clicking Next — re-scanning.`);
        const scrollAfterError = await adapter.page.evaluate(() => window.scrollY);
        if (Math.abs(scrollAfterError - scrollBeforeClick) > 50) {
          console.log(`[Orchestrator] [${pageLabel}] Site auto-scrolled to errors. Re-running fill cycle.`);
          return this.fillPage(fillPrompt, qaMap, pageLabel, resumePath, _depth + 1, llmCalls, dataPrompt);
        }
        await adapter.page.evaluate(() => window.scrollTo(0, 0));
        await adapter.page.waitForTimeout(500);
        return this.fillPage(fillPrompt, qaMap, pageLabel, resumePath, _depth + 1, llmCalls, dataPrompt);
      }

      // Verify page changed
      const urlAfterClick = await adapter.getCurrentUrl();
      const fingerprintAfterClick = await this.getPageFingerprint();
      if (urlAfterClick !== urlBeforeClick || fingerprintAfterClick !== fingerprintBeforeClick) {
        await this.waitForPageSettled();
        return 'navigated';
      }

      // SPA delayed rendering
      await adapter.page.waitForTimeout(2000);
      const urlAfterWait = await adapter.getCurrentUrl();
      const fingerprintAfterWait = await this.getPageFingerprint();
      if (urlAfterWait !== urlBeforeClick || fingerprintAfterWait !== fingerprintBeforeClick) {
        await this.waitForPageSettled();
        return 'navigated';
      }

      // Auto-scrolled (validation errors without error markers)
      const scrollAfterClick = await adapter.page.evaluate(() => window.scrollY);
      if (Math.abs(scrollAfterClick - scrollBeforeClick) > 50) {
        console.log(`[Orchestrator] [${pageLabel}] Clicked Next — page auto-scrolled to unfilled fields. Re-filling.`);
        return this.fillPage(fillPrompt, qaMap, pageLabel, resumePath, _depth + 1, llmCalls, dataPrompt);
      }

      console.log(`[Orchestrator] [${pageLabel}] Clicked Next but page unchanged.`);
    }

    if (clickResult === 'review_detected') {
      console.log(`[Orchestrator] [${pageLabel}] Review page detected — not clicking Submit.`);
      return 'review';
    }

    if (clickResult === 'not_found') {
      const scrollMax = await this.getContentScrollMax();
      await adapter.page.evaluate((target: number) =>
        window.scrollTo({ top: target, behavior: 'smooth' }),
      scrollMax);
      await adapter.page.waitForTimeout(800);

      const finalClick = await config.clickNextButton(adapter);
      if (finalClick === 'clicked') {
        console.log(`[Orchestrator] [${pageLabel}] Clicked Next at content bottom.`);
        await adapter.page.waitForTimeout(2000);
        await this.waitForPageSettled();
        return 'navigated';
      }
      if (finalClick === 'review_detected') {
        console.log(`[Orchestrator] [${pageLabel}] Review page detected at content bottom.`);
        return 'review';
      }
    }

    // Fallback review detection
    const hasSubmitFallback = await adapter.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn'));
      return btns.some(b => {
        const text = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
        return text.includes('submit') || text === 'apply' || text === 'apply now' || text === 'send application';
      });
    });
    if (hasSubmitFallback) {
      console.log(`[Orchestrator] [${pageLabel}] Submit button present — treating as review.`);
      return 'review';
    }

    console.log(`[Orchestrator] [${pageLabel}] Page complete. LLM calls: ${llmCalls}`);
    return 'complete';
  }

  // ==========================================================================
  // Advance after custom handler (experience page)
  // ==========================================================================

  private async advanceAfterCustomHandler(pageLabel: string): Promise<'navigated' | 'review' | 'stuck'> {
    const adapter = this.adapter;
    const config = this.config;

    const urlBefore = await adapter.getCurrentUrl();
    const fpBefore = await this.getPageFingerprint();

    await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await adapter.page.waitForTimeout(500);

    let clickResult = await config.clickNextButton(adapter);
    console.log(`[Orchestrator] [${pageLabel}] After custom handler, clickNext: ${clickResult}`);

    if (clickResult === 'clicked') {
      await adapter.page.waitForTimeout(2000);

      const hasErrors = await config.detectValidationErrors(adapter);
      if (hasErrors) {
        console.log(`[Orchestrator] [${pageLabel}] Validation errors after clicking Next — re-detecting.`);
        return 'stuck';
      }

      const urlAfter = await adapter.getCurrentUrl();
      const fpAfter = await this.getPageFingerprint();
      if (urlAfter !== urlBefore || fpAfter !== fpBefore) {
        return 'navigated';
      }

      await adapter.page.waitForTimeout(2000);
      const urlAfterWait = await adapter.getCurrentUrl();
      const fpAfterWait = await this.getPageFingerprint();
      if (urlAfterWait !== urlBefore || fpAfterWait !== fpBefore) {
        return 'navigated';
      }
      console.log(`[Orchestrator] [${pageLabel}] Clicked Next but page unchanged.`);
    }

    if (clickResult === 'review_detected') return 'review';

    if (clickResult === 'not_found') {
      const scrollMax = await this.getContentScrollMax();
      await adapter.page.evaluate((target: number) =>
        window.scrollTo({ top: target, behavior: 'smooth' }), scrollMax);
      await adapter.page.waitForTimeout(800);

      const retryClick = await config.clickNextButton(adapter);
      if (retryClick === 'clicked') {
        await adapter.page.waitForTimeout(2000);
        return 'navigated';
      }
      if (retryClick === 'review_detected') return 'review';
      console.log(`[Orchestrator] [${pageLabel}] Next button not found even at bottom.`);
    }

    return 'stuck';
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private async waitForPageSettled(): Promise<void> {
    try {
      await this.adapter.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await this.adapter.page.waitForTimeout(PAGE_TRANSITION_WAIT_MS);
    } catch (err) {
      console.warn(`[Orchestrator] waitForPageSettled failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async dismissCookieBanner(): Promise<void> {
    try {
      const dismissed = await this.adapter.page.evaluate(() => {
        const selectors = [
          '#onetrust-accept-btn-handler',
          '#cookie-accept', '#accept-cookies',
          '#CookieAcceptAll', '#cookieAcceptAll',
          '#truste-consent-button',
          '#sp-cc-accept',
          '.cookie-accept-btn', '.accept-cookies-btn',
          '.cookie-consent-accept',
          '[data-testid="cookie-accept"]',
          '[data-action="accept-cookies"]',
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              el.click();
              return true;
            }
          }
        }

        const buttons = document.querySelectorAll('button, a[role="button"], [role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (
            text === 'accept' || text === 'accept all' || text === 'accept cookies' ||
            text === 'accept all cookies' || text === 'i accept' || text === 'got it' ||
            text === 'ok' || text === 'agree' || text === 'consent'
          ) {
            const style = window.getComputedStyle(btn);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                (btn as HTMLElement).click();
                return true;
              }
            }
          }
        }
        return false;
      });

      if (dismissed) {
        console.log('[Orchestrator] Dismissed cookie consent banner');
        await this.adapter.page.waitForTimeout(500);
      }
    } catch (err) {
      console.warn(`[Orchestrator] dismissCookieBanner failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async dismissOpenOverlays(): Promise<void> {
    try {
      await this.adapter.page.keyboard.press('Escape');
      await this.adapter.page.waitForTimeout(200);
      await this.adapter.page.evaluate(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement).blur?.();
        }
      });
      await this.adapter.page.waitForTimeout(300);
    } catch (err) {
      console.warn(`[Orchestrator] dismissOpenOverlays failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async getPageFingerprint(): Promise<string> {
    return this.adapter.page.evaluate(() => {
      const h = document.querySelector('h1, h2, h3');
      const heading = (h?.textContent || '').trim().substring(0, 60);
      const fields = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      let visibleFieldCount = 0;
      for (const f of fields) {
        const rect = f.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) visibleFieldCount++;
      }
      const activeSelectors = [
        '[aria-current="step"]', '[aria-current="true"]',
        '.active-step', '.current-step',
        'li.active', 'a.active',
        '[class*="activeSection"]', '[class*="currentSection"]',
      ];
      let activeText = '';
      for (const sel of activeSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          activeText = (el.textContent || '').trim().substring(0, 40);
          break;
        }
      }
      return `${heading}|fields:${visibleFieldCount}|active:${activeText}`;
    });
  }

  private async clickNextOnGooglePage(): Promise<void> {
    const nextClicked = await this.adapter.page.evaluate(() => {
      const buttons = document.querySelectorAll('button, div[role="button"]');
      for (const btn of buttons) {
        if (btn.textContent?.trim().toLowerCase().includes('next')) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!nextClicked) {
      await this.adapter.act('Click the "Next" button.');
    }
  }

  private async checkIfReviewPage(): Promise<boolean> {
    return this.adapter.page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
      const isReviewHeading = headings.some(h => (h.textContent || '').toLowerCase().includes('review'));
      if (!isReviewHeading) return false;
      const buttons = Array.from(document.querySelectorAll('button'));
      const SUBMIT_TEXTS = ['submit', 'submit application', 'submit my application', 'submit this application', 'send application'];
      const hasSubmit = buttons.some(b => {
        const text = (b.textContent?.trim().toLowerCase() || '');
        return SUBMIT_TEXTS.indexOf(text) !== -1 || text.startsWith('submit');
      });
      if (!hasSubmit) return false;
      const editableCount = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), ' +
        'input[type="email"]:not([readonly]):not([disabled]), ' +
        'input[type="tel"]:not([readonly]):not([disabled]), ' +
        'textarea:not([readonly]):not([disabled]), ' +
        'select:not([disabled]), ' +
        'input[type="radio"]:not([disabled]), ' +
        'input[type="checkbox"]:not([disabled])'
      ).length;
      return editableCount === 0;
    });
  }

  private async verifyReviewPage(): Promise<boolean> {
    const ReviewVerificationSchema = z.object({
      is_final_review: z.boolean(),
      reason: z.string(),
    });

    try {
      console.log('[Orchestrator] Verifying review page classification with LLM...');
      await this.throttleLlm();
      const result = await this.adapter.extract(
        `Look at this page carefully. I need to determine if this is the FINAL review/summary page of a job application, or if there are still more steps to complete.

A TRUE final review page:
- Shows a read-only summary of ALL your previously entered application data
- Has a "Submit" or "Submit Application" button as the final action
- Has NO more sections, steps, or pages left to fill out
- The application progress indicator (if any) shows you are at the last step

This is NOT the final review page if ANY of these are true:
- There are still more steps/sections visible in a sidebar, progress bar, or navigation that haven't been completed yet
- The page is asking you to make a choice (e.g. enable notifications, select preferences, agree to terms)
- There are form fields, radio buttons, toggles, checkboxes, or dropdowns that need interaction
- A progress indicator shows you are NOT at the final step
- The page has content to interact with beyond just reviewing submitted data

Set is_final_review to true ONLY if this is genuinely the last page before submission with nothing left to do except click Submit.`,
        ReviewVerificationSchema,
      );

      console.log(`[Orchestrator] Review verification: is_final_review=${result.is_final_review}, reason="${result.reason}"`);
      return result.is_final_review;
    } catch (error) {
      console.warn(`[Orchestrator] Review verification LLM call failed: ${error}`);
      return false;
    }
  }

  /**
   * Calls adapter.act() with health check and rate-limit throttling.
   *
   * Returns `true` if the action succeeded, `false` if:
   *   - the page appears broken (skips LLM call entirely)
   *   - adapter returned `{ success: false }` (element not found, field mismatch, etc.)
   *
   * Retries once on 429/rate-limit errors (30s backoff).
   * Re-throws all other exceptions (budget exceeded, action limit, browser crash).
   */
  /**
   * Execute an LLM action via the appropriate adapter.
   * @param useVisual - When true, forces the primary (Magnitude) adapter. Default false uses llmAdapter (Stagehand).
   */
  private async safeAct(prompt: string, label: string, useVisual = false): Promise<boolean> {
    const healthy = await this.isPageHealthy();
    if (!healthy) {
      console.warn(`[Orchestrator] [${label}] Page appears broken — skipping LLM call.`);
      return false;
    }

    await this.throttleLlm();

    const target = useVisual ? this.adapter : this.llmAdapter;

    try {
      const result = await target.act(prompt);
      if (!result.success) {
        console.warn(`[Orchestrator] [${label}] act() reported failure: ${result.message}`);
        return false;
      }
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Too Many Requests')) {
        console.warn(`[Orchestrator] [${label}] Rate limited (429) — waiting 30s before retry...`);
        await this.adapter.page.waitForTimeout(30_000);
        this.lastLlmCallTime = Date.now();
        const retryResult = await target.act(prompt);
        return retryResult.success;
      }
      throw error;
    }
  }

  private async throttleLlm(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastLlmCallTime;
    if (this.lastLlmCallTime > 0 && elapsed < MIN_LLM_GAP_MS) {
      const wait = MIN_LLM_GAP_MS - elapsed;
      console.log(`[Orchestrator] Rate limit throttle: waiting ${wait}ms...`);
      await this.adapter.page.waitForTimeout(wait);
    }
    this.lastLlmCallTime = Date.now();
  }

  private async isPageHealthy(): Promise<boolean> {
    return this.adapter.page.evaluate(() => {
      const viewportHeight = window.innerHeight;
      let visibleText = '';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewportHeight) continue;
        if (rect.width === 0 || rect.height === 0) continue;
        visibleText += node.textContent + ' ';
        if (visibleText.length > 5000) break;
      }

      if (visibleText.length < 200) return true;

      const codePatterns = [
        /\bfunction\s*\(/g, /\bconst\s+\w+/g, /\bvar\s+\w+/g, /\blet\s+\w+/g,
        /\bimport\s+/g, /\bexport\s+/g, /\brequire\s*\(/g, /\bmodule\.exports/g,
        /=>\s*\{/g, /\}\s*\)/g, /\bclass\s+\w+/g, /\bnew\s+\w+/g,
        /\btry\s*\{/g, /\bcatch\s*\(/g, /\bthrow\s+/g,
        /\bif\s*\(/g, /\belse\s*\{/g, /\breturn\s+/g,
        /\bwindow\./g, /\bdocument\./g, /\bconsole\./g,
        /[{};]\s*[{};]/g,
      ];

      let codeHits = 0;
      for (const pattern of codePatterns) {
        const matches = visibleText.match(pattern);
        if (matches) codeHits += matches.length;
      }

      const uiElements = document.querySelectorAll(
        'button, [role="button"], input:not([type="hidden"]), select, textarea, label, h1, h2, h3, h4, img'
      );
      let visibleUiCount = 0;
      for (const el of uiElements) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewportHeight) continue;
        if (rect.width > 0 && rect.height > 0) visibleUiCount++;
      }

      if (codeHits >= 15 && visibleUiCount < 3) return false;
      if (codeHits >= 10 && codeHits > visibleUiCount * 3) return false;

      return true;
    });
  }

  private async uploadResumeIfPresent(resumePath: string): Promise<boolean> {
    const hasFileInput = await this.adapter.page.evaluate(() => {
      return document.querySelectorAll('input[type="file"]').length > 0;
    });
    if (!hasFileInput) return false;

    try {
      const fileInput = this.adapter.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(resumePath);
      console.log('[Orchestrator] Resume uploaded via DOM file input');
      await this.adapter.page.waitForTimeout(2000);
      return true;
    } catch (err) {
      console.warn(`[Orchestrator] DOM resume upload failed: ${err}. LLM will try clicking upload button.`);
      return false;
    }
  }

  private async scanVisibleUnfilledFields(qaMap: Record<string, string>): Promise<ScannedField[]> {
    const visibleEmpty = await this.adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const results: Array<{ label: string; kind: string; selector: string; isRequired: boolean; options: string[] }> = [];

      const allInputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([disabled]):not([readonly]), ' +
        'textarea:not([disabled]):not([readonly]), select:not([disabled])'
      );
      for (const el of allInputs) {
        if (el.value && el.value.trim() !== '') continue;
        if (el.tagName === 'SELECT' && (el as HTMLSelectElement).selectedIndex > 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 5 || rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (el.closest('nav, header, [role="navigation"]')) continue;

        let label = '';
        const htmlEl = el as HTMLInputElement;
        if ('labels' in htmlEl && htmlEl.labels?.length) label = (htmlEl.labels[0].textContent || '').trim();
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label) label = el.getAttribute('placeholder') || '';
        if (!label && htmlEl.id) {
          const lbl = document.querySelector('label[for="' + CSS.escape(htmlEl.id) + '"]');
          if (lbl) label = (lbl.textContent || '').trim();
        }
        if (!label) {
          const parent = el.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(el)) label = (lbl.textContent || '').trim();
          }
        }
        if (!label) label = htmlEl.name || htmlEl.id || '';
        label = label.substring(0, 120);

        const kind = el.tagName === 'SELECT' ? 'select' : 'text';
        const selector = el.getAttribute('data-gh-scan-idx')
          ? '[data-gh-scan-idx="' + el.getAttribute('data-gh-scan-idx') + '"]'
          : (el.id ? '#' + CSS.escape(el.id) : '');
        const options = el.tagName === 'SELECT'
          ? Array.from((el as HTMLSelectElement).options).filter(o => o.value && !o.disabled).map(o => o.text.trim()).filter(Boolean)
          : [];

        results.push({ label, kind, selector, isRequired: htmlEl.required || el.getAttribute('aria-required') === 'true', options });
      }

      // Custom dropdowns and ARIA radios
      const customEls = document.querySelectorAll(
        '[role="combobox"], [role="listbox"], [aria-haspopup], [role="radiogroup"], [role="radio"]'
      );
      for (const el of customEls) {
        if (el.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5 || rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;

        const inputChild = el.querySelector('input') as HTMLInputElement | null;
        const hasValue = inputChild?.value?.trim();
        if (hasValue) continue;
        if (el.getAttribute('aria-checked') === 'true') continue;
        const role = el.getAttribute('role') || '';
        if (role === 'radiogroup') {
          const checked = el.querySelector('[role="radio"][aria-checked="true"]');
          if (checked) continue;
        }

        let label = '';
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const lbl = document.getElementById(labelledBy);
          if (lbl) label = (lbl.textContent || '').trim();
        }
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label) {
          const parent = el.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(el)) label = (lbl.textContent || '').trim();
          }
        }
        label = label.substring(0, 120);
        if (!label) continue;

        const isRadio = role === 'radiogroup' || role === 'radio';
        const kind = isRadio ? 'aria_radio' : 'custom_dropdown';
        const selector = el.getAttribute('data-gh-scan-idx')
          ? '[data-gh-scan-idx="' + el.getAttribute('data-gh-scan-idx') + '"]'
          : (el.id ? '#' + CSS.escape(el.id) : '');

        const options: string[] = [];
        if (isRadio) {
          const radios = (role === 'radiogroup' ? el : el.parentElement)?.querySelectorAll('[role="radio"]');
          if (radios) {
            for (const r of radios) {
              const t = r.getAttribute('aria-label') || (r.textContent || '').trim();
              if (t) options.push(t);
            }
          }
        }

        results.push({ label, kind, selector, isRequired: el.getAttribute('aria-required') === 'true', options });
      }

      // Material Design styled selects
      const seenLabels = new Set(results.map(r => r.label.toLowerCase()));
      const arrowEls: Element[] = [];
      document.querySelectorAll('i, span').forEach(ael => {
        const t = (ael.textContent || '').trim();
        if (t === 'arrow_drop_down' || t === 'expand_more' || t === 'keyboard_arrow_down') {
          arrowEls.push(ael);
        }
      });
      for (const arrowEl of arrowEls) {
        let container: Element | null = arrowEl.parentElement;
        for (let up = 0; up < 5 && container; up++) {
          const cRect = container.getBoundingClientRect();
          if (cRect.width >= 80 && cRect.width <= 700 && cRect.height >= 20 && cRect.height <= 120) break;
          container = container.parentElement;
        }
        if (!container || container === document.body) continue;
        const cRect = container.getBoundingClientRect();
        if (cRect.width < 5 || cRect.height < 5 || cRect.bottom < 0 || cRect.top > vh) continue;
        const cSt = window.getComputedStyle(container);
        if (cSt.display === 'none' || cSt.visibility === 'hidden') continue;
        if (container.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"]')) continue;

        const mdInput = container.querySelector('input') as HTMLInputElement | null;
        if (mdInput?.value?.trim()) continue;

        let mdLabel = container.getAttribute('aria-label') || '';
        if (!mdLabel) {
          const lblBy = container.getAttribute('aria-labelledby');
          if (lblBy) {
            const lblEl = document.getElementById(lblBy);
            if (lblEl) mdLabel = (lblEl.textContent || '').trim();
          }
        }
        if (!mdLabel) {
          const parent = container.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(container)) mdLabel = (lbl.textContent || '').trim();
          }
        }
        if (!mdLabel) {
          const prev = container.previousElementSibling;
          if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
            const t = (prev.textContent || '').trim();
            if (t.length < 80) mdLabel = t;
          }
        }
        mdLabel = mdLabel.substring(0, 120);
        if (!mdLabel) continue;
        if (seenLabels.has(mdLabel.toLowerCase())) continue;
        seenLabels.add(mdLabel.toLowerCase());

        const mdSelector = container.getAttribute('data-gh-scan-idx')
          ? '[data-gh-scan-idx="' + container.getAttribute('data-gh-scan-idx') + '"]'
          : (container.id ? '#' + CSS.escape(container.id) : '');

        results.push({
          label: mdLabel,
          kind: 'custom_dropdown',
          selector: mdSelector,
          isRequired: container.getAttribute('aria-required') === 'true' || (container.closest('[class*="required"]') !== null),
          options: [],
        });
      }

      return results;
    });

    // Deduplicate and match answers
    if (!Array.isArray(visibleEmpty)) return [];
    const seen = new Set<string>();
    const fields: ScannedField[] = [];
    for (const raw of visibleEmpty) {
      const key = raw.label + '|' + raw.kind;
      if (seen.has(key)) continue;
      seen.add(key);

      const answer = findBestAnswer(raw.label, qaMap);
      fields.push({
        id: 'visible-' + fields.length,
        kind: raw.kind as ScannedField['kind'],
        fillStrategy: raw.kind === 'text' || raw.kind === 'select' ? 'native_setter' : 'click_option',
        selector: raw.selector,
        label: raw.label,
        currentValue: '',
        options: raw.options.length > 0 ? raw.options : undefined,
        absoluteY: 0,
        isRequired: raw.isRequired,
        matchedAnswer: answer || undefined,
        filled: false,
      });
    }

    return fields;
  }

  private buildScanContextForLLM(fields: ScannedField[]): string {
    return fields.map(f => {
      const kindLabel: Record<string, string> = {
        text: 'Text input', select: 'Dropdown', custom_dropdown: 'Dropdown',
        radio: 'Radio buttons', aria_radio: 'Radio buttons', checkbox: 'Checkbox',
        date: 'Date input', file: 'File upload', contenteditable: 'Rich text editor',
        upload_button: 'Upload button', unknown: 'Unknown field',
      };
      const kind = kindLabel[f.kind] || f.kind;
      const required = f.isRequired ? ' [REQUIRED]' : '';
      const options = f.options && f.options.length > 0
        ? ` Options: [${f.options.slice(0, 10).join(', ')}${f.options.length > 10 ? ', ...' : ''}]`
        : '';
      const expectedValue = f.matchedAnswer
        ? ` → Fill with: "${f.matchedAnswer}"`
        : f.isRequired
          ? ' → No exact data available — use your best judgment to pick a reasonable answer that benefits the applicant'
          : '';
      return `- "${f.label}" (${kind})${options}${expectedValue}${required}`;
    }).join('\n');
  }

  private buildMagnitudeHandPrompt(
    field: ScannedField,
    answer: string | undefined,
    dataPrompt: string,
  ): string {
    const kindHints: Record<string, string> = {
      custom_dropdown: 'This is a custom dropdown. Click it to open, find the correct option, and select it. If it has a search/autocomplete input, type the value first, wait for options to appear, then click the match.',
      select: 'This is a dropdown menu. Click to open it, then select the correct option.',
      contenteditable: 'This is a rich text editor. Click into it and type the value.',
      aria_radio: 'This is a radio button group. Click the correct option.',
      radio: 'This is a radio button group. Click the correct option.',
      checkbox: 'This is a checkbox. Click it if it should be checked.',
      date: 'This is a date field. Enter the date in the format shown.',
      text: 'This is a text input field. Click into it and type the value.',
      unknown: 'Interact with this form control appropriately.',
    };

    const fieldHint = kindHints[field.kind] || kindHints['unknown'];
    const optionsList = field.options && field.options.length > 0
      ? `\nAvailable options: [${field.options.slice(0, 20).join(', ')}${field.options.length > 20 ? ', ...' : ''}]`
      : '';

    const valueInstruction = answer
      ? `Fill it with: "${answer}"`
      : `Use your best judgment based on the applicant data below to pick the most reasonable value.`;

    return `You are filling out a job application form. Focus ONLY on the single field described below. Do NOT interact with any other fields, buttons, or navigation elements.

FIELD: "${field.label}"${field.isRequired ? ' [REQUIRED]' : ''}
TYPE: ${field.kind}${optionsList}
INSTRUCTION: ${valueInstruction}

${fieldHint}

RULES:
- Fill ONLY this one field, then stop immediately.
- Do NOT scroll the page or click Next/Submit.
- Do NOT interact with any other fields.
- If a dropdown has no matching option, select the closest reasonable match.
- ONE attempt only — do not retry if it doesn't work.

APPLICANT DATA:
${dataPrompt}`;
  }

  /**
   * Returns the current value for each field by selector, in order.
   * Used for per-field before/after comparison in llmFillPhase.
   * Handles native inputs (.value), custom dropdowns (inner input or selected text),
   * and aria radio groups (aria-checked radio text).
   */
  private async getPerFieldValues(fields: { selector: string; kind?: string }[]): Promise<string[]> {
    const fieldInfo = fields.map(f => ({ selector: f.selector, kind: f.kind || 'text' }));
    return this.adapter.page.evaluate((info: { selector: string; kind: string }[]) => {
      return info.map(({ selector, kind }) => {
        if (!selector) return '';
        let el: Element | null;
        try {
          el = document.querySelector(selector);
        } catch {
          return '';
        }
        if (!el) return '';

        // Native inputs: read .value
        if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
          return (el as HTMLInputElement).value ?? '';
        }

        // Custom dropdown: check inner input, then selected option text
        if (kind === 'custom_dropdown') {
          const inner = el.querySelector('input') as HTMLInputElement | null;
          if (inner?.value?.trim()) return inner.value;
          const selected = el.querySelector('[aria-selected="true"], [data-selected="true"], .selected');
          if (selected) return (selected.textContent || '').trim();
          return (el.textContent || '').trim().substring(0, 100);
        }

        // Aria radio: return checked radio's text
        if (kind === 'aria_radio') {
          const checked = el.querySelector('[role="radio"][aria-checked="true"]');
          if (checked) return (checked.getAttribute('aria-label') || checked.textContent || '').trim();
          if (el.getAttribute('aria-checked') === 'true') {
            return (el.getAttribute('aria-label') || el.textContent || '').trim();
          }
          return '';
        }

        // Fallback: try .value then textContent
        if ('value' in el) return (el as HTMLInputElement).value ?? '';
        return '';
      });
    }, fieldInfo);
  }

  private async getCheckedCheckboxes(): Promise<number[]> {
    return this.adapter.page.evaluate(() => {
      const indices: number[] = [];
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      for (let i = 0; i < cbs.length; i++) {
        if ((cbs[i] as HTMLInputElement).checked) indices.push(i);
      }
      return indices;
    });
  }

  private async restoreUncheckedCheckboxes(previouslyChecked: number[]): Promise<void> {
    if (previouslyChecked.length === 0) return;
    const restored = await this.adapter.page.evaluate((indices) => {
      let count = 0;
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      for (let i = 0; i < indices.length; i++) {
        const cb = cbs[indices[i]] as HTMLInputElement | undefined;
        if (cb && !cb.checked) {
          cb.click();
          count++;
        }
      }
      return count;
    }, previouslyChecked);
    if (restored > 0) {
      console.log(`[Orchestrator] Restored ${restored} checkbox(es) the LLM accidentally unchecked.`);
    }
  }

  private async getContentScrollMax(): Promise<number> {
    return this.adapter.page.evaluate(() => {
      const elements = document.querySelectorAll(
        'button, [role="button"], input, select, textarea, a[href], label, h1, h2, h3, h4, p, li, td, th, img, [role="listbox"], [role="combobox"]'
      );
      let maxBottom = 0;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const bottom = rect.bottom + window.scrollY;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      const contentLimit = maxBottom > 0
        ? Math.min(maxBottom + 150, document.documentElement.scrollHeight)
        : document.documentElement.scrollHeight;
      return Math.max(0, contentLimit - window.innerHeight);
    });
  }

  // ==========================================================================
  // Result builder
  // ==========================================================================

  private buildResult(
    success: boolean,
    pagesProcessed: number,
    awaitingUserReview: boolean,
    finalPage: string,
  ): OrchestratorResult {
    return {
      success,
      pagesProcessed,
      domFilled: this.totalDomFilled,
      llmFilled: this.totalLlmFilled,
      magnitudeFilled: this.totalMagnitudeFilled,
      totalFields: this.totalFieldsSeen,
      awaitingUserReview,
      keepBrowserOpen: awaitingUserReview,
      finalPage,
      platform: this.config.platformId,
    };
  }
}
