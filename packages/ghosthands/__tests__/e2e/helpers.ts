/**
 * E2E test helpers for GhostHands.
 *
 * Provides:
 *  - Supabase test client setup
 *  - Job factory for creating test jobs
 *  - Database cleanup utilities
 *  - Mock VALET client wrapper
 *  - Test worker runner (JobPoller + JobExecutor with mocked browser agent)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Environment / client setup
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/**
 * Returns a service-role Supabase client for test operations.
 */
export function getTestSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
export const TEST_USER_ID_2 = '00000000-0000-0000-0000-000000000002';
export const TEST_WORKER_ID = 'test-worker-1';
export const TEST_WORKER_ID_2 = 'test-worker-2';

export const JOB_STATUSES = [
  'pending',
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;

// ---------------------------------------------------------------------------
// Job factory
// ---------------------------------------------------------------------------

export interface TestJobOverrides {
  id?: string;
  user_id?: string;
  job_type?: string;
  target_url?: string;
  task_description?: string;
  input_data?: Record<string, unknown>;
  priority?: number;
  max_retries?: number;
  retry_count?: number;
  timeout_seconds?: number;
  status?: string;
  worker_id?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  scheduled_at?: string | null;
  error_code?: string | null;
  error_details?: Record<string, unknown> | null;
  last_heartbeat?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/**
 * Build a default job row suitable for direct DB insertion.
 */
export function buildJobRow(overrides: TestJobOverrides = {}): Record<string, unknown> {
  return {
    user_id: overrides.user_id ?? TEST_USER_ID,
    created_by: 'test',
    job_type: overrides.job_type ?? 'apply',
    target_url: overrides.target_url ?? 'https://boards.greenhouse.io/testco/jobs/12345',
    task_description: overrides.task_description ?? 'Apply to the Software Engineer position',
    input_data: overrides.input_data ?? {
      user_data: {
        first_name: 'Test',
        last_name: 'User',
        email: 'test@example.com',
      },
      tier: 'starter',
      platform: 'greenhouse',
    },
    priority: overrides.priority ?? 5,
    max_retries: overrides.max_retries ?? 3,
    retry_count: overrides.retry_count ?? 0,
    timeout_seconds: overrides.timeout_seconds ?? 300,
    status: overrides.status ?? 'pending',
    worker_id: overrides.worker_id ?? null,
    tags: overrides.tags ?? ['test'],
    metadata: overrides.metadata ?? {},
    idempotency_key: overrides.idempotency_key ?? null,
    scheduled_at: overrides.scheduled_at ?? null,
    error_code: overrides.error_code ?? null,
    error_details: overrides.error_details ?? null,
    last_heartbeat: overrides.last_heartbeat ?? null,
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
  };
}

/**
 * Insert one or more jobs directly into the database. Returns the inserted rows.
 */
export async function insertTestJobs(
  supabase: SupabaseClient,
  jobs: TestJobOverrides | TestJobOverrides[],
): Promise<Array<Record<string, unknown>>> {
  const rows = (Array.isArray(jobs) ? jobs : [jobs]).map(buildJobRow);

  const { data, error } = await supabase
    .from('gh_automation_jobs')
    .insert(rows)
    .select();

  if (error) throw new Error(`insertTestJobs failed: ${error.message}`);
  return data as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Database cleanup
// ---------------------------------------------------------------------------

/**
 * Delete all test data from GhostHands tables.
 * Calls are ordered to respect FK constraints.
 */
export async function cleanupTestData(supabase: SupabaseClient): Promise<void> {
  // Delete events first (FK to jobs)
  await supabase.from('gh_job_events').delete().in('job_id', await testJobIds(supabase));

  // Delete jobs created by test harness
  await supabase.from('gh_automation_jobs').delete().eq('created_by', 'test');

  // Delete usage rows for test users
  await supabase
    .from('gh_user_usage')
    .delete()
    .in('user_id', [TEST_USER_ID, TEST_USER_ID_2]);
}

async function testJobIds(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase
    .from('gh_automation_jobs')
    .select('id')
    .eq('created_by', 'test');
  return (data ?? []).map((r: { id: string }) => r.id);
}

/**
 * Ensure the test user's profile row exists (used by CostControlService to resolve tier).
 */
export async function ensureTestProfile(
  supabase: SupabaseClient,
  userId: string = TEST_USER_ID,
  tier: string = 'starter',
): Promise<void> {
  await supabase.from('profiles').upsert(
    { id: userId, subscription_tier: tier },
    { onConflict: 'id' },
  );
}

/**
 * Ensure the test user has a usage row for the current billing period.
 */
export async function ensureTestUsage(
  supabase: SupabaseClient,
  userId: string = TEST_USER_ID,
  overrides: {
    tier?: string;
    total_cost_usd?: number;
    job_count?: number;
  } = {},
): Promise<void> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  await supabase.from('gh_user_usage').upsert(
    {
      user_id: userId,
      tier: overrides.tier ?? 'starter',
      period_start: periodStart,
      period_end: periodEnd,
      total_cost_usd: overrides.total_cost_usd ?? 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      job_count: overrides.job_count ?? 0,
    },
    { onConflict: 'user_id,period_start' },
  );
}

// ---------------------------------------------------------------------------
// Mock VALET client
// ---------------------------------------------------------------------------

/**
 * A lightweight wrapper that calls the GhostHands API (or DB directly) as
 * VALET would. Uses service-role key for auth.
 */
export class MockValetClient {
  constructor(private supabase: SupabaseClient) {}

  async createJob(overrides: TestJobOverrides = {}): Promise<Record<string, unknown>> {
    const [job] = await insertTestJobs(this.supabase, overrides);
    return job;
  }

  async getJob(jobId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();
    if (error) return null;
    return data as Record<string, unknown>;
  }

  async getJobStatus(jobId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('gh_automation_jobs')
      .select('status')
      .eq('id', jobId)
      .single();
    return data?.status ?? null;
  }

  async getJobEvents(jobId: string): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.supabase
      .from('gh_job_events')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.supabase
      .from('gh_automation_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ['pending', 'queued', 'running', 'paused']);
  }

  async getUserUsage(userId: string): Promise<Record<string, unknown> | null> {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { data } = await this.supabase
      .from('gh_user_usage')
      .select('*')
      .eq('user_id', userId)
      .eq('period_start', periodStart)
      .single();
    return data as Record<string, unknown> | null;
  }
}

// ---------------------------------------------------------------------------
// Mock browser agent
// ---------------------------------------------------------------------------

export interface MockAgentBehavior {
  /** Number of actions the agent will fire before completing */
  actionCount?: number;
  /** Total tokens to report (split evenly across actions) */
  totalTokens?: number;
  /** Per-token cost rate */
  costPerToken?: number;
  /** If set, the agent throws this error after the given action index */
  failAtAction?: number;
  failWithError?: Error;
  /** The extracted result to return */
  extractResult?: Record<string, unknown>;
  /** Delay in ms per action (simulates work) */
  actionDelayMs?: number;
}

/**
 * Creates a mock BrowserAgent-like object that emits events
 * in the same pattern as the real magnitude-core BrowserAgent.
 */
export function createMockAgent(behavior: MockAgentBehavior = {}) {
  const {
    actionCount = 5,
    totalTokens = 1000,
    costPerToken = 0.000001,
    failAtAction,
    failWithError,
    extractResult = { submitted: true, success_message: 'Test application submitted' },
    actionDelayMs = 1,
  } = behavior;

  const listeners: Record<string, Array<(...args: any[]) => void>> = {};

  const events = {
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    emit(event: string, ...args: any[]) {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
  };

  const tokensPerAction = Math.floor(totalTokens / Math.max(actionCount, 1));
  const costPerAction = tokensPerAction * costPerToken;

  return {
    events,
    page: {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    },
    registerCredentials: vi.fn(),

    act: vi.fn(async () => {
      for (let i = 0; i < actionCount; i++) {
        // Check if we should fail at this action
        if (failAtAction !== undefined && i === failAtAction) {
          throw failWithError ?? new Error('Mock agent failure');
        }

        events.emit('actionStarted', { variant: `action_${i}` });
        await new Promise((r) => setTimeout(r, actionDelayMs));

        events.emit('tokensUsed', {
          inputTokens: tokensPerAction,
          outputTokens: tokensPerAction,
          inputCost: costPerAction,
          outputCost: costPerAction,
        });

        events.emit('actionDone', { variant: `action_${i}` });
      }
    }),

    extract: vi.fn().mockResolvedValue(extractResult),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test worker runner
// ---------------------------------------------------------------------------

/**
 * Simulates the worker-side flow: picks up a pending job and runs
 * a mock execution through the JobExecutor path, using direct DB
 * operations to simulate what `gh_pickup_next_job` RPC would do.
 */
export async function simulateWorkerPickup(
  supabase: SupabaseClient,
  workerId: string = TEST_WORKER_ID,
): Promise<string | null> {
  // Simulate FOR UPDATE SKIP LOCKED by selecting the oldest pending job
  // and atomically claiming it. In the real system this is an RPC call.
  const { data: jobs } = await supabase
    .from('gh_automation_jobs')
    .select('id')
    .eq('status', 'pending')
    .is('worker_id', null)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1);

  if (!jobs || jobs.length === 0) return null;

  const jobId = jobs[0].id;

  const { error } = await supabase
    .from('gh_automation_jobs')
    .update({
      status: 'queued',
      worker_id: workerId,
      last_heartbeat: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', 'pending');

  if (error) return null;
  return jobId;
}

/**
 * Simulates a full job execution cycle:
 * pending -> queued -> running -> completed/failed
 */
export async function simulateJobExecution(
  supabase: SupabaseClient,
  jobId: string,
  outcome: 'completed' | 'failed' = 'completed',
  details: {
    error_code?: string;
    error_details?: Record<string, unknown>;
    result_data?: Record<string, unknown>;
    result_summary?: string;
    action_count?: number;
    total_tokens?: number;
    llm_cost_cents?: number;
    screenshot_urls?: string[];
  } = {},
): Promise<void> {
  // Transition to running
  await supabase
    .from('gh_automation_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    })
    .eq('id', jobId);

  // Log start event
  await supabase.from('gh_job_events').insert({
    job_id: jobId,
    event_type: 'job_started',
    metadata: { simulated: true },
    actor: TEST_WORKER_ID,
  });

  // Small delay to simulate work
  await new Promise((r) => setTimeout(r, 10));

  if (outcome === 'completed') {
    await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result_data: details.result_data ?? { submitted: true },
        result_summary: details.result_summary ?? 'Test completed',
        action_count: details.action_count ?? 5,
        total_tokens: details.total_tokens ?? 1000,
        llm_cost_cents: details.llm_cost_cents ?? 1,
        screenshot_urls: details.screenshot_urls ?? [],
      })
      .eq('id', jobId);

    await supabase.from('gh_job_events').insert({
      job_id: jobId,
      event_type: 'job_completed',
      metadata: { simulated: true },
      actor: TEST_WORKER_ID,
    });
  } else {
    await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_code: details.error_code ?? 'internal_error',
        error_details: details.error_details ?? { message: 'Simulated failure' },
        action_count: details.action_count ?? 2,
        total_tokens: details.total_tokens ?? 500,
        llm_cost_cents: details.llm_cost_cents ?? 0,
      })
      .eq('id', jobId);

    await supabase.from('gh_job_events').insert({
      job_id: jobId,
      event_type: 'job_failed',
      metadata: {
        simulated: true,
        error_code: details.error_code ?? 'internal_error',
      },
      actor: TEST_WORKER_ID,
    });
  }
}

// ---------------------------------------------------------------------------
// Utility: wait for a condition (polling)
// ---------------------------------------------------------------------------

export async function waitFor(
  fn: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 100 } = opts;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Wait until a job reaches one of the given statuses.
 */
export async function waitForJobStatus(
  supabase: SupabaseClient,
  jobId: string,
  statuses: string[],
  timeoutMs: number = 10_000,
): Promise<string> {
  let lastStatus = '';

  await waitFor(
    async () => {
      const { data } = await supabase
        .from('gh_automation_jobs')
        .select('status')
        .eq('id', jobId)
        .single();
      lastStatus = data?.status ?? '';
      return statuses.includes(lastStatus);
    },
    { timeoutMs },
  );

  return lastStatus;
}
