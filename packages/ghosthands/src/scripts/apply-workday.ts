#!/usr/bin/env bun
/**
 * Submit Workday Application Job
 *
 * Creates a workday_apply job using real user profile data from VALET's
 * parsed resumes table. The worker will navigate to the Workday listing,
 * sign in with Google, fill out the entire application, and stop at the
 * review page.
 *
 * Prerequisites:
 *   1. A resume uploaded and parsed in VALET (status = 'parsed')
 *   2. Migration 008_gh_browser_sessions.sql applied
 *   3. Google session stored (optional — avoids fresh sign-in 2FA)
 *   4. Worker running: bun run worker -- --worker-id=<name>
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/apply-workday.ts -- --user-id=<uuid> --worker-id=workday-test
 *   npx tsx --env-file=.env src/scripts/apply-workday.ts -- --user-id=<uuid> --worker-id=workday-test --url=<workday-url>
 */

import { Client as PgClient } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { ResumeProfileLoader } from '../db/resumeProfileLoader.js';
import { TEST_QA_OVERRIDES } from '../../__tests__/fixtures/workdayTestData.js';

// --- Config ---

const DEFAULT_WORKDAY_URL =
  'https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/Canada%2C-BC%2C-Vancouver/Software-Engineer-III-Senior-Software-Engineer--Full-Stack-_JR-0103512/apply/applyManually?q=software+engineer';

// --- Parse args ---

function parseArg(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) return null;
  const value = arg.split('=').slice(1).join('=');
  return value || null;
}

// --- Session check ---

async function checkGoogleSession(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('gh_browser_sessions')
    .select('id, last_used_at')
    .eq('user_id', userId)
    .in('domain', ['accounts.google.com', 'mail.google.com', 'google.com'])
    .limit(1);

  return !!(data && data.length > 0);
}

// --- Main ---

async function main() {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DIRECT_URL ||
    process.env.DATABASE_DIRECT_URL;
  if (!dbUrl) {
    console.error('Error: DATABASE_URL must be set');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Load user profile from VALET's parsed resumes
  const requestedUserId = parseArg('user-id');
  if (!requestedUserId) {
    console.error('Error: --user-id=<uuid> is required.');
    console.error('Pass the VALET user ID whose parsed resume should be used.');
    console.error('Example: npx tsx --env-file=.env src/scripts/apply-workday.ts -- --user-id=a453804e-... --worker-id=workday-test');
    process.exit(1);
  }

  const loader = new ResumeProfileLoader(supabase);
  console.log(`\nLoading resume profile for user ${requestedUserId}...`);

  let result;
  try {
    result = await loader.loadForUser(requestedUserId!); // non-null asserted — checked above
  } catch (err) {
    console.error(`\nFailed to load resume profile: ${err instanceof Error ? err.message : err}`);
    console.error('Ensure a resume has been uploaded and parsed in VALET.');
    process.exit(1);
  }

  const { profile, fileKey, userId, resumeId, parsingConfidence } = result;

  // Allow TEST_GMAIL_EMAIL to override the email for Google sign-in
  const emailOverride = process.env.TEST_GMAIL_EMAIL;
  if (emailOverride) {
    profile.email = emailOverride;
    console.log(`Using TEST_GMAIL_EMAIL override: ${emailOverride}`);
  }

  console.log(`\nResume loaded successfully:`);
  console.log(`   Resume ID:    ${resumeId}`);
  console.log(`   User ID:      ${userId}`);
  console.log(`   Name:         ${profile.first_name} ${profile.last_name}`);
  console.log(`   Email:        ${profile.email}`);
  console.log(`   Phone:        ${profile.phone || '(not provided)'}`);
  console.log(`   Education:    ${profile.education.length} entries`);
  console.log(`   Experience:   ${profile.experience.length} entries`);
  console.log(`   Skills:       ${profile.skills.length} skills`);
  console.log(`   Resume file:  ${fileKey || '(none)'}`);
  console.log(`   Confidence:   ${parsingConfidence != null ? `${(parsingConfidence * 100).toFixed(0)}%` : 'N/A'}`);

  // 2. Check for Google session
  const hasSession = await checkGoogleSession(supabase, userId);
  if (!hasSession) {
    console.warn('\nWARNING: No Google session found in gh_browser_sessions.');
    console.warn('   The worker will need to sign in fresh, which may trigger 2FA.');
    console.warn('   To store a session first, run:');
    console.warn('     bun test __tests__/integration/sessions/sessionPersistence.test.ts\n');
  } else {
    console.log('\nGoogle session found in database');
  }

  // 3. Build job input data
  const targetWorkerId = parseArg('worker-id') || null;
  const targetUrl = parseArg('url') || DEFAULT_WORKDAY_URL;

  const inputData = {
    user_data: profile,
    qa_overrides: TEST_QA_OVERRIDES,
    tier: 'starter',
    platform: 'workday',
  };

  // Build resume_ref from VALET's file_key (compatible with ResumeDownloader)
  const resumeRef = fileKey ? { storage_path: fileKey } : null;

  const taskDescription = [
    'Fill out the entire Workday job application.',
    'Sign in using "Sign in with Google" if prompted.',
    'Fill all required fields using the provided user data.',
    'For any optional self-identification questions, select "I do not wish to answer".',
    'IMPORTANT: Do NOT click "Submit Application" — stop at the review/summary page.',
  ].join(' ');

  // 4. Insert job into database
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  console.log('\nCreating Workday application job...\n');

  try {
    const queryResult = await client.query(
      `
      INSERT INTO gh_automation_jobs (
        job_type, target_url, task_description,
        input_data, user_id, status,
        timeout_seconds, max_retries, priority,
        target_worker_id, tags, resume_ref
      ) VALUES (
        'workday_apply',
        $1,
        $2,
        $3::jsonb,
        $4,
        'pending',
        600, 1, 1,
        $5,
        $6::jsonb,
        $7::jsonb
      )
      RETURNING id, status, target_url, target_worker_id
    `,
      [
        targetUrl,
        taskDescription,
        JSON.stringify(inputData),
        userId,
        targetWorkerId,
        JSON.stringify(['workday', 'test']),
        resumeRef ? JSON.stringify(resumeRef) : null,
      ],
    );

    const job = queryResult.rows[0];
    console.log('Workday application job created!\n');
    console.log(`   Job ID:     ${job.id}`);
    console.log(`   Status:     ${job.status}`);
    console.log(`   URL:        ${job.target_url}`);
    console.log(`   Applicant:  ${profile.first_name} ${profile.last_name}`);
    console.log(`   Email:      ${profile.email}`);
    if (job.target_worker_id) {
      console.log(`   Target:     ${job.target_worker_id} (only this worker will pick it up)`);
    } else {
      console.log(`   Target:     any worker`);
    }
    console.log(`   Resume:     ${fileKey ? 'attached' : 'none'}`);
    console.log(`   Timeout:    600s (10 minutes)`);
    console.log('\n   The worker will:');
    console.log('     1. Navigate to the Workday listing');
    console.log('     2. Click Apply');
    console.log('     3. Sign in with Google (using stored session)');
    console.log('     4. Fill out all application pages');
    console.log('     5. STOP at the review page (NOT submit)');
    console.log('     6. Keep the browser open for you to review');
    console.log('\nWatch your worker terminal — it should pick this up within 5 seconds.');
  } catch (err) {
    console.error('Error creating job:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
