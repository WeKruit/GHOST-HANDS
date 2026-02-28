#!/usr/bin/env node
/**
 * Submit Job Application (Generic)
 *
 * Creates a smart_apply job using real user profile data from VALET's
 * parsed resumes table. Works with ANY application website — SmartApplyHandler
 * auto-detects the platform (Workday, Greenhouse, Lever, LinkedIn, etc.)
 * and adapts its filling strategy accordingly.
 *
 * Prerequisites:
 *   1. A resume uploaded and parsed in VALET (status = 'parsed')
 *   2. Worker running: npx tsx --env-file=.env src/workers/main.ts -- --worker-id=<name>
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/apply.ts -- --user-id=<uuid> --url=<application-url>
 *
 * Flags:
 *   --user-id=<uuid>      (required) VALET user ID whose parsed resume to use
 *   --url=<url>            (required) The job application URL
 *   --worker-id=<name>     (optional) Target a specific worker (default: any worker picks it up)
 *   --timeout=<seconds>    (optional) Job timeout in seconds (default: 1800)
 *
 * Examples:
 *   # Greenhouse application, any worker
 *   npx tsx --env-file=.env src/scripts/apply.ts -- --user-id=e1aac8ad-... --url=https://boards.greenhouse.io/company/jobs/123
 *
 *   # Workday application, specific worker
 *   npx tsx --env-file=.env src/scripts/apply.ts -- --user-id=e1aac8ad-... --url=https://company.wd5.myworkdayjobs.com/... --worker-id=my-worker
 *
 *   # Any website
 *   npx tsx --env-file=.env src/scripts/apply.ts -- --user-id=e1aac8ad-... --url=https://company.com/careers/apply
 */

import { Client as PgClient } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { ResumeProfileLoader } from '../db/resumeProfileLoader.js';

// --- Platform detection (lightweight, no handler dependency) ---

function detectPlatform(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('myworkdayjobs.com') || lower.includes('myworkdaysite.com') || lower.includes('workday.com')) return 'workday';
  if (lower.includes('greenhouse.io')) return 'greenhouse';
  if (lower.includes('lever.co')) return 'lever';
  if (lower.includes('linkedin.com')) return 'linkedin';
  if (lower.includes('amazon.jobs')) return 'amazon';
  if (lower.includes('icims.com')) return 'icims';
  if (lower.includes('taleo')) return 'taleo';
  if (lower.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (lower.includes('ashbyhq.com')) return 'ashby';
  return 'generic';
}

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
  // Validate required env vars
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

  // Parse CLI args
  const requestedUserId = parseArg('user-id');
  const targetUrl = parseArg('url');
  const targetWorkerId = parseArg('worker-id') || null;
  const timeoutSeconds = parseInt(parseArg('timeout') || '1800', 10);

  if (!requestedUserId) {
    console.error('Error: --user-id=<uuid> is required.');
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx --env-file=.env src/scripts/apply.ts -- --user-id=<uuid> --url=<application-url>');
    console.error('');
    console.error('Flags:');
    console.error('  --user-id=<uuid>      VALET user ID whose parsed resume to use');
    console.error('  --url=<url>            The job application URL');
    console.error('  --worker-id=<name>     Target a specific worker (optional)');
    console.error('  --timeout=<seconds>    Job timeout in seconds (default: 1800)');
    process.exit(1);
  }

  if (!targetUrl) {
    console.error('Error: --url=<application-url> is required.');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx --env-file=.env src/scripts/apply.ts -- \\');
    console.error(`    --user-id=${requestedUserId} \\`);
    console.error('    --url=https://boards.greenhouse.io/company/jobs/123');
    process.exit(1);
  }

  const platform = detectPlatform(targetUrl);
  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Load user profile from VALET's parsed resumes
  const loader = new ResumeProfileLoader(supabase);
  console.log(`\nLoading resume profile for user ${requestedUserId}...`);

  let result;
  try {
    result = await loader.loadForUser(requestedUserId);
  } catch (err) {
    console.error(`\nFailed to load resume profile: ${err instanceof Error ? err.message : err}`);
    console.error('Ensure a resume has been uploaded and parsed in VALET.');
    process.exit(1);
  }

  const { profile, fileKey, userId, resumeId, parsingConfidence } = result;

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

  // 2. Check for Google session (informational only)
  const hasSession = await checkGoogleSession(supabase, userId);
  if (!hasSession) {
    console.warn('\nNote: No Google session found in gh_browser_sessions.');
    console.warn('   If the site requires Google sign-in, the worker may trigger 2FA.');
  } else {
    console.log('\nGoogle session found in database.');
  }

  // 3. Build job input data
  const inputData = {
    user_data: profile,
    qa_overrides: {},
    tier: 'starter',
    platform,
  };

  const resumeRef = fileKey ? { storage_path: fileKey } : null;

  const taskDescription = [
    `Fill out the job application at the provided URL.`,
    'Fill all required fields using the provided user data.',
    'For any optional self-identification questions, select "I do not wish to answer".',
    'IMPORTANT: Do NOT click "Submit Application" — stop at the review/summary page.',
  ].join(' ');

  // 4. Insert job into database
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  console.log(`\nCreating ${platform} application job (handler: smart_apply)...\n`);

  try {
    const queryResult = await client.query(
      `
      INSERT INTO gh_automation_jobs (
        job_type, target_url, task_description,
        input_data, user_id, status,
        timeout_seconds, max_retries, priority,
        target_worker_id, tags, resume_ref
      ) VALUES (
        'smart_apply',
        $1,
        $2,
        $3::jsonb,
        $4,
        'pending',
        $5, 1, 1,
        $6,
        $7::jsonb,
        $8::jsonb
      )
      RETURNING id, status, target_url, target_worker_id
    `,
      [
        targetUrl,
        taskDescription,
        JSON.stringify(inputData),
        userId,
        timeoutSeconds,
        targetWorkerId,
        JSON.stringify([platform, 'smart_apply']),
        resumeRef ? JSON.stringify(resumeRef) : null,
      ],
    );

    const job = queryResult.rows[0];
    console.log('Job created!\n');
    console.log(`   Job ID:     ${job.id}`);
    console.log(`   Status:     ${job.status}`);
    console.log(`   URL:        ${job.target_url}`);
    console.log(`   Handler:    smart_apply`);
    console.log(`   Platform:   ${platform}`);
    console.log(`   Applicant:  ${profile.first_name} ${profile.last_name}`);
    console.log(`   Email:      ${profile.email}`);
    if (job.target_worker_id) {
      console.log(`   Target:     ${job.target_worker_id} (only this worker will pick it up)`);
    } else {
      console.log(`   Target:     any worker`);
    }
    console.log(`   Resume:     ${fileKey ? 'attached' : 'none'}`);
    console.log(`   Timeout:    ${timeoutSeconds}s`);
    console.log('\n   The worker will:');
    console.log(`     1. Navigate to the application URL`);
    console.log('     2. Detect the platform and adapt strategy');
    console.log('     3. Fill out all application fields using the user profile');
    console.log('     4. Use MagnitudeHand (visual agent) for any tricky fields');
    console.log('     5. STOP at the review page (NOT submit)');
    console.log('\nWatch your worker terminal — it should pick this up within 5 seconds.');
  } catch (err) {
    console.error('Error creating job:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
