import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PlatformConfig, PageState, PageType, ScannedField } from './platforms/types.js';
import { detectPlatformFromUrl } from './platforms/index.js';
import { findBestAnswer } from './platforms/genericConfig.js';
import { ProgressStep } from '../progressTracker.js';

// --- Constants ---

const PAGE_TRANSITION_WAIT_MS = 3_000;
const MAX_FORM_PAGES = 15;
const MIN_LLM_GAP_MS = 5_000; // Minimum gap between LLM calls to stay under rate limits

// --- Handler ---

export class SmartApplyHandler implements TaskHandler {
  readonly type = 'smart_apply';
  readonly description = 'Fill out a job application on any ATS platform (multi-step), stopping before submission';
  private lastLlmCallTime = 0;

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

    // Build data prompt and QA map via platform config
    const dataPrompt = config.buildDataPrompt(userProfile, qaOverrides);
    const qaMap = config.buildQAMap(userProfile, qaOverrides);

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

        // Handle based on page type
        switch (pageState.page_type) {
          case 'job_listing':
            await this.handleJobListing(adapter);
            break;

          case 'login':
          case 'google_signin':
            if (config.handleLogin) {
              await config.handleLogin(adapter, userProfile);
            } else {
              await this.handleGenericLogin(adapter, userProfile);
            }
            break;

          case 'verification_code':
            await this.handleVerificationCode(adapter);
            break;

          case 'phone_2fa':
            await this.handlePhone2FA(adapter);
            break;

          case 'account_creation':
            await this.handleAccountCreation(adapter, dataPrompt);
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
            }

            const step = (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload')
              ? ProgressStep.UPLOADING_RESUME
              : ProgressStep.FILLING_FORM;
            await progress.setStep(step as any);

            const fillPrompt = config.buildPagePrompt(pageState.page_type, dataPrompt);
            const result = await this.fillPage(adapter, config, fillPrompt, qaMap, pageState.page_type, resumePath);

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
      const hasPasswordField = document.querySelectorAll('input[type="password"]').length > 0;
      const hasConfirmation = bodyText.includes('thank you for applying')
        || bodyText.includes('application received')
        || bodyText.includes('successfully submitted')
        || bodyText.includes('application has been submitted');
      return { hasPasswordField, hasConfirmation };
    });

    if (obvious.hasConfirmation) {
      return { page_type: 'confirmation', page_title: 'Confirmation' };
    }

    if (obvious.hasPasswordField) {
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

    // Generic login: look for SSO or sign-in buttons
    console.log('[SmartApply] On login page, looking for sign-in options...');
    const loginResult = await adapter.act(
      'Look for a "Sign in with Google" button, a Google icon/logo button, or a "Continue with Google" option and click it. If there is no Google sign-in option, look for "Sign In" or "Log In" button instead. Click ONLY ONE button, then report the task as done.',
    );
    if (!loginResult.success) {
      console.warn(`[SmartApply] Login act() failed or timed out: ${loginResult.message}. Will retry on next loop iteration.`);
    }
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
  ): Promise<void> {
    console.log('[SmartApply] Account creation page detected, filling in details...');

    const result = await adapter.act(
      `Fill out the account creation form, then click "Create Account", "Register", "Continue", or "Next".

HOW TO FILL:
- Use the email from the data mapping as both the username/email and for any confirmation fields.
- If a password field exists, use a strong password: "GhApp2026!x" (capital letter, number, symbol, 12+ chars).
- If a "confirm password" field exists, type the same password again.
- Fill name, email, and other fields from the data mapping below.
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
   * Fill the current page using a scan-first approach:
   *   Phase 0 (SCAN):    Scroll through the page to discover ALL fields.
   *   Phase 1 (DOM FILL): Fill matched fields programmatically by selector.
   *   Phase 2 (LLM FILL): Give the LLM precise context about remaining fields.
   *   Phase 3 (ADVANCE):  Click Next or detect review page.
   *
   * The LLM NEVER scrolls or clicks navigation buttons. It only fills fields.
   * All scrolling and page navigation is handled deterministically by the orchestrator.
   */
  private async fillPage(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
    resumePath?: string | null,
    _depth = 0,
    _llmCallsCarried = 0,
  ): Promise<'navigated' | 'review' | 'complete'> {
    const MAX_DEPTH = 3;     // max recursive retries on validation errors
    const MAX_CYCLES = 5;    // max scan-fill-rescan cycles (for conditional fields)
    const MAX_LLM_CALLS = 6;
    let llmCalls = _llmCallsCarried;

    if (_depth >= MAX_DEPTH) {
      console.warn(`[SmartApply] [${pageLabel}] Hit max fill depth (${MAX_DEPTH}) — giving up on validation errors.`);
      return 'complete';
    }
    let resumeUploaded = false;

    // Safety: check if this is actually the review page (misclassified)
    if (await this.checkIfReviewPage(adapter)) {
      console.log(`[SmartApply] [${pageLabel}] SAFETY: This is the review page — skipping all fill logic.`);
      return 'review';
    }

    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      // ── PHASE 0: SCAN ──
      console.log(`[SmartApply] [${pageLabel}] Cycle ${cycle + 1} — scanning page...`);
      const scan = await config.scanPageFields(adapter);

      const emptyFields = scan.fields.filter(f => !f.currentValue || f.currentValue.trim() === '');
      const filledFields = scan.fields.filter(f => f.currentValue && f.currentValue.trim() !== '');
      console.log(`[SmartApply] [${pageLabel}] Scan: ${scan.fields.length} total, ${emptyFields.length} empty, ${filledFields.length} filled`);

      if (emptyFields.length === 0) {
        console.log(`[SmartApply] [${pageLabel}] No empty fields found — advancing.`);
        break; // Go to Phase 3 (ADVANCE)
      }

      // Log what was found
      for (const f of emptyFields) {
        console.log(`[SmartApply] [${pageLabel}]   [${f.kind}] "${f.label}" (${f.fillStrategy})${f.options ? ` opts: [${f.options.slice(0, 3).join(', ')}${f.options.length > 3 ? '...' : ''}]` : ''}`);
      }

      // ── PHASE 0.5: RESUME UPLOAD ──
      if (resumePath && !resumeUploaded) {
        const fileField = scan.fields.find(f => f.kind === 'file' && !f.currentValue);
        if (fileField) {
          const uploaded = await this.uploadResumeIfPresent(adapter, resumePath);
          if (uploaded) {
            resumeUploaded = true;
            fileField.filled = true;
          }
        }
        // If no file input but there's an upload button, use LLM click
        if (!resumeUploaded) {
          const uploadBtn = scan.fields.find(f => f.kind === 'upload_button' && !f.filled);
          if (uploadBtn) {
            console.log(`[SmartApply] [${pageLabel}] Upload button found — clicking via LLM to trigger file dialog...`);
            try {
              // Scroll to it first
              await adapter.page.evaluate(
                (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
                uploadBtn.selector,
              );
              await adapter.page.waitForTimeout(300);
              await this.safeAct(adapter,
                'Click the resume/CV upload button or drag-and-drop area to open the file picker. ' +
                'Look for text like "Upload", "Attach", "Choose File", "Browse", "Add Resume", or a drag-and-drop zone. ' +
                'Click it ONCE, then report done immediately. Do NOT fill any other fields.',
                pageLabel);
              llmCalls++;
              await adapter.page.waitForTimeout(3000);
              resumeUploaded = true;
              uploadBtn.filled = true;
            } catch (err) {
              console.warn(`[SmartApply] [${pageLabel}] LLM resume upload click failed: ${err}`);
            }
          }
        }
      }

      // ── PHASE 1: DOM FILL ──
      let domFills = 0;
      const unfilled = scan.fields.filter(f => !f.filled && (!f.currentValue || f.currentValue.trim() === ''));

      for (const field of unfilled) {
        if (field.kind === 'file' || field.kind === 'upload_button') continue; // handled above

        const answer = findBestAnswer(field.label, qaMap);
        if (!answer) continue;

        field.matchedAnswer = answer;

        try {
          const success = await config.fillScannedField(adapter, field, answer);
          if (success) {
            field.filled = true;
            domFills++;
            console.log(`[SmartApply] [${pageLabel}] DOM-filled "${field.label}" → "${answer.substring(0, 30)}${answer.length > 30 ? '...' : ''}" (${field.kind})`);
          }
        } catch (err) {
          console.warn(`[SmartApply] [${pageLabel}] DOM fill failed for "${field.label}": ${err}`);
        }
      }

      // Also check required/consent checkboxes (these use pattern matching, not qaMap)
      domFills += await config.checkRequiredCheckboxes(adapter);

      if (domFills > 0) {
        console.log(`[SmartApply] [${pageLabel}] DOM filled ${domFills} field(s) total`);
      }

      // ── PHASE 2: LLM FILL (scroll-and-rescan per viewport) ──
      // Instead of relying on the initial scan's absoluteY (which goes stale when
      // DOM fills trigger conditional fields), we scroll through the page and
      // do a live rescan of visible fields at each position.
      const initialUnfilled = scan.fields.filter(f => !f.filled && (!f.currentValue || f.currentValue.trim() === '') && f.kind !== 'file' && f.kind !== 'upload_button');

      if (initialUnfilled.length > 0 && llmCalls < MAX_LLM_CALLS) {
        // Scroll to top before starting LLM viewport walk
        await adapter.page.evaluate(() => window.scrollTo(0, 0));
        await adapter.page.waitForTimeout(400);

        const vpHeight = await adapter.page.evaluate(() => window.innerHeight);
        const totalHeight = await adapter.page.evaluate(() => document.documentElement.scrollHeight);
        const maxScrollPos = Math.max(0, totalHeight - vpHeight);
        let currentScrollPos = 0;
        const maxLLMScrollSteps = 10;
        let llmScrollSteps = 0;

        while (llmScrollSteps < maxLLMScrollSteps && llmCalls < MAX_LLM_CALLS) {
          // Live-scan what's actually visible right now
          const visibleFields = await this.scanVisibleUnfilledFields(adapter, config, qaMap);

          if (visibleFields.length > 0) {
            const groupContext = this.buildScanContextForLLM(visibleFields);
            const enrichedPrompt = `${fillPrompt}\n\nFIELDS VISIBLE IN CURRENT VIEWPORT (${visibleFields.length} field(s) detected by scan):\n${groupContext}\n\nFill the fields listed above. They are currently visible and empty. Use the expected values shown where provided.\n\nADDITIONALLY: If you see any other visible empty required fields on screen (marked with * or "required") that are NOT listed above, fill those too. Some custom dropdowns or non-standard UI components may not appear in the scan. For dropdowns that don't have a text input, click them to open, then select the correct option.\n\nCRITICAL: NEVER skip a [REQUIRED] field (marked with * or [REQUIRED]). If no exact data is available, use your best judgment to pick the most reasonable answer. For example, "Degree Status" → "Completed" or "Graduated", "Visa Status" → "Authorized to work", etc. Required fields MUST be filled.\n\nIMPORTANT — STUCK FIELD RULE: If you type a value into a dropdown/autocomplete field and NO matching options appear in the dropdown list, the value is NOT available. Do NOT retry the same field. Do NOT try clicking arrows, pressing Enter, retyping, or scrolling the dropdown. Instead: select all text in the field, delete it to clear it, click somewhere else to close any popups, then move on to the next field. You get ONE attempt per field — if it doesn't match, clear it and move on.\n\nDo NOT scroll or click Next.`;

            const fieldsBefore = await this.getVisibleFieldValues(adapter);
            const checkedBefore = await this.getCheckedCheckboxes(adapter);

            console.log(`[SmartApply] [${pageLabel}] LLM call ${llmCalls + 1}/${MAX_LLM_CALLS} for ${visibleFields.length} visible field(s): ${visibleFields.map(f => `"${f.label}"`).join(', ')}`);
            try {
              await this.safeAct(adapter, enrichedPrompt, pageLabel);
            } catch (actError) {
              console.warn(`[SmartApply] [${pageLabel}] LLM act() failed: ${actError instanceof Error ? actError.message : actError}`);
            }
            llmCalls++;

            await this.dismissOpenOverlays(adapter);
            await this.restoreUncheckedCheckboxes(adapter, checkedBefore);

            // If LLM made changes, re-check this same position (conditional fields may have appeared)
            const fieldsAfter = await this.getVisibleFieldValues(adapter);
            if (fieldsAfter !== fieldsBefore) {
              // Mark matched scan fields as filled
              for (const vf of visibleFields) {
                const match = scan.fields.find(sf => sf.selector === vf.selector);
                if (match) match.filled = true;
              }
              continue; // re-scan same viewport position before scrolling
            }
          }

          // Scroll down to next viewport position
          if (currentScrollPos >= maxScrollPos) break;
          currentScrollPos = Math.min(currentScrollPos + Math.round(vpHeight * 0.7), maxScrollPos);
          await adapter.page.evaluate((y: number) => window.scrollTo(0, y), currentScrollPos);
          await adapter.page.waitForTimeout(400);
          llmScrollSteps++;
        }
      }

      break; // Done filling, move to Phase 3
    }

    // ── PHASE 3: ADVANCE ──
    // Clean up scan attributes before navigating
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
      console.log(`[SmartApply] [${pageLabel}] Clicked Next via DOM.`);
      await adapter.page.waitForTimeout(2000);

      // Check for validation errors
      const hasErrors = await config.detectValidationErrors(adapter);
      if (hasErrors) {
        console.log(`[SmartApply] [${pageLabel}] Validation errors after clicking Next — re-scanning.`);
        // Re-scan and re-fill from the position the site scrolled to
        const scrollAfterError = await adapter.page.evaluate(() => window.scrollY);
        if (Math.abs(scrollAfterError - scrollBeforeClick) > 50) {
          // Site auto-scrolled to errors — re-fill at this position
          console.log(`[SmartApply] [${pageLabel}] Site auto-scrolled to errors. Re-running fill cycle.`);
          return this.fillPage(adapter, config, fillPrompt, qaMap, pageLabel, resumePath, _depth + 1, llmCalls);
        }
        await adapter.page.evaluate(() => window.scrollTo(0, 0));
        await adapter.page.waitForTimeout(500);
        return this.fillPage(adapter, config, fillPrompt, qaMap, pageLabel, resumePath, _depth + 1, llmCalls);
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
        console.log(`[SmartApply] [${pageLabel}] Clicked Next — page auto-scrolled to unfilled fields. Re-filling.`);
        return this.fillPage(adapter, config, fillPrompt, qaMap, pageLabel, resumePath, _depth + 1, llmCalls);
      }

      console.log(`[SmartApply] [${pageLabel}] Clicked Next but page unchanged.`);
    }

    if (clickResult === 'review_detected') {
      console.log(`[SmartApply] [${pageLabel}] Review page detected — not clicking Submit.`);
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
        console.log(`[SmartApply] [${pageLabel}] Clicked Next at content bottom.`);
        await adapter.page.waitForTimeout(2000);
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }
      if (finalClick === 'review_detected') {
        console.log(`[SmartApply] [${pageLabel}] Review page detected at content bottom.`);
        return 'review';
      }
    }

    console.log(`[SmartApply] [${pageLabel}] Page complete. LLM calls: ${llmCalls}`);
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

      // Click a neutral area to trigger blur on any focused element.
      // Use coordinates unlikely to hit a button (top-left corner of viewport).
      await adapter.page.mouse.click(5, 5);
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
      const hasSubmit = buttons.some(b => (b.textContent?.trim().toLowerCase() || '') === 'submit');
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
      await adapter.act(prompt);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Too Many Requests')) {
        console.warn(`[SmartApply] [${label}] Rate limited (429) — waiting 30s before retry...`);
        await adapter.page.waitForTimeout(30_000);
        this.lastLlmCallTime = Date.now();
        await adapter.act(prompt);
        return;
      }
      throw error;
    }
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
