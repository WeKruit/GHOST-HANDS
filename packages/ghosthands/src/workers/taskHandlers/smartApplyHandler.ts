import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PlatformConfig, PageState, PageType } from './platforms/types.js';
import { detectPlatformFromUrl } from './platforms/index.js';
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
            const result = await this.fillPage(adapter, config, fillPrompt, qaMap, pageState.page_type);

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

    // Tier 1: URL-based (fast, no LLM cost)
    const urlResult = config.detectPageByUrl(currentUrl);
    if (urlResult) return urlResult;

    // Tier 2: DOM-based (fast, no LLM cost)
    const domResult = await config.detectPageByDOM(adapter);
    if (domResult) return domResult;

    // Tier 3: LLM classification
    try {
      // Check page health before sending screenshot to LLM — broken pages
      // showing raw JS waste massive tokens (5-10k+ per screenshot)
      const healthy = await this.isPageHealthy(adapter);
      if (!healthy) {
        console.warn('[SmartApply] Page appears broken (raw JS/code visible) — skipping LLM classification.');
        const fallbackType = await config.classifyByDOMFallback(adapter);
        return { page_type: fallbackType, page_title: 'broken_page' };
      }

      const urlHints: string[] = [];
      if (currentUrl.includes('signin') || currentUrl.includes('login')) urlHints.push('This appears to be a login page.');
      if (currentUrl.includes('job') || currentUrl.includes('position') || currentUrl.includes('career')) urlHints.push('This appears to be a job-related page.');

      const classificationPrompt = config.buildClassificationPrompt(urlHints);
      await this.throttleLlm(adapter);
      const llmResult = await adapter.extract(classificationPrompt, config.pageStateSchema);

      // SAFETY: If LLM says "review", verify before stopping the application.
      // Many single-page forms (e.g. Amazon) show a Submit button on every
      // page, which fools the classification.
      if (llmResult.page_type === 'review') {
        // Quick DOM check first — if page has editable fields, it's definitely
        // NOT the review page. Saves ~1,875 tokens vs the LLM verification call.
        const hasEditableFields = await adapter.page.evaluate(() => {
          return document.querySelectorAll(
            'input[type="text"]:not([readonly]):not([disabled]), ' +
            'input[type="email"]:not([readonly]):not([disabled]), ' +
            'input[type="tel"]:not([readonly]):not([disabled]), ' +
            'textarea:not([readonly]):not([disabled]), ' +
            'select:not([disabled])'
          ).length > 0;
        });

        if (hasEditableFields) {
          console.log('[SmartApply] Page has editable fields — overriding "review" to "questions" (skipped LLM verify)');
          return { ...llmResult, page_type: 'questions' as PageType };
        }

        // DOM inconclusive — use expensive LLM verification as last resort
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
      throw new Error(`Failed to create account: ${result.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  // =========================================================================
  // Fill + Scroll Loop
  // =========================================================================

  /**
   * Fill the current page by alternating between two phases:
   *   Phase 1 (FILL):    DOM fills + LLM fills for visible empty fields.
   *   Phase 2 (ADVANCE): DOM clicks Next or scrolls to reveal more content.
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
  ): Promise<'navigated' | 'review' | 'complete'> {
    const MAX_ROUNDS = 15;
    const MAX_LLM_CALLS = 8;
    let llmCalls = 0;
    let consecutiveNoProgress = 0;

    // Safety: check if this is actually the review page (misclassified)
    if (await this.checkIfReviewPage(adapter)) {
      console.log(`[SmartApply] [${pageLabel}] SAFETY: This is the review page — skipping all fill logic.`);
      return 'review';
    }

    // Scroll to top
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      console.log(`[SmartApply] [${pageLabel}] Round ${round}...`);

      // ── PHASE 1: FILL (viewport-locked) ──

      // DOM-first fills (dropdowns, dates, checkboxes — no LLM cost)
      let domFills = 0;
      if (Object.keys(qaMap).length > 0) {
        domFills += await config.fillDropdownsProgrammatically(adapter, qaMap);
      }
      domFills += await config.fillDateFieldsProgrammatically(adapter, qaMap);
      domFills += await config.checkRequiredCheckboxes(adapter);
      if (domFills > 0) {
        console.log(`[SmartApply] [${pageLabel}] DOM filled ${domFills} field(s)`);
      }

      // LLM fills remaining visible fields (no scrolling, no button clicks)
      const hasEmpty = await config.hasEmptyVisibleFields(adapter);
      if (hasEmpty && llmCalls < MAX_LLM_CALLS) {
        // Snapshot field state BEFORE the LLM acts so we can detect whether it actually changed anything
        const fieldsBefore = await this.getVisibleFieldValues(adapter);

        console.log(`[SmartApply] [${pageLabel}] LLM call ${llmCalls + 1}/${MAX_LLM_CALLS}...`);
        try {
          await this.safeAct(adapter, fillPrompt, pageLabel);
        } catch (actError) {
          console.warn(`[SmartApply] [${pageLabel}] LLM act() failed: ${actError instanceof Error ? actError.message : actError}`);
        }
        llmCalls++;

        // Check if the LLM actually filled anything new
        const fieldsAfter = await this.getVisibleFieldValues(adapter);
        if (fieldsAfter !== fieldsBefore) {
          // LLM made progress — loop back to re-check (may have revealed conditional fields)
          consecutiveNoProgress = 0;
          continue;
        }
        // LLM didn't change anything (e.g. empty fields with no matching data) — fall through to Phase 2
        console.log(`[SmartApply] [${pageLabel}] LLM reported done with no field changes — advancing.`);
      }

      if (!hasEmpty) {
        console.log(`[SmartApply] [${pageLabel}] No empty fields visible.`);
      }

      // ── PHASE 2: ADVANCE (orchestrator-controlled) ──

      const urlBeforeClick = await adapter.getCurrentUrl();
      const fingerprintBeforeClick = await this.getPageFingerprint(adapter);

      // Try to click Next via DOM
      const clickResult = await config.clickNextButton(adapter);
      if (clickResult === 'clicked') {
        console.log(`[SmartApply] [${pageLabel}] Clicked Next via DOM.`);
        await adapter.page.waitForTimeout(2000);

        // Check for validation errors before declaring navigation success
        const hasErrors = await config.detectValidationErrors(adapter);
        if (hasErrors) {
          console.log(`[SmartApply] [${pageLabel}] Validation errors after clicking Next — scrolling to top for retry.`);
          await adapter.page.evaluate(() => window.scrollTo(0, 0));
          await adapter.page.waitForTimeout(500);
          consecutiveNoProgress = 0;
          continue; // Phase 1 again — fill the error fields
        }

        // Verify the page actually changed (URL or content fingerprint)
        const urlAfterClick = await adapter.getCurrentUrl();
        const fingerprintAfterClick = await this.getPageFingerprint(adapter);
        if (urlAfterClick !== urlBeforeClick || fingerprintAfterClick !== fingerprintBeforeClick) {
          await this.waitForPageLoad(adapter);
          return 'navigated';
        }

        // Page didn't change — might be SPA with delayed rendering. Wait and check once more.
        await adapter.page.waitForTimeout(2000);
        const urlAfterWait = await adapter.getCurrentUrl();
        const fingerprintAfterWait = await this.getPageFingerprint(adapter);
        if (urlAfterWait !== urlBeforeClick || fingerprintAfterWait !== fingerprintBeforeClick) {
          await this.waitForPageLoad(adapter);
          return 'navigated';
        }

        // Click happened but nothing changed — treat as not navigated and scroll
        console.log(`[SmartApply] [${pageLabel}] Clicked Next but page unchanged — scrolling to find more content.`);
      }
      if (clickResult === 'review_detected') {
        console.log(`[SmartApply] [${pageLabel}] Review page detected — not clicking Submit.`);
        return 'review';
      }

      // No Next button visible (or click didn't navigate) — scroll down to reveal more content
      const scrolled = await this.scrollDown(adapter);
      if (!scrolled) {
        // Can't scroll further — one last try at the content bottom
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

        console.log(`[SmartApply] [${pageLabel}] Reached content boundary — no Next button found.`);
        return 'complete';
      }

      console.log(`[SmartApply] [${pageLabel}] Scrolled down — checking for more fields.`);

      // Track consecutive rounds with no progress
      if (domFills === 0 && !hasEmpty) {
        consecutiveNoProgress++;
        if (consecutiveNoProgress >= 3) {
          console.log(`[SmartApply] [${pageLabel}] ${consecutiveNoProgress} empty rounds — stopping.`);
          break;
        }
      } else {
        consecutiveNoProgress = 0;
      }
    }

    console.log(`[SmartApply] [${pageLabel}] Page complete. LLM calls: ${llmCalls}`);
    return 'complete';
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
   * Scroll the viewport down by 65% of the window height.
   * Returns true if the scroll position actually changed.
   */
  private async scrollDown(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
    const scrollMax = await this.getContentScrollMax(adapter);

    if (scrollBefore >= scrollMax - 10) return false; // Already at content bottom

    await adapter.page.evaluate(() =>
      window.scrollBy({ top: Math.round(window.innerHeight * 0.65), behavior: 'smooth' }),
    );
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
