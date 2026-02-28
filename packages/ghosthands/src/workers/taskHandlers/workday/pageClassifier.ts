/**
 * Page classification logic for Workday application flows.
 *
 * Detects the current page type using a combination of URL-based hints,
 * DOM signal analysis, and LLM-based extraction as a fallback.
 */

import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import { PageStateSchema } from './constants.js';
import type { PageState } from './constants.js';
import { getLogger } from '../../../monitoring/logger.js';

/**
 * Detect the current page type in a Workday application flow.
 * Uses URL-based detection first (reliable, no LLM needed), then DOM signals,
 * then LLM extraction, with DOM-based fallback if all else fails.
 */
export async function detectPage(adapter: BrowserAutomationAdapter): Promise<PageState> {
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
    getLogger().info('DOM detected sign-in page');
    return { page_type: 'login', page_title: 'Workday Sign-In', has_sign_in_with_google: domSignals.hasSignInWithGoogle };
  }

  try {
    // URL-based hints to help the LLM
    const urlHints: string[] = [];
    if (currentUrl.includes('signin') || currentUrl.includes('login')) urlHints.push('This appears to be a login page.');
    if (currentUrl.includes('myworkdayjobs.com') && currentUrl.includes('/job/')) urlHints.push('This appears to be a Workday job listing.');
    //if (currentUrl.includes('greenhouse.io') && currentUrl.includes('/job/')) urlHints.push('This appears to be a Workday job listing.');

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
    getLogger().warn('Page detection failed', { error: error instanceof Error ? error.message : String(error) });
    // Fallback: DOM-based page classification when LLM extract fails
    // (e.g. BamlValidationError from null fields)
    if (currentUrl.includes('myworkdayjobs.com') && (currentUrl.includes('login') || currentUrl.includes('signin'))) {
      return { page_type: 'login', page_title: 'Workday Login' };
    }
    // DOM-based fallback: read the page heading text to classify.
    // IMPORTANT: Only use the MAIN page heading (h1/h2/h3) for classification,
    // NOT progress bar step titles which contain "Review" on every page.
    const domFallback = await classifyPageFromDOM(adapter);
    if (domFallback !== 'unknown') {
      getLogger().info('DOM fallback classified page', { pageType: domFallback });
    }
    return { page_type: domFallback, page_title: domFallback === 'unknown' ? 'N/A' : domFallback };
  }
}

/**
 * DOM-based fallback page classification.
 * Reads page headings and body text to determine the page type when
 * LLM extraction fails.
 */
async function classifyPageFromDOM(adapter: BrowserAutomationAdapter): Promise<PageState['page_type']> {
  return adapter.page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    // Only read actual page headings — NOT progress bar steps (stepTitle)
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id*="pageHeader"]'));
    const headingText = headings.map(h => h.textContent?.toLowerCase() || '').join(' ');

    // Structural signals — used for review detection
    const hasSelectOneDropdowns = Array.from(document.querySelectorAll('button')).some(b => (b.textContent || '').trim() === 'Select One');
    const hasFormInputs = document.querySelectorAll('input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]').length > 0;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const buttonTexts = buttons.map(b => (b.textContent || '').trim().toLowerCase());
    const hasSubmitButton = buttonTexts.some(t => t === 'submit' || t === 'submit application');
    const hasSaveAndContinue = buttonTexts.some(t => t.includes('save and continue'));

    // REVIEW page detection FIRST: The review page is a read-only summary that
    // contains ALL section headings ("Application Questions", "My Information", etc.)
    // in its body. Check structural indicators before text matching to avoid false positives.
    if (!hasSelectOneDropdowns && !hasFormInputs && !hasSaveAndContinue && hasSubmitButton) return 'review';
    if (headingText.includes('review') && !hasSelectOneDropdowns && !hasFormInputs) return 'review';

    // Now check specific page types by heading text (NOT body text — the review page
    // body contains all section names which would cause false positives)
    if (headingText.includes('application questions') || headingText.includes('additional questions')) return 'questions';
    if (headingText.includes('voluntary disclosures') || headingText.includes('voluntary self')) return 'voluntary_disclosure';
    if (headingText.includes('self identify') || headingText.includes('self-identify')) return 'self_identify';
    if (headingText.includes('my experience') || headingText.includes('work experience')) return 'experience';
    if (headingText.includes('my information') || headingText.includes('personal info')) return 'personal_info';

    // Broader body text search as last resort (only if heading didn't match)
    const bodyStart = bodyText.substring(0, 2000);
    if (bodyStart.includes('application questions') || bodyStart.includes('additional questions')) return 'questions';
    if (bodyStart.includes('voluntary disclosures')) return 'voluntary_disclosure';
    if (bodyStart.includes('self identify') || bodyStart.includes('self-identify') || bodyStart.includes('disability status')) return 'self_identify';
    if (bodyStart.includes('my experience') || bodyStart.includes('resume')) return 'experience';
    if (bodyStart.includes('my information')) return 'personal_info';

    return 'unknown';
  });
}

/**
 * Quick check if the current page is actually the review page (misclassified).
 * Used as a safety check before filling forms.
 */
export async function isActuallyReview(adapter: BrowserAutomationAdapter): Promise<boolean> {
  return adapter.page.evaluate(() => {
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
}
