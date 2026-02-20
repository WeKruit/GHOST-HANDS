#!/usr/bin/env bun
/**
 * Submit Workday Application Test Job
 *
 * Creates a workday_apply job in the database that a running worker will pick up.
 * The worker will navigate to the CACI Workday listing, sign in with Google,
 * fill out the entire application, and stop at the review page.
 *
 * Prerequisites:
 *   1. Migration 008_gh_browser_sessions.sql applied
 *   2. Google session stored (run sessionPersistence.test.ts first)
 *   3. Worker running: bun run worker -- --worker-id=<name>
 *
 * Usage:
 *   bun run apply:workday                        # any worker picks it up
 *   bun run apply:workday -- --worker-id=adam     # only worker "adam" picks it up
 */

import { Client as PgClient } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { TEST_WORKDAY_PROFILE, TEST_QA_OVERRIDES } from '../../__tests__/fixtures/workdayTestData.js';

// --- Config ---

const DEFAULT_WORKDAY_URL =
  'https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/Canada%2C-BC%2C-Vancouver/Software-Engineer-III-Senior-Software-Engineer--Full-Stack-_JR-0103512/apply/applyManually?q=software+engineer';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

// --- Parse args ---

function parseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  if (arg) return arg.split('=').slice(1).join('=');
  return DEFAULT_WORKDAY_URL;
}

function parseTargetWorkerId(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--worker-id='));
  if (arg) {
    const id = arg.split('=')[1];
    if (!id) {
      console.error('--worker-id requires a value (e.g. --worker-id=adam)');
      process.exit(1);
    }
    return id;
  }
  return null;
}

// --- Session check ---

async function checkGoogleSession(supabase: any): Promise<boolean> {
  const { data } = await supabase
    .from('gh_browser_sessions')
    .select('id, last_used_at')
    .eq('user_id', TEST_USER_ID)
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
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const hasSession = await checkGoogleSession(supabase);
    if (!hasSession) {
      console.warn('\n⚠️  WARNING: No Google session found in gh_browser_sessions.');
      console.warn('   The worker will need to sign in fresh, which may trigger 2FA.');
      console.warn('   To store a session first, run:');
      console.warn('     bun test __tests__/integration/sessions/sessionPersistence.test.ts\n');
    } else {
      console.log('✓ Google session found in database');
    }
  }

  const targetWorkerId = parseTargetWorkerId();
  const targetUrl = parseUrl();
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  console.log('\nCreating Workday application job...\n');

  const inputData = {
    user_data: TEST_WORKDAY_PROFILE,
    qa_overrides: TEST_QA_OVERRIDES,
    tier: 'starter',
    platform: 'workday',
  };

  const taskDescription = [
    'Fill out the entire Workday job application.',
    'Sign in using "Sign in with Google" if prompted.',
    'Fill all required fields using the provided user data.',
    'For any optional self-identification questions, select "I do not wish to answer".',
    'IMPORTANT: Do NOT click "Submit Application" — stop at the review/summary page.',
  ].join(' ');

  try {
    const result = await client.query(
      `
      INSERT INTO gh_automation_jobs (
        job_type, target_url, task_description,
        input_data, user_id, status,
        timeout_seconds, max_retries, priority,
        target_worker_id, tags
      ) VALUES (
        'workday_apply',
        $1,
        $2,
        $3::jsonb,
        $4,
        'pending',
        600, 1, 1,
        $5,
        $6::jsonb
      )
      RETURNING id, status, target_url, target_worker_id
    `,
      [
        targetUrl,
        taskDescription,
        JSON.stringify(inputData),
        TEST_USER_ID,
        targetWorkerId,
        JSON.stringify(['workday', 'test', 'intern']),
      ],
    );

    const job = result.rows[0];
    console.log('Workday application job created!\n');
    console.log(`   Job ID:     ${job.id}`);
    console.log(`   Status:     ${job.status}`);
    console.log(`   URL:        ${job.target_url}`);
    console.log(`   Applicant:  ${TEST_WORKDAY_PROFILE.first_name} ${TEST_WORKDAY_PROFILE.last_name}`);
    console.log(`   Email:      ${TEST_WORKDAY_PROFILE.email}`);
    if (job.target_worker_id) {
      console.log(`   Target:     ${job.target_worker_id} (only this worker will pick it up)`);
    } else {
      console.log(`   Target:     any worker`);
    }
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
