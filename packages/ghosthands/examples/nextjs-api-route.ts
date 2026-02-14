/**
 * Example: VALET Next.js API Routes using GhostHandsClient
 *
 * Shows how VALET integrates with GhostHands to:
 * 1. Create automation jobs from user requests
 * 2. Query job status
 * 3. Cancel / retry jobs
 * 4. Subscribe to real-time job updates on the frontend
 *
 * Copy the relevant sections into your Next.js App Router API routes.
 */

import {
  GhostHandsClient,
  DuplicateIdempotencyKeyError,
  type CreateJobParams,
} from '../src/client';

// ---------------------------------------------------------------------------
// Initialise the client (singleton -- reuse across requests)
// ---------------------------------------------------------------------------

// API mode (recommended) -- talks to the GhostHands REST API:
const client = new GhostHandsClient(
  process.env.GHOSTHANDS_API_URL!,  // e.g. "https://gh.wekruit.com/api/v1/gh"
  process.env.GHOSTHANDS_API_KEY!,  // GH_SERVICE_SECRET shared key
);

// DB mode (alternative) -- talks directly to Supabase:
// const client = new GhostHandsClient({
//   mode: 'db',
//   supabaseUrl: process.env.SUPABASE_URL!,
//   supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
// });

// API mode with Realtime support:
// const client = new GhostHandsClient({
//   apiUrl: process.env.GHOSTHANDS_API_URL!,
//   apiKey: process.env.GHOSTHANDS_API_KEY!,
//   supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
//   supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
// });

// ---------------------------------------------------------------------------
// POST /api/gh/apply  -- submit a job application (snake_case API style)
// ---------------------------------------------------------------------------
export async function POST_apply(request: Request) {
  // Authenticate user via Supabase Auth:
  //   const supabase = createRouteHandlerClient({ cookies });
  //   const { data: { user } } = await supabase.auth.getUser();
  //   if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const user = { id: 'authenticated-user-uuid', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '+1-555-0100', subscription_tier: 'pro' as const };

  const body = await request.json();

  try {
    // CreateJobParams uses snake_case -- matches the REST API directly
    const job = await client.createJob({
      type: 'apply',
      user_id: user.id,
      target_url: body.jobUrl,
      task_description: `Apply to ${body.jobTitle} at ${body.company}`,
      input_data: {
        platform: 'workday',
        job_url: body.jobUrl,
        resume_id: body.resumeId,
        user_data: {
          firstName: user.first_name,
          lastName: user.last_name,
          email: user.email,
          phone: user.phone,
        },
        tier: user.subscription_tier,
      },
      idempotency_key: `valet-apply-${user.id}-${body.jobUrl}`,
    } satisfies CreateJobParams);

    return Response.json(job, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateIdempotencyKeyError) {
      return Response.json(
        {
          error: 'duplicate_idempotency_key',
          existingJobId: err.existingJobId,
          existingStatus: err.existingStatus,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/gh/apply (alternative) -- camelCase convenience style
// ---------------------------------------------------------------------------
export async function POST_apply_camelCase(request: Request) {
  const userId = 'authenticated-user-uuid';
  const body = await request.json();

  const job = await client.createJob(userId, {
    jobType: 'apply',
    targetUrl: body.jobUrl,
    taskDescription: `Apply to ${body.jobTitle} at ${body.company}`,
    inputData: {
      resumePath: body.resumePath,
      userData: {
        first_name: body.firstName,
        last_name: body.lastName,
        email: body.email,
        phone: body.phone,
        linkedin_url: body.linkedinUrl,
      },
      tier: body.subscriptionTier,
      platform: body.platform,
      qaOverrides: body.qaOverrides,
    },
    priority: body.priority ?? 5,
    tags: body.tags ?? [],
    idempotencyKey: `valet-apply-${userId}-${body.jobUrl}`,
  });

  return Response.json({ jobId: job.id, status: job.status }, { status: 201 });
}

// ---------------------------------------------------------------------------
// GET /api/gh/jobs/[id]  -- get full job details
// ---------------------------------------------------------------------------
export async function GET_job(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const job = await client.getJob(params.id);
    return Response.json(job);
  } catch {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/gh/jobs/[id]/status  -- lightweight status check
// ---------------------------------------------------------------------------
export async function GET_jobStatus(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const status = await client.getJobStatus(params.id);
    return Response.json(status);
  } catch {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/gh/jobs/[id]/cancel  -- cancel a job
// ---------------------------------------------------------------------------
export async function POST_cancel(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    await client.cancelJob(params.id);
    return Response.json({ id: params.id, status: 'cancelled' });
  } catch (err: any) {
    if (err.code === 'job_not_cancellable') {
      return Response.json({ error: err.code, message: err.message }, { status: 409 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/gh/jobs/[id]/retry  -- retry a failed/cancelled job
// ---------------------------------------------------------------------------
export async function POST_retry(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const job = await client.retryJob(params.id);
    return Response.json({ id: job.id, status: job.status });
  } catch (err: any) {
    if (err.code === 'job_not_retryable') {
      return Response.json({ error: err.code, message: err.message }, { status: 409 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/gh/jobs  -- list jobs for the authenticated user
// ---------------------------------------------------------------------------
export async function GET_jobs(request: Request) {
  const userId = 'authenticated-user-uuid';
  const url = new URL(request.url);

  const statusParam = url.searchParams.get('status');
  const result = await client.listJobs(userId, {
    status: statusParam ? (statusParam.split(',') as any) : undefined,
    jobType: (url.searchParams.get('job_type') as any) ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 20),
    offset: Number(url.searchParams.get('offset') ?? 0),
  });

  return Response.json(result);
}

// ---------------------------------------------------------------------------
// POST /api/gh/apply/batch  -- submit multiple applications
// ---------------------------------------------------------------------------
export async function POST_batch(request: Request) {
  const userId = 'authenticated-user-uuid';
  const { applications } = await request.json();

  const jobs = applications.map((app: any) => ({
    job_type: 'apply' as const,
    target_url: app.jobUrl,
    task_description: `Apply to ${app.jobTitle} at ${app.company}`,
    input_data: {
      resume_id: app.resumeId,
      user_data: app.userData,
      tier: app.tier,
      qa_overrides: app.qaOverrides,
    },
    tags: app.tags ?? [],
    idempotency_key: `valet-apply-${userId}-${app.jobUrl}`,
  }));

  const result = await client.createBatch(userId, jobs);
  return Response.json(result, { status: 201 });
}

// ---------------------------------------------------------------------------
// Realtime subscription (via client with Supabase configured)
// ---------------------------------------------------------------------------
export async function subscribeExample(jobId: string) {
  // Requires client created with supabaseUrl+supabaseKey
  const sub = client.subscribeToJobStatus(jobId, (status) => {
    console.log(`Job ${status.id}: ${status.status} -- ${status.status_message}`);
  });

  // Later:
  // await sub.unsubscribe();
  return sub;
}

// ---------------------------------------------------------------------------
// Frontend: Realtime subscription (React hook sketch)
// ---------------------------------------------------------------------------
/*
  import { createClient } from '@supabase/supabase-js';
  import { useState, useEffect } from 'react';
  import type { AutomationJob } from '@ghosthands/client';

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  function useJobUpdates(userId: string) {
    const [jobs, setJobs] = useState<Map<string, AutomationJob>>(new Map());

    useEffect(() => {
      const channel = supabase
        .channel('my-job-updates')
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'gh_automation_jobs',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const job = payload.new as AutomationJob;
            setJobs((prev) => new Map(prev).set(job.id, job));
          },
        )
        .subscribe();

      return () => { supabase.removeChannel(channel); };
    }, [userId]);

    return jobs;
  }
*/

// ---------------------------------------------------------------------------
// Server-side polling (when WebSockets are not available)
// ---------------------------------------------------------------------------
export async function serverSideWaitExample() {
  const job = await client.createJob({
    type: 'apply',
    user_id: 'user-uuid',
    target_url: 'https://boards.greenhouse.io/company/jobs/123',
    task_description: 'Apply to SWE at Company',
    input_data: {
      user_data: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    },
  });

  // Block until the job reaches a terminal status
  const completed = await client.pollForCompletion(job.id, {
    intervalMs: 2000,
    timeoutMs: 300_000,
  });

  console.log('Job finished:', completed.status, completed.result_summary);
}
