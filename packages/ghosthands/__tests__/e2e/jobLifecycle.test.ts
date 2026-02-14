/**
 * E2E: Happy-path job lifecycle
 *
 * Tests the full flow: create -> pickup -> execute -> complete
 * using direct Supabase operations to simulate the real system.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getTestSupabase,
  cleanupTestData,
  insertTestJobs,
  MockValetClient,
  simulateWorkerPickup,
  simulateJobExecution,
  waitForJobStatus,
  TEST_USER_ID,
  TEST_WORKER_ID,
} from './helpers';

const supabase = getTestSupabase();
const valet = new MockValetClient(supabase);

describe('Job Lifecycle (Happy Path)', () => {
  beforeAll(async () => {
    await cleanupTestData(supabase);
  });

  afterAll(async () => {
    await cleanupTestData(supabase);
  });

  beforeEach(async () => {
    await cleanupTestData(supabase);
  });

  // ─── Create ──────────────────────────────────────────────────────

  it('should create a job in pending status', async () => {
    const job = await valet.createJob({
      target_url: 'https://boards.greenhouse.io/testco/jobs/111',
      task_description: 'Apply to engineer role',
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.user_id).toBe(TEST_USER_ID);
    expect(job.job_type).toBe('apply');
    expect(job.worker_id).toBeNull();
    expect(job.retry_count).toBe(0);
  });

  it('should store input_data and metadata correctly', async () => {
    const inputData = {
      user_data: { first_name: 'Jane', last_name: 'Doe', email: 'jane@test.com' },
      tier: 'pro',
      platform: 'greenhouse',
      qa_overrides: { 'Are you authorized to work?': 'Yes' },
    };
    const metadata = { source: 'valet', campaign: 'test-run-1' };

    const job = await valet.createJob({
      input_data: inputData,
      metadata,
    });

    const fetched = await valet.getJob(job.id as string);
    expect(fetched).not.toBeNull();
    expect((fetched!.input_data as Record<string, unknown>).tier).toBe('pro');
    expect((fetched!.input_data as Record<string, unknown>).qa_overrides).toEqual({
      'Are you authorized to work?': 'Yes',
    });
    expect((fetched!.metadata as Record<string, unknown>).source).toBe('valet');
  });

  it('should respect idempotency keys (no duplicate creation)', async () => {
    const key = `idem-${Date.now()}`;

    const job1 = await valet.createJob({ idempotency_key: key });
    expect(job1.id).toBeDefined();

    // Attempting to insert the same idempotency_key should fail at DB level
    // (unique constraint). In the real API this returns 409.
    await expect(
      insertTestJobs(supabase, { idempotency_key: key }),
    ).rejects.toThrow();
  });

  // ─── Pickup ──────────────────────────────────────────────────────

  it('should pick up a pending job and claim it', async () => {
    await valet.createJob();

    const pickedUpId = await simulateWorkerPickup(supabase);
    expect(pickedUpId).toBeDefined();

    const job = await valet.getJob(pickedUpId!);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('queued');
    expect(job!.worker_id).toBe(TEST_WORKER_ID);
    expect(job!.last_heartbeat).toBeDefined();
  });

  it('should pick jobs in priority order (highest first)', async () => {
    await insertTestJobs(supabase, [
      { priority: 1, task_description: 'Low priority' },
      { priority: 10, task_description: 'High priority' },
      { priority: 5, task_description: 'Medium priority' },
    ]);

    const firstPickup = await simulateWorkerPickup(supabase);
    const firstJob = await valet.getJob(firstPickup!);
    expect(firstJob!.task_description).toBe('High priority');
  });

  it('should not pick up jobs that are already claimed', async () => {
    await insertTestJobs(supabase, {
      status: 'queued',
      worker_id: 'other-worker',
    });
    await insertTestJobs(supabase, {
      status: 'running',
      worker_id: 'other-worker',
    });

    // No unclaimed pending jobs
    const pickup = await simulateWorkerPickup(supabase);
    expect(pickup).toBeNull();
  });

  // ─── Execute ─────────────────────────────────────────────────────

  it('should transition through running to completed', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    // Simulate full execution
    const pickedUp = await simulateWorkerPickup(supabase);
    expect(pickedUp).toBe(jobId);

    await simulateJobExecution(supabase, jobId, 'completed', {
      result_data: { submitted: true, confirmation_id: 'ABC-123' },
      action_count: 8,
      total_tokens: 2000,
      llm_cost_cents: 5,
    });

    const completed = await valet.getJob(jobId);
    expect(completed!.status).toBe('completed');
    expect(completed!.completed_at).toBeDefined();
    expect(completed!.started_at).toBeDefined();
    expect((completed!.result_data as Record<string, unknown>).confirmation_id).toBe('ABC-123');
    expect(completed!.action_count).toBe(8);
    expect(completed!.total_tokens).toBe(2000);
    expect(completed!.llm_cost_cents).toBe(5);
  });

  it('should record job events throughout the lifecycle', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'completed');

    const events = await valet.getJobEvents(jobId);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain('job_started');
    expect(eventTypes).toContain('job_completed');
  });

  // ─── Complete ────────────────────────────────────────────────────

  it('full lifecycle: create → pickup → run → complete → verify', async () => {
    // 1. VALET creates the job
    const created = await valet.createJob({
      target_url: 'https://boards.greenhouse.io/acme/jobs/99999',
      task_description: 'Apply to Senior Engineer at Acme Corp',
      input_data: {
        user_data: { first_name: 'Alice', last_name: 'Smith', email: 'alice@test.com' },
        tier: 'pro',
      },
      tags: ['e2e', 'lifecycle'],
    });

    expect(created.status).toBe('pending');

    // 2. Worker picks up
    const pickedUpId = await simulateWorkerPickup(supabase);
    expect(pickedUpId).toBe(created.id);

    let status = await valet.getJobStatus(pickedUpId!);
    expect(status).toBe('queued');

    // 3. Worker executes
    await simulateJobExecution(supabase, pickedUpId!, 'completed', {
      result_data: { submitted: true, success_message: 'Application submitted!' },
      action_count: 12,
      total_tokens: 3500,
      llm_cost_cents: 8,
    });

    // 4. VALET verifies
    const final = await valet.getJob(pickedUpId!);
    expect(final!.status).toBe('completed');
    expect((final!.result_data as Record<string, unknown>).submitted).toBe(true);
    expect(final!.action_count).toBe(12);

    // 5. Verify event trail
    const events = await valet.getJobEvents(pickedUpId!);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Screenshots & Result Storage ─────────────────────────────────

  it('should store screenshot URLs in the completed job record', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'completed', {
      result_data: { submitted: true },
      screenshot_urls: [
        'https://storage.example.com/gh/jobs/test/final-001.png',
        'https://storage.example.com/gh/jobs/test/final-002.png',
      ],
    });

    const completed = await valet.getJob(jobId);
    expect(completed!.status).toBe('completed');
    const urls = completed!.screenshot_urls as string[];
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('final-001.png');
    expect(urls[1]).toContain('final-002.png');
  });

  it('should store result_data for VALET to retrieve (completion notification)', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'completed', {
      result_data: {
        submitted: true,
        confirmation_id: 'APP-2026-0214',
        success_message: 'Your application has been received!',
      },
      result_summary: 'Application submitted successfully',
    });

    // VALET retrieves the completed job to display to user
    const completed = await valet.getJob(jobId);
    expect(completed!.status).toBe('completed');
    expect(completed!.result_summary).toBe('Application submitted successfully');

    const resultData = completed!.result_data as Record<string, unknown>;
    expect(resultData.submitted).toBe(true);
    expect(resultData.confirmation_id).toBe('APP-2026-0214');
    expect(resultData.success_message).toContain('received');
  });

  // ─── Cancel ──────────────────────────────────────────────────────

  it('should cancel a pending job', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await valet.cancelJob(jobId);

    const cancelled = await valet.getJob(jobId);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.completed_at).toBeDefined();
  });

  it('should not cancel an already-completed job', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'completed');

    // Cancel should have no effect (the .in() filter won't match)
    await valet.cancelJob(jobId);
    const stillCompleted = await valet.getJob(jobId);
    expect(stillCompleted!.status).toBe('completed');
  });

  // ─── Tags / filtering ───────────────────────────────────────────

  it('should filter jobs by status', async () => {
    await insertTestJobs(supabase, [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'completed', completed_at: new Date().toISOString() },
      { status: 'failed', completed_at: new Date().toISOString() },
    ]);

    const { data: pending } = await supabase
      .from('gh_automation_jobs')
      .select('id')
      .eq('created_by', 'test')
      .eq('status', 'pending');

    expect(pending!.length).toBe(2);

    const { data: terminal } = await supabase
      .from('gh_automation_jobs')
      .select('id')
      .eq('created_by', 'test')
      .in('status', ['completed', 'failed']);

    expect(terminal!.length).toBe(2);
  });
});
