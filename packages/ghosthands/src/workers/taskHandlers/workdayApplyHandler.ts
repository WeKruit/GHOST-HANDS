import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import { ProgressStep } from '../progressTracker.js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { WorkdayUserProfile } from './workdayTypes.js';

// --- Constants ---

const PHONE_2FA_TIMEOUT_MS = 180_000; // 3 minutes
const PHONE_2FA_POLL_INTERVAL_MS = 5_000;
const PAGE_TRANSITION_WAIT_MS = 3_000;
const MAX_FORM_PAGES = 15; // safety limit to avoid infinite loops

// --- Page type detection schema ---

const PageStateSchema = z.object({
  page_type: z.enum([
    'job_listing',
    'login',
    'google_signin',
    'verification_code',
    'phone_2fa',
    'account_creation',
    'personal_info',
    'experience',
    'resume_upload',
    'questions',
    'voluntary_disclosure',
    'self_identify',
    'review',
    'confirmation',
    'error',
    'unknown',
  ]),
  page_title: z.string().optional().default(''),
  has_apply_button: z.boolean().optional().default(false),
  has_next_button: z.boolean().optional().default(false),
  has_submit_button: z.boolean().optional().default(false),
  has_sign_in_with_google: z.boolean().optional().default(false),
  error_message: z.string().optional().default(''),
});

type PageState = z.input<typeof PageStateSchema>;

// --- Handler ---

export class WorkdayApplyHandler implements TaskHandler {
  readonly type = 'workday_apply';
  readonly description = 'Fill out a Workday job application (multi-step), stopping before submission';

  /** Built during execute() for programmatic dropdown filling */
  private fullQAMap: Record<string, string> = {};

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
    const userProfile = job.input_data.user_data as WorkdayUserProfile;
    const qaOverrides = job.input_data.qa_overrides || {};

    console.log(`[WorkdayApply] Starting application for ${job.target_url}`);
    console.log(`[WorkdayApply] Applicant: ${userProfile.first_name} ${userProfile.last_name}`);

    // Build the data prompt with all user information
    const dataPrompt = this.buildDataPrompt(userProfile, qaOverrides);
    this.fullQAMap = this.buildFullQAMap(userProfile, qaOverrides);

    let pagesProcessed = 0;

    try {
      // Main detect-and-act loop
      while (pagesProcessed < MAX_FORM_PAGES) {
        pagesProcessed++;

        // Wait for page to settle after any navigation
        await this.waitForPageLoad(adapter);

        // Detect current page type
        const pageState = await this.detectPage(adapter);
        console.log(`[WorkdayApply] Page ${pagesProcessed}: ${pageState.page_type} (title: ${pageState.page_title || 'N/A'})`);

        // Handle based on page type
        switch (pageState.page_type) {
          case 'job_listing':
            await this.handleJobListing(adapter, pageState);
            break;

          case 'login':
          case 'google_signin':
            await this.handleLogin(adapter, pageState, userProfile);
            break;

          case 'verification_code':
            await this.handleVerificationCode(adapter);
            break;

          case 'phone_2fa':
            await this.handlePhone2FA(adapter);
            break;

          case 'account_creation':
            await this.handleAccountCreation(adapter, userProfile, dataPrompt);
            break;

          case 'personal_info':
            await progress.setStep(ProgressStep.FILLING_FORM);
            await this.handlePersonalInfoPage(adapter, userProfile, qaOverrides);
            break;

          case 'experience':
          case 'resume_upload':
            await progress.setStep(ProgressStep.UPLOADING_RESUME);
            await this.handleExperiencePage(adapter, userProfile);
            break;

          case 'questions':
            await progress.setStep(ProgressStep.ANSWERING_QUESTIONS);
            await this.handleFormPage(adapter, 'application questions', dataPrompt);
            break;

          case 'voluntary_disclosure':
            await progress.setStep(ProgressStep.ANSWERING_QUESTIONS);
            await this.handleVoluntaryDisclosure(adapter, dataPrompt);
            break;

          case 'self_identify':
            await progress.setStep(ProgressStep.ANSWERING_QUESTIONS);
            await this.handleSelfIdentify(adapter, dataPrompt);
            break;

          case 'review':
            // We've reached the review page — STOP HERE
            await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            console.log('\n' + '='.repeat(70));
            console.log('[WorkdayApply] APPLICATION FILLED SUCCESSFULLY');
            console.log('[WorkdayApply] Stopped at REVIEW page — NOT submitting.');
            console.log('[WorkdayApply] The browser is open for you to review and submit manually.');
            console.log('[WorkdayApply] DO NOT close this terminal until you are done.');
            console.log('='.repeat(70) + '\n');

            return {
              success: true,
              keepBrowserOpen: true,
              awaitingUserReview: true,
              data: {
                pages_processed: pagesProcessed,
                final_page: 'review',
                message: 'Application filled. Waiting for user to review and submit.',
              },
            };

          case 'confirmation':
            // This shouldn't happen (we don't submit), but handle gracefully
            console.warn('[WorkdayApply] Unexpected: landed on confirmation page');
            return {
              success: true,
              data: {
                pages_processed: pagesProcessed,
                final_page: 'confirmation',
                message: 'Application appears to have been submitted (unexpected).',
              },
            };

          case 'error':
            return {
              success: false,
              error: `Workday error page: ${pageState.error_message || 'Unknown error'}`,
              data: { pages_processed: pagesProcessed },
            };

          case 'unknown':
          default:
            // Try to handle as a generic form page
            console.log(`[WorkdayApply] Unknown page type, attempting generic form fill`);
            await this.handleGenericPage(adapter, dataPrompt);
            break;
        }
      }

      // Safety: hit max pages without reaching review
      console.warn(`[WorkdayApply] Reached max page limit (${MAX_FORM_PAGES}) without finding review page`);
      await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
      console.log('\n' + '='.repeat(70));
      console.log('[WorkdayApply] Reached page limit. Browser is open for manual takeover.');
      console.log('[WorkdayApply] DO NOT close this terminal until you are done.');
      console.log('='.repeat(70) + '\n');

      return {
        success: true,
        keepBrowserOpen: true,
        awaitingUserReview: true,
        data: {
          pages_processed: pagesProcessed,
          final_page: 'max_pages_reached',
          message: `Processed ${pagesProcessed} pages. Browser open for manual review.`,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[WorkdayApply] Error on page ${pagesProcessed}: ${msg}`);

      // If we fail mid-application, keep browser open so user can recover
      if (pagesProcessed > 2) {
        console.log('[WorkdayApply] Keeping browser open for manual recovery.');
        return {
          success: false,
          keepBrowserOpen: true,
          error: msg,
          data: { pages_processed: pagesProcessed },
        };
      }

      return {
        success: false,
        error: msg,
        data: { pages_processed: pagesProcessed },
      };
    }
  }

  // --- Page Detection ---

  private async detectPage(adapter: BrowserAutomationAdapter): Promise<PageState> {
    const currentUrl = await adapter.getCurrentUrl();

    // URL-based detection first — these are reliable and don't require LLM extraction
    // (Google's pages block DOMParser with TrustedHTML CSP, so extract() fails there)
    if (currentUrl.includes('accounts.google.com')) {
      // Password entry page — the worker can handle this automatically
      if (currentUrl.includes('/pwd') || currentUrl.includes('/identifier')) {
        return { page_type: 'google_signin', page_title: 'Google Sign-In (password)' };
      }
      // ANY /challenge/ URL (CAPTCHA, SMS, phone tap, verification code, etc.)
      // must be solved manually by the user. Don't try to automate these.
      if (currentUrl.includes('/challenge/')) {
        const challengeType = currentUrl.includes('recaptcha') ? 'CAPTCHA'
          : currentUrl.includes('ipp') ? 'Phone/SMS verification'
          : currentUrl.includes('dp') ? 'Device prompt'
          : 'Google challenge';
        return { page_type: 'phone_2fa', page_title: `${challengeType} (manual solve required)` };
      }
      return { page_type: 'google_signin', page_title: 'Google Sign-In' };
    }

    // DOM-based detection for sign-in pages — more reliable than LLM classification
    const domSignals = await adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const html = document.body.innerHTML.toLowerCase();
      return {
        hasSignInWithGoogle: bodyText.includes('sign in with google') || bodyText.includes('continue with google') || html.includes('google') && bodyText.includes('sign in'),
        hasSignIn: bodyText.includes('sign in') || bodyText.includes('log in'),
        hasApplyButton: bodyText.includes('apply') && !bodyText.includes('application questions'),
        hasSubmitApplication: bodyText.includes('submit application') || bodyText.includes('submit your application'),
      };
    });

    if (domSignals.hasSignInWithGoogle || (domSignals.hasSignIn && !domSignals.hasApplyButton && !domSignals.hasSubmitApplication)) {
      console.log('[WorkdayApply] DOM detected sign-in page');
      return { page_type: 'login', page_title: 'Workday Sign-In', has_sign_in_with_google: domSignals.hasSignInWithGoogle };
    }

    try {
      // URL-based hints to help the LLM
      const urlHints: string[] = [];
      if (currentUrl.includes('signin') || currentUrl.includes('login')) urlHints.push('This appears to be a login page.');
      if (currentUrl.includes('myworkdayjobs.com') && currentUrl.includes('/job/')) urlHints.push('This appears to be a Workday job listing.');

      const urlContext = urlHints.length > 0 ? `URL context: ${urlHints.join(' ')} ` : '';

      return await adapter.extract(
        `${urlContext}Analyze the current page and determine what type of page this is in a Workday job application process.

CLASSIFICATION RULES (check in this order):
1. If the page has a "Sign in with Google" button, OR shows login/sign-in options (even if "Create Account" is also present) → classify as "login".
2. If the page heading/title contains "Application Questions" or "Additional Questions" or you see screening questions (radio buttons, dropdowns, text inputs asking about eligibility, availability, referral source, etc.) → classify as "questions".
3. If the page shows a summary of the entire application with a prominent "Submit" or "Submit Application" button → classify as "review".
4. If the page heading says "My Experience" or "Work Experience" or asks for resume upload → classify as "experience" or "resume_upload".
5. If the page asks for name, email, phone, address fields → classify as "personal_info".
6. If the page heading says "Voluntary Disclosures" and asks about gender, race/ethnicity, veteran status → classify as "voluntary_disclosure".
7. If the page heading says "Self Identify" or "Self-Identification" or asks specifically about disability status (e.g. "Please indicate if you have a disability") → classify as "self_identify".
8. If the page asks about gender, race/ethnicity, veteran status, disability but doesn't match rules 6 or 7 → classify as "voluntary_disclosure".
9. If you see ONLY a "Create Account" or "Sign Up" form with no sign-in option → classify as "account_creation".

IMPORTANT: Pages titled "Application Questions (1 of N)" or "(2 of N)" are ALWAYS "questions", never "experience".
IMPORTANT: If a page has BOTH "Sign In" and "Create Account" options, classify as "login" (NOT "account_creation").`,
        PageStateSchema,
      );
    } catch (error) {
      console.warn(`[WorkdayApply] Page detection failed: ${error}`);
      // Fallback: DOM-based page classification when LLM extract fails
      // (e.g. BamlValidationError from null fields)
      if (currentUrl.includes('myworkdayjobs.com') && (currentUrl.includes('login') || currentUrl.includes('signin'))) {
        return { page_type: 'login', page_title: 'Workday Login' };
      }
      // DOM-based fallback: read the page heading text to classify
      // IMPORTANT: Check review FIRST because the review page contains ALL section headings
      // (e.g. "Application Questions", "My Information") as part of the summary.
      const domFallback = await adapter.page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id*="pageHeader"], [data-automation-id*="stepTitle"]'));
        const headingText = headings.map(h => h.textContent?.toLowerCase() || '').join(' ');

        // REVIEW page detection: The review page is a READ-ONLY summary with no form inputs,
        // just text showing what was filled in. It has a "Submit" button.
        // Key difference from the last form page: review has NO dropdowns ("Select One" buttons),
        // NO unfilled inputs, and the heading contains "Review".
        const hasSelectOneDropdowns = !!document.querySelector('button')
          && Array.from(document.querySelectorAll('button')).some(b => (b.textContent || '').trim() === 'Select One');
        const hasFormInputs = document.querySelectorAll('input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]').length > 0;

        if (headingText.includes('review')) return 'review';
        // If there are no editable form fields and no unfilled dropdowns, it's likely the review page
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const buttonTexts = buttons.map(b => (b.textContent || '').trim().toLowerCase());
        const hasSubmitButton = buttonTexts.some(t => t === 'submit' || t === 'submit application');
        const hasSaveAndContinue = buttonTexts.some(t => t.includes('save and continue'));
        if (hasSubmitButton && !hasSaveAndContinue && !hasSelectOneDropdowns && !hasFormInputs) return 'review';

        const allText = headingText + ' ' + bodyText.substring(0, 2000);
        if (allText.includes('application questions') || allText.includes('additional questions')) return 'questions';
        if (allText.includes('voluntary disclosures') || allText.includes('voluntary self')) return 'voluntary_disclosure';
        if (allText.includes('self identify') || allText.includes('self-identify') || allText.includes('disability status')) return 'self_identify';
        if (allText.includes('my experience') || allText.includes('work experience') || allText.includes('resume')) return 'experience';
        if (allText.includes('my information') || allText.includes('personal info')) return 'personal_info';
        return 'unknown';
      });
      if (domFallback !== 'unknown') {
        console.log(`[WorkdayApply] DOM fallback classified page as: ${domFallback}`);
      }
      return { page_type: domFallback, page_title: domFallback === 'unknown' ? 'N/A' : domFallback };
    }
  }

  // --- Page Handlers ---

  private async handleJobListing(adapter: BrowserAutomationAdapter, pageState: PageState): Promise<void> {
    console.log('[WorkdayApply] On job listing page, clicking Apply...');
    const result = await adapter.act(
      'Click the "Apply" button to start the job application. Look for buttons labeled "Apply", "Apply Now", "Apply for this job", or similar. If there are multiple apply buttons, click the main/primary one.',
    );
    if (!result.success) {
      throw new Error(`Failed to click Apply button: ${result.message}`);
    }
    await this.waitForPageLoad(adapter);
  }

  private async handleLogin(adapter: BrowserAutomationAdapter, pageState: PageState, userProfile: WorkdayUserProfile): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();
    const email = userProfile.email;
    const password = process.env.TEST_GMAIL_PASSWORD || '';

    // If we're on Google's sign-in page, handle each sub-page with DOM clicks
    // instead of act() to prevent the LLM from navigating into CAPTCHA pages.
    if (currentUrl.includes('accounts.google.com')) {
      console.log(`[WorkdayApply] On Google sign-in page for ${email}...`);

      // Detect which Google sub-page we're on via DOM
      // IMPORTANT: Google puts HIDDEN input[type="password"] on the email page
      // (aria-hidden="true", tabindex="-1") so we must check VISIBILITY, not just presence.
      // Also check password BEFORE account_chooser since password pages have [data-email].
      // Use string-based evaluate to avoid bundler injecting __name into browser context
      const googlePageType = await adapter.page.evaluate(`
        (() => {
          const targetEmail = ${JSON.stringify(email)}.toLowerCase();
          const bodyText = document.body.innerText.toLowerCase();

          // Check visibility: skip aria-hidden, display:none, zero-size elements
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

          // Password page first (password pages also have data-email attributes)
          if (hasVisiblePassword) return { type: 'password_entry', found: true };
          if (hasVisibleEmail) return { type: 'email_entry', found: true };

          // Account chooser
          const accountLinks = document.querySelectorAll('[data-email], [data-identifier]');
          for (const el of accountLinks) {
            const addr = (el.getAttribute('data-email') || el.getAttribute('data-identifier') || '').toLowerCase();
            if (addr === targetEmail) return { type: 'account_chooser', found: true };
          }
          if (bodyText.includes('choose an account') || bodyText.includes('select an account')) {
            return { type: 'account_chooser', found: true };
          }

          return { type: 'unknown', found: false };
        })()
      `) as { type: string; found: boolean };

      switch (googlePageType.type) {
        case 'account_chooser': {
          // Click the account via DOM — do NOT use act() which would let the LLM
          // navigate through CAPTCHA/challenge pages
          console.log('[WorkdayApply] Account chooser detected — clicking account via DOM...');
          const clicked = await adapter.page.evaluate((targetEmail: string) => {
            // Try data-email attribute first
            const byAttr = document.querySelector(`[data-email="${targetEmail}" i], [data-identifier="${targetEmail}" i]`);
            if (byAttr) { (byAttr as HTMLElement).click(); return true; }

            // Try finding by email text content
            const allClickable = document.querySelectorAll('div[role="link"], li[role="option"], a, div[tabindex], li[data-email]');
            for (const el of allClickable) {
              if (el.textContent?.toLowerCase().includes(targetEmail.toLowerCase())) {
                (el as HTMLElement).click();
                return true;
              }
            }

            // Broader fallback: any element containing the email
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
              const text = el.textContent?.toLowerCase() || '';
              if (text.includes(targetEmail.toLowerCase()) && el.children.length < 5) {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          }, email);

          if (!clicked) {
            console.warn('[WorkdayApply] Could not click account in chooser, falling back to LLM');
            await adapter.act(`Click on the account "${email}" to sign in with it.`);
          }

          // Return immediately — the main loop will re-detect the page.
          // If a CAPTCHA appears, detectPage() will catch it and route to handlePhone2FA.
          await adapter.page.waitForTimeout(2000);
          return;
        }

        case 'email_entry': {
          console.log('[WorkdayApply] Email entry page — typing email via DOM...');
          // Use :visible pseudo-class to skip hidden inputs Google puts in the DOM
          const emailInput = adapter.page.locator('input[type="email"]:visible').first();
          await emailInput.fill(email);
          await adapter.page.waitForTimeout(300);
          // Click "Next" button
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
          await adapter.page.waitForTimeout(2000);
          return;
        }

        case 'password_entry': {
          console.log('[WorkdayApply] Password entry page — typing password via DOM...');
          // Use :visible pseudo-class to skip hidden inputs Google puts in the DOM
          const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
          await passwordInput.fill(password);
          await adapter.page.waitForTimeout(300);
          // Click "Next" button
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
          await adapter.page.waitForTimeout(2000);
          return;
        }

        default: {
          // Unknown Google page — use LLM as fallback but with strict instruction
          console.log('[WorkdayApply] Unknown Google page — using LLM fallback...');
          await adapter.act(
            `This is a Google sign-in page. Do exactly ONE of these actions, then STOP:
1. If you see an existing account for "${email}", click on it.
2. If you see an "Email or phone" field, type "${email}" and click "Next".
3. If you see a "Password" field, type "${password}" and click "Next".
Do NOT interact with CAPTCHAs, reCAPTCHAs, or image challenges. If you see one, STOP immediately.`,
          );
          await adapter.page.waitForTimeout(2000);
          return;
        }
      }
    }

    // Otherwise we're on the Workday login page — click "Sign in with Google"
    console.log('[WorkdayApply] On login page, clicking Sign in with Google...');

    // Use Playwright locator click (real mouse events) — JS .click() doesn't
    // trigger Workday's event handlers for navigation buttons.
    let clicked = false;
    const googleBtnSelectors = [
      'button:has-text("Sign in with Google")',
      'button:has-text("Continue with Google")',
      'a:has-text("Sign in with Google")',
      '[data-automation-id*="google" i]',
    ];
    for (const sel of googleBtnSelectors) {
      try {
        const btn = adapter.page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click();
          clicked = true;
          console.log('[WorkdayApply] Clicked "Sign in with Google" via Playwright locator.');
          break;
        }
      } catch { /* try next selector */ }
    }

    if (!clicked) {
      // Fallback to LLM
      const result = await adapter.act(
        'Look for a "Sign in with Google" button, a Google icon/logo button, or a "Continue with Google" option and click it. If there is no Google sign-in option, look for "Sign In" or "Log In" button instead.',
      );
      if (!result.success) {
        console.warn(`[WorkdayApply] Google sign-in button not found, trying generic sign-in: ${result.message}`);
        await adapter.act('Click the "Sign In", "Log In", or "Create Account" button.');
      }
    }

    await this.waitForPageLoad(adapter);
  }

  private async handleVerificationCode(adapter: BrowserAutomationAdapter): Promise<void> {
    console.log('[WorkdayApply] Verification code required. Checking Gmail for code...');

    // Open Gmail in a new approach — navigate to it
    const currentUrl = await adapter.getCurrentUrl();

    // Navigate to Gmail to get the verification code
    await adapter.navigate('https://mail.google.com');
    await this.waitForPageLoad(adapter);

    // Extract the verification code from the latest email
    const codeResult = await adapter.extract(
      'Find the most recent email that contains a verification code, security code, or one-time password (OTP). Extract the numeric or alphanumeric code from it.',
      z.object({
        code: z.string(),
        found: z.boolean(),
      }),
    );

    if (!codeResult.found || !codeResult.code) {
      throw new Error('Could not find verification code in Gmail');
    }

    console.log(`[WorkdayApply] Found verification code: ${codeResult.code}`);

    // Go back to the verification page
    await adapter.navigate(currentUrl);
    await this.waitForPageLoad(adapter);

    // Enter the code
    const enterResult = await adapter.act(
      `Enter the verification code "${codeResult.code}" into the verification code input field and click the "Next", "Verify", "Continue", or "Submit" button.`,
    );

    if (!enterResult.success) {
      throw new Error(`Failed to enter verification code: ${enterResult.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  private async handlePhone2FA(adapter: BrowserAutomationAdapter): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();
    // Any Google /challenge/ page needs manual intervention — just poll URL changes
    const isGoogleChallenge = currentUrl.includes('accounts.google.com') && currentUrl.includes('/challenge/');

    console.log('\n' + '='.repeat(70));
    console.log('[WorkdayApply] MANUAL ACTION REQUIRED');
    if (currentUrl.includes('recaptcha')) {
      console.log('[WorkdayApply] Type: CAPTCHA — solve the image challenge in the browser.');
    } else if (currentUrl.includes('ipp')) {
      console.log('[WorkdayApply] Type: SMS/Phone verification — check your phone and approve or enter the code.');
    } else {
      console.log('[WorkdayApply] Type: Google security challenge — complete it in the browser.');
    }
    console.log(`[WorkdayApply] URL: ${currentUrl}`);
    console.log(`[WorkdayApply] Waiting up to ${PHONE_2FA_TIMEOUT_MS / 1000} seconds...`);
    console.log('='.repeat(70) + '\n');

    const startTime = Date.now();
    const startUrl = currentUrl;

    while (Date.now() - startTime < PHONE_2FA_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, PHONE_2FA_POLL_INTERVAL_MS));

      const nowUrl = await adapter.getCurrentUrl();
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // If URL changed, the challenge was solved
      if (nowUrl !== startUrl) {
        console.log(`[WorkdayApply] Challenge resolved after ${elapsed}s. Continuing...`);
        return;
      }

      // For Google challenges, just poll URL changes (don't waste LLM calls)
      if (isGoogleChallenge) {
        console.log(`[WorkdayApply] Still waiting for manual action... (${elapsed}s elapsed)`);
        continue;
      }

      // For non-Google 2FA, also check if the page content changed
      const pageCheck = await adapter.extract(
        'Is there still a 2FA/two-factor authentication prompt on this page asking the user to approve on their phone?',
        z.object({ still_waiting: z.boolean() }),
      );

      if (!pageCheck.still_waiting) {
        console.log(`[WorkdayApply] Challenge resolved after ${elapsed}s. Continuing...`);
        return;
      }

      console.log(`[WorkdayApply] Still waiting for manual action... (${elapsed}s elapsed)`);
    }

    throw new Error('Phone 2FA timed out after 3 minutes. Please try again.');
  }

  private async handleAccountCreation(
    adapter: BrowserAutomationAdapter,
    userProfile: WorkdayUserProfile,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Account creation page detected, filling in details...');

    const result = await adapter.act(
      `Fill out the account creation form with the provided user information, then click "Create Account", "Register", "Continue", or "Next". ${dataPrompt}`,
    );

    if (!result.success) {
      throw new Error(`Failed to create account: ${result.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  /**
   * Fill the personal info page by going top-to-bottom with programmatic scrolling.
   */
  private async handlePersonalInfoPage(
    adapter: BrowserAutomationAdapter,
    profile: WorkdayUserProfile,
    qaOverrides: Record<string, string>,
  ): Promise<void> {
    console.log('[WorkdayApply] Filling personal info page (top-down with smart scroll)...');

    const qaList = Object.entries(qaOverrides)
      .map(([q, a]) => `"${q}" → ${a}`)
      .join('\n  ');

    const dataBlock = `DATA:
  First Name: ${profile.first_name}
  Last Name: ${profile.last_name}
  Email: ${profile.email}
  Phone: ${profile.phone} (device type: Mobile, country code: +1 United States)
  Country: ${profile.address.country}
  Street Address: ${profile.address.street}
  City: ${profile.address.city}
  State: ${profile.address.state}
  Postal Code: ${profile.address.zip}

SCREENING QUESTIONS (if any appear on this page):
  ${qaList}
  For any question not listed, pick the most reasonable answer.`;

    const fillPrompt = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown button, question text, or input box is cut off at the top or bottom edge of the screen, it is NOT fully visible — DO NOT interact with it at all. Only touch fields where the ENTIRE element is within the viewport. When in doubt, skip it. IMPORTANT: if you already typed a value into a field but CANNOT see the text you typed (because the field is near the edge of the screen), DO NOT type again — the value is there, you just can't see it. Move on.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field. Typing into the same field multiple times causes duplicate text (e.g. "WuWuWu" instead of "Wu").

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field (e.g. Middle Name instead of Last Name).

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

Fill any EMPTY form fields that are FULLY visible on screen, from TOP to BOTTOM:
1. If the field already has ANY value (even if formatted differently), SKIP IT entirely.
2. Phone numbers like "(408) 555-1234" are CORRECTLY formatted by Workday — do NOT re-enter them.
3. If the field is truly empty (blank/no text): CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.
4. DROPDOWNS: After clicking a dropdown, ALWAYS TYPE your desired answer first (e.g. type "No", "Yes", "Male", "Website") to filter the list, then click the matching option. The popup menu that appears after you click a dropdown ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions on the page. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try typing a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
5. DATE FIELDS (MM/DD/YYYY): Click on the MM (month) part FIRST, then type the full date as continuous digits with NO slashes (e.g. "02182026" for Feb 18, 2026). For "today's date" or "signature date", type "02182026" (which is 02/18/2026). For "expected graduation date" use 05012027.
6. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'personal info');
  }

  /**
   * Handle a questions/application-questions page.
   * Reads each question, then answers one at a time with smart scrolling.
   */
  private async handleFormPage(
    adapter: BrowserAutomationAdapter,
    pageDescription: string,
    dataPrompt: string,
  ): Promise<void> {
    console.log(`[WorkdayApply] Filling ${pageDescription} page...`);

    const fillPrompt = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown button, question text, or input box is cut off at the top or bottom edge of the screen, it is NOT fully visible — DO NOT interact with it at all. Only touch fields where the ENTIRE element is within the viewport. When in doubt, skip it. IMPORTANT: if you already typed a value into a field but CANNOT see the text you typed (because the field is near the edge of the screen), DO NOT type again — the value is there, you just can't see it. Move on.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

You are on a "${pageDescription}" form page. Fill any EMPTY questions/fields that are FULLY visible on screen, from top to bottom:
1. If the field already has ANY value (even if formatted differently), SKIP IT.
2. Phone numbers like "(408) 555-1234" are CORRECTLY formatted — do NOT re-enter them.
3. If truly empty: CLICK on it, read the label, type or select the correct answer.
4. DROPDOWNS: After clicking a dropdown, ALWAYS TYPE your desired answer first (e.g. type "No", "Yes", "Website") to filter the list, then click the matching option. The popup menu that appears after you click a dropdown ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try typing a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
5. DATE FIELDS (MM/DD/YYYY): Click on the MM part FIRST, then type continuous digits (e.g. "02182026"). For "today's date" or "signature date", type "02182026". For "expected graduation date" use 05012027.
6. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataPrompt}`;

    await this.fillWithSmartScroll(adapter, fillPrompt, pageDescription);
  }

  /**
   * Handle the "My Experience" page: upload resume via DOM, then use LLM agent
   * to fill work experience, education, skills, and LinkedIn.
   *
   * This page uses a CUSTOM scroll+LLM loop instead of fillWithSmartScroll because:
   * - Fields are hidden behind "Add" buttons (hasEmptyVisibleFields returns false)
   * - The LLM must ALWAYS be invoked to click "Add" and fill expanded forms
   * - More LLM calls are needed (6 vs 4) due to multiple sections
   */
  private async handleExperiencePage(
    adapter: BrowserAutomationAdapter,
    userProfile: WorkdayUserProfile,
  ): Promise<void> {
    console.log('[WorkdayApply] On My Experience page — uploading resume via DOM, then LLM fills sections...');

    // Scroll to top first
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    // ==================== DOM-ONLY: Upload Resume ====================
    if (userProfile.resume_path) {
      console.log('[WorkdayApply] [MyExperience] Uploading resume via DOM...');
      const resumePath = path.isAbsolute(userProfile.resume_path)
        ? userProfile.resume_path
        : path.resolve(process.cwd(), userProfile.resume_path);

      if (!fs.existsSync(resumePath)) {
        console.warn(`[WorkdayApply] [MyExperience] Resume not found at ${resumePath} — skipping upload.`);
      } else {
        try {
          const fileInput = adapter.page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(resumePath);
          console.log('[WorkdayApply] [MyExperience] Resume file set via DOM file input.');
          await adapter.page.waitForTimeout(5000);

          const uploadOk = await adapter.page.evaluate(() => {
            return document.body.innerText.toLowerCase().includes('successfully uploaded')
              || document.body.innerText.toLowerCase().includes('successfully');
          });
          if (uploadOk) {
            console.log('[WorkdayApply] [MyExperience] Resume upload confirmed.');
          } else {
            console.warn('[WorkdayApply] [MyExperience] Resume upload status unclear — continuing.');
          }
        } catch (err) {
          console.warn(`[WorkdayApply] [MyExperience] Resume upload failed: ${err}`);
        }
      }
    }

    // ==================== LLM fills everything else ====================
    // Build a data prompt with all experience/education/skills/linkedin info
    const exp = userProfile.experience?.[0];
    const edu = userProfile.education?.[0];

    let dataBlock = `CRITICAL — DO NOT TOUCH THESE SECTIONS:
- "Websites" section: Do NOT click its "Add" button. Do NOT interact with it at all. Leave it completely empty. Clicking "Add" on Websites creates a required URL field that causes errors.
- "Certifications" section: Do NOT click its "Add" button. Leave it empty.
- Do NOT add more than one work experience entry.
- Do NOT add more than one education entry.

MY EXPERIENCE PAGE DATA:
`;

    if (exp) {
      const fromDate = exp.start_date ? (() => {
        const parts = exp.start_date.split('-');
        return parts.length >= 2 ? `${parts[1]}/${parts[0]}` : exp.start_date;
      })() : '';
      dataBlock += `
WORK EXPERIENCE (click "Add" under Work Experience section first):
  Job Title: ${exp.title}
  Company: ${exp.company}
  Location: ${exp.location || ''}
  I currently work here: ${exp.currently_work_here ? 'YES — check the checkbox' : 'No'}
  From date: ${fromDate} — IMPORTANT: The date field has TWO parts side by side: MM on the LEFT and YYYY on the RIGHT. You MUST click on the LEFT part (the MM box) first, NOT the right part (YYYY). Then type "${fromDate.replace('/', '')}" as continuous digits — Workday will auto-advance from the MM box to the YYYY box as you type.
  Role Description: ${exp.description}
`;
    }

    if (edu) {
      dataBlock += `
EDUCATION (click "Add" under Education section first):
  School or University: ${edu.school}
  Degree: ${edu.degree} (this is a DROPDOWN — click it, then type "${edu.degree}" to filter and select)
  Field of Study: ${edu.field_of_study} (this is a TYPEAHEAD — type "${edu.field_of_study}", wait for suggestions to load, then press Enter to select the first match)
`;
    }

    if (userProfile.skills && userProfile.skills.length > 0) {
      dataBlock += `
SKILLS (find the skills input field, usually has placeholder "Type to Add Skills"):
  For EACH skill below: click the skills input, type the skill name, WAIT for the autocomplete dropdown to appear, then press Enter to select the first match. After selecting, click on empty whitespace to dismiss the dropdown before typing the next skill.
  Skills to add: ${userProfile.skills.map(s => `"${s}"`).join(', ')}
`;
    }

    if (userProfile.linkedin_url) {
      dataBlock += `
LINKEDIN (under "Social Network URLs" section — NOT under "Websites"):
  LinkedIn: ${userProfile.linkedin_url}
  NOTE: The LinkedIn field is in the "Social Network URLs" section, which is DIFFERENT from the "Websites" section. Only fill the LinkedIn field.
`;
    }

    const fillPrompt = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown button, question text, or input box is cut off at the top or bottom edge of the screen, it is NOT fully visible — DO NOT interact with it at all. Only touch fields where the ENTIRE element is within the viewport. When in doubt, skip it. IMPORTANT: if you already typed a value into a field but CANNOT see the text you typed (because the field is near the edge of the screen), DO NOT type again — the value is there, you just can't see it. Move on.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field (e.g. Middle Name instead of Last Name).

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

This is the "My Experience" page. Fill any EMPTY fields/sections that are FULLY visible on screen.

IMPORTANT INTERACTION PATTERNS:
1. "Add" BUTTONS: ONLY click "Add" under "Work Experience" and "Education" sections. Do NOT click "Add" under "Websites" or "Certifications" — those must stay empty. If the form fields are already expanded (you can see Job Title, Company, etc.), do NOT click Add again.
2. DROPDOWNS (e.g. Degree): Click the dropdown button, then TYPE your desired value to filter the list, then click the matching option from the dropdown.
3. TYPEAHEAD FIELDS (e.g. Field of Study, Skills): Type the value, WAIT 2-3 seconds for the autocomplete suggestions to load, then press Enter to select the first match.
4. DATE FIELDS (MM/YYYY): The date has TWO boxes side by side — MM on the LEFT, YYYY on the RIGHT. Click on the LEFT box (MM) first. Then type the digits continuously (e.g. "012026"). Workday auto-advances from MM to YYYY. NEVER click on the right/YYYY box directly.
5. CHECKBOXES: Click directly on the checkbox or its label text.
6. After filling each field, CLICK on empty whitespace to deselect before moving to the next field.

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;

    // Custom scroll+LLM loop: ALWAYS invoke LLM each round because fields
    // are behind "Add" buttons that hasEmptyVisibleFields() can't detect.
    const MAX_SCROLL_ROUNDS = 8;
    const MAX_LLM_CALLS = 6;
    let llmCallCount = 0;

    // Scroll to top
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    for (let round = 1; round <= MAX_SCROLL_ROUNDS; round++) {
      // Always invoke LLM — experience page has dynamic content behind Add buttons
      if (llmCallCount < MAX_LLM_CALLS) {
        // Center the next empty field so the LLM sees it mid-screen (not at an edge)
        await this.centerNextEmptyField(adapter);
        console.log(`[WorkdayApply] [MyExperience] LLM fill round ${round} (call ${llmCallCount + 1}/${MAX_LLM_CALLS})...`);
        await adapter.act(fillPrompt);
        llmCallCount++;
        await adapter.page.waitForTimeout(1000);
      }

      // Check if we can scroll further
      const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
      const scrollMax = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );

      if (scrollBefore >= scrollMax - 10) {
        console.log('[WorkdayApply] [MyExperience] Reached bottom of page.');
        break;
      }

      // Scroll down 65% of viewport
      await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
      await adapter.page.waitForTimeout(800);

      const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
      if (scrollAfter <= scrollBefore) {
        console.log('[WorkdayApply] [MyExperience] Cannot scroll further.');
        break;
      }

      console.log(`[WorkdayApply] [MyExperience] Scrolled to ${scrollAfter}px (round ${round})...`);
    }

    console.log(`[WorkdayApply] [MyExperience] Page complete. Total LLM calls: ${llmCallCount}`);

    // Navigate: click Save and Continue with error recovery
    await this.clickNextWithErrorRecovery(adapter, fillPrompt, 'my experience');
  }

  private async handleVoluntaryDisclosure(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Filling voluntary self-identification page...');

    const fillPrompt = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown button, question text, or input box is cut off at the top or bottom edge of the screen, it is NOT fully visible — DO NOT interact with it at all. Only touch fields where the ENTIRE element is within the viewport. When in doubt, skip it. IMPORTANT: if you already typed a value into a field but CANNOT see the text you typed (because the field is near the edge of the screen), DO NOT type again — the value is there, you just can't see it. Move on.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

This is a voluntary self-identification page. Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Gender → type "Male"
   - Race/Ethnicity → type "Asian"
   - Veteran Status → type "not a protected"
   - Disability → type "do not wish"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.

If ALL visible questions already have answers, STOP IMMEDIATELY.`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'voluntary disclosure');
  }

  private async handleSelfIdentify(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Filling self-identification page...');

    const fillPrompt = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown button, question text, or input box is cut off at the top or bottom edge of the screen, it is NOT fully visible — DO NOT interact with it at all. Only touch fields where the ENTIRE element is within the viewport. When in doubt, skip it. IMPORTANT: if you already typed a value into a field but CANNOT see the text you typed (because the field is near the edge of the screen), DO NOT type again — the value is there, you just can't see it. Move on.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

This is a self-identification page (often about disability status). Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a field/dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Disability Status → type "do not wish"
   - Any other question → type "Decline"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.

If ALL visible questions already have answers, STOP IMMEDIATELY.`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'self-identify');
  }

  private async handleGenericPage(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Handling generic/unknown page...');

    const fillPrompt = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown button, question text, or input box is cut off at the top or bottom edge of the screen, it is NOT fully visible — DO NOT interact with it at all. Only touch fields where the ENTIRE element is within the viewport. When in doubt, skip it. IMPORTANT: if you already typed a value into a field but CANNOT see the text you typed (because the field is near the edge of the screen), DO NOT type again — the value is there, you just can't see it. Move on.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

Look at this page. Fill any EMPTY form fields that are FULLY visible, from top to bottom:
1. If a field already has ANY value, SKIP IT — do not re-enter or "fix" it.
2. If truly empty: CLICK the field, type/select the correct value, CLICK whitespace to deselect.
3. DROPDOWNS: After clicking a dropdown, ALWAYS TYPE your desired answer first to filter the list, then click the match. The popup menu ALWAYS belongs to the dropdown you just clicked. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.

If ALL fields already have values or no form fields exist, STOP IMMEDIATELY.

${dataPrompt}`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'generic');
  }

  // --- Helpers ---

  /**
   * Fill visible fields, then programmatically scroll down one viewport at a time,
   * filling any new fields that appear. Repeats until we've reached the bottom.
   * Finally clicks "Save and Continue" / "Next".
   *
   * Strategy: DOM-first, LLM-fallback.
   *   1. Programmatically fill all dropdowns we can match (no LLM needed).
   *   2. Let the LLM handle remaining text fields and any dropdowns we couldn't match.
   *   3. Scroll down and repeat.
   *
   * Early-exit: If there are no empty fields visible (DOM check), skip the LLM
   * call entirely for that scroll round. This prevents the LLM from "triple-checking"
   * fields that are already filled.
   */
  private async fillWithSmartScroll(
    adapter: BrowserAutomationAdapter,
    fillPrompt: string,
    pageLabel: string,
  ): Promise<void> {
    const MAX_SCROLL_ROUNDS = 10;
    const MAX_LLM_CALLS = 4; // Safety limit: max LLM invocations per page to prevent infinite loops
    let llmCallCount = 0;

    // SAFETY: Quick check if this is actually the review page (misclassified).
    // If so, bail out immediately — the main loop will re-detect and stop.
    const isActuallyReview = await adapter.page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
      const isReviewHeading = headings.some(h => (h.textContent || '').toLowerCase().includes('review'));
      const buttons = Array.from(document.querySelectorAll('button'));
      const hasSubmit = buttons.some(b => (b.textContent?.trim().toLowerCase() || '') === 'submit');
      const hasSaveAndContinue = buttons.some(b => (b.textContent?.trim().toLowerCase() || '').includes('save and continue'));
      const hasSelectOne = buttons.some(b => (b.textContent?.trim() || '') === 'Select One');
      const hasEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
      ).length > 0;
      return isReviewHeading && hasSubmit && !hasSaveAndContinue && !hasSelectOne && !hasEditableInputs;
    });
    if (isActuallyReview) {
      console.log(`[WorkdayApply] [${pageLabel}] SAFETY: This is the review page — skipping all fill logic.`);
      return;
    }

    // Scroll to top first
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    // Dismiss/collapse any Workday error banners so the LLM doesn't get distracted by them.
    // We handle errors ourselves in clickNextWithErrorRecovery.
    await adapter.page.evaluate(() => {
      const errorBanners = document.querySelectorAll(
        '[data-automation-id="errorMessage"], [role="alert"]'
      );
      errorBanners.forEach(el => (el as HTMLElement).style.display = 'none');
      const errorSections = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(el => el.textContent?.includes('Errors Found'));
      errorSections.forEach(el => (el as HTMLElement).click());
    });
    await adapter.page.waitForTimeout(300);

    // Round 1: DOM-first dropdown fill + date fill, then LLM for text fields
    console.log(`[WorkdayApply] [${pageLabel}] Round 1: DOM fill pass...`);
    if (Object.keys(this.fullQAMap).length > 0) {
      const programmaticFilled = await this.fillDropdownsProgrammatically(adapter);
      if (programmaticFilled > 0) {
        console.log(`[WorkdayApply] [${pageLabel}] Programmatically filled ${programmaticFilled} dropdown(s)`);
      }
    }
    // DOM-first: fill date fields
    await this.fillDateFieldsProgrammatically(adapter);
    // DOM-first: check any required checkboxes (Terms & Conditions, Privacy, etc.)
    await this.checkRequiredCheckboxes(adapter);

    // Check if there are empty fields remaining that need the LLM
    const needsLLM = await this.hasEmptyVisibleFields(adapter);
    if (needsLLM && llmCallCount < MAX_LLM_CALLS) {
      await this.centerNextEmptyField(adapter);
      console.log(`[WorkdayApply] [${pageLabel}] LLM filling remaining fields (round 1, call ${llmCallCount + 1}/${MAX_LLM_CALLS})...`);
      await adapter.act(fillPrompt);
      llmCallCount++;
    } else if (llmCallCount >= MAX_LLM_CALLS) {
      console.log(`[WorkdayApply] [${pageLabel}] LLM call limit reached (${MAX_LLM_CALLS}) — skipping.`);
    } else {
      console.log(`[WorkdayApply] [${pageLabel}] All visible fields filled — skipping LLM.`);
    }

    // Scroll-and-fill loop
    for (let round = 2; round <= MAX_SCROLL_ROUNDS; round++) {
      const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
      const scrollMax = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );

      if (scrollBefore >= scrollMax - 10) {
        console.log(`[WorkdayApply] [${pageLabel}] Reached bottom of page.`);
        break;
      }

      // Programmatic scroll: 65% of viewport height so we overlap and don't miss fields
      await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
      await adapter.page.waitForTimeout(800);

      const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
      if (scrollAfter <= scrollBefore) {
        console.log(`[WorkdayApply] [${pageLabel}] Cannot scroll further.`);
        break;
      }

      console.log(`[WorkdayApply] [${pageLabel}] Scrolled to ${scrollAfter}px (round ${round})...`);

      // DOM-first: fill dropdowns, date fields, and checkboxes programmatically
      if (Object.keys(this.fullQAMap).length > 0) {
        const programmaticFilled = await this.fillDropdownsProgrammatically(adapter);
        if (programmaticFilled > 0) {
          console.log(`[WorkdayApply] [${pageLabel}] Programmatically filled ${programmaticFilled} dropdown(s)`);
        }
      }
      await this.fillDateFieldsProgrammatically(adapter);
      await this.checkRequiredCheckboxes(adapter);

      // Only invoke the LLM if there are still empty fields visible AND we haven't hit the limit
      if (llmCallCount >= MAX_LLM_CALLS) {
        console.log(`[WorkdayApply] [${pageLabel}] LLM call limit reached (${MAX_LLM_CALLS}) — skipping for round ${round}.`);
        continue;
      }
      const stillNeedsLLM = await this.hasEmptyVisibleFields(adapter);
      if (stillNeedsLLM) {
        await this.centerNextEmptyField(adapter);
        console.log(`[WorkdayApply] [${pageLabel}] LLM filling remaining fields (round ${round}, call ${llmCallCount + 1}/${MAX_LLM_CALLS})...`);
        await adapter.act(fillPrompt);
        llmCallCount++;
      } else {
        console.log(`[WorkdayApply] [${pageLabel}] All visible fields filled — skipping LLM.`);
      }
    }

    console.log(`[WorkdayApply] [${pageLabel}] Page complete. Total LLM calls: ${llmCallCount}`);

    // Final: click the navigation button and handle validation errors
    await this.clickNextWithErrorRecovery(adapter, fillPrompt, pageLabel);
  }

  /**
   * Check whether the currently visible viewport has any empty form fields.
   * Returns true if there are empty text inputs, textareas, or unfilled dropdowns.
   * Used to decide whether to invoke the LLM (expensive) or skip.
   */
  private async hasEmptyVisibleFields(
    adapter: BrowserAutomationAdapter,
  ): Promise<boolean> {
    const result = await adapter.page.evaluate(() => {
      const emptyFields: string[] = [];

      // Check text inputs and textareas
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );
      for (const input of inputs) {
        // Only check visible, enabled fields
        const rect = input.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (input.disabled || input.readOnly) continue;
        if (input.type === 'hidden') continue;
        // Check if it's in the viewport
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

        // Skip Workday date segment inputs (MM, DD, YYYY) — they're handled by fillDateFieldsProgrammatically
        const placeholder = input.placeholder?.toUpperCase() || '';
        if (placeholder === 'MM' || placeholder === 'DD' || placeholder === 'YYYY') continue;

        // Skip inputs that are inside a dropdown/listbox container (internal to Workday dropdowns)
        const inDropdown = input.closest('[role="listbox"], [role="combobox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]');
        if (inDropdown) continue;

        // Skip very small inputs (< 20px wide) — likely hidden internal inputs
        if (rect.width < 20 || rect.height < 10) continue;

        // Skip inputs with aria-hidden
        if (input.getAttribute('aria-hidden') === 'true') continue;

        // Skip inputs inside elements with display:none or opacity:0
        const style = window.getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        // Skip optional/internal fields that are always empty or handled by dropdown widgets
        const automationId = input.getAttribute('data-automation-id') || '';
        const fieldName = input.name || input.id || '';
        const fieldLabel = input.getAttribute('aria-label') || '';
        const fieldIdentifier = (automationId + ' ' + fieldName + ' ' + fieldLabel).toLowerCase();
        if (fieldIdentifier.includes('extension') || fieldIdentifier.includes('countryphone') ||
            fieldIdentifier.includes('country-phone') || fieldIdentifier.includes('phonecode') ||
            fieldIdentifier.includes('middlename') || fieldIdentifier.includes('middle-name') ||
            fieldIdentifier.includes('middle name')) continue;

        if (!input.value || input.value.trim() === '') {
          // Build a debug label for this empty field
          const label = input.getAttribute('aria-label')
            || input.getAttribute('data-automation-id')
            || input.name
            || input.id
            || `${input.tagName}[${input.type || 'text'}]`;
          emptyFields.push(label);
        }
      }

      // Check for unfilled dropdowns ("Select One" buttons)
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text !== 'Select One') continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        emptyFields.push(`dropdown:"Select One"`);
      }

      // Check for unchecked required checkboxes (e.g. Terms & Conditions, Privacy acknowledgment)
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (cb.checked) continue;
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        // Check if it's a required checkbox (look for "Required" or * near it)
        const parent = cb.closest('div, label, fieldset');
        const parentText = (parent?.textContent || '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('required') || parentText.includes('*')) {
          emptyFields.push(`checkbox:"${parentText.substring(0, 60)}..."`);
        }
      }

      // Check for unanswered radio button groups
      const radioGroups = new Set<string>();
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(r => {
        if (r.name) radioGroups.add(r.name);
      });
      for (const groupName of radioGroups) {
        const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${groupName}"]`);
        const anyChecked = Array.from(radios).some(r => r.checked);
        if (!anyChecked) {
          // Check if at least one radio in this group is visible
          for (const r of radios) {
            const rect = r.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight) {
              emptyFields.push(`radio:${groupName}`);
              break;
            }
          }
        }
      }

      return emptyFields;
    });

    if (result.length > 0) {
      console.log(`[WorkdayApply] [EmptyCheck] Found ${result.length} empty field(s): ${result.join(', ')}`);
      return true;
    }
    return false;
  }

  /**
   * Find the first empty form field on the entire page and scroll it to the
   * center of the viewport. This ensures the LLM always sees the field it
   * needs to fill in the middle of the screen — not at an edge where it
   * can't verify if its input was registered.
   *
   * Returns true if an empty field was found and centered, false otherwise.
   */
  private async centerNextEmptyField(
    adapter: BrowserAutomationAdapter,
  ): Promise<boolean> {
    const centered = await adapter.page.evaluate(() => {
      // 1. Empty text inputs / textareas
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea'
      );
      for (const inp of inputs) {
        if (inp.disabled || inp.readOnly) continue;
        if (inp.type === 'hidden') continue;
        const rect = inp.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Skip date segment inputs
        const ph = (inp.placeholder || '').toUpperCase();
        if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
        // Skip internal dropdown inputs
        if (inp.closest('[role="listbox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]')) continue;
        // Skip hidden via CSS
        const style = window.getComputedStyle(inp);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (inp.getAttribute('aria-hidden') === 'true') continue;
        // Skip optional internal fields
        const ident = ((inp.getAttribute('data-automation-id') || '') + ' ' + (inp.name || '') + ' ' + (inp.getAttribute('aria-label') || '')).toLowerCase();
        if (ident.includes('extension') || ident.includes('countryphone') || ident.includes('phonecode') || ident.includes('middlename') || ident.includes('middle name') || ident.includes('middle-name')) continue;

        if (!inp.value || inp.value.trim() === '') {
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      // 2. Unfilled dropdowns ("Select One" buttons)
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text !== 'Select One') continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }

      // 3. Unchecked required checkboxes
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:checked)');
      for (const cb of checkboxes) {
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const parent = cb.closest('div, label, fieldset');
        const parentText = (parent?.textContent || '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('required') || parentText.includes('*')) {
          cb.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      return false;
    });

    if (centered) {
      await adapter.page.waitForTimeout(300);
    }
    return centered;
  }

  /**
   * Click "Save and Continue" and check for Workday validation errors.
   * If errors are found, scroll to find unfilled required fields, fill them, and retry.
   */
  private async clickNextWithErrorRecovery(
    adapter: BrowserAutomationAdapter,
    fillPrompt: string,
    pageLabel: string,
  ): Promise<void> {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Scroll to bottom where the Save and Continue button lives
      await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await adapter.page.waitForTimeout(800);

      console.log(`[WorkdayApply] [${pageLabel}] Clicking Save and Continue (attempt ${attempt})...`);
      await this.clickSaveAndContinueDOM(adapter);

      // Wait for page response
      await adapter.page.waitForTimeout(2000);

      // Check for Workday validation error banner via DOM
      const hasErrors = await adapter.page.evaluate(() => {
        // Workday shows errors in a banner with class containing 'error' or in an element with role='alert'
        const errorBanner = document.querySelector(
          '[data-automation-id="errorMessage"], [role="alert"], .css-1fdonr0, [class*="WJLK"]'
        );
        if (errorBanner && errorBanner.textContent?.toLowerCase().includes('error')) return true;
        // Also check for text "Errors Found" anywhere visible
        const allText = document.body.innerText;
        return allText.includes('Errors Found') || allText.includes('Error -');
      });

      if (!hasErrors) {
        // No errors — page navigation succeeded
        console.log(`[WorkdayApply] [${pageLabel}] Save and Continue succeeded.`);
        await this.waitForPageLoad(adapter);
        return;
      }

      console.log(`[WorkdayApply] [${pageLabel}] Validation errors detected! Clicking error jump links...`);

      // Scroll to top first so we see the error banner
      await adapter.page.evaluate(() => window.scrollTo(0, 0));
      await adapter.page.waitForTimeout(500);

      // Auto-click each error jump link to navigate to the missing field, then fill it
      const errorLinks = await adapter.page.evaluate(() => {
        // Workday error banners contain clickable links (usually <a> tags) that jump to the field
        const links = Array.from(document.querySelectorAll(
          '[data-automation-id="errorMessage"] a, [role="alert"] a, ' +
          '[class*="error"] a, [class*="WJLK"] a'
        ));
        // Also check for inline error links in the error summary
        const allLinks = document.querySelectorAll('a');
        for (const a of allLinks) {
          const text = (a.textContent || '').trim();
          const parent = a.closest('[data-automation-id="errorMessage"], [role="alert"]');
          if (parent && text.length > 5) links.push(a);
        }
        return links.length;
      });

      if (errorLinks > 0) {
        console.log(`[WorkdayApply] [${pageLabel}] Found ${errorLinks} error link(s), clicking each one...`);
        // Click each error link one at a time, then fill the field it jumps to
        for (let linkIdx = 0; linkIdx < errorLinks; linkIdx++) {
          await adapter.page.evaluate((idx: number) => {
            const links = Array.from(document.querySelectorAll(
              '[data-automation-id="errorMessage"] a, [role="alert"] a'
            ));
            if (links[idx]) (links[idx] as HTMLElement).click();
          }, linkIdx);
          await adapter.page.waitForTimeout(800);

          // Now fill any empty field that's visible after jumping
          if (Object.keys(this.fullQAMap).length > 0) {
            await this.fillDropdownsProgrammatically(adapter);
          }
          await this.fillDateFieldsProgrammatically(adapter);
        }
      }

      // Use LLM to handle any remaining errors the DOM couldn't fix
      await adapter.act(
        `There are validation errors on this page. Look for any error messages or fields highlighted in red. If you see clickable error links at the top of the page, click on each one — they will jump you directly to the missing field. Then fill in the correct value. For each missing/invalid field:
1. CLICK on the error link to jump to it, OR click directly on the field.
2. Fill in the correct value or select the correct option.
3. CLICK on empty whitespace to deselect.

${fillPrompt}`,
      );

      // Also do a full programmatic scroll pass to catch anything the LLM missed
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

        // DOM-first: fill any dropdowns programmatically
        if (Object.keys(this.fullQAMap).length > 0) {
          await this.fillDropdownsProgrammatically(adapter);
        }

        // Only invoke LLM if there are still empty fields
        const hasEmpty = await this.hasEmptyVisibleFields(adapter);
        if (hasEmpty) {
          await adapter.act(
            `If there are any EMPTY required fields visible on screen (marked with * or highlighted in red), CLICK on each one and fill it with the correct value. If ALL visible fields are already filled, do NOTHING — just stop immediately.

${fillPrompt}`,
          );
        }
      }
    }

    // After max retries, proceed anyway (let the main loop handle it)
    console.warn(`[WorkdayApply] [${pageLabel}] Still has errors after ${MAX_RETRIES} retries, proceeding...`);
    await this.waitForPageLoad(adapter);
  }

  /**
   * Click "Save and Continue" / "Next" via direct Playwright DOM click.
   * This prevents the LLM act() from bleeding into the next page.
   *
   * SAFETY: If the only available button is "Submit", check if this is the review page
   * first. If it is, do NOT click — the main loop will detect "review" and stop.
   */
  private async clickSaveAndContinueDOM(adapter: BrowserAutomationAdapter): Promise<void> {
    const result = await adapter.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));

      // Priority 1: Safe buttons that never submit the application
      const safePriorities = ['save and continue', 'next', 'continue'];
      for (const target of safePriorities) {
        const btn = buttons.find(b => (b.textContent?.trim().toLowerCase() || '') === target);
        if (btn) {
          (btn as HTMLElement).click();
          return 'clicked';
        }
      }
      // Partial match for safe buttons
      const fallback = buttons.find(b => {
        const text = b.textContent?.trim().toLowerCase() || '';
        return text.includes('save and continue') || text.includes('next');
      });
      if (fallback) {
        (fallback as HTMLElement).click();
        return 'clicked';
      }

      // Priority 2: "Submit" — but ONLY if this is NOT the review page.
      // The review page is a read-only summary with no editable form fields.
      const submitBtn = buttons.find(b => {
        const text = b.textContent?.trim().toLowerCase() || '';
        return text === 'submit' || text === 'submit application';
      });
      if (submitBtn) {
        // Check if this looks like the review page
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
        const isReviewHeading = headings.some(h => (h.textContent || '').toLowerCase().includes('review'));
        // Review pages have no editable inputs, no "Select One" dropdowns, no unchecked checkboxes
        const hasEditableInputs = document.querySelectorAll(
          'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
        ).length > 0;
        const hasSelectOne = buttons.some(b => (b.textContent?.trim() || '') === 'Select One');
        const hasUncheckedRequired = document.querySelectorAll('input[type="checkbox"]:not(:checked)').length > 0;

        if (isReviewHeading || (!hasEditableInputs && !hasSelectOne && !hasUncheckedRequired)) {
          return 'review_detected';
        }

        (submitBtn as HTMLElement).click();
        return 'clicked';
      }

      return 'not_found';
    });

    if (result === 'review_detected') {
      console.log('[WorkdayApply] Review page detected — NOT clicking Submit. Stopping.');
      return;
    }

    if (result === 'not_found') {
      // Last resort: use LLM but with very strict instruction — NEVER click Submit
      console.warn('[WorkdayApply] DOM click failed, falling back to LLM act()');
      await adapter.act(
        'Click the "Save and Continue" button. Click ONLY that button and then STOP. Do absolutely nothing else. Do NOT click "Submit" or "Submit Application".',
      );
    }
  }

  private async waitForPageLoad(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      // Wait for network to settle
      await adapter.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      // Additional wait for JS rendering
      await adapter.page.waitForTimeout(PAGE_TRANSITION_WAIT_MS);
    } catch {
      // Non-fatal — page may already be loaded
    }
  }

  /**
   * Build a comprehensive Q&A map for programmatic dropdown filling.
   * Merges user-provided Q&A overrides with profile defaults.
   */
  private buildFullQAMap(
    profile: WorkdayUserProfile,
    qaOverrides: Record<string, string>,
  ): Record<string, string> {
    return {
      // Self-identification (voluntary disclosure) defaults
      'Gender': profile.gender || 'I do not wish to answer',
      'Race/Ethnicity': profile.race_ethnicity || 'I do not wish to answer',
      'Race': profile.race_ethnicity || 'I do not wish to answer',
      'Ethnicity': profile.race_ethnicity || 'I do not wish to answer',
      'Veteran Status': profile.veteran_status || 'I am not a protected veteran',
      'Are you a protected veteran': profile.veteran_status || 'I am not a protected veteran',
      'Disability': profile.disability_status || 'I do not wish to answer',
      'Disability Status': profile.disability_status || 'I do not wish to answer',
      'Please indicate if you have a disability': profile.disability_status || 'I do not wish to answer',
      // Contact info dropdowns
      'Country': profile.address.country,
      'Country/Territory': profile.address.country,
      'State': profile.address.state,
      'State/Province': profile.address.state,
      'Phone Device Type': profile.phone_device_type || 'Mobile',
      'Phone Type': profile.phone_device_type || 'Mobile',
      // Text field answers (used by fillTextFieldsProgrammatically too)
      'Please enter your name': `${profile.first_name} ${profile.last_name}`,
      'Please enter your name:': `${profile.first_name} ${profile.last_name}`,
      'Enter your name': `${profile.first_name} ${profile.last_name}`,
      'Your name': `${profile.first_name} ${profile.last_name}`,
      'Full name': `${profile.first_name} ${profile.last_name}`,
      'Signature': `${profile.first_name} ${profile.last_name}`,
      'Name': `${profile.first_name} ${profile.last_name}`,
      'What is your desired salary?': 'Open to discussion',
      'Desired salary': 'Open to discussion',
      // User-provided Q&A overrides take highest priority (spread last)
      ...qaOverrides,
    };
  }

  /**
   * Programmatically fill text input fields by matching their labels to the QA map.
   * Handles fields like "Please enter your name:" that are not dropdowns or dates.
   */
  private async fillTextFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
  ): Promise<number> {
    // Find empty text inputs/textareas with their labels
    const textFields = await adapter.page.evaluate(`
      (() => {
        var results = [];
        var inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          var rect = inp.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width < 20 || rect.height < 10) continue;
          if (inp.disabled || inp.readOnly) continue;
          if (inp.type === 'hidden') continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          // Skip date segments
          var ph = (inp.placeholder || '').toUpperCase();
          if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
          // Skip inputs inside dropdowns
          if (inp.closest('[role="listbox"], [role="combobox"], [data-automation-id*="dropdown"]')) continue;
          // Skip if already has a value
          if (inp.value && inp.value.trim() !== '') continue;
          // Tag for Playwright
          inp.setAttribute('data-gh-text-idx', String(i));
          // Find label text
          var label = '';
          // Try aria-label
          label = inp.getAttribute('aria-label') || '';
          if (!label || label.length < 5) {
            // Try associated label element
            var id = inp.id;
            if (id) {
              var lbl = document.querySelector('label[for="' + id + '"]');
              if (lbl) label = (lbl.textContent || '').trim();
            }
          }
          if (!label || label.length < 5) {
            // Try positional: find text above by Y coordinate
            var inpRect = inp.getBoundingClientRect();
            var bestDist = 9999;
            var bestLabel = '';
            var candidates = document.querySelectorAll('label, p, div, span, h3, h4');
            for (var c = 0; c < candidates.length; c++) {
              var cel = candidates[c];
              if (cel.contains(inp)) continue;
              var cr = cel.getBoundingClientRect();
              if (cr.bottom > inpRect.top) continue;
              var d = inpRect.top - cr.bottom;
              if (d > 200) continue;
              var ct = (cel.textContent || '').trim();
              if (!ct || ct.length < 5 || ct === 'Select One' || ct === 'Required') continue;
              if (cel.children.length > 5) continue;
              if (d < bestDist) { bestDist = d; bestLabel = ct; }
            }
            if (bestLabel) label = bestLabel;
          }
          label = label.replace(/[*]/g, '').replace(/Required/gi, '').replace(/\\s+/g, ' ').trim();
          results.push({ index: i, label: label });
        }
        return results;
      })()
    `) as Array<{ index: number; label: string }>;

    if (textFields.length === 0) return 0;

    let filled = 0;
    for (const field of textFields) {
      const answer = this.findBestDropdownAnswer(field.label, this.fullQAMap);
      if (!answer || answer === 'today') continue; // Skip date answers

      console.log(`[WorkdayApply] [TextFill] Filling "${field.label}" → "${answer}"`);
      const input = adapter.page.locator(`[data-gh-text-idx="${field.index}"]`);
      await input.scrollIntoViewIfNeeded().catch(() => {});
      await adapter.page.waitForTimeout(200);
      await input.click();
      await adapter.page.waitForTimeout(200);
      await input.fill(answer);
      await adapter.page.waitForTimeout(200);
      await adapter.page.keyboard.press('Tab');
      await adapter.page.waitForTimeout(200);
      filled++;
    }

    // Clean up
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-text-idx]').forEach(el => {
        el.removeAttribute('data-gh-text-idx');
      });
    });

    return filled;
  }

  /**
   * Programmatically fill date fields (MM/DD/YYYY format) on the page.
   * Workday date inputs are segmented (separate MM, DD, YYYY parts) but if you
   * click on the MM part and type the full date as digits (e.g. "02182026"),
   * Workday auto-advances through the segments.
   */
  private async fillDateFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
  ): Promise<number> {
    // Find all empty date inputs on the page
    const dateFields = await adapter.page.evaluate(`
      (() => {
        var results = [];
        // Workday date fields have input[placeholder*="MM"] or input[data-automation-id*="date"]
        var dateInputs = document.querySelectorAll(
          'input[placeholder*="MM"], input[data-automation-id*="dateSectionMonth"], input[aria-label*="Month"], input[aria-label*="date"]'
        );
        for (var i = 0; i < dateInputs.length; i++) {
          var inp = dateInputs[i];
          var rect = inp.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          // Check if the date field is empty (MM part hasn't been filled)
          if (inp.value && inp.value.trim() !== '' && inp.value !== 'MM') continue;
          // Tag it for Playwright locator
          inp.setAttribute('data-gh-date-idx', String(i));
          // Try to find the label text for this date field
          var label = '';
          var ancestor = inp.parentElement;
          for (var up = 0; up < 8 && ancestor; up++) {
            var labels = ancestor.querySelectorAll('label, [data-automation-id*="formLabel"]');
            for (var l = 0; l < labels.length; l++) {
              var t = (labels[l].textContent || '').trim();
              if (t && t.length > 3) { label = t; break; }
            }
            if (label) break;
            // Also check text content of ancestor if it's small enough
            var allText = (ancestor.textContent || '').trim();
            if (allText.length > 5 && allText.length < 200 && !allText.includes('Select One')) {
              label = allText.replace(/MM.*YYYY/g, '').replace(/[*]/g, '').replace(/Required/gi, '').trim();
              if (label.length > 5) break;
              label = '';
            }
            ancestor = ancestor.parentElement;
          }
          results.push({ index: i, label: label });
        }
        return results;
      })()
    `) as Array<{ index: number; label: string }>;

    if (dateFields.length === 0) return 0;

    // Get today's date in MMDDYYYY format
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const todayDigits = `${mm}${dd}${yyyy}`;

    let filled = 0;
    for (const field of dateFields) {
      const labelLower = field.label.toLowerCase();
      let dateValue = todayDigits; // Default: today's date

      // Check if the Q&A map has a specific date answer
      if (labelLower.includes('graduation') || labelLower.includes('expected')) {
        // Expected graduation date: May 2027 → 05/01/2027
        dateValue = '05012027';
      } else if (labelLower.includes('start')) {
        dateValue = '08012023';
      } else if (labelLower.includes('end')) {
        dateValue = '05012027';
      }
      // "today's date", "current date", "signature date" → use actual today

      console.log(`[WorkdayApply] [Date] Filling "${field.label || 'date field'}" → ${dateValue.substring(0,2)}/${dateValue.substring(2,4)}/${dateValue.substring(4)}`);

      // Use JavaScript to scroll, focus, and click the date input.
      // Playwright's locator.click() fails with "element is outside of the viewport"
      // on Workday's spinbutton date inputs, so we bypass it entirely.
      const clicked = await adapter.page.evaluate((idx: string) => {
        const el = document.querySelector(`input[data-gh-date-idx="${idx}"]`) as HTMLInputElement;
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        el.click();
        return true;
      }, String(field.index));

      if (!clicked) {
        console.warn(`[WorkdayApply] [Date] Could not find date input ${field.index}`);
        continue;
      }

      await adapter.page.waitForTimeout(300);
      // Type digits — Workday auto-advances from MM to DD to YYYY
      await adapter.page.keyboard.type(dateValue, { delay: 80 });
      await adapter.page.waitForTimeout(200);
      // Tab to deselect
      await adapter.page.keyboard.press('Tab');
      await adapter.page.waitForTimeout(200);
      filled++;
    }

    // Clean up temporary attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-date-idx]').forEach(el => {
        el.removeAttribute('data-gh-date-idx');
      });
    });

    return filled;
  }

  /**
   * Programmatically check any required checkboxes (Terms & Conditions, Privacy, etc.)
   * that are visible and unchecked.
   */
  private async checkRequiredCheckboxes(
    adapter: BrowserAutomationAdapter,
  ): Promise<number> {
    const checked = await adapter.page.evaluate(`
      (() => {
        var count = 0;
        var checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < checkboxes.length; i++) {
          var cb = checkboxes[i];
          if (cb.checked) continue;
          var rect = cb.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          // Check if this is a required/important checkbox
          var parent = cb.closest('div, label, fieldset');
          var parentText = (parent ? parent.textContent : '').toLowerCase();
          if (parentText.includes('acknowledge') || parentText.includes('terms') ||
              parentText.includes('agree') || parentText.includes('privacy') ||
              parentText.includes('i have read')) {
            cb.click();
            count++;
          }
        }
        return count;
      })()
    `) as number;

    if (checked > 0) {
      console.log(`[WorkdayApply] [Checkbox] Checked ${checked} required checkbox(es)`);
    }
    return checked;
  }

  /**
   * Programmatically fill Workday dropdowns that still show "Select One".
   * Bypasses the LLM entirely — uses DOM queries to find options and click them.
   */
  private async fillDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
  ): Promise<number> {
    // Step 1: Scan page for all unfilled dropdowns and find their question labels.
    // Uses a string-based evaluate to avoid Bun/esbuild __name injection into browser context.
    const dropdownInfos: Array<{ index: number; label: string }> = await adapter.page.evaluate(`
      (() => {
        var results = [];
        var buttons = document.querySelectorAll('button');
        var idx = 0;

        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var text = (btn.textContent || '').trim();
          if (text !== 'Select One') continue;

          var rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          btn.setAttribute('data-gh-dropdown-idx', String(idx));

          var labelText = '';

          // Strategy 1: aria-label on the button or a close ancestor
          if (!labelText) {
            var ariaLabel = btn.getAttribute('aria-label');
            if (!ariaLabel || ariaLabel === 'Select One') {
              var ariaParent = btn.closest('[aria-label]');
              if (ariaParent) ariaLabel = ariaParent.getAttribute('aria-label');
            }
            if (ariaLabel && ariaLabel !== 'Select One') {
              labelText = ariaLabel;
            }
          }

          // Strategy 2: Walk up to find a <label> tag
          if (!labelText) {
            var node = btn.parentElement;
            for (var d = 0; d < 10 && node; d++) {
              var lbl = node.querySelector('label');
              if (lbl && (lbl.textContent || '').trim() && (lbl.textContent || '').trim() !== 'Select One') {
                labelText = (lbl.textContent || '').trim();
                break;
              }
              node = node.parentElement;
            }
          }

          // Strategy 3: data-automation-id labels (Workday-specific)
          if (!labelText) {
            var daParent = btn.closest('[data-automation-id]');
            if (daParent) {
              var labelEls = daParent.querySelectorAll('[data-automation-id*="formLabel"], [data-automation-id*="label"], [data-automation-id*="questionText"]');
              for (var le = 0; le < labelEls.length; le++) {
                var t = (labelEls[le].textContent || '').trim();
                if (t && t !== 'Select One' && t.length > 3) {
                  labelText = t;
                  break;
                }
              }
            }
          }

          // Strategy 4 (NEW): Find the nearest ancestor that acts as a "question container"
          // by walking up until we find one that has exactly one "Select One" button.
          // That ancestor's text content (minus the button text) is the question label.
          // This is the most reliable strategy for Application Questions pages where
          // each question is wrapped in a container div with nested sub-divs.
          if (!labelText) {
            var ancestor = btn.parentElement;
            for (var up = 0; up < 12 && ancestor; up++) {
              // Count how many "Select One" buttons are inside this ancestor
              var selectBtns = ancestor.querySelectorAll('button');
              var selectOneCount = 0;
              for (var sb = 0; sb < selectBtns.length; sb++) {
                if ((selectBtns[sb].textContent || '').trim() === 'Select One') selectOneCount++;
              }
              // If this ancestor contains exactly 1 "Select One" button (ours),
              // its text is likely the question + "Select One" + maybe "Required"
              if (selectOneCount === 1) {
                var fullText = (ancestor.textContent || '').trim();
                // Remove "Select One", "Required", asterisks
                var cleaned = fullText
                  .replace(/Select One/g, '')
                  .replace(/Required/gi, '')
                  .replace(/[*]/g, '')
                  .trim();
                // Only accept if there's meaningful question text remaining
                if (cleaned.length > 8) {
                  labelText = cleaned;
                  break;
                }
              }
              ancestor = ancestor.parentElement;
            }
          }

          // Strategy 5: Walk up and check preceding siblings
          if (!labelText) {
            var container = btn.parentElement;
            for (var u = 0; u < 8 && container; u++) {
              var prev = container.previousElementSibling;
              if (prev) {
                var pt = (prev.textContent || '').trim();
                if (pt && pt.length > 5 && pt !== 'Select One' && pt !== 'Required') {
                  labelText = pt;
                  break;
                }
              }
              container = container.parentElement;
            }
          }

          // Strategy 6: Look at all text in parent divs (up to 6 levels), skipping
          // any text that belongs to other dropdown buttons
          if (!labelText) {
            var parentNode = btn.parentElement;
            for (var p = 0; p < 6 && parentNode; p++) {
              var childNodes = parentNode.childNodes;
              for (var cn = 0; cn < childNodes.length; cn++) {
                var child = childNodes[cn];
                if (child === btn) continue;
                if (child.contains && child.contains(btn)) continue;
                var candidateText = '';
                if (child.nodeType === 3) {
                  candidateText = (child.textContent || '').trim();
                } else if (child.nodeType === 1) {
                  var tag = (child.tagName || '').toLowerCase();
                  if (tag === 'button' || tag === 'input' || tag === 'select') continue;
                  candidateText = (child.textContent || '').trim();
                }
                if (candidateText && candidateText.length > 5
                    && candidateText !== 'Select One'
                    && candidateText !== 'Required') {
                  labelText = candidateText;
                  break;
                }
              }
              if (labelText) break;
              parentNode = parentNode.parentElement;
            }
          }

          // Strategy 7: Relaxed container search — accept containers with 2-3 "Select One"
          // buttons and look at text that appears BEFORE this specific button in DOM order.
          // Also check for Workday's aria-describedby or aria-labelledby references.
          if (!labelText) {
            // Try aria-describedby / aria-labelledby on the button
            var describedBy = btn.getAttribute('aria-describedby') || btn.getAttribute('aria-labelledby');
            if (describedBy) {
              var ids = describedBy.split(/\\s+/);
              for (var di = 0; di < ids.length; di++) {
                var el = document.getElementById(ids[di]);
                if (el) {
                  var txt = (el.textContent || '').trim();
                  if (txt && txt.length > 5 && txt !== 'Select One') {
                    labelText = txt;
                    break;
                  }
                }
              }
            }
          }
          if (!labelText) {
            // Walk up further (up to 15 levels) and find any container with
            // meaningful text before this button
            var anc = btn.parentElement;
            for (var w = 0; w < 15 && anc; w++) {
              var ancText = (anc.textContent || '');
              // Must have substantial text beyond just button/boilerplate text
              var stripped = ancText
                .replace(/Select One/g, '')
                .replace(/Required/gi, '')
                .replace(/[*]/g, '')
                .trim();
              if (stripped.length > 15 && stripped.length < 2000) {
                // Extract just the first substantial sentence/question
                var sentences = stripped.split(/[.?!\\n]/).filter(function(s) { return s.trim().length > 10; });
                if (sentences.length > 0) {
                  labelText = sentences[0].trim();
                  break;
                }
              }
              anc = anc.parentElement;
            }
          }

          // Strategy 8: Positional — find text blocks geometrically ABOVE the button.
          // This catches cases where the question text is in a separate div/paragraph
          // that is NOT an ancestor of the dropdown button (e.g. Workday Application Questions).
          if (!labelText) {
            var btnRect = btn.getBoundingClientRect();
            var bestDist = 9999;
            var bestText = '';
            // Check all block-level text elements
            var textEls = document.querySelectorAll('p, div, span, label, h1, h2, h3, h4, h5, li');
            for (var te = 0; te < textEls.length; te++) {
              var tel = textEls[te];
              // Skip if it contains or is the button
              if (tel.contains(btn) || tel === btn) continue;
              // Skip if it's inside any dropdown
              if (tel.closest('[role="listbox"]')) continue;
              var telRect = tel.getBoundingClientRect();
              // Must be above or at the same level as the button (within 300px)
              if (telRect.bottom > btnRect.top) continue;
              var dist = btnRect.top - telRect.bottom;
              if (dist > 300) continue;
              var telText = (tel.textContent || '').trim();
              // Skip boilerplate
              if (!telText || telText.length < 10 || telText === 'Select One' || telText === 'Required') continue;
              // Skip if this element has children with more specific text (avoid grabbing huge parent text)
              if (tel.children.length > 5) continue;
              // Prefer the closest text block above the button
              if (dist < bestDist) {
                bestDist = dist;
                bestText = telText;
              }
            }
            if (bestText) {
              labelText = bestText;
            }
          }

          // Clean up: remove trailing asterisks, "Required", excess whitespace
          labelText = labelText
            .replace(/\\s*\\*\\s*/g, ' ')
            .replace(/\\s*Required\\s*/gi, '')
            .replace(/\\s+/g, ' ')
            .replace(/Select One/g, '')
            .trim();
          // Truncate very long labels (keep first 200 chars for matching)
          if (labelText.length > 200) {
            labelText = labelText.substring(0, 200).trim();
          }

          results.push({ index: idx, label: labelText });
          idx++;
        }

        return results;
      })()
    `);

    if (dropdownInfos.length === 0) return 0;

    console.log(`[WorkdayApply] [Programmatic] Found ${dropdownInfos.length} unfilled dropdown(s):`);
    for (const info of dropdownInfos) {
      console.log(`  [${info.index}] label="${info.label || '(empty)'}"`);
    }

    let filled = 0;

    for (const info of dropdownInfos) {
      const answer = this.findBestDropdownAnswer(info.label, this.fullQAMap);
      if (!answer) {
        console.log(`[WorkdayApply] [Programmatic] No answer matched for: "${info.label}"`);
        continue;
      }

      // Verify the button still shows "Select One" (may have been filled by a prior iteration)
      const btn = adapter.page.locator(`button[data-gh-dropdown-idx="${info.index}"]`);
      const stillUnfilled = await btn.textContent().catch(() => '');
      if (!stillUnfilled?.includes('Select One')) continue;

      console.log(`[WorkdayApply] [Programmatic] Filling: "${info.label}" → "${answer}"`);

      // Scroll into view and click to open.
      // Use dispatchEvent as backup since Workday's overlapping dropdowns sometimes
      // cause Playwright coordinate-based clicks to open the wrong popup.
      await btn.scrollIntoViewIfNeeded();
      await adapter.page.waitForTimeout(200);

      // Click using Playwright locator (element-targeted, not coordinate)
      await btn.click();
      await adapter.page.waitForTimeout(600);

      // Find and click the matching option in the opened listbox
      let clicked = await this.clickDropdownOption(adapter, answer);

      // If the option wasn't found, the wrong dropdown might have opened.
      // Close it and retry with a JS dispatchEvent directly on the DOM element.
      if (!clicked) {
        await adapter.page.keyboard.press('Escape');
        await adapter.page.waitForTimeout(300);

        console.log(`[WorkdayApply] [Programmatic] Retrying with dispatchEvent for: "${info.label}"`);
        await adapter.page.evaluate((idx: string) => {
          const el = document.querySelector(`button[data-gh-dropdown-idx="${idx}"]`);
          if (el) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }, String(info.index));
        await adapter.page.waitForTimeout(600);

        clicked = await this.clickDropdownOption(adapter, answer);
      }

      if (clicked) {
        filled++;
        await adapter.page.waitForTimeout(500);
      } else {
        // Close the dropdown and move on
        await adapter.page.keyboard.press('Escape');
        await adapter.page.waitForTimeout(300);
        console.warn(`[WorkdayApply] [Programmatic] Option "${answer}" not found for "${info.label}"`);
      }
    }

    // Clean up temporary attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-dropdown-idx]').forEach(el => {
        el.removeAttribute('data-gh-dropdown-idx');
      });
    });

    return filled;
  }

  /**
   * Find and click a dropdown option matching the target answer.
   * Strategy: 1) Check if option is already visible in DOM, 2) Type to filter,
   * 3) Scroll through options with reasonable increments until match found.
   */
  private async clickDropdownOption(
    adapter: BrowserAutomationAdapter,
    targetAnswer: string,
  ): Promise<boolean> {
    // Wait for the options popup to appear
    await adapter.page
      .waitForSelector(
        '[role="listbox"], [role="option"], [data-automation-id*="promptOption"]',
        { timeout: 3000 },
      )
      .catch(() => {});

    // For multi-step answers like "Website → then select ...", use only the first part
    let searchText = targetAnswer;
    if (targetAnswer.includes('→')) {
      searchText = targetAnswer.split('→')[0].trim();
    }

    // Phase 1: Check if the option is already visible in the DOM and click it
    const directClick = await adapter.page.evaluate((target: string) => {
      const targetLower = target.toLowerCase();
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
          '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
      );

      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      // Also check if target contains option text (for partial matches)
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.length > 2 && targetLower.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, searchText);

    if (directClick) return true;

    // Phase 2: Type-to-filter — type the answer text to filter the dropdown list
    console.log(`[WorkdayApply] [Dropdown] Typing "${searchText}" to filter...`);
    await adapter.page.keyboard.type(searchText, { delay: 50 });
    await adapter.page.waitForTimeout(500);

    // Check if typing filtered to a matching option
    const typedMatch = await adapter.page.evaluate((target: string) => {
      const targetLower = target.toLowerCase();
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
          '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
      );
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      // Also try partial match
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.length > 2 && targetLower.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, searchText);

    if (typedMatch) return true;

    // Phase 3: Scroll through the dropdown listbox to find the option.
    // Use keyboard arrows (more reliable than mouse scroll for listboxes).
    console.log(`[WorkdayApply] [Dropdown] Typing didn't filter, scrolling through options...`);

    // Clear the typed text first by selecting all and deleting
    await adapter.page.keyboard.press('Home');
    await adapter.page.waitForTimeout(100);

    // Use Down Arrow to scroll through options, checking after each batch
    const MAX_SCROLL_ATTEMPTS = 30;
    for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
      // Press Down 3 times per attempt (move through options faster)
      for (let k = 0; k < 3; k++) {
        await adapter.page.keyboard.press('ArrowDown');
        await adapter.page.waitForTimeout(80);
      }

      // Check if a matching option is now highlighted or visible
      const scrollMatch = await adapter.page.evaluate((target: string) => {
        const targetLower = target.toLowerCase();

        // Check focused/highlighted option
        const focused = document.querySelector('[role="option"][aria-selected="true"], [role="option"]:focus, [role="option"].selected');
        if (focused) {
          const text = focused.textContent?.trim().toLowerCase() || '';
          if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower) || (text.length > 2 && targetLower.includes(text))) {
            (focused as HTMLElement).click();
            return 'clicked';
          }
        }

        // Also check all visible options
        const options = document.querySelectorAll(
          '[role="option"], [role="listbox"] li, ' +
            '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
        );
        for (const opt of options) {
          const text = opt.textContent?.trim().toLowerCase() || '';
          if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
            (opt as HTMLElement).click();
            return 'clicked';
          }
        }

        return 'not_found';
      }, searchText);

      if (scrollMatch === 'clicked') return true;
    }

    return false;
  }

  /**
   * Find the best matching answer for a dropdown label from the Q&A map.
   * Uses multi-pass fuzzy matching: exact → contains → keyword overlap → stem overlap.
   */
  private findBestDropdownAnswer(
    label: string,
    qaMap: Record<string, string>,
  ): string | null {
    if (!label) return null;

    const labelLower = label.toLowerCase().replace(/\*/g, '').trim();
    if (labelLower.length < 2) return null;

    // Pass 1: Exact match (case-insensitive)
    for (const [q, a] of Object.entries(qaMap)) {
      if (q.toLowerCase() === labelLower) return a;
    }

    // Pass 2: Label contains the Q&A key
    for (const [q, a] of Object.entries(qaMap)) {
      if (labelLower.includes(q.toLowerCase())) return a;
    }

    // Pass 3: Q&A key contains the label (for short labels like "Gender", "State")
    for (const [q, a] of Object.entries(qaMap)) {
      if (q.toLowerCase().includes(labelLower) && labelLower.length > 3) return a;
    }

    // Pass 4: Significant word overlap (for rephrased questions)
    const labelWords = new Set(labelLower.split(/\s+/).filter(w => w.length > 3));
    let bestMatch: { answer: string; overlap: number } | null = null;

    for (const [q, a] of Object.entries(qaMap)) {
      const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const overlap = qWords.filter(w => labelWords.has(w)).length;
      if (overlap >= 3 && (!bestMatch || overlap > bestMatch.overlap)) {
        bestMatch = { answer: a, overlap };
      }
    }

    if (bestMatch) return bestMatch.answer;

    // Pass 5: Stem-based overlap — strip common suffixes (ing, ed, s, tion, etc.)
    // so "relocating" matches "relocate", "restrictions" matches "restriction", etc.
    const stem = (word: string) =>
      word.replace(/(ating|ting|ing|tion|sion|ment|ness|able|ible|ed|ly|er|est|ies|es|s)$/i, '');
    const labelStems = new Set(
      labelLower.split(/\s+/).filter(w => w.length > 3).map(stem),
    );
    bestMatch = null;

    for (const [q, a] of Object.entries(qaMap)) {
      const qStems = q.toLowerCase().split(/\s+/).filter(w => w.length > 3).map(stem);
      const overlap = qStems.filter(s => labelStems.has(s)).length;
      if (overlap >= 2 && (!bestMatch || overlap > bestMatch.overlap)) {
        bestMatch = { answer: a, overlap };
      }
    }

    if (bestMatch) return bestMatch.answer;

    return null;
  }

  private buildDataPrompt(
    profile: WorkdayUserProfile,
    qaOverrides: Record<string, string>,
  ): string {
    const parts: string[] = [
      'FIELD-TO-VALUE MAPPING — read each field label and match it to the correct value:',
      '',
      '--- NAME FIELDS ---',
      `If the label says "First Name" or "Legal First Name" → type: ${profile.first_name}`,
      `If the label says "Last Name" or "Legal Last Name" → type: ${profile.last_name}`,
      '',
      '--- CONTACT FIELDS ---',
      `If the label says "Email" or "Email Address" → type: ${profile.email}`,
      `If the label says "Phone Number" or "Phone" → type: ${profile.phone}`,
      `If the label says "Phone Device Type" → select: ${(profile as any).phone_device_type || 'Mobile'}`,
      `If the label says "Country Phone Code" or "Phone Country Code" → select: ${(profile as any).phone_country_code || '+1'} (United States)`,
      '',
      '--- ADDRESS FIELDS ---',
      `If the label says "Country" or "Country/Territory" → select from dropdown: ${profile.address.country}`,
      `If the label says "Address Line 1" or "Street" → type: ${profile.address.street}`,
      `If the label says "City" → type: ${profile.address.city}`,
      `If the label says "State" or "State/Province" → select from dropdown: ${profile.address.state}`,
      `If the label says "Postal Code" or "ZIP" or "ZIP Code" → type: ${profile.address.zip}`,
    ];

    if (profile.linkedin_url) {
      parts.push('');
      parts.push('--- LINKS ---');
      parts.push(`If the label says "LinkedIn" → type: ${profile.linkedin_url}`);
      if (profile.website_url) parts.push(`If the label says "Website" → type: ${profile.website_url}`);
    }

    if (profile.education?.length > 0) {
      const edu = profile.education[0];
      parts.push('');
      parts.push('--- EDUCATION ---');
      parts.push(`School/University → ${edu.school}`);
      parts.push(`Degree → ${edu.degree}`);
      parts.push(`Field of Study → ${edu.field_of_study}`);
      if (edu.gpa) parts.push(`GPA → ${edu.gpa}`);
      parts.push(`Start Date → ${edu.start_date}`);
      parts.push(`End Date → ${edu.end_date}`);
    }

    // Q&A overrides for screening questions
    if (Object.keys(qaOverrides).length > 0) {
      parts.push('');
      parts.push('--- SCREENING QUESTIONS — match the question text and select/type the answer ---');
      for (const [question, answer] of Object.entries(qaOverrides)) {
        parts.push(`If the question asks "${question}" → answer: ${answer}`);
      }
    }

    parts.push('');
    parts.push('--- GENERAL RULES ---');
    parts.push(`Work Authorization → ${profile.work_authorization}`);
    parts.push(`Visa Sponsorship → ${profile.visa_sponsorship}`);
    parts.push('For self-identification: Gender → select "Male". Race/Ethnicity → select "Asian (Not Hispanic or Latino)". Veteran Status → select "I am not a protected veteran". Disability → select "I do not wish to answer".');
    parts.push('For any question not listed above, select the most reasonable/common answer.');
    parts.push('DROPDOWN TECHNIQUE: After clicking a dropdown, ALWAYS TYPE your desired answer first (e.g. "No", "Yes", "Male", "Website") to filter the list. If a matching option appears, click it. If typing does not produce a match, click whitespace to close the dropdown, then re-click it and try typing a shorter keyword. The popup menu that appears after clicking a dropdown ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions. NEVER use arrow keys inside dropdowns. NEVER use mouse scroll inside dropdowns.');
    parts.push('NESTED DROPDOWNS: Some dropdowns have sub-menus. After selecting a category (e.g. "Website"), a second list appears with specific options (e.g. "workday.com"). Select the sub-option. Do NOT click any back arrow or "← Category" button — that navigates backwards.');
    parts.push('DATE FIELDS: Workday date fields have separate MM/DD/YYYY parts. ALWAYS click on the MM (month) part FIRST, then type the full date as continuous digits WITHOUT slashes or dashes (e.g. for 02/18/2026, click on MM and type "02182026"). Workday auto-advances from month to day to year. For "today\'s date" or "signature date", type "02182026" (which is 02/18/2026). For "expected graduation date", use 05012027.');
    parts.push('NEVER click "Submit Application" or "Submit".');

    return parts.join('\n');
  }
}
