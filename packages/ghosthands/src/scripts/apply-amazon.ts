#!/usr/bin/env bun
/**
 * Submit Amazon Jobs Application Test Job
 *
 * Creates a smart_apply job in the database that a running worker will pick up.
 * The worker will navigate to the Amazon job listing, sign in if prompted,
 * fill out the entire application, and stop at the review page.
 *
 * Prerequisites:
 *   1. Worker running: bun run worker -- --worker-id=<name>
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/apply-amazon.ts                        # any worker picks it up
 *   npx tsx --env-file=.env src/scripts/apply-amazon.ts --worker-id=adam        # only worker "adam" picks it up
 *   npx tsx --env-file=.env src/scripts/apply-amazon.ts --url=https://...       # custom Amazon URL
 */

import { Client as PgClient } from 'pg';

// --- Config ---

const DEFAULT_AMAZON_URL =
  'https://www.amazon.jobs/en/jobs/3155752/organic-social-media-manager-amazon-attraction-influence-and-marketing';

const TEST_USER_ID = process.env.GH_TEST_USER_ID || '00000000-0000-0000-0000-000000000001';

const TEST_AMAZON_PROFILE = {
  first_name: 'Happy',
  last_name: 'Wu',
  email: process.env.TEST_GMAIL_EMAIL || '',
  phone: '4085551234',
  address: {
    street: '123 Test Avenue',
    city: 'San Jose',
    state: 'California',
    zip: '95112',
    country: 'United States',
  },
  linkedin_url: 'www.linkedin.com/in/spencerwang1',
  current_company: 'WeKruit',
  current_title: 'Software developer',
  education: [
    {
      school: 'University of California, Los Angeles',
      degree: 'Bachelor of Science',
      field_of_study: 'Computer Science',
      start_date: '',
      end_date: '',
    },
  ],
  experience: [
    {
      company: 'WeKruit',
      title: 'Software developer',
      location: 'Los Angeles, CA',
      currently_work_here: true,
      start_date: '2026-01',
      end_date: '',
      description: 'Working at WeKruit Yippie!!!',
    },
  ],
  skills: ['Python', 'Amazon Web Services (AWS)', 'Social Media Marketing'],
  resume_path: 'resumeTemp.pdf',
  work_authorization: 'Yes',
  visa_sponsorship: 'No',
  veteran_status: 'I am not a protected veteran',
  disability_status: 'I do not wish to answer',
  gender: 'Male',
  race_ethnicity: 'Asian',
};

const TEST_QA_OVERRIDES: Record<string, string> = {
  'Are you legally authorized to work in the United States?': 'Yes',
  'Will you now or in the future require sponsorship for employment visa status?': 'No',
  'Are you at least 18 years of age?': 'Yes',
  'Are you willing to relocate?': 'Yes',
  'Have you previously worked for Amazon?': 'No',
  'Have you previously worked for this company?': 'No',
};

// --- Parse args ---

function parseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  if (arg) return arg.split('=').slice(1).join('=');
  return DEFAULT_AMAZON_URL;
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

  const targetWorkerId = parseTargetWorkerId();
  const targetUrl = parseUrl();
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  console.log('\nCreating Amazon Jobs application job...\n');

  const inputData = {
    user_data: TEST_AMAZON_PROFILE,
    qa_overrides: TEST_QA_OVERRIDES,
    tier: 'starter',
    platform: 'amazon',
  };

  const taskDescription = [
    'Fill out the entire Amazon job application.',
    'Sign in if prompted (Amazon SSO or Google).',
    'Fill all required fields using the provided user data.',
    'For any optional self-identification questions, select "I do not wish to answer" or "Decline to self-identify".',
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
        'smart_apply',
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
        JSON.stringify(['amazon', 'test']),
      ],
    );

    const job = result.rows[0];
    console.log('Amazon Jobs application job created!\n');
    console.log(`   Job ID:     ${job.id}`);
    console.log(`   Status:     ${job.status}`);
    console.log(`   URL:        ${job.target_url}`);
    console.log(`   Applicant:  ${TEST_AMAZON_PROFILE.first_name} ${TEST_AMAZON_PROFILE.last_name}`);
    console.log(`   Email:      ${TEST_AMAZON_PROFILE.email}`);
    if (job.target_worker_id) {
      console.log(`   Target:     ${job.target_worker_id} (only this worker will pick it up)`);
    } else {
      console.log(`   Target:     any worker`);
    }
    console.log(`   Timeout:    600s (10 minutes)`);
    console.log('\n   The worker will:');
    console.log('     1. Navigate to the Amazon job listing');
    console.log('     2. Click Apply');
    console.log('     3. Sign in if prompted');
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
