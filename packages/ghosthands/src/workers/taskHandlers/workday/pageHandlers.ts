/**
 * Individual page type handlers for Workday application flows.
 *
 * Each handler corresponds to a specific page type in the Workday
 * application process (job listing, login, verification code, 2FA,
 * account creation, personal info, experience/resume, voluntary
 * disclosure, self-identify, generic).
 */

import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import type { WorkdayUserProfile } from './workdayTypes.js';
import type { PageState } from './constants.js';
import { PHONE_2FA_TIMEOUT_MS, PHONE_2FA_POLL_INTERVAL_MS } from './constants.js';
import { getLogger } from '../../../monitoring/logger.js';
import {
  buildPersonalInfoPrompt,
  buildFormPagePrompt,
  buildExperiencePrompt,
  buildVoluntaryDisclosurePrompt,
  buildSelfIdentifyPrompt,
  buildGenericPagePrompt,
} from './workdayPrompts.js';
import { handleGoogleSignIn } from './googleSignIn.js';
import { fillWithSmartScroll } from './smartScroll.js';
import { centerNextEmptyField } from './domFillers.js';
import { waitForPageLoad, clickNextWithErrorRecovery } from './navigation.js';

// --- Job Listing ---

export async function handleJobListing(adapter: BrowserAutomationAdapter, pageState: PageState): Promise<void> {
  const logger = getLogger();
  logger.info('On job listing page, clicking Apply');
  const result = await adapter.act(
    'Click the "Apply" button to start the job application. Look for buttons labeled "Apply", "Apply Now", "Apply for this job", or similar. If there are multiple apply buttons, click the main/primary one.',
  );
  if (!result.success) {
    throw new Error(`Failed to click Apply button: ${result.message}`);
  }
  await waitForPageLoad(adapter);
}

// --- Login ---

export async function handleLogin(
  adapter: BrowserAutomationAdapter,
  pageState: PageState,
  userProfile: WorkdayUserProfile,
): Promise<void> {
  const currentUrl = await adapter.getCurrentUrl();
  const email = userProfile.email;

  // If we're on Google's sign-in page, handle each sub-page with DOM clicks
  // instead of act() to prevent the LLM from navigating into CAPTCHA pages.
  if (currentUrl.includes('accounts.google.com')) {
    await handleGoogleSignIn(adapter, email);
    return;
  }

  // Otherwise we're on the Workday login page — click "Sign in with Google"
  const logger = getLogger();
  logger.info('On login page, clicking Sign in with Google');

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
        logger.info('Clicked Sign in with Google via Playwright locator');
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
      logger.warn('Google sign-in button not found, trying generic sign-in', { message: result.message });
      await adapter.act('Click the "Sign In", "Log In", or "Create Account" button.');
    }
  }

  await waitForPageLoad(adapter);
}

// --- Verification Code ---

export async function handleVerificationCode(adapter: BrowserAutomationAdapter): Promise<void> {
  const logger = getLogger();
  logger.info('Verification code required, checking Gmail for code');

  // Open Gmail in a new approach — navigate to it
  const currentUrl = await adapter.getCurrentUrl();

  // Navigate to Gmail to get the verification code
  await adapter.navigate('https://mail.google.com');
  await waitForPageLoad(adapter);

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

  logger.info('Found verification code');

  // Go back to the verification page
  await adapter.navigate(currentUrl);
  await waitForPageLoad(adapter);

  // Enter the code
  const enterResult = await adapter.act(
    `Enter the verification code "${codeResult.code}" into the verification code input field and click the "Next", "Verify", "Continue", or "Submit" button.`,
  );

  if (!enterResult.success) {
    throw new Error(`Failed to enter verification code: ${enterResult.message}`);
  }

  await waitForPageLoad(adapter);
}

// --- Phone 2FA ---

export async function handlePhone2FA(adapter: BrowserAutomationAdapter): Promise<void> {
  const logger = getLogger();
  const currentUrl = await adapter.getCurrentUrl();
  // Any Google /challenge/ page needs manual intervention — just poll URL changes
  const isGoogleChallenge = currentUrl.includes('accounts.google.com') && currentUrl.includes('/challenge/');

  const challengeType = currentUrl.includes('recaptcha') ? 'CAPTCHA'
    : currentUrl.includes('ipp') ? 'SMS/Phone verification'
    : 'Google security challenge';
  logger.info('Manual action required', { challengeType, url: currentUrl, timeoutSeconds: PHONE_2FA_TIMEOUT_MS / 1000 });

  const startTime = Date.now();
  const startUrl = currentUrl;

  while (Date.now() - startTime < PHONE_2FA_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, PHONE_2FA_POLL_INTERVAL_MS));

    const nowUrl = await adapter.getCurrentUrl();
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // If URL changed, the challenge was solved
    if (nowUrl !== startUrl) {
      logger.info('Challenge resolved', { elapsedSeconds: elapsed });
      return;
    }

    // For Google challenges, just poll URL changes (don't waste LLM calls)
    if (isGoogleChallenge) {
      logger.debug('Still waiting for manual action', { elapsedSeconds: elapsed });
      continue;
    }

    // For non-Google 2FA, also check if the page content changed
    const pageCheck = await adapter.extract(
      'Is there still a 2FA/two-factor authentication prompt on this page asking the user to approve on their phone?',
      z.object({ still_waiting: z.boolean() }),
    );

    if (!pageCheck.still_waiting) {
      logger.info('Challenge resolved', { elapsedSeconds: elapsed });
      return;
    }

    logger.debug('Still waiting for manual action', { elapsedSeconds: elapsed });
  }

  throw new Error('Phone 2FA timed out after 3 minutes. Please try again.');
}

// --- Account Creation ---

export async function handleAccountCreation(
  adapter: BrowserAutomationAdapter,
  userProfile: WorkdayUserProfile,
  dataPrompt: string,
): Promise<void> {
  getLogger().info('Account creation page detected, filling in details');

  const result = await adapter.act(
    `Fill out the account creation form with the provided user information, then click "Create Account", "Register", "Continue", or "Next". ${dataPrompt}`,
  );

  if (!result.success) {
    throw new Error(`Failed to create account: ${result.message}`);
  }

  await waitForPageLoad(adapter);
}

// --- Personal Info ---

export async function handlePersonalInfoPage(
  adapter: BrowserAutomationAdapter,
  profile: WorkdayUserProfile,
  qaOverrides: Record<string, string>,
  fullQAMap: Record<string, string>,
): Promise<void> {
  getLogger().info('Filling personal info page with smart scroll');

  const qaList = Object.entries(qaOverrides)
    .map(([q, a]) => `"${q}" \u2192 ${a}`)
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

  const fillPrompt = buildPersonalInfoPrompt(dataBlock);

  await fillWithSmartScroll(adapter, fillPrompt, 'personal info', fullQAMap);
}

// --- Form Page (Application Questions) ---

export async function handleFormPage(
  adapter: BrowserAutomationAdapter,
  pageDescription: string,
  dataPrompt: string,
  fullQAMap: Record<string, string>,
): Promise<'done' | 'review_detected'> {
  getLogger().info('Filling form page', { pageDescription });

  const fillPrompt = buildFormPagePrompt(pageDescription, dataPrompt);

  return fillWithSmartScroll(adapter, fillPrompt, pageDescription, fullQAMap);
}

// --- My Experience (resume upload + work/edu/skills) ---

/**
 * Handle the "My Experience" page: upload resume via DOM, then use LLM agent
 * to fill work experience, education, skills, and LinkedIn.
 *
 * This page uses a CUSTOM scroll+LLM loop instead of fillWithSmartScroll because:
 * - Fields are hidden behind "Add" buttons (hasEmptyVisibleFields returns false)
 * - The LLM must ALWAYS be invoked to click "Add" and fill expanded forms
 * - More LLM calls are needed (6 vs 4) due to multiple sections
 */
export async function handleExperiencePage(
  adapter: BrowserAutomationAdapter,
  userProfile: WorkdayUserProfile,
  fullQAMap: Record<string, string>,
): Promise<void> {
  const logger = getLogger();
  logger.info('On My Experience page, uploading resume via DOM then LLM fills sections');

  // Scroll to top first
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);

  // ==================== DOM-ONLY: Upload Resume ====================
  if (userProfile.resume_path) {
    logger.info('Uploading resume via DOM');
    const resumePath = path.isAbsolute(userProfile.resume_path)
      ? userProfile.resume_path
      : path.resolve(process.cwd(), userProfile.resume_path);

    if (!fs.existsSync(resumePath)) {
      logger.warn('Resume not found, skipping upload', { resumePath });
    } else {
      // Check if a resume is already uploaded (e.g. from a previous partial fill)
      const alreadyUploaded = await adapter.page.evaluate(`
        (() => {
          // Workday shows the uploaded filename near the file input area
          var fileArea = document.querySelector('[data-automation-id="resumeSection"], [data-automation-id="attachmentsSection"], [data-automation-id="fileUploadSection"]');
          var searchArea = fileArea || document.body;
          var text = searchArea.innerText || '';
          // Look for common resume file extensions in visible text
          if (/\\.(pdf|docx?|rtf|txt)/i.test(text)) return true;
          // Look for a delete/remove button near file inputs (Workday shows X next to uploaded files)
          var deleteBtn = searchArea.querySelector('[data-automation-id="delete-file"], button[aria-label*="delete" i], button[aria-label*="remove" i]');
          if (deleteBtn) return true;
          // Check if there's a visible filename element near the file input
          var fileNames = searchArea.querySelectorAll('[data-automation-id="fileName"], [data-automation-id="file-name"], .file-name');
          for (var i = 0; i < fileNames.length; i++) {
            if ((fileNames[i].textContent || '').trim().length > 2) return true;
          }
          return false;
        })()
      `) as boolean;

      if (alreadyUploaded) {
        logger.info('Resume already uploaded, skipping');
      } else try {
        const fileInput = adapter.page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(resumePath);
        logger.info('Resume file set via DOM file input');
        await adapter.page.waitForTimeout(5000);

        const uploadOk = await adapter.page.evaluate(() => {
          return document.body.innerText.toLowerCase().includes('successfully uploaded')
            || document.body.innerText.toLowerCase().includes('successfully');
        });
        if (uploadOk) {
          logger.info('Resume upload confirmed');
        } else {
          logger.warn('Resume upload status unclear, continuing');
        }
      } catch (err) {
        logger.warn('Resume upload failed', { error: err instanceof Error ? err.message : String(err) });
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
  From date: ${fromDate} — Look for the text "MM" on screen and click DIRECTLY on the letters "MM". Do NOT click the calendar icon or the "YYYY" box. After clicking "MM", type "${fromDate.replace('/', '')}" as continuous digits — Workday auto-advances to YYYY. If you see "1900" or an error, click the "YYYY" box, press Delete 6 times to clear it, then retype "${fromDate.replace('/', '')}".
  Role Description: ${exp.description}
`;
  }

  if (edu) {
    dataBlock += `
EDUCATION (click "Add" under Education section first):
  School or University: ${edu.school}
  Degree: ${edu.degree} (this is a DROPDOWN — click it, then type "${edu.degree}" to filter and select)
  Field of Study: ${edu.field_of_study} (this is a TYPEAHEAD — follow these steps exactly:
    1. Click the Field of Study input.
    2. Type "${edu.field_of_study}" into the input.
    3. Press Enter to trigger the dropdown to update.
    4. Wait a moment for the options to load.
    5. Look through the visible options for "${edu.field_of_study}" and click it.
    6. If the correct option is NOT visible in the dropdown, scroll through the dropdown list by clicking the scrollbar on the side of the dropdown to find and click the correct option.
  )
`;
  }

  if (userProfile.skills && userProfile.skills.length > 0) {
    dataBlock += `
SKILLS (find the skills input field, usually has placeholder "Type to Add Skills"):
  For EACH skill below: click the skills input, type the skill name, press Enter to trigger the dropdown, WAIT for the autocomplete dropdown to appear, then CLICK the matching option from the dropdown. If the correct option is not visible, scroll the dropdown to find it. After selecting, click on empty whitespace to dismiss the dropdown before typing the next skill.
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

  const fillPrompt = buildExperiencePrompt(dataBlock);

  // Custom scroll+LLM loop: ALWAYS invoke LLM each round because fields
  // are behind "Add" buttons that hasEmptyVisibleFields() can't detect.
  const MAX_SCROLL_ROUNDS = 8;
  const MAX_LLM_CALLS = 6;
  let llmCallCount = 0;

  // Scroll to top before DOM fills
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);

  // Scroll back to top before the LLM loop begins.
  // centerNextEmptyField and DOM interactions above may have shifted the scroll position.
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(400);

  for (let round = 1; round <= MAX_SCROLL_ROUNDS; round++) {
    // Always invoke LLM — experience page has dynamic content behind Add buttons
    if (llmCallCount < MAX_LLM_CALLS) {
      // Center the next empty field so the LLM sees it mid-screen (not at an edge)
      await centerNextEmptyField(adapter);
      logger.debug('MyExperience LLM fill round', { round, llmCall: llmCallCount + 1, maxLlmCalls: MAX_LLM_CALLS });
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
      logger.debug('MyExperience reached bottom of page');
      break;
    }

    // Scroll down 65% of viewport
    await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
    await adapter.page.waitForTimeout(800);

    const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
    if (scrollAfter <= scrollBefore) {
      logger.debug('MyExperience cannot scroll further');
      break;
    }

    logger.debug('MyExperience scrolled', { scrollY: scrollAfter, round });
  }

  logger.info('MyExperience page complete', { totalLlmCalls: llmCallCount });

  // Navigate: click Save and Continue with error recovery
  await clickNextWithErrorRecovery(adapter, fillPrompt, 'my experience', fullQAMap);
}

// --- Voluntary Disclosure ---

export async function handleVoluntaryDisclosure(
  adapter: BrowserAutomationAdapter,
  dataPrompt: string,
  fullQAMap: Record<string, string>,
): Promise<'done' | 'review_detected'> {
  getLogger().info('Filling voluntary self-identification page');

  const fillPrompt = buildVoluntaryDisclosurePrompt();

  return fillWithSmartScroll(adapter, fillPrompt, 'voluntary disclosure', fullQAMap);
}

// --- Self-Identify ---

export async function handleSelfIdentify(
  adapter: BrowserAutomationAdapter,
  dataPrompt: string,
  fullQAMap: Record<string, string>,
): Promise<'done' | 'review_detected'> {
  getLogger().info('Filling self-identification page');

  const fillPrompt = buildSelfIdentifyPrompt();

  return fillWithSmartScroll(adapter, fillPrompt, 'self-identify', fullQAMap);
}

// --- Generic / Unknown ---

export async function handleGenericPage(
  adapter: BrowserAutomationAdapter,
  dataPrompt: string,
  fullQAMap: Record<string, string>,
): Promise<void> {
  getLogger().info('Handling generic/unknown page');

  const fillPrompt = buildGenericPagePrompt(dataPrompt);

  await fillWithSmartScroll(adapter, fillPrompt, 'generic', fullQAMap);
}
