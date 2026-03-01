import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PlatformConfig, PageState, PageType, ScannedField, ScanResult } from './platforms/types.js';
import type { CostTracker } from '../costControl.js';
import { detectPlatformFromUrl } from './platforms/index.js';
import { findBestAnswer } from './platforms/genericConfig.js';
import { ProgressStep } from '../progressTracker.js';
import { fillFormOnPage, buildProfileText } from './formFiller.js';
import type { WorkdayUserProfile } from './workday/workdayTypes.js';

// --- Constants ---

const PAGE_TRANSITION_WAIT_MS = 3_000;
const MAX_FORM_PAGES = 15;
const MIN_LLM_GAP_MS = 5_000; // Minimum gap between LLM calls to stay under rate limits

// MagnitudeHand (Phase 2.75) — last-resort general GUI agent fallback
const MAGNITUDE_HAND_BUDGET_CAP = 0.50;       // Max $ to spend in MagnitudeHand per page
const MAGNITUDE_HAND_MAX_FIELDS = 15;          // Max fields to attempt per pass
const MAGNITUDE_HAND_ACT_TIMEOUT_MS = 30_000;  // Timeout per individual act() call
const MAGNITUDE_HAND_MIN_REMAINING_BUDGET = 0.02; // Skip if less than this remains

// --- Handler ---

export class SmartApplyHandler implements TaskHandler {
  readonly type = 'smart_apply';
  readonly description = 'Fill out a job application on any ATS platform (multi-step), stopping before submission';
  private lastLlmCallTime = 0;
  /** True after we've attempted native login — prevents re-trying login on Create Account pages */
  loginAttempted = false;
  /** True after clicking Apply — prevents SPA re-detection as job_listing */
  private applyClicked = false;

  validate(inputData: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const userData = inputData.user_data;

    if (!userData) {
      errors.push('user_data is required');
    } else {
      if (!userData.first_name) errors.push('user_data.first_name is required');
      if (!userData.last_name) errors.push('user_data.last_name is required');
      if (!userData.email) errors.push('user_data.email is required');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress } = ctx;
    const userProfile = job.input_data.user_data as Record<string, any>;
    const qaOverrides = job.input_data.qa_overrides || {};

    // Resolve platform config from URL
    const config = detectPlatformFromUrl(job.target_url);
    console.log(`[SmartApply] Platform: ${config.displayName} (${config.platformId})`);
    console.log(`[SmartApply] Starting application for ${job.target_url}`);
    console.log(`[SmartApply] Applicant: ${userProfile.first_name} ${userProfile.last_name}`);

    // Build data prompt, QA map, and profile text for formFiller
    const dataPrompt = config.buildDataPrompt(userProfile, qaOverrides);
    const qaMap = config.buildQAMap(userProfile, qaOverrides);
    const profileText = buildProfileText(userProfile as WorkdayUserProfile);

    // Resolve resume file path (if provided)
    let resumePath: string | null = null;
    if (userProfile.resume_path) {
      const resolved = path.isAbsolute(userProfile.resume_path)
        ? userProfile.resume_path
        : path.resolve(process.cwd(), userProfile.resume_path);
      if (fs.existsSync(resolved)) {
        resumePath = resolved;
        console.log(`[SmartApply] Resume found: ${resumePath}`);
      } else {
        console.warn(`[SmartApply] Resume not found at ${resolved} — skipping upload.`);
      }
    }

    // Auto-attach resume to any file dialog the LLM or DOM triggers
    if (resumePath) {
      const rp = resumePath;
      adapter.page.on('filechooser', async (chooser) => {
        console.log(`[SmartApply] File chooser opened — attaching resume: ${rp}`);
        await chooser.setFiles(rp);
      });
    }

    let pagesProcessed = 0;
    let lastPageSignature = '';
    let samePageCount = 0;
    const MAX_SAME_PAGE = 3; // bail if stuck on same page this many times

    try {
      // Main detect-and-act loop
      while (pagesProcessed < MAX_FORM_PAGES) {
        pagesProcessed++;

        await this.waitForPageLoad(adapter);

        // Dismiss cookie consent banners (common on many job sites)
        await this.dismissCookieBanner(adapter);

        // Detect current page type
        const pageState = await this.detectPage(adapter, config);
        const currentPageUrl = await adapter.getCurrentUrl();
        console.log(`[SmartApply] Page ${pagesProcessed}: ${pageState.page_type} (title: ${pageState.page_title || 'N/A'})`);

        // Stuck detection: compare URL + visible content fingerprint.
        // On SPAs (like Amazon.jobs), the URL stays constant across sections,
        // so we also check headings, field count, and active sidebar item.
        const contentFingerprint = await this.getPageFingerprint(adapter);
        const pageSignature = `${currentPageUrl}|${contentFingerprint}`;
        if (pageSignature === lastPageSignature) {
          samePageCount++;
          if (samePageCount >= MAX_SAME_PAGE) {
            console.warn(`[SmartApply] Stuck on same page for ${samePageCount} iterations (signature: ${contentFingerprint}) — stopping.`);
            await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            return {
              success: true,
              keepBrowserOpen: true,
              awaitingUserReview: true,
              data: {
                platform: config.platformId,
                pages_processed: pagesProcessed,
                final_page: 'stuck',
                message: `Application appears stuck on the same page. Browser open for manual takeover.`,
              },
            };
          }
        } else {
          samePageCount = 0;
          lastPageSignature = pageSignature;
        }

        // SPA guard: after clicking Apply on SPAs (Greenhouse), the URL doesn't
        // change and the form page may still have Apply-like buttons — override to questions
        if (pageState.page_type === 'job_listing' && this.applyClicked) {
          console.log(`[SmartApply] SPA guard: already clicked Apply — treating as questions page`);
          pageState.page_type = 'questions' as any;
          pageState.page_title = 'Form Page (SPA)';
        }

        // Handle based on page type
        switch (pageState.page_type) {
          case 'job_listing':
            await this.handleJobListing(adapter);
            this.applyClicked = true;
            break;

          case 'login':
          case 'google_signin':
            if (config.handleLogin) {
              await config.handleLogin(adapter, userProfile);
            } else {
              await this.handleGenericLogin(adapter, userProfile);
            }
            // Track that login was attempted so detectObviousPage doesn't
            // re-classify a Create Account page as login.
            this.loginAttempted = true;
            break;

          case 'verification_code':
            await this.handleVerificationCode(adapter);
            break;

          case 'phone_2fa':
            await this.handlePhone2FA(adapter);
            break;

          case 'account_creation':
            // If we haven't tried login yet, try it first — many sites (e.g. Workday)
            // show the Create Account page by default with an "Already have an account? Sign In" link.
            // The login handler already knows how to click "Sign In" and try credentials.
            if (!this.loginAttempted) {
              console.log('[SmartApply] Account creation page detected but login not yet attempted — trying login first.');
              if (config.handleLogin) {
                await config.handleLogin(adapter, userProfile);
              } else {
                await this.handleGenericLogin(adapter, userProfile);
              }
              this.loginAttempted = true;
              // Don't call handleAccountCreation here — let the main loop re-detect the page.
              // If login succeeded, we'll land on the application form.
              // If login failed, the login handler navigates to Create Account,
              // and the next iteration will classify it as account_creation with loginAttempted=true.
              break;
            }
            await this.handleAccountCreation(adapter, dataPrompt, userProfile);
            break;

          case 'review':
            // We've reached the review page — STOP HERE
            await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            console.log('\n' + '='.repeat(70));
            console.log('[SmartApply] APPLICATION FILLED SUCCESSFULLY');
            console.log('[SmartApply] Stopped at REVIEW page — NOT submitting.');
            console.log('[SmartApply] The browser is open for you to review and submit manually.');
            console.log('[SmartApply] DO NOT close this terminal until you are done.');
            console.log('='.repeat(70) + '\n');

            return {
              success: true,
              keepBrowserOpen: true,
              awaitingUserReview: true,
              data: {
                platform: config.platformId,
                pages_processed: pagesProcessed,
                final_page: 'review',
                message: 'Application filled. Waiting for user to review and submit.',
              },
            };

          case 'confirmation':
            console.warn('[SmartApply] Unexpected: landed on confirmation page');
            return {
              success: true,
              data: {
                platform: config.platformId,
                pages_processed: pagesProcessed,
                final_page: 'confirmation',
                message: 'Application appears to have been submitted (unexpected).',
              },
            };

          case 'error':
            return {
              success: false,
              error: `Application error page: ${pageState.error_message || 'Unknown error'}`,
              data: { platform: config.platformId, pages_processed: pagesProcessed },
            };

          default: {
            // ALL form pages — personal_info, experience, resume_upload, questions, etc.
            if (
              (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload') &&
              config.needsCustomExperienceHandler && config.handleExperiencePage
            ) {
              await progress.setStep(ProgressStep.UPLOADING_RESUME);
              await config.handleExperiencePage(adapter, userProfile, dataPrompt);

              // Robust navigation after custom handler — mirrors fillPage()'s post-click logic
              const urlBeforeExp = await adapter.getCurrentUrl();
              const fpBeforeExp = await this.getPageFingerprint(adapter);

              // Scroll to bottom to ensure Next button is visible
              await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
              await adapter.page.waitForTimeout(500);

              let expClickResult = await config.clickNextButton(adapter);
              console.log(`[SmartApply] [experience] After custom handler, clickNext: ${expClickResult}`);

              if (expClickResult === 'clicked') {
                await adapter.page.waitForTimeout(2000);

                // Check for validation errors
                const hasErrors = await config.detectValidationErrors(adapter);
                if (hasErrors) {
                  console.log(`[SmartApply] [experience] Validation errors after clicking Next — re-detecting page for recovery.`);
                  // Don't break — let the main loop re-detect the page.
                  // handleExperiencePage is idempotent (resume/skills already done, LLM sees filled fields).
                } else {
                  // Verify page actually changed
                  const urlAfterExp = await adapter.getCurrentUrl();
                  const fpAfterExp = await this.getPageFingerprint(adapter);
                  if (urlAfterExp !== urlBeforeExp || fpAfterExp !== fpBeforeExp) {
                    await this.waitForPageLoad(adapter);
                    break;
                  }
                  // SPA delayed render — wait and check again
                  await adapter.page.waitForTimeout(2000);
                  const urlAfterWait = await adapter.getCurrentUrl();
                  const fpAfterWait = await this.getPageFingerprint(adapter);
                  if (urlAfterWait !== urlBeforeExp || fpAfterWait !== fpBeforeExp) {
                    await this.waitForPageLoad(adapter);
                    break;
                  }
                  console.log(`[SmartApply] [experience] Clicked Next but page unchanged — re-detecting.`);
                }
              }

              if (expClickResult === 'review_detected') {
                console.log(`[SmartApply] [experience] Review page detected.`);
                break; // Main loop will re-detect as 'review' page type
              }

              if (expClickResult === 'not_found') {
                // Scroll to content bottom and retry
                const scrollMax = await this.getContentScrollMax(adapter);
                await adapter.page.evaluate((target: number) =>
                  window.scrollTo({ top: target, behavior: 'smooth' }),
                scrollMax);
                await adapter.page.waitForTimeout(800);

                const retryClick = await config.clickNextButton(adapter);
                if (retryClick === 'clicked') {
                  await adapter.page.waitForTimeout(2000);
                  await this.waitForPageLoad(adapter);
                  break;
                }
                if (retryClick === 'review_detected') {
                  console.log(`[SmartApply] [experience] Review page detected at bottom.`);
                  break;
                }
                console.log(`[SmartApply] [experience] Next button not found even at bottom — re-detecting.`);
              }
              // Fall-through: re-detect page for recovery
              break;
            }

            const step = (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload')
              ? ProgressStep.UPLOADING_RESUME
              : ProgressStep.FILLING_FORM;
            await progress.setStep(step as any);

            const result = await this.fillPage(adapter, config, resumePath, profileText);

            if (result === 'review') {
              // fillPage detected this is actually the review page
              console.log(`[SmartApply] Review page reached via fillPage — stopping.`);
              await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
              console.log('\n' + '='.repeat(70));
              console.log('[SmartApply] Stopped at REVIEW page — NOT submitting.');
              console.log('[SmartApply] The browser is open for you to review and submit manually.');
              console.log('[SmartApply] DO NOT close this terminal until you are done.');
              console.log('='.repeat(70) + '\n');

              return {
                success: true,
                keepBrowserOpen: true,
                awaitingUserReview: true,
                data: {
                  platform: config.platformId,
                  pages_processed: pagesProcessed,
                  final_page: 'review',
                  message: 'Application filled. Waiting for user to review and submit.',
                },
              };
            }
            // 'navigated' and 'complete' both continue the main loop
            break;
          }
        }
      }

      // Safety: hit max pages without reaching review
      console.warn(`[SmartApply] Reached max page limit (${MAX_FORM_PAGES}) without finding review page`);
      await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
      console.log('\n' + '='.repeat(70));
      console.log('[SmartApply] Reached page limit. Browser is open for manual takeover.');
      console.log('[SmartApply] DO NOT close this terminal until you are done.');
      console.log('='.repeat(70) + '\n');

      return {
        success: true,
        keepBrowserOpen: true,
        awaitingUserReview: true,
        data: {
          platform: config.platformId,
          pages_processed: pagesProcessed,
          final_page: 'max_pages_reached',
          message: `Processed ${pagesProcessed} pages. Browser open for manual review.`,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[SmartApply] Error on page ${pagesProcessed}: ${msg}`);

      // If we fail mid-application, keep browser open so user can recover
      if (pagesProcessed > 2) {
        console.log('[SmartApply] Keeping browser open for manual recovery.');
        return {
          success: false,
          keepBrowserOpen: true,
          error: msg,
          data: { platform: config.platformId, pages_processed: pagesProcessed },
        };
      }

      return {
        success: false,
        error: msg,
        data: { platform: config.platformId, pages_processed: pagesProcessed },
      };
    }
  }

  // =========================================================================
  // Page Detection — 4-tier delegation
  // =========================================================================

  private async detectPage(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
  ): Promise<PageState> {
    const currentUrl = await adapter.getCurrentUrl();

    // Tier 1: URL-based (fast, no LLM cost) — only catches dead-obvious patterns
    const urlResult = config.detectPageByUrl(currentUrl);
    if (urlResult) return urlResult;

    // Tier 2: Minimal DOM checks — ONLY for things the LLM can't see (or to save cost on obvious pages)
    const obviousResult = await this.detectObviousPage(adapter, currentUrl);
    if (obviousResult) return obviousResult;

    // Tier 2.5: Platform-specific DOM detection — catches form pages, login, review, etc.
    // without needing an LLM call. genericConfig.detectPageByDOM checks input counts,
    // review signals, apply buttons, etc.
    const domResult = await config.detectPageByDOM(adapter);
    if (domResult) {
      console.log(`[SmartApply] DOM detection classified page as: ${domResult.page_type}`);
      return domResult;
    }

    // Tier 3: LLM classification — the LLM sees the screenshot and decides
    try {
      const healthy = await this.isPageHealthy(adapter);
      if (!healthy) {
        console.warn('[SmartApply] Page appears broken (raw JS/code visible) — using DOM fallback.');
        const fallbackType = await config.classifyByDOMFallback(adapter);
        return { page_type: fallbackType, page_title: 'broken_page' };
      }

      // Build URL hints so the LLM has context about where we are
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
      await this.throttleLlm(adapter);
      const llmResult = await adapter.extract(classificationPrompt, config.pageStateSchema);
      console.log(`[SmartApply] LLM classified page as: ${llmResult.page_type}`);

      // SAFETY: If LLM says "account_creation" but the page has many form fields
      // beyond email/password (name, phone, address, etc.), it's a regular form page.
      // Amazon.jobs Contact Information on account.amazon.jobs triggers this false positive.
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

        // Real account creation forms have at most ~4 fields (email, password, confirm, name).
        // If there are 5+ form fields, this is a regular application form page.
        if (formFieldCount >= 5) {
          console.log(`[SmartApply] LLM said "account_creation" but page has ${formFieldCount} form fields — overriding to "questions"`);
          return { ...llmResult, page_type: 'questions' as PageType };
        }
      }

      // SAFETY: If LLM says "review", double-check — many single-page forms
      // show a Submit button on every page, which fools the classification.
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
          console.log('[SmartApply] LLM said "review" but page has editable fields — overriding to "questions"');
          return { ...llmResult, page_type: 'questions' as PageType };
        }

        const isReallyReview = await this.verifyReviewPage(adapter);
        if (!isReallyReview) {
          console.log('[SmartApply] Review verification failed — overriding to "questions"');
          return { ...llmResult, page_type: 'questions' as PageType };
        }
      }

      return llmResult;
    } catch (error) {
      console.warn(`[SmartApply] LLM page detection failed: ${error}`);

      // Tier 4: DOM fallback
      const fallbackType = await config.classifyByDOMFallback(adapter);
      if (fallbackType !== 'unknown') {
        console.log(`[SmartApply] DOM fallback classified page as: ${fallbackType}`);
      }
      return { page_type: fallbackType, page_title: fallbackType === 'unknown' ? 'N/A' : fallbackType };
    }
  }

  /**
   * Detect only dead-obvious pages that don't need LLM classification.
   * Keeps costs down for pages like Google Sign-In, confirmation, etc.
   */
  private async detectObviousPage(
    adapter: BrowserAutomationAdapter,
    currentUrl: string,
  ): Promise<PageState | null> {
    // Google Sign-In — URL is unmistakable
    if (currentUrl.includes('accounts.google.com')) {
      return { page_type: 'google_signin', page_title: 'Google Sign-In', has_sign_in_with_google: true };
    }

    // Quick DOM check for login (password field) and confirmation (thank you text)
    const obvious = await adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const hasPasswordField = passwordFields.length > 0;
      // 2+ password fields (password + confirm) = account creation, not login
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
      // Count form fields — pages with many inputs are application forms, not login
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

    // Account creation (confirm password or "Create Account" heading) — let
    // platform-specific detectPageByDOM handle the nuance instead of
    // misclassifying as login here.
    // Also: after login has been attempted and failed, the page may still have
    // password fields (Create Account form). Don't re-classify as login — let
    // detectPageByDOM decide if it's account_creation.
    // Also: if the page has 5+ form fields, it's an application form that happens
    // to have a password field somewhere (e.g. security question) — not a login page.
    if (obvious.hasPasswordField && !obvious.hasConfirmPassword && !obvious.isCreateAccountHeading
        && !this.loginAttempted && obvious.formFieldCount < 5) {
      return { page_type: 'login', page_title: 'Sign-In' };
    }

    // Everything else → let the LLM decide
    return null;
  }

  // =========================================================================
  // Universal Page Handlers
  // =========================================================================

  private async handleJobListing(adapter: BrowserAutomationAdapter): Promise<void> {
    console.log('[SmartApply] On job listing page, clicking Apply...');

    // Remove target="_blank" from Apply links so navigation stays in the same tab
    await adapter.page.evaluate(() => {
      document.querySelectorAll('a[target="_blank"]').forEach(a => {
        a.removeAttribute('target');
      });
    });

    const urlBefore = await adapter.getCurrentUrl();
    await this.throttleLlm(adapter);
    const result = await adapter.act(
      'Click the "Apply" or "Apply Now" button to start the job application. ' +
      'Your ONLY task is to click the apply button — nothing else. ' +
      'After clicking, report the task as done immediately. ' +
      'The page will navigate away — that is expected.',
    );

    // The LLM agent may report "failure" if the page navigated to a login/auth
    // page after clicking Apply — but the click itself succeeded. Check if the
    // URL actually changed to determine real success.
    if (!result.success) {
      const urlAfter = await adapter.getCurrentUrl();
      if (urlAfter !== urlBefore) {
        console.log('[SmartApply] Apply button clicked — page navigated. Continuing...');
      } else {
        throw new Error(`Failed to click Apply button: ${result.message}`);
      }
    }

    await this.waitForPageLoad(adapter);
  }

  private async handleGenericLogin(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
  ): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();
    const email = profile.email || '';

    // Google SSO detection
    if (currentUrl.includes('accounts.google.com')) {
      console.log(`[SmartApply] On Google sign-in page for ${email}...`);
      const password = process.env.TEST_GMAIL_PASSWORD || '';

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

          // Check for confirmation page (account pre-selected, "Continue" button visible)
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
        console.log('[SmartApply] Google confirmation page — clicking Continue...');
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
          await adapter.act('Click the "Continue" or "Confirm" button to proceed with the Google sign-in.');
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
        if (!clicked) await adapter.act(`Click on the account "${email}" to sign in with it.`);
        await adapter.page.waitForTimeout(2000);
        return;
      }

      if (googlePageType.type === 'email_entry') {
        const emailInput = adapter.page.locator('input[type="email"]:visible').first();
        await emailInput.fill(email);
        await adapter.page.waitForTimeout(300);
        await this.clickNextOnGooglePage(adapter);
        await adapter.page.waitForTimeout(2000);
        return;
      }

      if (googlePageType.type === 'password_entry') {
        const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
        await passwordInput.fill(password);
        await adapter.page.waitForTimeout(300);
        await this.clickNextOnGooglePage(adapter);
        await adapter.page.waitForTimeout(2000);
        return;
      }

      // Unknown Google page — LLM fallback (password handled via DOM only)
      await adapter.act(
        `This is a Google sign-in page. Move through the sign-in flow for "${email}":
- If you see a "Continue", "Confirm", or "Allow" button, click it to proceed.
- If you see the account "${email}" listed, click on it to select it.
- If you see an "Email or phone" field, type "${email}" and click "Next".
- If you see a "Password" field, do NOT type anything — just report the task as done.
- If you see a CAPTCHA or image challenge, report the task as done.
Click only ONE button, then report the task as done.`,
      );
      await adapter.page.waitForTimeout(2000);
      return;
    }

    // Non-Google login path: Google SSO → native email/password → account creation
    console.log('[SmartApply] On login page, looking for sign-in options...');
    const password = profile.password || process.env.TEST_GMAIL_PASSWORD || '';

    // Step 1: Check for a Google SSO button
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
      console.log('[SmartApply] Google SSO button found — clicking...');
      await adapter.act('Click the "Sign in with Google" button, Google icon/logo button, or "Continue with Google" option. Click ONLY ONE button, then report done.');
      await this.waitForPageLoad(adapter);
      return;
    }

    // Step 2: No Google SSO — attempt native email/password login
    console.log('[SmartApply] No Google SSO available — trying email/password login...');
    const PASSWORD_SUFFIX = 'aA1!';

    const formState = await adapter.page.evaluate(() => {
      const hasEmail = !!document.querySelector(
        'input[type="email"]:not([disabled]), input[autocomplete="email"]:not([disabled]), ' +
        'input[name*="email" i]:not([disabled]), input[name*="user" i]:not([disabled])'
      );
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const hasPassword = passwordFields.length > 0;
      // If there are 2+ password fields (password + confirm), this is a Create Account form
      const isCreateAccountForm = passwordFields.length > 1;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const hasCreateAccountHeading = headingText.includes('create account')
        || headingText.includes('register') || headingText.includes('sign up');
      // Look for a "Sign In" / "Log In" tab/link to switch to the login view
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

    // If we're on a Create Account form with a "Sign In" link, click it first
    if (formState.isCreateAccountForm && formState.hasSignInLink) {
      console.log('[SmartApply] On Create Account form — clicking Sign In link first...');
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
        // Re-check form state after switching to Sign In view
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
      // Helper: fill credentials and submit
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
          await adapter.act('Click the "Sign In", "Log In", "Next", or "Continue" button. Click ONLY ONE button.');
        }

        await adapter.page.waitForTimeout(3000);
        await this.waitForPageLoad(adapter);
      };

      // Helper: check for login errors
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

        // If base password failed, try with suffix
        if (loginError && password) {
          console.log(`[SmartApply] Login failed with base password: "${loginError}" — retrying with strengthened password...`);
          await fillAndSubmit(password + PASSWORD_SUFFIX);
          loginError = await checkLoginError();
        }

        if (loginError) {
          console.log(`[SmartApply] Login failed: "${loginError}" — navigating to account creation...`);

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

          if (clickedCreate) {
            console.log('[SmartApply] Clicked account creation link.');
          } else {
            await adapter.act('The login failed. Look for a "Create Account", "Sign Up", "Register", or "Don\'t have an account?" link and click it. Click ONLY ONE link.');
          }
          await this.waitForPageLoad(adapter);
        }
      }
      return;
    }

    // Step 3: No form fields visible — use LLM to find sign-in or sign-up option
    await adapter.act(
      'This is a login page. First, look for a "Sign In" or "Log In" button and click it. Only if there is no sign-in option, click a "Create Account" or "Sign Up" link instead. Click ONLY ONE button, then report done.',
    );
    await this.waitForPageLoad(adapter);
  }

  private async handleVerificationCode(adapter: BrowserAutomationAdapter): Promise<void> {
    console.log('[SmartApply] Verification code required. Checking Gmail for code...');

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

      if (codeMatch) {
        code = codeMatch[1];
      }
    } finally {
      await gmailPage.close();
    }

    if (!code) {
      throw new Error('Could not find verification code in Gmail');
    }

    console.log(`[SmartApply] Found verification code: ${code}`);

    const enterResult = await adapter.act(
      `Enter the verification code "${code}" into the verification code input field, then click the "Next", "Verify", "Continue", or "Submit" button. Report the task as done after clicking.`,
    );

    if (!enterResult.success) {
      throw new Error(`Failed to enter verification code: ${enterResult.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  private async handlePhone2FA(adapter: BrowserAutomationAdapter): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();

    let challengeDesc: string;
    if (currentUrl.includes('recaptcha')) {
      challengeDesc = 'Captcha challenge requires human intervention';
    } else if (currentUrl.includes('ipp') || currentUrl.includes('/challenge/')) {
      challengeDesc = '2FA phone verification requires human intervention';
    } else {
      challengeDesc = '2FA security challenge requires human intervention';
    }

    console.log(`[SmartApply] ${challengeDesc} at ${currentUrl}`);
    throw new Error(challengeDesc);
  }

  private async handleAccountCreation(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
    profile: Record<string, any>,
  ): Promise<void> {
    console.log('[SmartApply] Account creation page detected, filling in details...');

    const email = profile.email || '';
    const basePassword = profile.password || process.env.TEST_GMAIL_PASSWORD || '';
    // Append suffix to satisfy stricter password requirements on job sites
    const password = basePassword ? basePassword + 'aA1!' : 'GhApp2026!x';

    // DOM-fill email and password first (keeps password out of LLM prompts)
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

    // Fill ALL visible password inputs (password + confirm password)
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

    // LLM handles the rest (name fields, terms checkboxes, submit button)
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
      // act() may time out even though account creation succeeded and the page
      // transitioned (e.g. Amazon fills contact info after creating the account,
      // and the agent keeps going until timeout). Check if the page has moved on.
      const hasPasswordField = await adapter.page.evaluate(() =>
        document.querySelectorAll('input[type="password"]').length > 0
      );
      if (!hasPasswordField) {
        console.log('[SmartApply] act() reported failure but page has moved past account creation — continuing.');
        return;
      }
      throw new Error(`Failed to create account: ${result.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  // =========================================================================
  // Fill + Scroll Loop
  // =========================================================================

  /**
   * Fill the current page using the proven formFiller approach:
   *   1. formFiller: extract fields, LLM answers, DOM fill, MagnitudeHand fallback
   *   2. ADVANCE:   Click Next or detect review page.
   */
  private async fillPage(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    resumePath?: string | null,
    profileText?: string,
    _depth = 0,
  ): Promise<'navigated' | 'review' | 'complete'> {
    const MAX_DEPTH = 3;

    if (_depth >= MAX_DEPTH) {
      console.warn(`[SmartApply] Hit max fill depth (${MAX_DEPTH}) — giving up on validation errors.`);
      return 'complete';
    }

    // Safety: check if this is actually the review page (misclassified)
    if (await this.checkIfReviewPage(adapter)) {
      console.log(`[SmartApply] SAFETY: This is the review page — skipping all fill logic.`);
      return 'review';
    }

    // ── FILL PHASE: Use formFiller (DOM fill + MagnitudeHand fallback) ──
    if (profileText) {
      const fillResult = await fillFormOnPage(adapter.page, adapter, profileText, resumePath);
      console.log(`[SmartApply] formFiller: ${fillResult.domFilled} DOM + ${fillResult.magnitudeFilled} Magnitude filled (${fillResult.llmCalls} LLM calls)`);
    }

    // ── ADVANCE PHASE: Click Next or detect review page ──
    // Clean up any data-ff-id attributes (formFiller tags elements)
    // and also clean up legacy scan attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-scan-idx]').forEach(el => el.removeAttribute('data-gh-scan-idx'));
    });

    // Scroll to bottom to find Next button
    await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await adapter.page.waitForTimeout(500);

    const urlBeforeClick = await adapter.getCurrentUrl();
    const fingerprintBeforeClick = await this.getPageFingerprint(adapter);
    const scrollBeforeClick = await adapter.page.evaluate(() => window.scrollY);

    const clickResult = await config.clickNextButton(adapter);
    if (clickResult === 'clicked') {
      console.log(`[SmartApply] Clicked Next via DOM.`);
      await adapter.page.waitForTimeout(2000);

      // Check for validation errors
      const hasErrors = await config.detectValidationErrors(adapter);
      if (hasErrors) {
        console.log(`[SmartApply] Validation errors after clicking Next — re-filling.`);
        return this.fillPage(adapter, config, resumePath, profileText, _depth + 1);
      }

      // Verify page changed
      const urlAfterClick = await adapter.getCurrentUrl();
      const fingerprintAfterClick = await this.getPageFingerprint(adapter);
      if (urlAfterClick !== urlBeforeClick || fingerprintAfterClick !== fingerprintBeforeClick) {
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }

      // SPA delayed rendering — wait and check again
      await adapter.page.waitForTimeout(2000);
      const urlAfterWait = await adapter.getCurrentUrl();
      const fingerprintAfterWait = await this.getPageFingerprint(adapter);
      if (urlAfterWait !== urlBeforeClick || fingerprintAfterWait !== fingerprintBeforeClick) {
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }

      // Check if site auto-scrolled (validation errors without error markers)
      const scrollAfterClick = await adapter.page.evaluate(() => window.scrollY);
      if (Math.abs(scrollAfterClick - scrollBeforeClick) > 50) {
        console.log(`[SmartApply] Clicked Next — page auto-scrolled to unfilled fields. Re-filling.`);
        return this.fillPage(adapter, config, resumePath, profileText, _depth + 1);
      }

      console.log(`[SmartApply] Clicked Next but page unchanged.`);
    }

    if (clickResult === 'review_detected') {
      console.log(`[SmartApply] Review page detected — not clicking Submit.`);
      return 'review';
    }

    if (clickResult === 'not_found') {
      // Scroll to content bottom and try once more
      const scrollMax = await this.getContentScrollMax(adapter);
      await adapter.page.evaluate((target: number) =>
        window.scrollTo({ top: target, behavior: 'smooth' }),
      scrollMax);
      await adapter.page.waitForTimeout(800);

      const finalClick = await config.clickNextButton(adapter);
      if (finalClick === 'clicked') {
        console.log(`[SmartApply] Clicked Next at content bottom.`);
        await adapter.page.waitForTimeout(2000);
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }
      if (finalClick === 'review_detected') {
        console.log(`[SmartApply] Review page detected at content bottom.`);
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
      console.log(`[SmartApply] Submit button present — treating as review.`);
      return 'review';
    }

    console.log(`[SmartApply] Page complete.`);
    return 'complete';
  }

  /**
   * Detect file upload inputs on the page and upload the resume via DOM.
   * Handles both visible <input type="file"> and button-triggered file dialogs.
   * Returns true if a resume was uploaded.
   */
  private async uploadResumeIfPresent(
    adapter: BrowserAutomationAdapter,
    resumePath: string,
  ): Promise<boolean> {
    // Check for file input anywhere on the page (not just viewport — they're often hidden)
    const hasFileInput = await adapter.page.evaluate(() => {
      return document.querySelectorAll('input[type="file"]').length > 0;
    });

    if (!hasFileInput) return false;

    try {
      const fileInput = adapter.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(resumePath);
      console.log(`[SmartApply] Resume uploaded via DOM file input: ${resumePath}`);
      await adapter.page.waitForTimeout(2000); // Wait for upload processing
      return true;
    } catch (err) {
      console.warn(`[SmartApply] DOM resume upload failed: ${err}. LLM will try clicking upload button.`);
      return false;
    }
  }

  /**
   * Quick live-scan of unfilled fields visible in the current viewport.
   * Unlike the full scanPageFields (which scrolls through the entire page),
   * this only checks what's on screen right now — used before each LLM call
   * so the prompt reflects the actual DOM state after conditional fields appear.
   */
  private async scanVisibleUnfilledFields(
    adapter: BrowserAutomationAdapter,
    _config: PlatformConfig,
    qaMap: Record<string, string>,
  ): Promise<ScannedField[]> {
    // Use the platform's collectVisibleFields via a single-viewport scan
    // by calling scanPageFields with the page already at the right scroll position.
    // But that scrolls around — instead, use hasEmptyVisibleFields as a quick gate,
    // then call the adapter's evaluate to get visible empty field data.
    const visibleEmpty = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const results: Array<{ label: string; kind: string; selector: string; isRequired: boolean; options: string[] }> = [];

      // Quick scan of visible empty form fields
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

      // Also check custom dropdowns and ARIA radios in viewport
      const customEls = document.querySelectorAll(
        '[role="combobox"], [role="listbox"], [aria-haspopup], [role="radiogroup"], [role="radio"]'
      );
      for (const el of customEls) {
        if (el.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5 || rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;

        // Check if already filled
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

        // Extract radio/dropdown options
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

      // Also check Material Design / proprietary styled selects (arrow icon detection)
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

        // Check if filled
        const mdInput = container.querySelector('input') as HTMLInputElement | null;
        if (mdInput?.value?.trim()) continue;

        // Extract label
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
          // Try preceding sibling
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

    // Deduplicate by label and match answers
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
        absoluteY: 0, // not used for LLM viewport scan
        isRequired: raw.isRequired,
        matchedAnswer: answer || undefined,
        filled: false,
      });
    }

    return fields;
  }

  /**
   * Build a text summary of fields for enriching the LLM prompt.
   * Includes field type, options, required status, and expected answer if known.
   * e.g. `- "Country/Region" (Dropdown) → Expected: "United States" [REQUIRED]`
   */
  private buildScanContextForLLM(fields: ScannedField[]): string {
    return fields.map(f => {
      const kindLabel: Record<string, string> = {
        text: 'Text input',
        select: 'Dropdown',
        custom_dropdown: 'Dropdown',
        radio: 'Radio buttons',
        aria_radio: 'Radio buttons',
        checkbox: 'Checkbox',
        date: 'Date input',
        file: 'File upload',
        contenteditable: 'Rich text editor',
        upload_button: 'Upload button',
        unknown: 'Unknown field',
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

  /**
   * Group unfilled fields into viewport-sized chunks by absoluteY,
   * so each LLM call targets fields that are visible together.
   */
  private groupFieldsByViewport(fields: ScannedField[], viewportHeight: number): ScannedField[][] {
    if (fields.length === 0) return [];
    const groups: ScannedField[][] = [];
    let currentGroup: ScannedField[] = [fields[0]];
    let groupTop = fields[0].absoluteY;

    for (let i = 1; i < fields.length; i++) {
      const field = fields[i];
      // If this field is within the same viewport window as the group start, add it
      if (field.absoluteY - groupTop < viewportHeight * 0.8) {
        currentGroup.push(field);
      } else {
        groups.push(currentGroup);
        currentGroup = [field];
        groupTop = field.absoluteY;
      }
    }
    groups.push(currentGroup);
    return groups;
  }

  /**
   * Check if there's a visible upload button, link, or dropzone on screen.
   * Used to decide whether to invoke the LLM to click it when DOM upload fails.
   */
  private async hasVisibleUploadArea(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const uploadWords = [
        'upload', 'attach', 'choose file', 'select file', 'browse',
        'add file', 'add resume', 'add cv', 'add document', 'add cover letter',
        'drag', 'drop file', 'drop your', 'drop here',
      ];
      const els = document.querySelectorAll(
        'button, [role="button"], a[href], label[for], ' +
        '[class*="upload"], [class*="dropzone"], [class*="drop-zone"], ' +
        '[class*="file-upload"], [class*="attach"], [class*="resume-upload"]'
      );
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const text = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (text.length > 150) continue;
        // Skip nav buttons
        if (text === 'submit' || text === 'next' || text === 'continue' || text === 'save') continue;
        for (const word of uploadWords) {
          if (text.includes(word)) return true;
        }
      }
      return false;
    });
  }

  /**
   * Quick fingerprint of visible field values to detect whether the LLM changed anything.
   */
  private async getVisibleFieldValues(adapter: BrowserAutomationAdapter): Promise<string> {
    return adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const vals: string[] = [];
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select'
      ).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh || rect.width === 0 || rect.height === 0) return;
        vals.push(el.value || '');
      });
      return vals.join('|');
    });
  }

  /**
   * Dismiss any open dropdowns, popups, or overlays the LLM may have left behind.
   * An open dropdown blocks clicks on other elements and prevents the selected
   * value from being committed (blur/change events don't fire until it closes).
   */
  private async dismissOpenOverlays(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      // Press Escape to close any open dropdown/popup/menu
      await adapter.page.keyboard.press('Escape');
      await adapter.page.waitForTimeout(200);

      // Trigger blur on the active element to commit any pending values.
      // Avoid clicking at fixed coordinates (could hit a nav link).
      await adapter.page.evaluate(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement).blur?.();
        }
      });
      await adapter.page.waitForTimeout(300);
    } catch {
      // Non-fatal — overlay may not exist
    }
  }

  /**
   * Snapshot which checkboxes are currently checked (by index) so we can detect if
   * the LLM accidentally unchecks any.
   */
  private async getCheckedCheckboxes(adapter: BrowserAutomationAdapter): Promise<number[]> {
    return adapter.page.evaluate(() => {
      const indices: number[] = [];
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      for (let i = 0; i < cbs.length; i++) {
        if ((cbs[i] as HTMLInputElement).checked) indices.push(i);
      }
      return indices;
    });
  }

  /**
   * Re-check any checkboxes that were checked before the LLM acted but got unchecked.
   * The LLM should NEVER uncheck a checkbox.
   */
  private async restoreUncheckedCheckboxes(
    adapter: BrowserAutomationAdapter,
    previouslyChecked: number[],
  ): Promise<void> {
    if (previouslyChecked.length === 0) return;
    const restored = await adapter.page.evaluate((indices) => {
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
      console.log(`[SmartApply] Restored ${restored} checkbox(es) the LLM accidentally unchecked.`);
    }
  }

  /**
   * Smart scroll: find the next actionable element below the viewport and scroll
   * just enough to bring it into view. Falls back to 50% viewport jump if no
   * specific target is found.
   * Returns true if the scroll position actually changed.
   */
  private async scrollDown(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
    const scrollMax = await this.getContentScrollMax(adapter);

    if (scrollBefore >= scrollMax - 10) return false; // Already at content bottom

    // Find the Y position of the next actionable element below the viewport
    const targetY = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const scrollY = window.scrollY;

      // All the element types we care about (form fields, upload areas, buttons, custom controls)
      const selectors = [
        'input:not([type="hidden"]):not([disabled])',
        'textarea:not([disabled])',
        'select:not([disabled])',
        '[contenteditable="true"]',
        '[role="combobox"]',
        '[role="listbox"]',
        '[role="radiogroup"]',
        '[role="radio"]',
        '[aria-haspopup="listbox"]',
        '[aria-haspopup="true"]',
        'input[type="file"]',
        'button',
        '[role="button"]',
        'label[for]',
        '[class*="upload"]',
        '[class*="dropzone"]',
        '[class*="drop-zone"]',
        '[class*="file-upload"]',
        '[class*="attach"]',
      ];

      let closestBelow = Infinity;

      for (let s = 0; s < selectors.length; s++) {
        const els = document.querySelectorAll(selectors[s]);
        for (let e = 0; e < els.length; e++) {
          const rect = els[e].getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(els[e]);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          // Element is below the viewport (or partially cut off at the bottom)
          if (rect.top > vh - 20) {
            const absTop = rect.top + scrollY;
            if (absTop < closestBelow) closestBelow = absTop;
          }
        }
      }

      if (closestBelow === Infinity) {
        // No specific target found — fall back to 50% viewport jump
        return scrollY + Math.round(vh * 0.5);
      }

      // Scroll so the target element is ~20% from the top of the viewport
      return Math.max(scrollY + 1, closestBelow - Math.round(vh * 0.2));
    });

    await adapter.page.evaluate((target: number) =>
      window.scrollTo({ top: target, behavior: 'smooth' }),
    targetY);
    await adapter.page.waitForTimeout(1200);

    const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
    return scrollAfter > scrollBefore;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async waitForPageLoad(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      await adapter.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await adapter.page.waitForTimeout(PAGE_TRANSITION_WAIT_MS);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Dismiss cookie consent banners that may overlay page content.
   * Uses DOM-first approach — clicks common accept/reject/close buttons.
   */
  private async dismissCookieBanner(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      const dismissed = await adapter.page.evaluate(() => {
        // Common cookie banner selectors across many sites
        const selectors = [
          // By ID
          '#onetrust-accept-btn-handler',           // OneTrust (very common)
          '#cookie-accept', '#accept-cookies',
          '#CookieAcceptAll', '#cookieAcceptAll',
          '#truste-consent-button',                  // TrustArc
          '#sp-cc-accept',                           // Amazon's own cookie banner
          // By class
          '.cookie-accept-btn', '.accept-cookies-btn',
          '.cookie-consent-accept',
          // By data attributes
          '[data-testid="cookie-accept"]',
          '[data-action="accept-cookies"]',
          // Generic buttons with common text
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

        // Text-based fallback: look for buttons with "Accept" or "Accept all" text
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
        console.log('[SmartApply] Dismissed cookie consent banner');
        await adapter.page.waitForTimeout(500);
      }
    } catch {
      // Non-fatal — cookie banner may not exist
    }
  }

  private async clickNextOnGooglePage(adapter: BrowserAutomationAdapter): Promise<void> {
    const nextClicked = await adapter.page.evaluate(() => {
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
      await adapter.act('Click the "Next" button.');
    }
  }

  /**
   * Quick DOM-only check if the current page looks like a review page.
   * Used as a lightweight safety net inside fillPage — NOT the
   * primary review detection (that's verifyReviewPage with LLM confirmation).
   * Only returns true if heading says "review" AND Submit present AND no editable fields.
   */
  private async checkIfReviewPage(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
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
      // Check entire page for any editable form elements
      const editableCount = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), ' +
        'input[type="email"]:not([readonly]):not([disabled]), ' +
        'input[type="tel"]:not([readonly]):not([disabled]), ' +
        'textarea:not([readonly]):not([disabled]), ' +
        'select:not([disabled]), ' +
        'input[type="radio"]:not([disabled]), ' +
        'input[type="checkbox"]:not([disabled])'
      ).length;
      // If there are interactive form elements, probably not a true review page
      return editableCount === 0;
    });
  }

  /**
   * Use a second LLM call to verify the page is truly the final review/summary.
   * DOM checks miss radio buttons, toggles, custom widgets, and other non-standard
   * form elements, so we ask the LLM to visually inspect the page for signs that
   * there is still more application to complete.
   */
  private async verifyReviewPage(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const ReviewVerificationSchema = z.object({
      is_final_review: z.boolean(),
      reason: z.string(),
    });

    try {
      console.log('[SmartApply] Verifying review page classification with LLM...');
      await this.throttleLlm(adapter);
      const result = await adapter.extract(
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

      console.log(`[SmartApply] Review verification: is_final_review=${result.is_final_review}, reason="${result.reason}"`);
      return result.is_final_review;
    } catch (error) {
      console.warn(`[SmartApply] Review verification LLM call failed: ${error}`);
      // If the verification fails, err on the side of NOT treating it as review
      // so we don't prematurely stop the application
      return false;
    }
  }

  /**
   * Call adapter.act() with throttling, broken-page guard, and 429 retry.
   * - Enforces minimum gap between LLM calls to stay under rate limits
   * - Checks page health before sending screenshots (broken pages waste tokens)
   * - Retries once on 429 with a 30s backoff (the rate limit window is per-minute)
   */
  private async safeAct(
    adapter: BrowserAutomationAdapter,
    prompt: string,
    label: string,
  ): Promise<void> {
    // Check page health — don't waste tokens on broken pages showing raw JS
    const healthy = await this.isPageHealthy(adapter);
    if (!healthy) {
      console.warn(`[SmartApply] [${label}] Page appears broken (raw JS/code visible) — skipping LLM call to save tokens.`);
      return;
    }

    // Enforce minimum gap between LLM calls
    await this.throttleLlm(adapter);

    try {
      const result = await adapter.act(prompt);
      // Defense-in-depth: check result even though adapters now throw on failure.
      if (!result.success) {
        throw new Error(`[${label}] act() returned failure: ${result.message}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Too Many Requests')) {
        console.warn(`[SmartApply] [${label}] Rate limited (429) — waiting 30s before retry...`);
        await adapter.page.waitForTimeout(30_000);
        this.lastLlmCallTime = Date.now();
        const retryResult = await adapter.act(prompt);
        if (!retryResult.success) {
          throw new Error(`[${label}] act() returned failure after retry: ${retryResult.message}`);
        }
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // MagnitudeHand — Last-resort general GUI agent fallback
  // ---------------------------------------------------------------------------

  /**
   * Phase 2.75: MagnitudeHand — Last-resort fallback for fields that DOM fill
   * and LLM fill both failed to handle. Uses the adapter as a general GUI agent
   * with per-field micro-scoped act() calls to minimize quadratic cost.
   *
   * Typical targets: nested/cascading dropdowns, custom ARIA widgets,
   * autocomplete fields, contenteditable divs.
   *
   * Returns the number of fields successfully filled.
   */
  private async magnitudeHandFallback(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    scan: ScanResult,
    qaMap: Record<string, string>,
    dataPrompt: string,
    pageLabel: string,
    costTracker?: CostTracker,
  ): Promise<number> {
    // 1. Identify unfilled fields
    const unfilled = scan.fields.filter(f =>
      !f.filled &&
      (!f.currentValue || f.currentValue.trim() === '') &&
      f.kind !== 'file' && f.kind !== 'upload_button'
    );

    if (unfilled.length === 0) {
      console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: No unfilled fields — skipping.`);
      return 0;
    }

    // 2. Budget gate — skip if insufficient budget remaining
    if (costTracker) {
      const remaining = costTracker.getRemainingBudget();
      if (remaining < MAGNITUDE_HAND_MIN_REMAINING_BUDGET) {
        console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Budget too low ($${remaining.toFixed(4)} remaining) — skipping.`);
        return 0;
      }
    }

    console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: ${unfilled.length} unfilled field(s) — starting fallback.`);

    // 3. Snapshot cost baseline for soft cap enforcement
    const costBaseline = costTracker
      ? costTracker.getTaskBudget() - costTracker.getRemainingBudget()
      : 0;
    let fieldsFilled = 0;
    const fieldsToAttempt = unfilled.slice(0, MAGNITUDE_HAND_MAX_FIELDS);

    for (const field of fieldsToAttempt) {
      // 3a. Check soft cap — stop if MagnitudeHand has spent too much
      if (costTracker) {
        const currentCost = costTracker.getTaskBudget() - costTracker.getRemainingBudget();
        const magnitudeHandSpent = currentCost - costBaseline;
        if (magnitudeHandSpent >= MAGNITUDE_HAND_BUDGET_CAP) {
          console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Soft cap reached ($${magnitudeHandSpent.toFixed(4)} / $${MAGNITUDE_HAND_BUDGET_CAP}) — stopping.`);
          break;
        }
        if (costTracker.getRemainingBudget() < MAGNITUDE_HAND_MIN_REMAINING_BUDGET) {
          console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Global budget exhausted — stopping.`);
          break;
        }
      }

      // 3b. Scroll field into view
      if (field.selector) {
        try {
          await adapter.page.evaluate(
            (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
            field.selector,
          );
          await adapter.page.waitForTimeout(300);
        } catch {
          // Selector may be stale — continue anyway, Magnitude uses screenshots
        }
      }

      // 3c. Build micro-scoped prompt for this single field
      const answer = field.matchedAnswer || findBestAnswer(field.label, qaMap);
      const prompt = this.buildMagnitudeHandPrompt(field, answer || undefined, dataPrompt);

      // 3d. Execute via adapter.act() with timeout
      const answerPreview = answer ? `"${answer.substring(0, 30)}${answer.length > 30 ? '...' : ''}"` : 'best judgment';
      console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Filling "${field.label}" (${field.kind}) → ${answerPreview}`);

      try {
        await this.throttleLlm(adapter);
        const result = await adapter.act(prompt, {
          timeoutMs: MAGNITUDE_HAND_ACT_TIMEOUT_MS,
        });

        if (result.success) {
          field.filled = true;
          fieldsFilled++;
          console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Filled "${field.label}" OK (${result.durationMs}ms)`);
        } else {
          console.warn(`[SmartApply] [${pageLabel}] MagnitudeHand: Failed "${field.label}": ${result.message}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // BudgetExceededError must propagate up
        if (msg.includes('Budget exceeded') || msg.includes('Action limit exceeded')) {
          console.warn(`[SmartApply] [${pageLabel}] MagnitudeHand: Budget/action limit hit — stopping.`);
          throw err;
        }
        console.warn(`[SmartApply] [${pageLabel}] MagnitudeHand: Error on "${field.label}": ${msg}`);
      }

      // 3e. Dismiss any overlays the agent may have opened
      await this.dismissOpenOverlays(adapter);
    }

    console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Filled ${fieldsFilled}/${fieldsToAttempt.length} field(s).`);
    return fieldsFilled;
  }

  /**
   * Build a minimal, focused prompt for a single MagnitudeHand field fill.
   * Keeps the prompt short to minimize input tokens (cost optimization).
   */
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
   * Generate a fingerprint of the visible page content for SPA stuck detection.
   * On SPAs where the URL never changes, this detects actual page transitions
   * by comparing headings, form field count, and active sidebar items.
   */
  private async getPageFingerprint(adapter: BrowserAutomationAdapter): Promise<string> {
    return adapter.page.evaluate(() => {
      // First visible heading
      const h = document.querySelector('h1, h2, h3');
      const heading = (h?.textContent || '').trim().substring(0, 60);

      // Count visible form fields as a content signature
      const fields = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      let visibleFieldCount = 0;
      for (const f of fields) {
        const rect = f.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) visibleFieldCount++;
      }

      // Active sidebar/step indicator (common in multi-step forms)
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

  /**
   * Calculate the maximum safe scroll position based on actual visible content,
   * NOT raw document.scrollHeight. On SPAs (React/Next.js) like Amazon.jobs,
   * scrollHeight includes <script> tags and framework boilerplate past the
   * rendered content. Scrolling into that territory shows raw JavaScript.
   * This finds the bottom edge of the last meaningful UI element and uses
   * that as the content boundary — matching what manual scrolling would reach.
   */
  private async getContentScrollMax(adapter: BrowserAutomationAdapter): Promise<number> {
    return adapter.page.evaluate(() => {
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
      // Use content boundary + buffer, capped at actual scroll height
      const contentLimit = maxBottom > 0
        ? Math.min(maxBottom + 150, document.documentElement.scrollHeight)
        : document.documentElement.scrollHeight;
      return Math.max(0, contentLimit - window.innerHeight);
    });
  }

  /**
   * Check if the visible page content is healthy (actual UI) vs broken (raw JS/source code).
   * On SPAs, rendering glitches can expose raw JavaScript, minified bundles, or JSON in the
   * viewport. Sending a screenshot of dense code to the LLM is extremely expensive (a single
   * screenshot of minified JS can burn 5-10k+ vision tokens). This checks the visible text
   * for code-like patterns and returns false if the page looks broken.
   */
  private async isPageHealthy(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      // Sample visible text in the viewport
      const viewportHeight = window.innerHeight;
      const elements = document.elementsFromPoint(window.innerWidth / 2, viewportHeight / 2);

      // Get all text visible in the viewport by checking elements in the viewport region
      let visibleText = '';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      let textNodes = 0;
      while ((node = walker.nextNode() as Text | null)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        // Only check text in the current viewport
        if (rect.bottom < 0 || rect.top > viewportHeight) continue;
        if (rect.width === 0 || rect.height === 0) continue;
        visibleText += node.textContent + ' ';
        textNodes++;
        if (visibleText.length > 5000) break; // Sample enough text
      }

      if (visibleText.length < 200) return true; // Not enough text to judge — assume healthy

      // Count code-like patterns
      const codePatterns = [
        /\bfunction\s*\(/g, /\bconst\s+\w+/g, /\bvar\s+\w+/g, /\blet\s+\w+/g,
        /\bimport\s+/g, /\bexport\s+/g, /\brequire\s*\(/g, /\bmodule\.exports/g,
        /=>\s*\{/g, /\}\s*\)/g, /\bclass\s+\w+/g, /\bnew\s+\w+/g,
        /\btry\s*\{/g, /\bcatch\s*\(/g, /\bthrow\s+/g,
        /\bif\s*\(/g, /\belse\s*\{/g, /\breturn\s+/g,
        /\bwindow\./g, /\bdocument\./g, /\bconsole\./g,
        /[{};]\s*[{};]/g, // dense punctuation typical of minified JS
      ];

      let codeHits = 0;
      for (const pattern of codePatterns) {
        const matches = visibleText.match(pattern);
        if (matches) codeHits += matches.length;
      }

      // Count UI-like elements in viewport (buttons, inputs, labels, headings)
      const uiElements = document.querySelectorAll(
        'button, [role="button"], input:not([type="hidden"]), select, textarea, label, h1, h2, h3, h4, img'
      );
      let visibleUiCount = 0;
      for (const el of uiElements) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewportHeight) continue;
        if (rect.width > 0 && rect.height > 0) visibleUiCount++;
      }

      // Heuristic: if code patterns significantly outnumber UI elements, page is broken
      // A healthy form page typically has >5 UI elements and <5 code patterns
      // A broken page showing JS typically has 20+ code patterns and <3 UI elements
      if (codeHits >= 15 && visibleUiCount < 3) return false;
      if (codeHits >= 10 && codeHits > visibleUiCount * 3) return false;

      return true;
    });
  }

  /**
   * Enforce a minimum gap between LLM calls to stay under rate limits.
   * The Magnitude SDK makes multiple internal LLM calls per act()/extract(),
   * so we need breathing room between our calls.
   */
  private async throttleLlm(adapter: BrowserAutomationAdapter): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastLlmCallTime;
    if (this.lastLlmCallTime > 0 && elapsed < MIN_LLM_GAP_MS) {
      const wait = MIN_LLM_GAP_MS - elapsed;
      console.log(`[SmartApply] Rate limit throttle: waiting ${wait}ms before next LLM call...`);
      await adapter.page.waitForTimeout(wait);
    }
    this.lastLlmCallTime = Date.now();
  }

  // Note: dismissErrorBanners was removed. Hiding [role="alert"] elements via
  // style.display='none' breaks React's DOM reconciliation on SPAs. Error banners
  // are left visible — the LLM prompt already instructs it to fix errors, not get
  // distracted by them.
}
