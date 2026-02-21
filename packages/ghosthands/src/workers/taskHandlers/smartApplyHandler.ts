import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PlatformConfig, PageState, PageType } from './platforms/types.js';
import { detectPlatformFromUrl } from './platforms/index.js';
import { ProgressStep } from '../progressTracker.js';

// --- Constants ---

const PAGE_TRANSITION_WAIT_MS = 3_000;
const MAX_FORM_PAGES = 15;

// --- Handler ---

export class SmartApplyHandler implements TaskHandler {
  readonly type = 'smart_apply';
  readonly description = 'Fill out a job application on any ATS platform (multi-step), stopping before submission';

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

    let pagesProcessed = 0;
    let lastPageUrl = '';
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

        // Stuck detection: if we keep seeing the same URL, we're looping
        if (currentPageUrl === lastPageUrl) {
          samePageCount++;
          if (samePageCount >= MAX_SAME_PAGE) {
            console.warn(`[SmartApply] Stuck on same page for ${samePageCount} iterations — stopping to avoid infinite loop.`);
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
          lastPageUrl = currentPageUrl;
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
            // We don't special-case by page type for generic sites. The LLM sees the
            // actual page and fills whatever is on screen. Platform configs with
            // custom experience handlers (e.g. Workday) override via handleCustomPageType.
            if (
              (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload') &&
              config.needsCustomExperienceHandler && config.handleExperiencePage
            ) {
              await progress.setStep(ProgressStep.UPLOADING_RESUME);
              await config.handleExperiencePage(adapter, userProfile, dataPrompt);
            } else {
              const step = (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload')
                ? ProgressStep.UPLOADING_RESUME
                : ProgressStep.FILLING_FORM;
              await progress.setStep(step as any);

              const fillPrompt = config.buildPagePrompt(pageState.page_type, dataPrompt);
              await this.fillWithSmartScroll(adapter, config, fillPrompt, qaMap, pageState.page_type);
            }
            await this.clickNextWithErrorRecovery(adapter, config, config.buildPagePrompt(pageState.page_type, dataPrompt), qaMap, pageState.page_type);
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

    // Tier 1: URL-based (fast, no LLM cost)
    const urlResult = config.detectPageByUrl(currentUrl);
    if (urlResult) return urlResult;

    // Tier 2: DOM-based (fast, no LLM cost)
    const domResult = await config.detectPageByDOM(adapter);
    if (domResult) return domResult;

    // Tier 3: LLM classification
    try {
      const urlHints: string[] = [];
      if (currentUrl.includes('signin') || currentUrl.includes('login')) urlHints.push('This appears to be a login page.');
      if (currentUrl.includes('job') || currentUrl.includes('position') || currentUrl.includes('career')) urlHints.push('This appears to be a job-related page.');

      const classificationPrompt = config.buildClassificationPrompt(urlHints);
      const llmResult = await adapter.extract(classificationPrompt, config.pageStateSchema);

      // SAFETY: If LLM says "review", do a second LLM check to confirm.
      // Many single-page forms (e.g. Amazon) show a Submit button on every
      // page, which fools the first classification. The verification prompt
      // explicitly asks the LLM to look for signs this is NOT the final review.
      if (llmResult.page_type === 'review') {
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

  // =========================================================================
  // Universal Page Handlers
  // =========================================================================

  private async handleJobListing(adapter: BrowserAutomationAdapter): Promise<void> {
    console.log('[SmartApply] On job listing page, clicking Apply...');

    const urlBefore = await adapter.getCurrentUrl();
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
      throw new Error(`Failed to create account: ${result.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  // =========================================================================
  // Fill + Scroll Loop
  // =========================================================================

  /**
   * Fill visible fields, then programmatically scroll down one viewport at a time,
   * filling any new fields that appear. Strategy: DOM-first, LLM-fallback.
   */
  private async fillWithSmartScroll(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
  ): Promise<void> {
    const MAX_SCROLL_ROUNDS = 10;
    const MAX_LLM_CALLS = 8;
    let llmCallCount = 0;
    let totalProgrammaticFills = 0;

    // Safety: check if this is actually the review page (misclassified)
    const isActuallyReview = await this.checkIfReviewPage(adapter);
    if (isActuallyReview) {
      console.log(`[SmartApply] [${pageLabel}] SAFETY: This is the review page — skipping all fill logic.`);
      return;
    }

    // Scroll to top first
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    // Dismiss error banners (if platform supports it)
    await this.dismissErrorBanners(adapter);

    // Round 1: DOM-first fill, then LLM for remaining fields
    console.log(`[SmartApply] [${pageLabel}] Round 1: DOM fill pass...`);
    if (Object.keys(qaMap).length > 0) {
      const programmaticFilled = await config.fillDropdownsProgrammatically(adapter, qaMap);
      if (programmaticFilled > 0) {
        console.log(`[SmartApply] [${pageLabel}] Programmatically filled ${programmaticFilled} dropdown(s)`);
        totalProgrammaticFills += programmaticFilled;
      }
    }
    await config.fillDateFieldsProgrammatically(adapter, qaMap);
    await config.checkRequiredCheckboxes(adapter);

    const needsLLM = await config.hasEmptyVisibleFields(adapter);
    if (needsLLM && llmCallCount < MAX_LLM_CALLS) {
      await config.centerNextEmptyField(adapter);
      const filledSummary = await this.getFilledFieldsSummary(adapter);
      const promptWithState = filledSummary ? `${filledSummary}\n${fillPrompt}` : fillPrompt;
      console.log(`[SmartApply] [${pageLabel}] LLM filling remaining fields (round 1, call ${llmCallCount + 1}/${MAX_LLM_CALLS})...`);
      await this.protectFilledFields(adapter);
      try {
        await adapter.act(promptWithState);
      } catch (actError) {
        console.warn(`[SmartApply] [${pageLabel}] LLM act() failed: ${actError instanceof Error ? actError.message : actError}`);
      } finally {
        try { await this.unprotectFields(adapter); } catch { /* page may have navigated */ }
      }
      llmCallCount++;
    } else if (llmCallCount >= MAX_LLM_CALLS) {
      console.log(`[SmartApply] [${pageLabel}] LLM call limit reached (${MAX_LLM_CALLS}) — skipping.`);
    } else {
      console.log(`[SmartApply] [${pageLabel}] All visible fields filled — skipping LLM.`);
    }

    // Scroll-and-fill loop
    for (let round = 2; round <= MAX_SCROLL_ROUNDS; round++) {
      const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
      const scrollMax = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );

      if (scrollBefore >= scrollMax - 10) {
        console.log(`[SmartApply] [${pageLabel}] Reached bottom of page.`);
        break;
      }

      // Scroll down 65% of viewport
      await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
      await adapter.page.waitForTimeout(800);

      const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
      if (scrollAfter <= scrollBefore) {
        console.log(`[SmartApply] [${pageLabel}] Cannot scroll further.`);
        break;
      }

      console.log(`[SmartApply] [${pageLabel}] Scrolled to ${scrollAfter}px (round ${round})...`);

      // DOM-first fills
      if (Object.keys(qaMap).length > 0) {
        const programmaticFilled = await config.fillDropdownsProgrammatically(adapter, qaMap);
        if (programmaticFilled > 0) {
          console.log(`[SmartApply] [${pageLabel}] Programmatically filled ${programmaticFilled} dropdown(s)`);
          totalProgrammaticFills += programmaticFilled;
        }
      }
      await config.fillDateFieldsProgrammatically(adapter, qaMap);
      await config.checkRequiredCheckboxes(adapter);

      if (llmCallCount >= MAX_LLM_CALLS) {
        console.log(`[SmartApply] [${pageLabel}] LLM call limit reached (${MAX_LLM_CALLS}) — skipping for round ${round}.`);
        continue;
      }
      const stillNeedsLLM = await config.hasEmptyVisibleFields(adapter);
      if (stillNeedsLLM) {
        await config.centerNextEmptyField(adapter);
        const filledSummary = await this.getFilledFieldsSummary(adapter);
        const promptWithState = filledSummary ? `${filledSummary}\n${fillPrompt}` : fillPrompt;
        console.log(`[SmartApply] [${pageLabel}] LLM filling remaining fields (round ${round}, call ${llmCallCount + 1}/${MAX_LLM_CALLS})...`);
        await this.protectFilledFields(adapter);
        try { await adapter.act(promptWithState); } finally { await this.unprotectFields(adapter); }
        llmCallCount++;
      } else {
        console.log(`[SmartApply] [${pageLabel}] All visible fields filled — skipping LLM.`);
      }
    }

    // GUARANTEE: Always call the LLM at least once per page.
    // DOM checks only detect standard HTML form elements (<input>, <select>, radio buttons).
    // Many sites use custom UI components (card selectors, toggle switches, styled buttons
    // representing choices) that only the LLM can see and interact with visually.
    // If we never called the LLM and had no programmatic fills, the page likely has
    // non-standard interactive elements that need LLM attention.
    if (llmCallCount === 0 && totalProgrammaticFills === 0) {
      console.log(`[SmartApply] [${pageLabel}] No fields detected by DOM — calling LLM once to handle any custom UI elements...`);
      await adapter.page.evaluate(() => window.scrollTo(0, 0));
      await adapter.page.waitForTimeout(500);
      try {
        await adapter.act(fillPrompt);
      } catch (actError) {
        console.warn(`[SmartApply] [${pageLabel}] LLM act() failed: ${actError instanceof Error ? actError.message : actError}`);
      }
      llmCallCount++;
    }

    console.log(`[SmartApply] [${pageLabel}] Page complete. Total LLM calls: ${llmCallCount}`);
  }

  // =========================================================================
  // Navigation + Error Recovery
  // =========================================================================

  /**
   * Click the Next/Continue button and handle validation errors with retries.
   */
  private async clickNextWithErrorRecovery(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    fillPrompt: string,
    qaMap: Record<string, string>,
    pageLabel: string,
  ): Promise<void> {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Scroll to bottom where the navigation button lives
      await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await adapter.page.waitForTimeout(800);

      const urlBefore = await adapter.getCurrentUrl();
      console.log(`[SmartApply] [${pageLabel}] Clicking Next (attempt ${attempt})...`);
      const clickResult = await config.clickNextButton(adapter);

      if (clickResult === 'review_detected') {
        console.log(`[SmartApply] [${pageLabel}] Review page detected — NOT clicking Submit.`);
        return;
      }

      // If DOM couldn't find a Next button, use LLM as fallback
      if (clickResult === 'not_found') {
        console.log(`[SmartApply] [${pageLabel}] No Next button found via DOM — trying LLM fallback...`);
        await adapter.act(
          'Click the button that advances to the next step of the application. ' +
          'Look for buttons labeled "Next", "Continue", "Proceed", "Save and Continue", "Review", or similar. ' +
          'Do NOT click "Submit" or "Submit Application". Report done after clicking.',
        );
      }

      // Wait for page response
      await adapter.page.waitForTimeout(2000);

      // Verify the page actually changed
      const urlAfter = await adapter.getCurrentUrl();
      const pageChanged = urlAfter !== urlBefore;

      // Check for validation errors
      const hasErrors = await config.detectValidationErrors(adapter);

      if (!hasErrors && pageChanged) {
        console.log(`[SmartApply] [${pageLabel}] Navigation succeeded.`);
        await this.waitForPageLoad(adapter);
        return;
      }

      if (!hasErrors && !pageChanged) {
        // No errors but page didn't change — might be a SPA that updates in-place
        // Wait a bit longer and check again
        await adapter.page.waitForTimeout(2000);
        const urlAfterWait = await adapter.getCurrentUrl();
        if (urlAfterWait !== urlBefore) {
          console.log(`[SmartApply] [${pageLabel}] Navigation succeeded (delayed).`);
          await this.waitForPageLoad(adapter);
          return;
        }
        // Page truly didn't change — treat as success for SPAs where URL stays the same
        // The stuck detection in the main loop will catch actual loops
        console.log(`[SmartApply] [${pageLabel}] Page URL unchanged — may be SPA navigation. Continuing.`);
        await this.waitForPageLoad(adapter);
        return;
      }

      console.log(`[SmartApply] [${pageLabel}] Validation errors detected! Attempting recovery...`);

      // Scroll to top to see error banners
      await adapter.page.evaluate(() => window.scrollTo(0, 0));
      await adapter.page.waitForTimeout(500);

      // Use LLM to handle errors — shorter prompt that focuses on the task
      await adapter.act(
        `Validation errors are showing on this page. Fix them:
1. If there are clickable error links at the top, click each one to jump to the missing field.
2. Fill the missing/invalid field with the correct value from the data mapping.
3. Click whitespace to deselect, then fix the next error.
Report the task as done when all visible errors are addressed.

${fillPrompt}`,
      );

      // Programmatic scroll pass to catch anything the LLM missed
      for (let scrollPass = 0; scrollPass < 5; scrollPass++) {
        const before = await adapter.page.evaluate(() => window.scrollY);
        const max = await adapter.page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight,
        );
        if (before >= max - 10) break;

        await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
        await adapter.page.waitForTimeout(800);

        const after = await adapter.page.evaluate(() => window.scrollY);
        if (after <= before) break;

        // DOM-first fills
        if (Object.keys(qaMap).length > 0) {
          await config.fillDropdownsProgrammatically(adapter, qaMap);
        }

        const hasEmpty = await config.hasEmptyVisibleFields(adapter);
        if (hasEmpty) {
          await adapter.act(
            `Fill any empty required fields visible on screen (marked with * or highlighted in red). If all fields are filled, report the task as done.

${fillPrompt}`,
          );
        }
      }
    }

    console.warn(`[SmartApply] [${pageLabel}] Still has errors after ${MAX_RETRIES} retries, proceeding...`);
    await this.waitForPageLoad(adapter);
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
   * Used as a lightweight safety net inside fillWithSmartScroll — NOT the
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
   * Make filled text fields readonly so the LLM agent physically cannot corrupt them.
   * This is the strongest defense against the LLM re-typing into already-filled fields.
   * Fields are tagged with data-gh-protected so we can restore them after the act() call.
   */
  private async protectFilledFields(adapter: BrowserAutomationAdapter): Promise<void> {
    const count = await adapter.page.evaluate(() => {
      let protected_count = 0;
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );
      for (const input of inputs) {
        if (!input.value || input.value.trim() === '') continue;
        if (input.readOnly) continue;
        if (input.type === 'hidden') continue;
        // Don't protect fields with very short values — likely just a prefix
        // (e.g. "+1" country code, "Mr" title) not a complete answer
        if (input.value.trim().length < 4) continue;
        const rect = input.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Don't protect inputs inside dropdowns (they need to be typeable for filtering)
        if (input.closest('[role="listbox"], [role="combobox"]')) continue;
        const style = window.getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        input.setAttribute('data-gh-protected', 'true');
        input.readOnly = true;
        protected_count++;
      }
      return protected_count;
    });
    if (count > 0) {
      console.log(`[SmartApply] Protected ${count} filled field(s) as readonly`);
    }
  }

  /**
   * Remove readonly protection from fields we previously locked.
   */
  private async unprotectFields(adapter: BrowserAutomationAdapter): Promise<void> {
    await adapter.page.evaluate(() => {
      const protectedEls = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-gh-protected="true"]');
      for (const el of protectedEls) {
        el.readOnly = false;
        el.removeAttribute('data-gh-protected');
      }
    });
  }

  /**
   * Scan the DOM for fields that already have values and return a summary string.
   * This is prepended to the LLM prompt so it knows which fields are DONE.
   */
  private async getFilledFieldsSummary(adapter: BrowserAutomationAdapter): Promise<string> {
    const filledFields = await adapter.page.evaluate(() => {
      const results: string[] = [];
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );
      for (const input of inputs) {
        if (!input.value || input.value.trim() === '') continue;
        if (input.type === 'hidden') continue;
        const rect = input.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Skip inputs inside dropdowns
        if (input.closest('[role="listbox"], [role="combobox"]')) continue;

        const style = window.getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Find the label
        let label = '';
        const labelEl = (input as HTMLInputElement).labels?.[0];
        if (labelEl) label = labelEl.textContent?.trim() || '';
        if (!label) label = input.getAttribute('aria-label') || '';
        if (!label) label = input.placeholder || '';
        if (!label) label = input.name || input.id || '';
        // Clean up
        label = label.replace(/\s*\*\s*/g, '').replace(/Required/gi, '').trim();
        if (!label) label = input.type || 'text';

        // Truncate long values for display
        const val = input.value.length > 30 ? input.value.substring(0, 27) + '...' : input.value;
        results.push(`  - "${label}": "${val}"`);
      }

      // Also check selects that have a value
      const selects = document.querySelectorAll<HTMLSelectElement>('select');
      for (const sel of selects) {
        if (sel.selectedIndex <= 0) continue;
        const rect = sel.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        let label = sel.labels?.[0]?.textContent?.trim() || sel.getAttribute('aria-label') || sel.name || 'dropdown';
        label = label.replace(/\s*\*\s*/g, '').replace(/Required/gi, '').trim();
        results.push(`  - "${label}": "${sel.options[sel.selectedIndex]?.text || sel.value}"`);
      }

      return results;
    });

    if (filledFields.length === 0) return '';

    return `ALREADY FILLED (${filledFields.length} fields) — DO NOT click on, clear, retype, or interact with ANY of these fields. They are correct even if values look truncated or short. Moving to a filled field and retyping WILL corrupt the data.\n${filledFields.join('\n')}\nOnly interact with EMPTY fields that have a matching value in the data mapping.\n`;
  }

  /**
   * Dismiss error banners so the LLM doesn't get distracted by them.
   */
  private async dismissErrorBanners(adapter: BrowserAutomationAdapter): Promise<void> {
    await adapter.page.evaluate(() => {
      // Hide common error banner patterns
      const errorBanners = document.querySelectorAll(
        '[data-automation-id="errorMessage"], [role="alert"]'
      );
      errorBanners.forEach(el => (el as HTMLElement).style.display = 'none');
      // Click "Errors Found" collapse buttons
      const errorSections = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(el => el.textContent?.includes('Errors Found'));
      errorSections.forEach(el => (el as HTMLElement).click());
    });
    await adapter.page.waitForTimeout(300);
  }
}
