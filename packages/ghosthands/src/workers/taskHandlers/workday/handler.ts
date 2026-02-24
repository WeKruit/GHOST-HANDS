/**
 * WorkdayApplyHandler — main orchestrator for Workday job applications.
 *
 * This is a thin orchestrator that delegates to specialized modules for
 * page detection, form filling, navigation, and authentication. It implements
 * the detect-and-act loop that drives the multi-page application flow.
 */

import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from '../types.js';
import { ProgressStep } from '../../progressTracker.js';
import type { WorkdayUserProfile } from './workdayTypes.js';
import { MAX_FORM_PAGES } from './constants.js';
import { getLogger } from '../../../monitoring/logger.js';
import type { PageState } from './constants.js';
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

export class WorkdayApplyHandler implements TaskHandler {
  readonly type = 'workday_apply';
  readonly description = 'Fill out a Workday job application (multi-step), stopping before submission';

  /** Built during execute() for programmatic dropdown filling */
  private fullQAMap: Record<string, string> = {};

  /**
   * Zod schema for WorkdayApplyHandler input validation.
   * user_data is required and must contain first_name, last_name, and email.
   */
  private static readonly InputSchema = z.object({
    user_data: z.object({
      first_name: z.string({ required_error: 'is required' }).min(1, 'is required'),
      last_name: z.string({ required_error: 'is required' }).min(1, 'is required'),
      email: z.string({ required_error: 'is required' }).email('must be a valid email'),
    }).passthrough(),
  }).passthrough();

  validate(inputData: Record<string, any>): ValidationResult {
    const result = WorkdayApplyHandler.InputSchema.safeParse(inputData);
    if (result.success) {
      return { valid: true };
    }
    const errors = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')} ${issue.message}` : issue.message
    );
    return { valid: false, errors };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress } = ctx;
    const userProfile = job.input_data.user_data as WorkdayUserProfile;
    const qaOverrides = job.input_data.qa_overrides || {};

    // Wire the downloaded resume file path into the profile so handleExperiencePage can upload it
    if (ctx.resumeFilePath) {
      userProfile.resume_path = ctx.resumeFilePath;
    }

    const logger = getLogger();
    logger.info('Starting application', { targetUrl: job.target_url, applicant: `${userProfile.first_name} ${userProfile.last_name}` });

    // Build the data prompt with all user information
    const dataPrompt = this.buildDataPrompt(userProfile, qaOverrides);
    this.fullQAMap = this.buildFullQAMap(userProfile, qaOverrides);

    // Self-identification fields for voluntary disclosure / self-identify prompts
    const selfId = {
      gender: userProfile.gender || 'Male',
      race_ethnicity: userProfile.race_ethnicity || 'Asian (Not Hispanic or Latino)',
      veteran_status: userProfile.veteran_status || 'I am not a protected veteran',
      disability_status: userProfile.disability_status || 'No, I Don\'t Have A Disability',
    };

    let pagesProcessed = 0;

    try {
      // Main detect-and-act loop
      while (pagesProcessed < MAX_FORM_PAGES) {
        pagesProcessed++;

        // Wait for page to settle after any navigation
        await waitForPageLoad(adapter);

        // Detect current page type
        let pageState = await detectPage(adapter);
        logger.info('Processing page', { page: pagesProcessed, pageType: pageState.page_type, title: pageState.page_title || 'N/A' });

        // Handle based on page type
        switch (pageState.page_type) {
          case 'job_listing':
            await handleJobListing(adapter, pageState);
            break;

          case 'login':
          case 'google_signin':
            await handleLogin(adapter, pageState, userProfile);
            break;

          case 'verification_code':
            await handleVerificationCode(adapter);
            break;

          case 'phone_2fa':
            await handlePhone2FA(adapter);
            break;

          case 'account_creation':
            await handleAccountCreation(adapter, userProfile, dataPrompt);
            break;

          case 'personal_info':
            await progress.setStep(ProgressStep.FILLING_FORM);
            await handlePersonalInfoPage(adapter, userProfile, qaOverrides, this.fullQAMap);
            break;

          case 'experience':
          case 'resume_upload':
            await progress.setStep(ProgressStep.UPLOADING_RESUME);
            await handleExperiencePage(adapter, userProfile, this.fullQAMap);
            break;

          case 'questions': {
            await progress.setStep(ProgressStep.ANSWERING_QUESTIONS);
            const qResult = await handleFormPage(adapter, 'application questions', dataPrompt, this.fullQAMap);
            if (qResult === 'review_detected') {
              pageState = { page_type: 'review', page_title: 'Review' };
              continue; // re-enter loop — will hit the 'review' case
            }
            break;
          }

          case 'voluntary_disclosure': {
            await progress.setStep(ProgressStep.ANSWERING_QUESTIONS);
            const vResult = await handleVoluntaryDisclosure(adapter, dataPrompt, this.fullQAMap, selfId);
            if (vResult === 'review_detected') {
              pageState = { page_type: 'review', page_title: 'Review' };
              continue;
            }
            break;
          }

          case 'self_identify': {
            await progress.setStep(ProgressStep.ANSWERING_QUESTIONS);
            const sResult = await handleSelfIdentify(adapter, dataPrompt, this.fullQAMap, selfId);
            if (sResult === 'review_detected') {
              pageState = { page_type: 'review', page_title: 'Review' };
              continue;
            }
            break;
          }

          case 'review':
            // We've reached the review page — STOP HERE
            await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            logger.info('Application filled successfully, stopped at review page', { pagesProcessed, finalPage: 'review' });

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
            logger.warn('Unexpected: landed on confirmation page');
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
            logger.info('Unknown page type, attempting generic form fill');
            await handleGenericPage(adapter, dataPrompt, this.fullQAMap);
            break;
        }
      }

      // Safety: hit max pages without reaching review
      logger.warn('Reached max page limit without finding review page', { maxPages: MAX_FORM_PAGES, pagesProcessed });
      await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);

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
      logger.error('Error during application', { page: pagesProcessed, error: msg });

      // If we fail mid-application, keep browser open so user can recover
      if (pagesProcessed > 2) {
        logger.info('Keeping browser open for manual recovery', { pagesProcessed });
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

  // --- Data Prompt Builders ---

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
      // NOTE: State is intentionally NOT in the QA map. The profile stores abbreviations
      // (e.g. "CA") but Workday dropdowns use full names ("California"). The LLM handles
      // this mapping automatically via the data prompt.
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
      parts.push('');
      parts.push('--- EDUCATION ---');
      for (const edu of profile.education) {
        parts.push(`School/University → ${edu.school}`);
        parts.push(`Degree → ${edu.degree}`);
        parts.push(`Field of Study → ${edu.field_of_study}`);
        if (edu.gpa) parts.push(`GPA → ${edu.gpa}`);
        parts.push(`Start Date → ${edu.start_date}`);
        parts.push(`End Date → ${edu.end_date}`);
      }
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
    parts.push(`For self-identification: Gender → select "${profile.gender}". Race/Ethnicity → select "${profile.race_ethnicity}". Veteran Status → select "${profile.veteran_status}". Disability → select "${profile.disability_status}".`);
    parts.push('For any question not listed above, select the most reasonable/common answer.');
    parts.push('DROPDOWN TECHNIQUE: After clicking a dropdown, ALWAYS TYPE your desired answer first (e.g. "No", "Yes", "Male", "Website") to filter the list. If a matching option appears, click it. If typing does not produce a match, click whitespace to close the dropdown, then re-click it and try typing a shorter keyword. The popup menu that appears after clicking a dropdown ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions. NEVER use arrow keys inside dropdowns. NEVER use mouse scroll inside dropdowns.');
    parts.push('NESTED DROPDOWNS: Some dropdowns have sub-menus. After selecting a category (e.g. "Website"), a second list appears with specific options (e.g. "workday.com"). Select the sub-option. Do NOT click any back arrow or "\u2190 Category" button — that navigates backwards.');
    parts.push('DATE FIELDS: Workday date fields have separate MM/DD/YYYY parts. ALWAYS click on the MM (month) part FIRST, then type the full date as continuous digits WITHOUT slashes or dashes (e.g. for 02/18/2026, click on MM and type "02182026"). Workday auto-advances from month to day to year. For "today\'s date" or "signature date", type "02182026" (which is 02/18/2026). For "expected graduation date", use 05012027.');
    parts.push('NEVER click "Submit Application" or "Submit".');

    return parts.join('\n');
  }
}
