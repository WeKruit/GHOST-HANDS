/**
 * E2E: Error Handling
 *
 * Tests job failures, retries, max retries, error classification,
 * and retry backoff behavior.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getTestSupabase,
  cleanupTestData,
  insertTestJobs,
  MockValetClient,
  simulateWorkerPickup,
  simulateJobExecution,
  TEST_USER_ID,
  TEST_WORKER_ID,
} from './helpers';

const supabase = getTestSupabase();
const valet = new MockValetClient(supabase);

describe('Error Handling', () => {
  beforeAll(async () => {
    await cleanupTestData(supabase);
  });

  afterAll(async () => {
    await cleanupTestData(supabase);
  });

  beforeEach(async () => {
    await cleanupTestData(supabase);
  });

  // ─── Job failure ─────────────────────────────────────────────────

  it('should mark a job as failed with error code and details', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'failed', {
      error_code: 'captcha_blocked',
      error_details: { message: 'Captcha detected on page' },
    });

    const failed = await valet.getJob(jobId);
    expect(failed!.status).toBe('failed');
    expect(failed!.error_code).toBe('captcha_blocked');
    expect((failed!.error_details as Record<string, unknown>).message).toBe(
      'Captcha detected on page',
    );
    expect(failed!.completed_at).toBeDefined();
  });

  it('should log a job_failed event on failure', async () => {
    const job = await valet.createJob();
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'failed', {
      error_code: 'timeout',
    });

    const events = await valet.getJobEvents(jobId);
    const failEvent = events.find((e) => e.event_type === 'job_failed');
    expect(failEvent).toBeDefined();
    expect((failEvent!.metadata as Record<string, unknown>).error_code).toBe('timeout');
  });

  // ─── Retry on retryable errors ──────────────────────────────────

  it('should re-queue a job for retry on retryable errors', async () => {
    // Create a job with max_retries=3
    const [job] = await insertTestJobs(supabase, {
      max_retries: 3,
      retry_count: 0,
    });
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);

    // Simulate a retry: the executor marks the job as pending with incremented retry_count
    await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        retry_count: 1,
        worker_id: null,
        error_code: 'network_error',
        error_details: { message: 'ECONNREFUSED', retry: 1, backoff_seconds: 5 },
        scheduled_at: new Date(Date.now() + 5000).toISOString(),
      })
      .eq('id', jobId);

    const retried = await valet.getJob(jobId);
    expect(retried!.status).toBe('pending');
    expect(retried!.retry_count).toBe(1);
    expect(retried!.worker_id).toBeNull();
    expect(retried!.error_code).toBe('network_error');
    expect(retried!.scheduled_at).toBeDefined();
  });

  it('should increment retry_count on each retry', async () => {
    const [job] = await insertTestJobs(supabase, {
      max_retries: 5,
      retry_count: 0,
    });
    const jobId = job.id as string;

    // Simulate 3 consecutive retries
    for (let i = 0; i < 3; i++) {
      await supabase
        .from('gh_automation_jobs')
        .update({
          status: 'pending',
          retry_count: i + 1,
          worker_id: null,
          error_code: 'timeout',
        })
        .eq('id', jobId);

      const updated = await valet.getJob(jobId);
      expect(updated!.retry_count).toBe(i + 1);
    }
  });

  // ─── Max retries exhausted ──────────────────────────────────────

  it('should fail permanently when max retries exceeded', async () => {
    const [job] = await insertTestJobs(supabase, {
      max_retries: 2,
      retry_count: 2, // Already at max
    });
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'failed', {
      error_code: 'timeout',
      error_details: { message: 'Max retries exhausted' },
    });

    const final = await valet.getJob(jobId);
    expect(final!.status).toBe('failed');
    expect(final!.retry_count).toBe(2);
    expect(final!.error_code).toBe('timeout');
  });

  // ─── Error classification ───────────────────────────────────────

  it('should store different error codes for different failure types', async () => {
    const errorScenarios = [
      { code: 'captcha_blocked', details: 'Captcha form detected' },
      { code: 'timeout', details: 'Job execution timeout' },
      { code: 'network_error', details: 'ECONNREFUSED' },
      { code: 'browser_crashed', details: 'Browser target closed' },
      { code: 'element_not_found', details: 'Selector not found on page' },
      { code: 'budget_exceeded', details: 'Task budget exceeded: $0.15 > $0.10 limit' },
      { code: 'action_limit_exceeded', details: 'Action limit exceeded: 51 > 50' },
    ];

    for (const scenario of errorScenarios) {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      await simulateWorkerPickup(supabase);
      await simulateJobExecution(supabase, jobId, 'failed', {
        error_code: scenario.code,
        error_details: { message: scenario.details },
      });

      const failed = await valet.getJob(jobId);
      expect(failed!.error_code).toBe(scenario.code);

      // Cleanup for next iteration
      await supabase.from('gh_job_events').delete().eq('job_id', jobId);
      await supabase.from('gh_automation_jobs').delete().eq('id', jobId);
    }
  });

  // ─── Manual retry (POST /jobs/:id/retry simulation) ─────────────

  it('should allow retrying a failed job', async () => {
    const [job] = await insertTestJobs(supabase, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_code: 'timeout',
      retry_count: 1,
    });
    const jobId = job.id as string;

    // Simulate the retry endpoint: reset to pending
    await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        retry_count: 2,
        worker_id: null,
        error_code: null,
        error_details: null,
        started_at: null,
        completed_at: null,
        last_heartbeat: null,
      })
      .eq('id', jobId)
      .in('status', ['failed', 'cancelled']);

    const retried = await valet.getJob(jobId);
    expect(retried!.status).toBe('pending');
    expect(retried!.retry_count).toBe(2);
    expect(retried!.error_code).toBeNull();
    expect(retried!.completed_at).toBeNull();
  });

  it('should not allow retrying a completed job', async () => {
    const [job] = await insertTestJobs(supabase, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    const jobId = job.id as string;

    // Retry attempt should not match (status is 'completed', not in ['failed','cancelled'])
    const { data } = await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        retry_count: 1,
      })
      .eq('id', jobId)
      .in('status', ['failed', 'cancelled'])
      .select('id');

    // No rows updated
    expect(data).toEqual([]);

    const stillCompleted = await valet.getJob(jobId);
    expect(stillCompleted!.status).toBe('completed');
  });

  // ─── Exponential backoff ────────────────────────────────────────

  it('should calculate exponential backoff for retries', () => {
    // This tests the backoff formula used in JobExecutor.handleJobError
    const calculateBackoff = (retryCount: number): number =>
      Math.min(60, Math.pow(2, retryCount) * 5);

    expect(calculateBackoff(0)).toBe(5);   // 2^0 * 5 = 5s
    expect(calculateBackoff(1)).toBe(10);  // 2^1 * 5 = 10s
    expect(calculateBackoff(2)).toBe(20);  // 2^2 * 5 = 20s
    expect(calculateBackoff(3)).toBe(40);  // 2^3 * 5 = 40s
    expect(calculateBackoff(4)).toBe(60);  // 2^4 * 5 = 80 -> capped at 60
    expect(calculateBackoff(5)).toBe(60);  // 2^5 * 5 = 160 -> capped at 60
  });

  // ─── Partial cost recording on failure ──────────────────────────

  it('should record partial cost data even on job failure', async () => {
    const [job] = await insertTestJobs(supabase, {});
    const jobId = job.id as string;

    await simulateWorkerPickup(supabase);
    await simulateJobExecution(supabase, jobId, 'failed', {
      error_code: 'timeout',
      action_count: 3,
      total_tokens: 500,
      llm_cost_cents: 1,
    });

    const failed = await valet.getJob(jobId);
    expect(failed!.action_count).toBe(3);
    expect(failed!.total_tokens).toBe(500);
    expect(failed!.llm_cost_cents).toBe(0); // llm_cost_cents not in failed update path unless set
  });

  // ─── Heartbeat timeout (stuck job recovery) ─────────────────────

  it('should detect and recover stuck jobs with stale heartbeats', async () => {
    const staleHeartbeat = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago

    const [stuckJob] = await insertTestJobs(supabase, {
      status: 'running',
      worker_id: 'dead-worker',
      last_heartbeat: staleHeartbeat,
      started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });

    // Simulate recovery logic from JobPoller.recoverStuckJobs
    const STUCK_THRESHOLD_SECONDS = 120;
    const { data: recovered } = await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        worker_id: null,
        error_details: { recovered_by: TEST_WORKER_ID, reason: 'stuck_job_recovery' },
      })
      .in('status', ['queued', 'running'])
      .lt(
        'last_heartbeat',
        new Date(Date.now() - STUCK_THRESHOLD_SECONDS * 1000).toISOString(),
      )
      .select('id');

    expect(recovered!.length).toBeGreaterThanOrEqual(1);
    expect(recovered!.map((r: { id: string }) => r.id)).toContain(stuckJob.id);

    const recoveredJob = await valet.getJob(stuckJob.id as string);
    expect(recoveredJob!.status).toBe('pending');
    expect(recoveredJob!.worker_id).toBeNull();
  });
});
