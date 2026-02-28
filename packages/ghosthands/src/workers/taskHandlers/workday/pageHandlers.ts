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
  buildExperienceEntryPrompt,
  buildVoluntaryDisclosurePrompt,
  buildSelfIdentifyPrompt,
  buildGenericPagePrompt,
  type SelfIdFields,
} from './workdayPrompts.js';
import { handleGoogleSignIn } from './googleSignIn.js';
import { fillWithSmartScroll } from './smartScroll.js';
import { waitForPageLoad, clickNextWithErrorRecovery } from './navigation.js';

// --- DOM Helpers ---

/**
 * Find and click the "Add" button for a specific section (e.g. "Work Experience", "Education").
 *
 * Two-phase approach:
 *   1. DOM scan: find the button, tag it with data-gh-add-target, scroll it into view.
 *   2. Playwright click: use real mouse events (Workday's React handlers ignore JS .click()).
 *
 * Matches button text: "Add", "Add Another", "Add Work Experience", etc.
 */
async function clickSectionAddButton(
  adapter: BrowserAutomationAdapter,
  sectionLabel: string,
): Promise<boolean> {
  const logger = getLogger();
  const labelLower = sectionLabel.toLowerCase();

  // Phase 1: DOM scan — heading-first approach.
  // Find the section heading, then find the nearest Add button after it in DOM order.
  // This prevents matching a Work Experience Add button when looking for Education.
  const found = await adapter.page.evaluate(`
    (() => {
      var label = "${labelLower}";
      // Remove any stale tag from a prior call
      var old = document.querySelector('[data-gh-add-target]');
      if (old) old.removeAttribute('data-gh-add-target');

      // Step 1: Find all headings and buttons in DOM order using TreeWalker
      var walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        { acceptNode: function(n) {
          var tag = n.tagName;
          if (tag === 'BUTTON' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5') {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }}
      );

      var elements = [];
      var el;
      while (el = walker.nextNode()) { elements.push(el); }

      // Step 2: Find the LAST heading that matches our section label
      var lastHeadingIndex = -1;
      for (var i = 0; i < elements.length; i++) {
        var tag = elements[i].tagName;
        if (tag !== 'BUTTON') {
          var text = (elements[i].textContent || '').toLowerCase();
          if (text.includes(label)) { lastHeadingIndex = i; }
        }
      }
      if (lastHeadingIndex === -1) return false;

      // Step 3: Starting after the heading, find the first Add button.
      // Stop if we hit a heading for a DIFFERENT section (means we've left our section).
      var knownSections = ['work experience', 'education', 'skills', 'websites', 'certifications'];
      for (var j = lastHeadingIndex + 1; j < elements.length; j++) {
        var el = elements[j];
        if (el.tagName !== 'BUTTON') {
          // It's a heading — check if it belongs to a different section
          var headText = (el.textContent || '').toLowerCase();
          var isDifferentSection = false;
          for (var s = 0; s < knownSections.length; s++) {
            if (knownSections[s] !== label && headText.includes(knownSections[s])) {
              isDifferentSection = true;
              break;
            }
          }
          if (isDifferentSection) break; // Left our section
          continue;
        }
        // It's a button
        var btnText = (el.textContent || '').trim().toLowerCase();
        if (!btnText.startsWith('add')) continue;
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        el.setAttribute('data-gh-add-target', 'true');
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }
      return false;
    })()
  `) as boolean;

  if (!found) return false;

  // Phase 2: Playwright click — real mouse events that trigger Workday's React handlers
  try {
    const btn = adapter.page.locator('[data-gh-add-target="true"]');
    await btn.click({ timeout: 3000 });
    logger.info('Clicked Add button via Playwright', { section: sectionLabel });
  } catch {
    // Fallback to DOM click if Playwright can't reach it
    await adapter.page.evaluate(() => {
      const el = document.querySelector('[data-gh-add-target="true"]') as HTMLElement;
      if (el) el.click();
    });
    logger.info('Clicked Add button via DOM fallback', { section: sectionLabel });
  }

  // Clean up tag
  await adapter.page.evaluate(() => {
    const el = document.querySelector('[data-gh-add-target]');
    if (el) el.removeAttribute('data-gh-add-target');
  });

  return true;
}

/**
 * After clicking "Add" for a section, scroll to the newly created empty entry fields.
 * Finds the LAST empty text input within/near the section (the newest entry) and
 * scrolls it into view. Falls back to scrolling the section heading into view.
 */
async function scrollToNewEntryFields(
  adapter: BrowserAutomationAdapter,
  sectionLabel: string,
): Promise<void> {
  const labelLower = sectionLabel.toLowerCase();

  await adapter.page.evaluate(`
    (() => {
      var label = "${labelLower}";

      // Find the section container by looking for headings that mention the label
      var headings = document.querySelectorAll('h2, h3, h4, h5, legend, [data-automation-id]');
      var sectionEl = null;
      for (var i = 0; i < headings.length; i++) {
        var text = (headings[i].textContent || '').toLowerCase();
        if (text.includes(label)) {
          // Walk up a few levels to find the section container
          sectionEl = headings[i].parentElement;
          for (var u = 0; u < 5 && sectionEl; u++) {
            // A good container has multiple inputs inside it
            var inputs = sectionEl.querySelectorAll('input[type="text"], input:not([type]), textarea');
            if (inputs.length >= 2) break;
            sectionEl = sectionEl.parentElement;
          }
          break;
        }
      }

      // Find the FIRST empty text input in the section (the newly created entry's first field)
      var searchArea = sectionEl || document.body;
      var inputs = searchArea.querySelectorAll('input[type="text"], input:not([type]), textarea');
      var firstEmpty = null;
      for (var j = 0; j < inputs.length; j++) {
        var inp = inputs[j];
        if (inp.disabled || inp.readOnly || inp.type === 'hidden') continue;
        var rect = inp.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        var ph = (inp.placeholder || '').toUpperCase();
        if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
        if (inp.closest('[role="listbox"]')) continue;
        if (!inp.value || inp.value.trim() === '') {
          firstEmpty = inp;
          break;
        }
      }

      if (firstEmpty) {
        firstEmpty.scrollIntoView({ block: 'center', behavior: 'instant' });
      } else if (sectionEl) {
        sectionEl.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    })()
  `);

  await adapter.page.waitForTimeout(500);
}

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
  // Configurable max entries
  const maxExperiences = (userProfile as any).max_experiences ?? 2;
  const maxEducations = (userProfile as any).max_educations ?? 1;
  const maxSkills = (userProfile as any).max_skills ?? 3;

  const experiences = (userProfile.experience || []).slice(0, maxExperiences);
  const educations = (userProfile.education || []).slice(0, maxEducations);

  logger.info('Experience page entries', {
    totalExperiences: userProfile.experience?.length || 0,
    fillingExperiences: experiences.length,
    totalEducations: userProfile.education?.length || 0,
    fillingEducations: educations.length,
  });

  let llmCallCount = 0;

  // Scroll to top before filling
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);

  // ==================== SEQUENTIAL WORK EXPERIENCE ENTRIES ====================
  for (let i = 0; i < experiences.length; i++) {
    const exp = experiences[i];
    logger.info('Filling work experience entry', { entry: i + 1, total: experiences.length, title: exp.title });

    // a. Click "Add" under Work Experience via DOM
    const addClicked = await clickSectionAddButton(adapter, 'Work Experience');
    if (!addClicked) {
      logger.warn('Could not find Add button for Work Experience', { entry: i + 1 });
    }
    await adapter.page.waitForTimeout(1000);

    // b. Scroll to the new entry's first empty field
    await scrollToNewEntryFields(adapter, 'Work Experience');

    // c. Build focused prompt for just this entry
    // Date defaults: yesterday for "from", today for "to"
    const yesterday = new Date(Date.now() - 86400000);
    const today = new Date();
    const fmtDate = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const parseDate = (raw: string | undefined, fallback: Date) => {
      if (!raw) return fmtDate(fallback);
      const parts = raw.split('-');
      return parts.length >= 2 ? `${parts[1]}/${parts[0]}` : raw;
    };

    const fromDate = parseDate(exp.start_date, yesterday);
    const toDate = parseDate(exp.end_date, today);

    const toDateLine = exp.currently_work_here
      ? ''
      : `\n  To date: ${toDate} — click on the "MM" text, then type "${toDate.replace('/', '')}" as continuous digits.`;

    const entryData = `You are filling WORK EXPERIENCE entry ${i + 1} of ${experiences.length}.

ABSOLUTE RULE: Find the heading "Work Experience ${i + 1}" on the page. You must ONLY interact with fields that appear BELOW this heading. Everything above this heading belongs to previous entries — do NOT click, type, scroll to, or modify ANY field above "Work Experience ${i + 1}" under any circumstances. If you see fields with values that look "wrong" or different from what is listed below, but those fields are ABOVE the "Work Experience ${i + 1}" heading, they belong to a PREVIOUS entry and are CORRECT — leave them alone.

IDENTIFYING YOUR FIELDS: The fields for this entry are EMPTY by default:
  - Text fields will be BLANK (no text).
  - Date fields will show "MM/YYYY" placeholders (not actual dates).
  - The "I currently work here" checkbox will be UNCHECKED by default.
If you see a field that already has a value (text, a date like "05/2024", or a CHECKED checkbox), it belongs to a PREVIOUS entry — do NOT touch it, do NOT uncheck it, do NOT modify it. YOUR fields are empty/unchecked and require scrolling DOWN to find.

Fill ALL of these fields (scroll down if needed to find them):
  Job Title: ${exp.title}
  Company: ${exp.company}
  Location: ${exp.location || ''}
  I currently work here: ${exp.currently_work_here ? 'YES — check the checkbox' : 'No — the checkbox is already unchecked by default, do NOT touch any checkbox that is already checked'}
  From date: ${fromDate} — click on the "MM" text, then type "${fromDate.replace('/', '')}" as continuous digits.${toDateLine}
  Role Description: ${exp.description}

REMEMBER: NEVER scroll up. All fields for this entry are BELOW the "Work Experience ${i + 1}" heading — keep scrolling DOWN to find them. The order from top to bottom is: Job Title → Company → Location → Checkbox → Date fields → Role Description.

RECOVERY: If at any point you see a heading for a PREVIOUS entry (e.g. "Work Experience ${i}" or earlier), you have scrolled too far up or are looking at the wrong area. Immediately scroll DOWN (at least 50 pixels per scroll) until you see the "Work Experience ${i + 1}" heading, then continue filling fields below it.

Do NOT click any "Add" buttons. Do NOT touch any other sections. Do NOT interact with fields under any other "Work Experience" heading.`;

    const entryPrompt = buildExperienceEntryPrompt(entryData);

    // d. Single LLM call — the LLM can scroll within the entry
    logger.debug('Work experience LLM call', { entry: i + 1, llmCall: llmCallCount + 1 });
    await adapter.act(entryPrompt);
    llmCallCount++;
    await adapter.page.waitForTimeout(1000);

    logger.info('Work experience entry done', { entry: i + 1, title: exp.title });
  }

  // ==================== SEQUENTIAL EDUCATION ENTRIES ====================
  for (let i = 0; i < educations.length; i++) {
    const edu = educations[i];
    logger.info('Filling education entry', { entry: i + 1, total: educations.length, school: edu.school });

    // a. Click "Add" under Education via DOM
    const addClicked = await clickSectionAddButton(adapter, 'Education');
    if (!addClicked) {
      logger.warn('Could not find Add button for Education', { entry: i + 1 });
    }
    await adapter.page.waitForTimeout(1000);

    // b. Scroll to the new entry's first empty field
    await scrollToNewEntryFields(adapter, 'Education');

    // c. Build focused prompt for just this entry
    const entryData = `You are filling EDUCATION entry ${i + 1} of ${educations.length}.

CRITICAL: Find the heading "Education ${i + 1}" on the page. IGNORE everything ABOVE that heading — those fields belong to previous entries and you must NOT interact with them. Only fill fields that appear BELOW the "Education ${i + 1}" heading.

Fill ALL of these fields (scroll down if needed to find them):
  School or University: ${edu.school}
  Degree: ${edu.degree} (this is a DROPDOWN — click it, then type "${edu.degree}" to filter and select)
  Field of Study: ${edu.field_of_study} (this is a TYPEAHEAD — the value MUST be selected from the dropdown, typing alone will NOT work. Follow these steps exactly:
    1. Click the Field of Study input box to select it.
    2. Type "${edu.field_of_study}" into the input.
    3. Press ENTER to trigger the dropdown to filter/update.
    4. WAIT 3 seconds — do nothing during this time. Let the dropdown load.
    5. Look for "${edu.field_of_study}" in the dropdown list and CLICK on it. The field is NOT filled until you click the option.
    6. If "${edu.field_of_study}" is NOT found in the dropdown (you see "No matches found" or the exact option simply does not exist in the list):
       a. Clear the input field (click the X button next to the text, or select all + delete).
       b. Type a SHORTER search term — use just the first word: "${edu.field_of_study.split(/\s+/)[0]}".
       c. Press ENTER and WAIT 3 seconds for the dropdown to update.
       d. Look for the CLOSEST matching option and CLICK it. For example, "Business Administration" is a reasonable match for "Business Analytics", and "Computer Science" is a reasonable match for "Computer Engineering".
       e. If the first word yields no results either, try other individual words from "${edu.field_of_study}".
       f. Do NOT scroll endlessly through the entire dropdown list. If the exact value doesn't exist, pick the closest available match using a shorter search term.
    7. After clicking the option, click on empty whitespace to dismiss the dropdown.
    DO NOT skip step 3 (Enter) or step 5 (click). Typing alone does NOT fill the field.
    IMPORTANT: The exact value "${edu.field_of_study}" may NOT exist in this dropdown. That is OK — select the closest available match instead of scrolling forever.
  )

Do NOT click any "Add" buttons. Do NOT touch any other sections. Do NOT interact with fields under any other "Education" heading.`;

    const entryPrompt = buildExperienceEntryPrompt(entryData);

    // d. Single LLM call — the LLM can scroll within the entry
    logger.debug('Education LLM call', { entry: i + 1, llmCall: llmCallCount + 1 });
    await adapter.act(entryPrompt);
    llmCallCount++;
    await adapter.page.waitForTimeout(1000);

    logger.info('Education entry done', { entry: i + 1, school: edu.school });
  }

  // ==================== SKILLS ====================
  const skillsToAdd = (userProfile.skills || []).slice(0, maxSkills);
  const hasSkills = skillsToAdd.length > 0;
  const hasLinkedin = !!userProfile.linkedin_url;

  if (hasSkills) {
    const skillsBlock = `CRITICAL — DO NOT TOUCH THESE SECTIONS:
- "Websites" section: Do NOT click its "Add" button. Leave it empty.
- "Certifications" section: Do NOT click its "Add" button. Leave it empty.
- "Social Network URLs" / "LinkedIn" section: Do NOT fill this. Leave it empty.
- Do NOT click "Add" under Work Experience or Education — those are already filled.

Fill ONLY the Skills field. Skip any fields that already have values.

SKILLS — OVERRIDE: The "one dropdown per turn" rule does NOT apply to skills. Add ALL skills in this turn without stopping.
  To open the skills input, look for the small icon with three horizontal lines (≡ list icon) near the skills field. ALWAYS click this icon to open the dropdown — do NOT click on any grey skill tags/chips that may already be in the field, as that will NOT open the dropdown.
  For EACH skill below, repeat this process: click the three-lines icon (≡), type the skill name, press ENTER to trigger the dropdown, WAIT 3 seconds for suggestions to load, then CLICK the matching option from the dropdown. After selecting, click on empty whitespace to dismiss the dropdown, then immediately proceed to the NEXT skill by clicking the three-lines icon again. Keep going until ALL skills are added. Do NOT stop after just one skill.
  Skills to add: ${skillsToAdd.map(s => `"${s}"`).join(', ')}
`;

    const skillsPrompt = buildExperienceEntryPrompt(skillsBlock);

    // Scroll to the Skills section — try to find the actual input field first,
    // fall back to the heading with block:'start' so content below is visible.
    await adapter.page.evaluate(`
      (() => {
        var headings = document.querySelectorAll('h2, h3, h4, h5, legend, [data-automation-id]');
        var skillsHeading = null;
        for (var i = 0; i < headings.length; i++) {
          var text = (headings[i].textContent || '').toLowerCase();
          if (text.includes('skill')) {
            skillsHeading = headings[i];
          }
        }
        if (!skillsHeading) return;

        var container = skillsHeading.parentElement;
        for (var u = 0; u < 5 && container; u++) {
          var inputs = container.querySelectorAll('input[type="text"], input:not([type])');
          if (inputs.length >= 1) break;
          container = container.parentElement;
        }

        if (container) {
          var inputs = container.querySelectorAll('input[type="text"], input:not([type])');
          for (var j = 0; j < inputs.length; j++) {
            var inp = inputs[j];
            var rect = inp.getBoundingClientRect();
            if (rect.width > 20 && rect.height > 10) {
              inp.scrollIntoView({ block: 'center', behavior: 'instant' });
              return;
            }
          }
        }

        skillsHeading.scrollIntoView({ block: 'start', behavior: 'instant' });
      })()
    `);
    await adapter.page.waitForTimeout(500);

    logger.debug('Skills LLM call', { llmCall: llmCallCount + 1, skills: skillsToAdd.length });
    await adapter.act(skillsPrompt);
    llmCallCount++;
    await adapter.page.waitForTimeout(1000);
  }

  // ==================== LINKEDIN ====================
  if (hasLinkedin) {
    const linkedinBlock = `CRITICAL — DO NOT TOUCH THESE SECTIONS:
- "Websites" section: Do NOT click its "Add" button. Leave it empty.
- "Certifications" section: Do NOT click its "Add" button. Leave it empty.
- "Skills" section: Already filled. Do NOT modify it.
- Do NOT click "Add" under Work Experience or Education — those are already filled.

Fill ONLY the LinkedIn field. Skip any fields that already have values.

LINKEDIN (under "Social Network URLs" section — NOT under "Websites"):
  LinkedIn: ${userProfile.linkedin_url}
  NOTE: The LinkedIn field is in the "Social Network URLs" section, which is DIFFERENT from the "Websites" section. Only fill the LinkedIn field.
`;

    const linkedinPrompt = buildExperienceEntryPrompt(linkedinBlock);

    // Scroll to the Social Network URLs section
    await adapter.page.evaluate(`
      (() => {
        var headings = document.querySelectorAll('h2, h3, h4, h5, legend, [data-automation-id]');
        var target = null;
        for (var i = 0; i < headings.length; i++) {
          var text = (headings[i].textContent || '').toLowerCase();
          if (text.includes('social') || text.includes('linkedin')) {
            target = headings[i];
          }
        }
        if (target) {
          target.scrollIntoView({ block: 'start', behavior: 'instant' });
        }
      })()
    `);
    await adapter.page.waitForTimeout(500);

    logger.debug('LinkedIn LLM call', { llmCall: llmCallCount + 1 });
    await adapter.act(linkedinPrompt);
    llmCallCount++;
    await adapter.page.waitForTimeout(1000);
  }

  logger.info('MyExperience page complete', { totalLlmCalls: llmCallCount, experiences: experiences.length, educations: educations.length });

  // Build a generic fallback prompt for error recovery during navigation
  const fallbackPrompt = buildExperiencePrompt('All entries have been filled. If you see any empty required fields, fill them.');

  // Navigate: click Save and Continue with error recovery
  await clickNextWithErrorRecovery(adapter, fallbackPrompt, 'my experience', fullQAMap);
}

// --- Voluntary Disclosure ---

export async function handleVoluntaryDisclosure(
  adapter: BrowserAutomationAdapter,
  dataPrompt: string,
  fullQAMap: Record<string, string>,
  selfId: SelfIdFields,
): Promise<'done' | 'review_detected'> {
  getLogger().info('Filling voluntary self-identification page');

  const fillPrompt = buildVoluntaryDisclosurePrompt(selfId);

  return fillWithSmartScroll(adapter, fillPrompt, 'voluntary disclosure', fullQAMap);
}

// --- Self-Identify ---

export async function handleSelfIdentify(
  adapter: BrowserAutomationAdapter,
  dataPrompt: string,
  fullQAMap: Record<string, string>,
  selfId: SelfIdFields,
): Promise<'done' | 'review_detected'> {
  getLogger().info('Filling self-identification page');

  const fillPrompt = buildSelfIdentifyPrompt(selfId);

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
