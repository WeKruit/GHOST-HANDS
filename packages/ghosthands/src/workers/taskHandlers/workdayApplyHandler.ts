import { z } from 'zod';
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
  page_title: z.string().optional(),
  has_apply_button: z.boolean().optional(),
  has_next_button: z.boolean().optional(),
  has_submit_button: z.boolean().optional(),
  has_sign_in_with_google: z.boolean().optional(),
  error_message: z.string().optional(),
});

type PageState = z.infer<typeof PageStateSchema>;

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
            await this.handleExperiencePage(adapter);
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
      if (currentUrl.includes('/challenge/') || currentUrl.includes('/pwd')) {
        // Password page or 2FA challenge
        return { page_type: 'google_signin', page_title: 'Google Sign-In (password/challenge)' };
      }
      if (currentUrl.includes('/signin/v2/challenge/dp') || currentUrl.includes('/signin/v2/challenge/ipp')) {
        return { page_type: 'phone_2fa', page_title: 'Google 2FA' };
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
      // Fallback: check URL for Workday login page
      if (currentUrl.includes('myworkdayjobs.com') && (currentUrl.includes('login') || currentUrl.includes('signin'))) {
        return { page_type: 'login', page_title: 'Workday Login' };
      }
      return { page_type: 'unknown' };
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

    // If we're already on Google's sign-in page (accounts.google.com), enter credentials directly
    if (currentUrl.includes('accounts.google.com')) {
      console.log(`[WorkdayApply] On Google sign-in page, entering credentials for ${email}...`);

      // Check if we need to enter email or password
      const result = await adapter.act(
        `This is a Google sign-in page. If you see an "Email or phone" input field, type "${email}" and click "Next". If you see a "Password" field instead, type "${password}" and click "Next". Do exactly one of these actions.`,
      );

      if (!result.success) {
        console.warn(`[WorkdayApply] Google credential entry failed: ${result.message}`);
      }

      await this.waitForPageLoad(adapter);
      return;
    }

    // Otherwise we're on the Workday login page — click "Sign in with Google"
    console.log('[WorkdayApply] On login page, clicking Sign in with Google...');

    const result = await adapter.act(
      'Look for a "Sign in with Google" button, a Google icon/logo button, or a "Continue with Google" option and click it. If there is no Google sign-in option, look for "Sign In" or "Log In" button instead.',
    );

    if (!result.success) {
      console.warn(`[WorkdayApply] Google sign-in button not found, trying generic sign-in: ${result.message}`);
      await adapter.act('Click the "Sign In", "Log In", or "Create Account" button.');
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
    console.log('\n' + '='.repeat(70));
    console.log('[WorkdayApply] PHONE 2FA REQUIRED');
    console.log('[WorkdayApply] Please approve the sign-in request on your phone.');
    console.log(`[WorkdayApply] Waiting up to ${PHONE_2FA_TIMEOUT_MS / 1000} seconds...`);
    console.log('='.repeat(70) + '\n');

    const startTime = Date.now();
    const startUrl = await adapter.getCurrentUrl();

    while (Date.now() - startTime < PHONE_2FA_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, PHONE_2FA_POLL_INTERVAL_MS));

      const currentUrl = await adapter.getCurrentUrl();
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // If URL changed, 2FA was approved
      if (currentUrl !== startUrl) {
        console.log(`[WorkdayApply] 2FA approved after ${elapsed}s. Continuing...`);
        return;
      }

      // Also check if the page content changed
      const pageCheck = await adapter.extract(
        'Is there still a 2FA/two-factor authentication prompt on this page asking the user to approve on their phone?',
        z.object({ still_waiting: z.boolean() }),
      );

      if (!pageCheck.still_waiting) {
        console.log(`[WorkdayApply] 2FA approved after ${elapsed}s. Continuing...`);
        return;
      }

      console.log(`[WorkdayApply] Still waiting for 2FA... (${elapsed}s elapsed)`);
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

    const fillPrompt = `Fill out any EMPTY or INCORRECT form fields visible on screen, from TOP to BOTTOM. For each field:
1. If the field already has the correct value, SKIP IT entirely — move to the next field.
2. If the field is empty or has the wrong value: CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.
3. DROPDOWNS: First try TYPING the answer (e.g. "No", "Yes") to filter the list and click the match. If typing doesn't filter, close the dropdown (click whitespace), reopen it, then press DOWN ARROW repeatedly until you find the option, then press ENTER. NEVER mouse-scroll inside dropdowns. NEVER press Escape (it may act as Enter).

If ALL visible fields are already correctly filled, do NOTHING — just stop immediately.
IMPORTANT: Do NOT scroll at all — not even 1 pixel. I handle scrolling separately. Ignore any error banners. Do NOT click "Submit" or "Save and Continue".

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

    const fillPrompt = `You are on a "${pageDescription}" form page. Fill any EMPTY or UNANSWERED questions/fields visible on screen, from top to bottom. For each one:
1. If the field already has a correct answer, SKIP IT — move to the next one.
2. If empty or wrong: CLICK on the field, read the label, type or select the correct answer.
3. DROPDOWNS: First try TYPING the answer to filter the list and click the match. If typing doesn't filter, close the dropdown (click whitespace), reopen it, then press DOWN ARROW repeatedly until you find the option, then press ENTER. NEVER mouse-scroll inside dropdowns. NEVER press Escape.

If ALL visible fields are already answered, do NOTHING — just stop immediately.
IMPORTANT: Do NOT scroll at all — not even 1 pixel. I handle scrolling separately. Ignore any error banners. Do NOT click "Submit" or "Save and Continue".

${dataPrompt}`;

    await this.fillWithSmartScroll(adapter, fillPrompt, pageDescription);
  }

  private async handleExperiencePage(adapter: BrowserAutomationAdapter): Promise<void> {
    console.log('[WorkdayApply] On experience/resume page — skipping (no required fields)...');
    await this.clickSaveAndContinueDOM(adapter);
    await this.waitForPageLoad(adapter);
  }

  private async handleVoluntaryDisclosure(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Filling voluntary self-identification page...');

    const fillPrompt = `This is a voluntary self-identification page. Fill any UNANSWERED questions visible on screen:
1. If a dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter (e.g. "Decline", "do not wish").
   - Gender → type "Decline"
   - Race/Ethnicity → type "Decline"
   - Veteran Status → type "not a protected"
   - Disability → type "do not wish"
3. If typing does NOT filter the list: click whitespace to close, re-click the dropdown, then press DOWN ARROW key repeatedly to navigate through options until you see the right one, then press ENTER. NEVER mouse-scroll inside dropdowns. NEVER press Escape (it may act as Enter).

If ALL visible questions are already answered, do NOTHING — just stop immediately.
IMPORTANT: Do NOT scroll at all — not even 1 pixel. I handle scrolling separately. Ignore any error banners. Do NOT click "Submit" or "Save and Continue".`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'voluntary disclosure');
  }

  private async handleSelfIdentify(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Filling self-identification page...');

    const fillPrompt = `This is a self-identification page (often about disability status). Fill any UNANSWERED questions visible on screen:
1. If a field/dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter (e.g. "do not wish", "Decline").
   - Disability Status → type "do not wish"
   - Any other question → type "Decline"
3. If typing does NOT filter the list: click whitespace to close, re-click the dropdown, then press DOWN ARROW key repeatedly to navigate through options until you see the right one, then press ENTER. NEVER mouse-scroll inside dropdowns. NEVER press Escape (it may act as Enter).

If ALL visible questions are already answered, do NOTHING — just stop immediately.
IMPORTANT: Do NOT scroll at all — not even 1 pixel. I handle scrolling separately. Ignore any error banners. Do NOT click "Submit" or "Save and Continue".`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'self-identify');
  }

  private async handleGenericPage(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
  ): Promise<void> {
    console.log('[WorkdayApply] Handling generic/unknown page...');

    const fillPrompt = `Look at this page. If there are any EMPTY or UNANSWERED form fields visible, fill them from top to bottom:
1. If a field already has the correct value, SKIP IT.
2. If empty or wrong: CLICK the field, type/select the correct value, CLICK whitespace to deselect.

If ALL fields are already filled or no form fields exist, do NOTHING — just stop immediately.
IMPORTANT: Do NOT scroll at all — not even 1 pixel. I handle scrolling separately. Ignore any error banners. Do NOT click "Submit" or "Save and Continue".

${dataPrompt}`;

    await this.fillWithSmartScroll(adapter, fillPrompt, 'generic');
  }

  // --- Helpers ---

  /**
   * Fill visible fields, then programmatically scroll down one viewport at a time,
   * filling any new fields that appear. Repeats until we've reached the bottom.
   * Finally clicks "Save and Continue" / "Next".
   */
  private async fillWithSmartScroll(
    adapter: BrowserAutomationAdapter,
    fillPrompt: string,
    pageLabel: string,
  ): Promise<void> {
    const MAX_SCROLL_ROUNDS = 10;

    // Scroll to top first
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    // Dismiss/collapse any Workday error banners so the LLM doesn't get distracted by them.
    // We handle errors ourselves in clickNextWithErrorRecovery.
    await adapter.page.evaluate(() => {
      // Hide error banners by collapsing or removing them from view
      const errorBanners = document.querySelectorAll(
        '[data-automation-id="errorMessage"], [role="alert"]'
      );
      errorBanners.forEach(el => (el as HTMLElement).style.display = 'none');
      // Also collapse any expanded error sections
      const errorSections = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(el => el.textContent?.includes('Errors Found'));
      errorSections.forEach(el => (el as HTMLElement).click());
    });
    await adapter.page.waitForTimeout(300);

    // Round 1: fill everything currently visible
    console.log(`[WorkdayApply] [${pageLabel}] Filling visible fields (round 1)...`);
    await adapter.act(fillPrompt);

    // Programmatic dropdown pass: fill any remaining "Select One" dropdowns the LLM missed
    if (Object.keys(this.fullQAMap).length > 0) {
      const programmaticFilled = await this.fillDropdownsProgrammatically(adapter);
      if (programmaticFilled > 0) {
        console.log(`[WorkdayApply] [${pageLabel}] Programmatically filled ${programmaticFilled} dropdown(s)`);
      }
    }

    // Scroll-and-fill loop
    for (let round = 2; round <= MAX_SCROLL_ROUNDS; round++) {
      // Get current scroll position
      const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
      const scrollMax = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );

      // Already at or near the bottom
      if (scrollBefore >= scrollMax - 10) {
        console.log(`[WorkdayApply] [${pageLabel}] Reached bottom of page.`);
        break;
      }

      // Programmatic scroll: one full viewport height
      await adapter.page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await adapter.page.waitForTimeout(800); // let lazy-loaded content appear

      const scrollAfter = await adapter.page.evaluate(() => window.scrollY);

      // If we didn't actually scroll, we're stuck at the bottom
      if (scrollAfter <= scrollBefore) {
        console.log(`[WorkdayApply] [${pageLabel}] Cannot scroll further.`);
        break;
      }

      console.log(`[WorkdayApply] [${pageLabel}] Scrolled to ${scrollAfter}px, filling new fields (round ${round})...`);
      await adapter.act(fillPrompt);

      // Programmatic dropdown pass after each scroll round
      if (Object.keys(this.fullQAMap).length > 0) {
        const programmaticFilled = await this.fillDropdownsProgrammatically(adapter);
        if (programmaticFilled > 0) {
          console.log(`[WorkdayApply] [${pageLabel}] Programmatically filled ${programmaticFilled} dropdown(s) after scroll`);
        }
      }
    }

    // Final: click the navigation button and handle validation errors
    await this.clickNextWithErrorRecovery(adapter, fillPrompt, pageLabel);
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

      console.log(`[WorkdayApply] [${pageLabel}] Validation errors detected! Scrolling to find missing fields...`);

      // Scroll to top first so we see the error banner
      await adapter.page.evaluate(() => window.scrollTo(0, 0));
      await adapter.page.waitForTimeout(500);

      // Use LLM to read what errors exist
      await adapter.act(
        `There are validation errors at the top of the page. Read the error messages carefully. Then scroll down to find each field mentioned in the errors. For each missing/invalid field:
1. CLICK on the field to focus it.
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

        await adapter.page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await adapter.page.waitForTimeout(800);

        const after = await adapter.page.evaluate(() => window.scrollY);
        if (after <= before) break;

        // Fill any unfilled fields visible after scrolling
        await adapter.act(
          `If there are any EMPTY required fields visible on screen (marked with * or highlighted in red), CLICK on each one and fill it with the correct value. If ALL visible fields are already filled, do NOTHING — just stop immediately.

${fillPrompt}`,
        );
      }
    }

    // After max retries, proceed anyway (let the main loop handle it)
    console.warn(`[WorkdayApply] [${pageLabel}] Still has errors after ${MAX_RETRIES} retries, proceeding...`);
    await this.waitForPageLoad(adapter);
  }

  /**
   * Click "Save and Continue" / "Next" via direct Playwright DOM click.
   * This prevents the LLM act() from bleeding into the next page.
   */
  private async clickSaveAndContinueDOM(adapter: BrowserAutomationAdapter): Promise<void> {
    const clicked = await adapter.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
      // Priority order: "Save and Continue" > "Next" > "Continue"
      const priorities = ['save and continue', 'next', 'continue'];
      for (const target of priorities) {
        const btn = buttons.find(b => {
          const text = b.textContent?.trim().toLowerCase() || '';
          return text === target;
        });
        if (btn) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      // Fallback: partial match
      const fallback = buttons.find(b => {
        const text = b.textContent?.trim().toLowerCase() || '';
        return text.includes('save and continue') || text.includes('next');
      });
      if (fallback) {
        (fallback as HTMLElement).click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      // Last resort: use LLM but with very strict instruction
      console.warn('[WorkdayApply] DOM click failed, falling back to LLM act()');
      await adapter.act(
        'Click the "Save and Continue" button. Click ONLY that button and then STOP. Do absolutely nothing else.',
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
      // User-provided Q&A overrides take highest priority (spread last)
      ...qaOverrides,
    };
  }

  /**
   * Programmatically fill Workday dropdowns that still show "Select One".
   * Bypasses the LLM entirely — uses DOM queries to find options and click them.
   */
  private async fillDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
  ): Promise<number> {
    // Step 1: Scan page for all unfilled dropdowns and tag them with temp attributes
    const dropdownInfos = await adapter.page.evaluate(() => {
      const results: Array<{ index: number; label: string }> = [];
      const buttons = document.querySelectorAll('button');
      let idx = 0;

      buttons.forEach(btn => {
        const text = btn.textContent?.trim();
        if (text !== 'Select One') return;

        // Skip invisible buttons
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Tag for reliable re-selection via Playwright locator
        btn.setAttribute('data-gh-dropdown-idx', String(idx));

        // Walk up the DOM to find the associated label
        let labelText = '';
        let node: HTMLElement | null = btn;
        for (let depth = 0; depth < 10 && node; depth++) {
          node = node.parentElement;
          if (!node) break;
          const lbl = node.querySelector('label');
          if (lbl && lbl.textContent?.trim()) {
            labelText = lbl.textContent.trim();
            break;
          }
        }

        // Fallback: data-automation-id based labels
        if (!labelText) {
          const parent = btn.closest('[data-automation-id]');
          if (parent) {
            const labelEls = parent.querySelectorAll(
              '[data-automation-id*="formLabel"], [data-automation-id*="label"]',
            );
            for (const l of labelEls) {
              const t = l.textContent?.trim();
              if (t && t !== 'Select One') {
                labelText = t;
                break;
              }
            }
          }
        }

        results.push({ index: idx, label: labelText });
        idx++;
      });

      return results;
    });

    if (dropdownInfos.length === 0) return 0;

    console.log(`[WorkdayApply] [Programmatic] Found ${dropdownInfos.length} unfilled dropdown(s)`);

    let filled = 0;

    for (const info of dropdownInfos) {
      const answer = this.findBestDropdownAnswer(info.label, this.fullQAMap);
      if (!answer) {
        console.log(`[WorkdayApply] [Programmatic] No answer for: "${info.label}"`);
        continue;
      }

      // Verify the button still shows "Select One" (may have been filled by a prior iteration)
      const btn = adapter.page.locator(`button[data-gh-dropdown-idx="${info.index}"]`);
      const stillUnfilled = await btn.textContent().catch(() => '');
      if (!stillUnfilled?.includes('Select One')) continue;

      console.log(`[WorkdayApply] [Programmatic] Filling: "${info.label}" → "${answer}"`);

      // Scroll into view and click to open
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await adapter.page.waitForTimeout(600);

      // Find and click the matching option in the opened listbox
      const clicked = await this.clickDropdownOption(adapter, answer);

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
   * Searches ALL option elements in the DOM (not just visible ones in the scroll viewport).
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

    return adapter.page.evaluate((target: string) => {
      const targetLower = target.toLowerCase();

      // Collect option elements from various Workday DOM patterns
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
          '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
      );

      // Pass 1: Exact match (case-insensitive)
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text === targetLower) {
          (opt as HTMLElement).click();
          return true;
        }
      }

      // Pass 2: Option text starts with target
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.startsWith(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }

      // Pass 3: Target is contained in option text
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.includes(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }

      // Pass 4: Option text is contained in target (for partial matches)
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.length > 2 && targetLower.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }

      return false;
    }, searchText);
  }

  /**
   * Find the best matching answer for a dropdown label from the Q&A map.
   * Uses multi-pass fuzzy matching: exact → contains → keyword overlap.
   */
  private findBestDropdownAnswer(
    label: string,
    qaMap: Record<string, string>,
  ): string | null {
    if (!label) return null;

    const labelLower = label.toLowerCase().replace(/\*/g, '').trim();

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
    parts.push('For any self-identification questions (gender, race, veteran, disability) → select "I do not wish to answer" or "Decline to self-identify"');
    parts.push('For any question not listed above, select the most reasonable/common answer.');
    parts.push('DROPDOWN TECHNIQUE (two-phase): Phase 1: After opening a dropdown, TYPE the desired answer (e.g. "No", "Yes") to filter the list. If a matching option appears, click it. Phase 2: If typing does not filter or no match appears, click whitespace to close the dropdown, then re-click the dropdown to reopen it, and press the DOWN ARROW key repeatedly to scroll through options one by one until you find the correct one, then press ENTER to select it. NEVER use mouse scroll inside dropdowns (it scrolls too little). NEVER press Escape inside a dropdown (it may trigger Enter instead).');
    parts.push('NESTED DROPDOWNS: Some dropdowns have sub-menus. After selecting a category (e.g. "Website"), a second list appears with specific options (e.g. "workday.com"). Select the sub-option. Do NOT click any back arrow or "← Category" button — that navigates backwards.');
    parts.push('NEVER click "Submit Application" or "Submit".');

    return parts.join('\n');
  }
}
