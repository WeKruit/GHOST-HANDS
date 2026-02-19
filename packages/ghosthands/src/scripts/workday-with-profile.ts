#!/usr/bin/env bun
/**
 * Workday Application with Profile
 *
 * Uses the BrowserAutomationAdapter to fill Workday application forms
 * using a saved applicant profile (JSON).
 *
 * Usage:
 *   bun run workday:profile <job_url> [profile_name]
 *   bun run workday:profile https://company.wd5.myworkdayjobs.com/careers/job/123
 *   bun run workday:profile https://... joy-kim
 *
 * Environment:
 *   WORKDAY_JOB_URL       — default job URL (if not passed as arg)
 *   APPLICANT_PROFILE     — default profile name (default: joy-kim)
 *   GH_MODEL / MODEL      — LLM model override (e.g. "qwen-72b", "claude-haiku")
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { MagnitudeAdapter } from '../adapters/magnitude.js';
import { loadModelConfig, printModelInfo } from '../config/models.js';
import type { LLMConfig } from '../adapters/types.js';

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

const PROFILES_DIR = resolve(__dirname, '../../../../applicant-profiles');

function loadProfile(profileName: string) {
  const profilePath = resolve(PROFILES_DIR, `${profileName}.json`);
  return JSON.parse(readFileSync(profilePath, 'utf-8'));
}

function formatProfileForAgent(profile: any): string {
  return `
APPLICANT INFORMATION:
Personal:
- Full Name: ${profile.personal.firstName} ${profile.personal.lastName}
- Email: ${profile.personal.email}
- Phone: ${profile.personal.phone}
- Location: ${profile.personal.location.city}, ${profile.personal.location.state}
- LinkedIn: ${profile.links.linkedin}
- GitHub: ${profile.links.github}

Education:
- Degree: ${profile.education.degree} in ${profile.education.major}
- School: ${profile.education.school} (${profile.education.schoolShort})
- GPA: ${profile.education.gpa}/4.0
- Graduation: ${profile.education.graduationDate}

Current Experience:
- Title: ${profile.experience[0].title}
- Company: ${profile.experience[0].company}
- Duration: ${profile.experience[0].duration}

Work Preferences:
- Work Authorization: ${profile.workPreferences.workAuthorization}
- Requires Sponsorship: ${profile.workPreferences.requiresSponsorship ? 'Yes' : 'No'}
- Willing to Relocate: ${profile.workPreferences.willingToRelocate ? 'Yes' : 'No'}
- Start Date: ${profile.workPreferences.startDate}

Skills:
- Programming: ${profile.skills.programmingLanguages.join(', ')}
- Frameworks: ${profile.skills.frameworks.join(', ')}
- Tools: ${profile.skills.tools.join(', ')}
  `.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const jobUrl = process.argv[2] || process.env.WORKDAY_JOB_URL;
  const profileName = process.argv[3] || process.env.APPLICANT_PROFILE || 'joy-kim';

  if (!jobUrl) {
    console.error('Please provide a Workday job URL:');
    console.error('  bun run workday:profile <job_url> [profile_name]');
    console.error('  or set WORKDAY_JOB_URL in .env');
    process.exit(1);
  }

  console.log('\nGhostHands Workday Application with Profile');
  console.log('='.repeat(60));

  // Load profile
  console.log(`\nLoading applicant profile: ${profileName}`);
  const profile = loadProfile(profileName);
  console.log(`Loaded profile: ${profile.meta.profile_name}`);

  const profileInfo = formatProfileForAgent(profile);

  // Resolve LLM via config system
  const resolved = loadModelConfig();
  printModelInfo(resolved);
  const llmConfig = resolved.llmClient as LLMConfig;

  // Create adapter
  const adapter = new MagnitudeAdapter();

  console.log(`\nNavigating to: ${jobUrl}`);
  await adapter.start({ url: jobUrl, llm: llmConfig });

  // Track costs
  let totalCost = 0;
  adapter.on('tokensUsed', (usage) => {
    const cost = (usage.inputCost ?? 0) + (usage.outputCost ?? 0);
    totalCost += cost;
    console.log(
      `  [tokens] +${usage.inputTokens} in / +${usage.outputTokens} out` +
        (cost > 0 ? ` ($${cost.toFixed(6)})` : ''),
    );
  });

  console.log('\n' + '='.repeat(60));
  console.log('Starting application process...');
  console.log('='.repeat(60) + '\n');

  try {
    // Step 0: Handle login/signup if needed
    console.log('\n[0/5] Checking for login/signup requirement...\n');
    const currentUrl = await adapter.getCurrentUrl();

    if (currentUrl.includes('login') || currentUrl.includes('sign-in') || currentUrl.includes('auth')) {
      console.log('Login/signup page detected');

      await adapter.act(`
        Look at this page carefully.
        If you see a "Create Account", "Sign Up", or "Register" button/link, click it.
        If you see a "Continue with Email" or similar option, click that.
        DO NOT try to sign in with an existing account.
        We need to CREATE A NEW ACCOUNT.
      `);

      await adapter.page.waitForTimeout(2000);

      console.log('\nCreating new account with applicant information...\n');
      await adapter.act(`
        Fill in the account creation/registration form with:
        - Email: ${profile.personal.email}
        - First Name: ${profile.personal.firstName}
        - Last Name: ${profile.personal.lastName}
        - Phone: ${profile.personal.phone} (if asked)
        - Create a password: ApplicantPass2024! (if asked)

        After filling, click "Continue", "Next", or "Create Account" button.
        DO NOT click "Sign in with Google" or other social login options.
      `);

      await adapter.page.waitForTimeout(3000);
      console.log('Account creation attempted, proceeding to application...\n');
    } else {
      console.log('No login required, proceeding directly to application\n');
    }

    // Step 1: Navigate and identify form
    console.log('\n[1/5] Analyzing the application form...\n');
    await adapter.act(`
      Look at the current page.
      Identify what information is being asked for.
      If there's an "Apply" button, click it to start the application.
      If you're already on an application form, just observe what fields are visible.
      DO NOT fill anything yet, just explore what fields are available.
    `);

    // Step 2: Fill basic information
    console.log('\n[2/5] Filling personal information...\n');
    await adapter.act(`
      Fill in the application form with the following information:

      ${profileInfo}

      IMPORTANT:
      - Only fill fields that are currently visible on this page
      - If a field is a dropdown, select the option that best matches the information
      - Skip any file upload fields (we'll handle those separately)
      - If you see "Continue", "Next", or "Save & Continue", DO NOT click it yet
      - DO NOT click "Submit" or any final submission button
    `);

    // Step 3: Handle resume upload if present
    console.log('\n[3/5] Checking for resume upload...\n');

    if (profile.documents?.resume?.path) {
      await adapter.act(`
        Look for a "Resume" or "CV" upload button.
        If you find one, click it to open the file picker.
        Note: The actual file will be uploaded separately.
      `);

      // Handle file upload via escape-hatch to Playwright page
      console.log('Resume upload detected - handling file picker...');
      try {
        const fileChooserPromise = adapter.page.waitForEvent('filechooser', { timeout: 5000 });
        const fileChooser = await fileChooserPromise;
        const resumePath = resolve(PROFILES_DIR, '..', profile.documents.resume.path);
        await fileChooser.setFiles(resumePath);
        console.log('Resume uploaded');
      } catch {
        console.log('No resume upload found or already handled');
      }
    }

    // Step 4: Handle multi-page forms
    console.log('\n[4/5] Checking for additional pages...\n');
    await adapter.act(`
      Look at the current page.
      If you see a "Next", "Continue", or "Save & Continue" button, click it to go to the next page.
      If there are multiple pages/sections in this application, proceed to the next one.
      If this is the final page with a "Submit" button, DO NOT click it yet - just observe.
    `);

    await adapter.page.waitForTimeout(2000);
    const newUrl = await adapter.getCurrentUrl();
    if (newUrl !== currentUrl) {
      console.log('Moved to next page, filling additional information...\n');
      await adapter.act(`
        Fill any new fields on this page with information from the applicant profile:
        ${profileInfo}
        - Fill all visible required fields
        - Skip file uploads
        DO NOT click Submit yet.
      `);
    }

    // Step 5: Review before submission
    console.log('\n[5/5] Reviewing application...\n');
    await adapter.act(`
      Review the entire application form.
      Check if there are any required fields (marked with * or "Required") that are still empty.
      List what has been filled and what might be missing.
      If everything looks complete, note that the form is ready for submission.
      DO NOT click Submit yet - we'll do that manually after review.
    `);

    console.log('\n' + '='.repeat(60));
    console.log('Application form filled successfully!');
    console.log(`Total cost: $${totalCost.toFixed(6)}`);
    console.log('='.repeat(60));

    console.log('\nPausing for manual review...');
    console.log('\n   Review checklist:');
    console.log('   - All required fields filled?');
    console.log('   - Information is correct?');
    console.log('   - Resume uploaded (if required)?');
    console.log('   - Ready to submit?');
    console.log('\n   Press Enter to continue and submit, or Ctrl+C to cancel.\n');

    // Wait for user confirmation
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });

    console.log('\nSubmitting application...\n');
    await adapter.act(`
      Find and click the "Submit", "Submit Application", or "Apply" button to complete and submit the application.
      This is the final submission action.
    `);

    await adapter.page.waitForTimeout(3000);

    console.log('\n' + '='.repeat(60));
    console.log('Application submitted!');
    console.log('='.repeat(60));

    const finalUrl = await adapter.getCurrentUrl();
    console.log(`\nFinal URL: ${finalUrl}`);

    // Confirmation screenshot
    console.log('\nTaking confirmation screenshot...');
    const screenshot = await adapter.screenshot();
    const screenshotPath = `./confirmation-${Date.now()}.png`;
    writeFileSync(screenshotPath, screenshot);
    console.log(`Screenshot saved: ${screenshotPath}`);

    await adapter.stop();
    console.log('\nProcess complete!');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('\nError during application:', error);
    throw error;
  } finally {
    if (adapter.isActive()) {
      await adapter.stop();
    }
  }
}

main().catch(console.error);
