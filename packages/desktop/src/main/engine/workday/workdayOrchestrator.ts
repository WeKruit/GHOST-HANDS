/**
 * workdayOrchestrator — entry point for the desktop Workday pipeline.
 *
 * Bridges the desktop app's Magnitude agent + UserProfile to the staging
 * Workday handler's proven detect-and-act loop. This replaces the generic
 * fillWithSmartScroll for Workday URLs.
 */

import type { UserProfile, ProgressEvent } from '../../../shared/types.js';
import { DesktopAdapterShim } from './DesktopAdapterShim.js';
import { mapDesktopProfileToWorkday } from './profileMapper.js';
import type { WorkdayUserProfile } from './workdayTypes.js';
import type { SelfIdFields } from './workdayPrompts.js';
import { MAX_FORM_PAGES } from './constants.js';
import type { PageState } from './constants.js';
import { getLogger } from './desktopLogger.js';
import { detectPage } from './pageClassifier.js';
import { waitForPageLoad } from './navigation.js';
import {
  handleJobListing,
  handleLogin,
  handleVerificationCode,
  handlePhone2FA,
  handleAccountCreation,
  handlePersonalInfoPage,
  handleFormPage,
  handleExperiencePage,
  handleVoluntaryDisclosure,
  handleSelfIdentify,
  handleGenericPage,
} from './pageHandlers.js';

type EmitFn = (type: ProgressEvent['type'], message?: string, extra?: Partial<ProgressEvent>) => void;

/**
 * Run the full Workday multi-page pipeline.
 *
 * @param agent  - Magnitude BrowserAgent (already navigated to the Workday URL)
 * @param profile - Desktop UserProfile (camelCase)
 * @param emit   - Progress event emitter from engine.ts
 * @param resumePath - Optional path to resume file for upload
 */
export async function runWorkdayPipeline(
  agent: any,
  profile: UserProfile,
  emit: EmitFn,
  resumePath?: string,
): Promise<void> {
  const logger = getLogger();
  const adapter = new DesktopAdapterShim(agent);
  const workdayProfile = mapDesktopProfileToWorkday(profile, resumePath);

  // Build data prompt and Q&A map (ported from handler.ts)
  const qaOverrides = profile.qaAnswers || {};
  const dataPrompt = buildDataPrompt(workdayProfile, qaOverrides);
  const fullQAMap = buildFullQAMap(workdayProfile, qaOverrides);

  const selfId: SelfIdFields = {
    gender: workdayProfile.gender || 'Male',
    race_ethnicity: workdayProfile.race_ethnicity || 'Asian (Not Hispanic or Latino)',
    veteran_status: workdayProfile.veteran_status || 'I am not a protected veteran',
    disability_status: workdayProfile.disability_status || "No, I Don't Have A Disability",
  };

  let pagesProcessed = 0;

  emit('status', 'Workday pipeline started — detecting page type...');

  try {
    while (pagesProcessed < MAX_FORM_PAGES) {
      pagesProcessed++;

      await waitForPageLoad(adapter);

      let pageState = await detectPage(adapter);
      logger.info('Processing page', { page: pagesProcessed, pageType: pageState.page_type, title: pageState.page_title || 'N/A' });
      emit('status', `Page ${pagesProcessed}: ${pageState.page_type}`);

      switch (pageState.page_type) {
        case 'job_listing':
          await handleJobListing(adapter, pageState);
          break;

        case 'login':
        case 'google_signin':
          emit('status', 'Handling login...');
          await handleLogin(adapter, pageState, workdayProfile);
          break;

        case 'verification_code':
          emit('status', 'Retrieving verification code...');
          await handleVerificationCode(adapter);
          break;

        case 'phone_2fa':
          emit('status', 'Waiting for manual 2FA (up to 3 min)...');
          await handlePhone2FA(adapter);
          break;

        case 'account_creation':
          emit('status', 'Creating account...');
          await handleAccountCreation(adapter, workdayProfile, dataPrompt);
          break;

        case 'personal_info':
          emit('status', 'Filling personal information...');
          await handlePersonalInfoPage(adapter, workdayProfile, qaOverrides, fullQAMap);
          break;

        case 'experience':
        case 'resume_upload':
          emit('status', 'Filling experience & uploading resume...');
          await handleExperiencePage(adapter, workdayProfile, fullQAMap);
          break;

        case 'questions': {
          emit('status', 'Answering application questions...');
          const qResult = await handleFormPage(adapter, 'application questions', dataPrompt, fullQAMap);
          if (qResult === 'review_detected') {
            pageState = { page_type: 'review', page_title: 'Review' };
            continue;
          }
          break;
        }

        case 'voluntary_disclosure': {
          emit('status', 'Filling voluntary disclosures...');
          const vResult = await handleVoluntaryDisclosure(adapter, dataPrompt, fullQAMap, selfId);
          if (vResult === 'review_detected') {
            pageState = { page_type: 'review', page_title: 'Review' };
            continue;
          }
          break;
        }

        case 'self_identify': {
          emit('status', 'Filling self-identification...');
          const sResult = await handleSelfIdentify(adapter, dataPrompt, fullQAMap, selfId);
          if (sResult === 'review_detected') {
            pageState = { page_type: 'review', page_title: 'Review' };
            continue;
          }
          break;
        }

        case 'review':
          emit('status', 'Reached review page — stopping before submission');
          logger.info('Application filled, stopped at review page', { pagesProcessed });
          return;

        case 'confirmation':
          logger.warn('Unexpected: landed on confirmation page');
          emit('status', 'Application appears to have been submitted (unexpected)');
          return;

        case 'error':
          throw new Error(`Workday error page: ${pageState.error_message || 'Unknown error'}`);

        case 'unknown':
        default:
          emit('status', 'Unknown page — attempting generic fill...');
          await handleGenericPage(adapter, dataPrompt, fullQAMap);
          break;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (pagesProcessed > 2) {
      emit('status', `Error after ${pagesProcessed} pages — browser open for manual review`);
      return; // Don't re-throw — match staging's keepBrowserOpen behavior
    }
    throw error;
  }

  logger.warn('Reached max page limit without finding review page', { maxPages: MAX_FORM_PAGES, pagesProcessed });
  emit('status', `Processed ${pagesProcessed} pages — browser open for manual review`);
}

// ---------------------------------------------------------------------------
// Data prompt builders (ported from handler.ts)
// ---------------------------------------------------------------------------

function buildFullQAMap(
  profile: WorkdayUserProfile,
  qaOverrides: Record<string, string>,
): Record<string, string> {
  return {
    'Gender': profile.gender || 'I do not wish to answer',
    'Race/Ethnicity': profile.race_ethnicity || 'I do not wish to answer',
    'Race': profile.race_ethnicity || 'I do not wish to answer',
    'Ethnicity': profile.race_ethnicity || 'I do not wish to answer',
    'Veteran Status': profile.veteran_status || 'I am not a protected veteran',
    'Are you a protected veteran': profile.veteran_status || 'I am not a protected veteran',
    'Disability': profile.disability_status || 'I do not wish to answer',
    'Disability Status': profile.disability_status || 'I do not wish to answer',
    'Please indicate if you have a disability': profile.disability_status || 'I do not wish to answer',
    'Country': profile.address.country,
    'Country/Territory': profile.address.country,
    'State': profile.address.state,
    'State/Province': profile.address.state,
    'Phone Device Type': profile.phone_device_type || 'Mobile',
    'Phone Type': profile.phone_device_type || 'Mobile',
    'Please enter your name': `${profile.first_name} ${profile.last_name}`,
    'Please enter your name:': `${profile.first_name} ${profile.last_name}`,
    'Enter your name': `${profile.first_name} ${profile.last_name}`,
    'Your name': `${profile.first_name} ${profile.last_name}`,
    'Full name': `${profile.first_name} ${profile.last_name}`,
    'Signature': `${profile.first_name} ${profile.last_name}`,
    'Name': `${profile.first_name} ${profile.last_name}`,
    'Are you legally authorized to work': profile.work_authorization || 'Yes',
    'Are you legally authorized to work in the United States': profile.work_authorization || 'Yes',
    'Will you now or in the future require sponsorship': profile.visa_sponsorship || 'No',
    'Will you now, or in the future, require sponsorship': profile.visa_sponsorship || 'No',
    'What is your desired salary?': 'Open to discussion',
    'Desired salary': 'Open to discussion',
    ...qaOverrides,
  };
}

function buildDataPrompt(
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
    `If the label says "Phone Device Type" → select: ${profile.phone_device_type || 'Mobile'}`,
    `If the label says "Country Phone Code" or "Phone Country Code" → select: ${profile.phone_country_code || '+1'} (United States)`,
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
  parts.push(`For self-identification: Gender → select "${profile.gender || 'Male'}". Race/Ethnicity → select "${profile.race_ethnicity || 'Asian (Not Hispanic or Latino)'}". Veteran Status → select "${profile.veteran_status || 'I am not a protected veteran'}". Disability → select "${profile.disability_status || "No, I Don't Have A Disability"}".`);
  parts.push('For any question not listed above, select the most reasonable/common answer.');
  parts.push('DROPDOWN TECHNIQUE: After clicking a dropdown, ALWAYS TYPE your desired answer first (e.g. "No", "Yes", "Male", "Website") to filter the list. If a matching option appears, click it. If typing does not produce a match, click whitespace to close the dropdown, then re-click it and try typing a shorter keyword. The popup menu that appears after clicking a dropdown ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions. NEVER use arrow keys inside dropdowns. NEVER use mouse scroll inside dropdowns.');
  parts.push('NESTED DROPDOWNS: Some dropdowns have sub-menus. After selecting a category (e.g. "Website"), a second list appears with specific options (e.g. "workday.com"). Select the sub-option. Do NOT click any back arrow or "\u2190 Category" button — that navigates backwards.');
  parts.push('DATE FIELDS: Workday date fields have separate MM/DD/YYYY parts. ALWAYS click on the MM (month) part FIRST, then type the full date as continuous digits WITHOUT slashes or dashes (e.g. for 02/18/2026, click on MM and type "02182026"). Workday auto-advances from month to day to year. For "today\'s date" or "signature date", type "02182026" (which is 02/18/2026). For "expected graduation date", use 05012027.');
  parts.push('NEVER click "Submit Application" or "Submit".');

  return parts.join('\n');
}
