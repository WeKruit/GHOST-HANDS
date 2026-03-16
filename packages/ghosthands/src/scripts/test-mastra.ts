#!/usr/bin/env node
/**
 * Test Mastra Workflow Script
 *
 * Submits a job application through the Mastra workflow engine and polls
 * for status updates. Accepts any job URL as input.
 *
 * Prerequisites:
 *   1. A resume uploaded and parsed in VALET (status = 'parsed')
 *   2. API server running:  npx tsx --env-file=.env src/api/server.ts
 *   3. Worker running:      npx tsx --env-file=.env src/workers/main.ts -- --worker-id=<name>
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/test-mastra.ts -- --url=<job-url> --user-id=<uuid>
 *
 * Flags:
 *   --url=<url>            (required) The job application URL
 *   --user-id=<uuid>       (required) VALET user ID whose parsed resume to use
 *   --worker-id=<name>     (optional) Target a specific worker
 *   --timeout=<seconds>    (optional) Job timeout in seconds (default: 1800)
 *   --no-poll              (optional) Just submit, don't poll for status
 *   --poll-interval=<ms>   (optional) Status poll interval in ms (default: 5000)
 *   --direct               (optional) Insert directly into DB instead of using the API
 *
 * Examples:
 *   # Via API (requires API server running):
 *   npx tsx --env-file=.env src/scripts/test-mastra.ts -- \
 *     --url=https://boards.greenhouse.io/company/jobs/123 \
 *     --user-id=e1aac8ad-...
 *
 *   # Direct DB insert (no API server needed):
 *   npx tsx --env-file=.env src/scripts/test-mastra.ts -- \
 *     --url=https://company.wd5.myworkdayjobs.com/jobs/123 \
 *     --user-id=e1aac8ad-... --direct
 *
 *   # Target specific worker, custom timeout:
 *   npx tsx --env-file=.env src/scripts/test-mastra.ts -- \
 *     --url=https://jobs.lever.co/company/abc \
 *     --user-id=e1aac8ad-... --worker-id=adam --timeout=600
 */

import { Client as PgClient } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { ResumeProfileLoader } from '../db/resumeProfileLoader.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArg(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) return null;
  return arg.split('=').slice(1).join('=') || null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

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

function resolveValetApiBase(): string {
  const explicit =
    process.env.VALET_API_URL?.trim() ||
    process.env.API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return 'https://valet-api-stg.fly.dev';
}

function resolveValetCallbackUrl(): string {
  return `${resolveValetApiBase()}/api/v1/webhooks/ghosthands`;
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  pending: '\x1b[33m',   // yellow
  queued: '\x1b[33m',    // yellow
  running: '\x1b[36m',   // cyan
  paused: '\x1b[35m',    // magenta
  needs_human: '\x1b[31m', // red
  awaiting_review: '\x1b[35m', // magenta
  completed: '\x1b[32m', // green
  failed: '\x1b[31m',    // red
  cancelled: '\x1b[90m', // gray
  expired: '\x1b[90m',   // gray
};
const RESET = '\x1b[0m';

function colorStatus(status: string): string {
  return `${STATUS_COLORS[status] || ''}${status}${RESET}`;
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
  'needs_human',
  'awaiting_review',
]);

async function pollStatus(
  client: PgClient,
  jobId: string,
  intervalMs: number,
): Promise<void> {
  console.log(`\nPolling job status every ${intervalMs / 1000}s (Ctrl+C to stop)...\n`);

  let lastStatus = '';
  let lastMessage = '';

  while (true) {
    try {
      const { rows } = await client.query(
        `SELECT status, status_message, error_code, error_details,
                result_data, execution_mode, interaction_data,
                metadata, started_at, completed_at
         FROM gh_automation_jobs WHERE id = $1`,
        [jobId],
      );

      if (rows.length === 0) {
        console.error('Job not found in database!');
        return;
      }

      const job = rows[0];
      const now = new Date().toLocaleTimeString();

      // Only print when something changes
      if (job.status !== lastStatus || job.status_message !== lastMessage) {
        lastStatus = job.status;
        lastMessage = job.status_message;

        console.log(`[${now}] Status: ${colorStatus(job.status)}${job.status_message ? ` — ${job.status_message}` : ''}`);

        // Show interaction details for HITL/human-needed states
        if (['paused', 'needs_human', 'awaiting_review'].includes(job.status) && job.interaction_data) {
          const interaction = job.interaction_data;
          console.log(`         Blocker: ${interaction.blocker_type || interaction.type || 'unknown'}`);
          if (interaction.page_url) {
            console.log(`         Page:    ${interaction.page_url}`);
          }
          if (interaction.screenshot_url) {
            console.log(`         Screenshot: ${interaction.screenshot_url}`);
          }
          console.log('         (Waiting for human intervention — resolve via API or dashboard)');
        }

        // Show Mastra run ID from metadata
        if (job.metadata?.mastra_run_id && job.status === 'running') {
          console.log(`         Mastra Run: ${job.metadata.mastra_run_id}`);
        }
      }

      // Terminal state — print final summary
      if (TERMINAL_STATUSES.has(job.status)) {
        console.log('\n--- Final Result ---');
        console.log(`Status:     ${colorStatus(job.status)}`);
        console.log(`Mode:       ${job.execution_mode || 'unknown'}`);

        if (job.started_at) {
          console.log(`Started:    ${new Date(job.started_at).toLocaleString()}`);
        }
        if (job.completed_at) {
          console.log(`Completed:  ${new Date(job.completed_at).toLocaleString()}`);
          if (job.started_at) {
            const durationSec = (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000;
            console.log(`Duration:   ${durationSec.toFixed(1)}s`);
          }
        }

        if (job.status === 'failed' || job.status === 'needs_human') {
          console.log(`Error:      ${job.error_code || 'unknown'}`);
          if (job.error_details) {
            console.log(`Details:    ${JSON.stringify(job.error_details, null, 2)}`);
          }
        }

        if (job.status === 'completed' && job.result_data) {
          console.log(`Result:     ${JSON.stringify(job.result_data, null, 2).slice(0, 500)}`);
        }

        return;
      }
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Poll error: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Submit via API
// ---------------------------------------------------------------------------

async function submitViaApi(
  targetUrl: string,
  userId: string,
  profile: any,
  opts: { workerId: string | null; timeout: number; platform: string; resumeRef: any },
): Promise<string> {
  const apiBase = `http://localhost:${process.env.GH_API_PORT || '3100'}`;
  const serviceKey = process.env.GH_SERVICE_SECRET;

  if (!serviceKey) {
    throw new Error('GH_SERVICE_SECRET must be set for API submission');
  }

  const payload = {
    valet_task_id: `mastra-test-${Date.now()}`,
    valet_user_id: userId,
    callback_url: resolveValetCallbackUrl(),
    target_url: targetUrl,
    execution_mode: 'mastra',
    profile: {
      first_name: profile.first_name,
      last_name: profile.last_name,
      email: profile.email,
      phone: profile.phone || undefined,
      linkedin_url: profile.linkedin_url || undefined,
      work_authorization: profile.work_authorization || undefined,
      years_of_experience: profile.years_of_experience || undefined,
      education: profile.education?.map((e: any) => ({
        institution: e.school || e.institution,
        degree: e.degree,
        field: e.fieldOfStudy || e.field || '',
        graduation_year: e.graduation_year || new Date().getFullYear(),
      })) || [],
      work_history: profile.experience?.map((w: any) => ({
        company: w.company,
        title: w.title,
        start_date: w.startDate || w.start_date,
        end_date: w.endDate || w.end_date,
        description: w.description,
      })) || [],
      skills: profile.skills || [],
    },
    resume: opts.resumeRef || undefined,
    priority: 1,
    timeout_seconds: opts.timeout,
    target_worker_id: opts.workerId || undefined,
    metadata: { source: 'test-mastra-script', platform: opts.platform },
  };

  const resp = await fetch(`${apiBase}/api/v1/gh/valet/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GH-Service-Key': serviceKey,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API returned ${resp.status}: ${body}`);
  }

  const data = await resp.json() as { job_id: string };
  return data.job_id;
}

// ---------------------------------------------------------------------------
// Submit via direct DB insert
// ---------------------------------------------------------------------------

async function submitViaDirect(
  client: PgClient,
  targetUrl: string,
  userId: string,
  profile: any,
  opts: { workerId: string | null; timeout: number; platform: string; resumeRef: any },
): Promise<string> {
  const valetTaskId = `mastra-test-${Date.now()}`;
  const inputData = {
    user_data: profile,
    qa_overrides: {},
    tier: 'starter',
    platform: opts.platform,
  };

  const { rows } = await client.query(
    `INSERT INTO gh_automation_jobs (
       job_type, target_url, task_description,
       input_data, user_id, status,
       timeout_seconds, max_retries, priority,
       target_worker_id, tags, resume_ref,
       execution_mode, metadata, callback_url, valet_task_id
     ) VALUES (
       'smart_apply', $1, $2,
       $3::jsonb, $4, 'pending',
       $5, 1, 1,
       $6, $7::jsonb, $8::jsonb,
       'mastra', $9::jsonb, $10, $11
     )
     RETURNING id`,
    [
      targetUrl,
      'Fill out the job application at the provided URL. Fill all required fields using the provided user data. STOP at the review page — do NOT submit.',
      JSON.stringify(inputData),
      userId,
      opts.timeout,
      opts.workerId,
      JSON.stringify([opts.platform, 'smart_apply', 'mastra']),
      opts.resumeRef ? JSON.stringify(opts.resumeRef) : null,
      JSON.stringify({ source: 'test-mastra-script', platform: opts.platform }),
      resolveValetCallbackUrl(),
      valetTaskId,
    ],
  );

  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const targetUrl = parseArg('url');
  const requestedUserId = parseArg('user-id');
  const targetWorkerId = parseArg('worker-id') || null;
  const timeoutSeconds = parseInt(parseArg('timeout') || '1800', 10);
  const pollIntervalMs = parseInt(parseArg('poll-interval') || '5000', 10);
  const noPoll = hasFlag('no-poll');
  const directMode = hasFlag('direct');

  if (!targetUrl || !requestedUserId) {
    console.error('Usage: npx tsx --env-file=.env src/scripts/test-mastra.ts -- --url=<job-url> --user-id=<uuid>');
    console.error('');
    console.error('Required:');
    console.error('  --url=<url>            Job application URL');
    console.error('  --user-id=<uuid>       VALET user ID with a parsed resume');
    console.error('');
    console.error('Optional:');
    console.error('  --worker-id=<name>     Target a specific worker');
    console.error('  --timeout=<seconds>    Job timeout (default: 1800)');
    console.error('  --no-poll              Submit only, skip status polling');
    console.error('  --poll-interval=<ms>   Poll interval in ms (default: 5000)');
    console.error('  --direct               Insert into DB directly (no API server needed)');
    console.error('');
    console.error('Examples:');
    console.error('  npx tsx --env-file=.env src/scripts/test-mastra.ts -- \\');
    console.error('    --url=https://boards.greenhouse.io/company/jobs/123 \\');
    console.error(`    --user-id=${requestedUserId || '<uuid>'}`);
    process.exit(1);
  }

  // Validate env
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DIRECT_URL || process.env.DATABASE_DIRECT_URL;
  if (!dbUrl) {
    console.error('Error: DATABASE_URL or SUPABASE_DIRECT_URL must be set');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
    process.exit(1);
  }

  const platform = detectPlatform(targetUrl);
  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Load user profile
  console.log(`\nLoading resume profile for user ${requestedUserId}...`);
  const loader = new ResumeProfileLoader(supabase);

  let profileResult;
  try {
    profileResult = await loader.loadForUser(requestedUserId);
  } catch (err) {
    console.error(`Failed to load resume: ${err instanceof Error ? err.message : err}`);
    console.error('Ensure a resume has been uploaded and parsed in VALET.');
    process.exit(1);
  }

  const { profile, fileKey, userId } = profileResult;
  console.log(`Profile loaded: ${profile.first_name} ${profile.last_name} <${profile.email}>`);

  const resumeRef = fileKey ? { storage_path: fileKey } : null;
  const opts = { workerId: targetWorkerId, timeout: timeoutSeconds, platform, resumeRef };

  // 2. Connect to DB (needed for both direct insert and polling)
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  let jobId: string;

  try {
    // 3. Submit job
    if (directMode) {
      console.log(`\nSubmitting Mastra job via direct DB insert...`);
      jobId = await submitViaDirect(client, targetUrl, userId, profile, opts);
    } else {
      console.log(`\nSubmitting Mastra job via API...`);
      try {
        jobId = await submitViaApi(targetUrl, userId, profile, opts);
      } catch (err) {
        console.error(`API submission failed: ${err instanceof Error ? err.message : err}`);
        console.error('Is the API server running? Try --direct to skip the API.');
        await client.end();
        process.exit(1);
      }
    }

    console.log(`\nJob submitted!`);
    console.log(`   Job ID:     ${jobId}`);
    console.log(`   URL:        ${targetUrl}`);
    console.log(`   Platform:   ${platform}`);
    console.log(`   Mode:       mastra`);
    console.log(`   Applicant:  ${profile.first_name} ${profile.last_name}`);
    if (targetWorkerId) {
      console.log(`   Worker:     ${targetWorkerId}`);
    }
    console.log(`   Timeout:    ${timeoutSeconds}s`);

    // 4. Poll for status
    if (!noPoll) {
      await pollStatus(client, jobId, pollIntervalMs);
    } else {
      console.log('\nSkipping status polling (--no-poll). Check status with:');
      console.log(`   npx tsx --env-file=.env src/scripts/check-job.ts`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
