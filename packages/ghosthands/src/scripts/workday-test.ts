#!/usr/bin/env bun
/**
 * GhostHands Workday Application Smoke Test
 *
 * Reconnaissance run — tests how far the agent gets on a real
 * Workday job application page with fake data.
 *
 * Goal: Identify which UI elements (text inputs, dropdowns, file uploads,
 * date pickers) the agent handles well and which break.
 *
 * IMPORTANT: This script does NOT submit any application.
 *
 * Usage:
 *   bun run workday:test                         # auto-select best available LLM
 *   bun run workday:test -- --model=qwen-72b     # force Qwen VL
 *   bun run workday:test -- --model=claude-haiku  # force Claude
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MagnitudeAdapter } from '../adapters/magnitude.js';
import { loadModelConfig, printModelInfo } from '../config/models.js';
import type { LLMConfig, TokenUsage } from '../adapters/types.js';

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

const PROFILES_DIR = resolve(__dirname, '../../../../applicant-profiles');

function loadProfile(profileName: string = 'joy-kim') {
  const profilePath = resolve(PROFILES_DIR, `${profileName}.json`);
  return JSON.parse(readFileSync(profilePath, 'utf-8'));
}

const profile = loadProfile();

const testData = {
  firstName: profile.personal.firstName,
  lastName: profile.personal.lastName,
  email: profile.personal.email,
  phone: profile.personal.phone,
  address: `${profile.personal.location.city}, ${profile.personal.location.state}`,
  city: profile.personal.location.city,
  state: profile.personal.location.state,
  zip: profile.personal.location.zipCode,
  country: profile.personal.location.country,
  linkedin: profile.links.linkedin,
  currentCompany: profile.experience[0].company,
  currentTitle: profile.experience[0].title,
  password: process.env.WORKDAY_PASSWORD || 'GhostHands2026!',
};

// ---------------------------------------------------------------------------
// Metrics tracking
// ---------------------------------------------------------------------------

interface StepResult {
  step: string;
  status: 'success' | 'error';
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error?: string;
  finalUrl?: string;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  const resolved = loadModelConfig();

  console.log(`\n${'='.repeat(60)}`);
  console.log('  GhostHands — Workday Application Smoke Test');
  console.log(`${'='.repeat(60)}`);
  printModelInfo(resolved);
  console.log(`  Profile: ${profile.meta.profile_name}`);
  console.log(`  Email: ${testData.email}`);
  console.log('  Mode: Reconnaissance (NO submission)');
  console.log(`${'='.repeat(60)}\n`);

  const llmConfig = resolved.llmClient as LLMConfig;
  const adapter = new MagnitudeAdapter();

  const globalStart = Date.now();
  let stepInputTokens = 0;
  let stepOutputTokens = 0;
  let stepCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  const results: StepResult[] = [];

  // Token tracking
  adapter.on('tokensUsed', (usage: TokenUsage) => {
    stepInputTokens += usage.inputTokens;
    stepOutputTokens += usage.outputTokens;
    const cost = usage.inputCost + usage.outputCost;
    stepCost += cost;
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCost += cost;
    console.log(
      `  [tokens] +${usage.inputTokens} in / +${usage.outputTokens} out` +
        (cost > 0 ? ` ($${cost.toFixed(6)})` : ''),
    );
  });

  function resetStepMetrics() {
    stepInputTokens = 0;
    stepOutputTokens = 0;
    stepCost = 0;
  }

  try {
    console.log('[1/5] Starting adapter on job detail page...');
    await adapter.start({
      url: 'https://workday.wd5.myworkdayjobs.com/en-US/Workday/details/Software-Development-Engineer---ML-Ops_JR-0103873',
      llm: llmConfig,
    });

    // ---------------------------------------------------------------
    // Step 1: Click "Apply" on the job detail page
    // ---------------------------------------------------------------
    console.log('\n[2/5] Step 1: Click Apply on the job posting...\n');
    resetStepMetrics();
    const step1Start = Date.now();

    try {
      await adapter.act('Click the "Apply" button to start the job application.');
      results.push({
        step: 'Navigate to application form',
        status: 'success',
        durationMs: Date.now() - step1Start,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cost: stepCost,
        finalUrl: await adapter.getCurrentUrl(),
      });
      console.log(`\n  Step 1 complete. URL: ${await adapter.getCurrentUrl()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        step: 'Navigate to application form',
        status: 'error',
        durationMs: Date.now() - step1Start,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cost: stepCost,
        error: msg,
        finalUrl: await adapter.getCurrentUrl(),
      });
      console.error(`\n  Step 1 FAILED: ${msg}`);
      console.log('  Continuing to see how far we got...\n');
    }

    // ---------------------------------------------------------------
    // Step 2: Handle Create Account / Sign In
    // ---------------------------------------------------------------
    console.log('\n[3/5] Step 2: Handle account creation / sign-in...\n');
    resetStepMetrics();
    const step2Start = Date.now();

    const currentUrl = await adapter.getCurrentUrl();
    const pageTitle = await adapter.page.title();
    console.log(`  Current URL: ${currentUrl}`);
    console.log(`  Page title: ${pageTitle}`);

    try {
      await adapter.act(
        `Look at this page. This is a Workday job application.
If you see a "Create Account" link or tab, click it to create a new account.
If you see a "Sign In" form and the account already exists, sign in instead.

For creating an account, use:
- Email: ${testData.email}
- Password: ${testData.password}
- Verify Password: ${testData.password}

For signing in, use:
- Email: ${testData.email}
- Password: ${testData.password}

After filling in the fields, click the "Create Account" or "Sign In" button.
Do NOT use "Sign in with Google" or any social login.`,
      );

      await adapter.act(
        `Look at the current page.
If you see an error about "verify your account" or "email verification required", click "Resend Account Verification" if available.
If you see the application form (fields like Name, Phone, Address), that means sign-in was successful.
If you're on the application form, describe what fields you see.
If there's an error, describe what the error says.`,
      );

      results.push({
        step: 'Account creation / sign-in',
        status: 'success',
        durationMs: Date.now() - step2Start,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cost: stepCost,
        finalUrl: await adapter.getCurrentUrl(),
      });
      console.log(`\n  Step 2 complete. URL: ${await adapter.getCurrentUrl()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        step: 'Account creation / sign-in',
        status: 'error',
        durationMs: Date.now() - step2Start,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cost: stepCost,
        error: msg,
        finalUrl: await adapter.getCurrentUrl(),
      });
      console.error(`\n  Step 2 FAILED: ${msg}`);
      console.log('  Continuing to see how far we got...\n');
    }

    // ---------------------------------------------------------------
    // Step 3: Fill application form pages (loop)
    // ---------------------------------------------------------------
    const applicantData = [
      'Applicant information to use when filling forms:',
      `- First Name: ${testData.firstName}`,
      `- Last Name: ${testData.lastName}`,
      `- Email: ${testData.email}`,
      `- Phone: ${testData.phone}`,
      `- City: ${testData.city}`,
      `- State: ${testData.state}`,
      `- Zip/Postal Code: ${testData.zip}`,
      `- Country: ${testData.country}`,
      `- LinkedIn: ${testData.linkedin}`,
      `- Current Company: ${testData.currentCompany}`,
      `- Current Title: ${testData.currentTitle}`,
      `- Degree: ${profile.education.degree} in ${profile.education.major}`,
      `- School: ${profile.education.school}`,
      `- GPA: ${profile.education.gpa}`,
      `- Graduation: ${profile.education.graduationDate}`,
      `- Work Authorization: ${profile.workPreferences.workAuthorization}`,
      `- Requires Sponsorship: ${profile.workPreferences.requiresSponsorship ? 'Yes' : 'No'}`,
      `- Years of Experience: ${profile.additional.yearsOfExperience}`,
      `- Gender: ${profile.additional.gender}`,
      `- Ethnicity: ${profile.additional.race}`,
      `- Veteran Status: ${profile.additional.veteranStatus}`,
      `- Disability Status: ${profile.additional.disabilityStatus}`,
    ].join('\n');

    const MAX_PAGES = 8;
    let pageNum = 0;

    for (pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      console.log(`\n[Step 3.${pageNum}] Filling page ${pageNum} of application...\n`);
      resetStepMetrics();
      const pageStart = Date.now();

      try {
        await adapter.act(
          `${applicantData}

Look at the current page of this Workday job application.
Fill in ALL visible fields using the applicant information above.
- If a field is a dropdown, select the closest matching option.
- If a field asks a yes/no question, answer appropriately based on the data.
- Skip file upload fields (like resume upload).
- For questions not covered by the data above, use reasonable defaults or select "Prefer not to answer" / "Decline to self-identify" if available.
- Do NOT click "Save and Continue" or "Submit" yet — just fill in the fields.`,
        );

        await adapter.act(
          `Look at the current page after filling in the fields.
If you see a "Save and Continue" button, click it to proceed to the next page.
If you see a "Review" or "Submit Application" page (the final step), do NOT click Submit. Just mark the task as done.
If you see a "Next" or "Continue" button instead, click that.`,
        );

        results.push({
          step: `Fill page ${pageNum}`,
          status: 'success',
          durationMs: Date.now() - pageStart,
          inputTokens: stepInputTokens,
          outputTokens: stepOutputTokens,
          cost: stepCost,
          finalUrl: await adapter.getCurrentUrl(),
        });
        console.log(`\n  Page ${pageNum} complete. URL: ${await adapter.getCurrentUrl()}`);

        const pageUrl = await adapter.getCurrentUrl();
        if (pageUrl.includes('review') || pageUrl.includes('submit')) {
          console.log('  Reached Review/Submit page — stopping form fill loop.');
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          step: `Fill page ${pageNum}`,
          status: 'error',
          durationMs: Date.now() - pageStart,
          inputTokens: stepInputTokens,
          outputTokens: stepOutputTokens,
          cost: stepCost,
          error: msg,
          finalUrl: await adapter.getCurrentUrl(),
        });
        console.error(`\n  Page ${pageNum} FAILED: ${msg}`);
      }
    }

    if (pageNum > MAX_PAGES) {
      console.log(`\n  Reached max page limit (${MAX_PAGES}). Stopping.`);
    }

    // Done
    console.log('\n[Final] Stopping adapter (NOT submitting)...');
    await adapter.stop();
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
  } finally {
    if (adapter.isActive()) {
      await adapter.stop();
    }
  }

  // -------------------------------------------------------------------
  // Print results summary
  // -------------------------------------------------------------------
  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  RESULTS SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Model: ${resolved.alias} (${resolved.model})`);
  console.log(`  Total Duration: ${totalElapsed}s`);
  console.log(`  Total Input Tokens: ${totalInputTokens}`);
  console.log(`  Total Output Tokens: ${totalOutputTokens}`);
  console.log(`  Total Cost: $${totalCost.toFixed(6)}`);
  console.log();

  for (const r of results) {
    const status = r.status === 'success' ? 'PASS' : 'FAIL';
    const dur = (r.durationMs / 1000).toFixed(1);
    console.log(`  [${status}] ${r.step}`);
    console.log(`         Duration: ${dur}s | Tokens: ${r.inputTokens} in / ${r.outputTokens} out | Cost: $${r.cost.toFixed(6)}`);
    if (r.finalUrl) console.log(`         URL: ${r.finalUrl}`);
    if (r.error) console.log(`         Error: ${r.error}`);
    console.log();
  }

  console.log(`${'='.repeat(60)}`);
  console.log('  Workday smoke test complete.');
  console.log(`${'='.repeat(60)}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
