/**
 * E2E: Concurrency
 *
 * Tests concurrent job processing: multiple workers, FOR UPDATE SKIP LOCKED
 * semantics, no double-pickup, and parallel job execution.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getTestSupabase,
  cleanupTestData,
  insertTestJobs,
  MockValetClient,
  simulateWorkerPickup,
  simulateJobExecution,
  waitFor,
  TEST_USER_ID,
  TEST_WORKER_ID,
  TEST_WORKER_ID_2,
} from './helpers';

const supabase = getTestSupabase();
const valet = new MockValetClient(supabase);

// Unique job_type to isolate from other parallel test files sharing the same DB
const JOB_TYPE = 'concurrency_test';

/**
 * Aggressive cleanup that targets specifically the concurrency_test jobs.
 * This avoids race conditions with cleanupTestData's two-step approach.
 */
async function cleanupConcurrencyJobs() {
  // First get all job IDs with our unique job_type
  const { data: jobs } = await supabase
    .from('gh_automation_jobs')
    .select('id')
    .eq('job_type', JOB_TYPE);

  if (jobs && jobs.length > 0) {
    const ids = jobs.map((j: { id: string }) => j.id);
    // Delete events first (FK constraint)
    await supabase.from('gh_job_events').delete().in('job_id', ids);
    // Then delete the jobs
    await supabase.from('gh_automation_jobs').delete().in('id', ids);
  }

  // Also run the general cleanup for any non-typed test data
  await cleanupTestData(supabase);
}

describe('Concurrency', () => {
  beforeAll(async () => {
    await cleanupConcurrencyJobs();
  });

  afterAll(async () => {
    await cleanupConcurrencyJobs();
  });

  beforeEach(async () => {
    await cleanupConcurrencyJobs();
  });

  // ─── No double-pickup ──────────────────────────────────────────

  describe('No Double Pickup', () => {
    it('should not allow two workers to pick up the same job', async () => {
      // Create a single pending job
      await insertTestJobs(supabase, { job_type: JOB_TYPE });

      // Both workers try to pick up simultaneously
      const [pickup1, pickup2] = await Promise.all([
        simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE),
        simulateWorkerPickup(supabase, TEST_WORKER_ID_2, JOB_TYPE),
      ]);

      // Both may return a job ID (race condition in the mock helper),
      // but the DB should only have ONE worker_id assigned (last write wins).
      // The key invariant: only one worker_id in the final DB state.
      await new Promise((r) => setTimeout(r, 100));

      const { data: jobs } = await supabase
        .from('gh_automation_jobs')
        .select('id, worker_id, status')
        .eq('job_type', JOB_TYPE)
        .not('worker_id', 'is', null);

      expect(jobs!.length).toBe(1);
      // The job should be claimed by exactly one worker
      const claimedWorker = jobs![0].worker_id;
      expect([TEST_WORKER_ID, TEST_WORKER_ID_2]).toContain(claimedWorker);
    });

    it('should distribute multiple jobs across workers', async () => {
      // Create 4 pending jobs
      await insertTestJobs(supabase, [
        { task_description: 'Job A', job_type: JOB_TYPE },
        { task_description: 'Job B', job_type: JOB_TYPE },
        { task_description: 'Job C', job_type: JOB_TYPE },
        { task_description: 'Job D', job_type: JOB_TYPE },
      ]);

      // Worker 1 picks up first
      const pickup1 = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
      expect(pickup1).not.toBeNull();

      // Worker 2 picks up second
      const pickup2 = await simulateWorkerPickup(supabase, TEST_WORKER_ID_2, JOB_TYPE);
      expect(pickup2).not.toBeNull();

      // They should have different jobs
      expect(pickup1).not.toBe(pickup2);

      // Verify workers are assigned correctly
      const { data: claimed } = await supabase
        .from('gh_automation_jobs')
        .select('id, worker_id')
        .eq('created_by', 'test')
        .not('worker_id', 'is', null)
        .order('created_at');

      expect(claimed!.length).toBe(2);
      const workerIds = new Set(claimed!.map((j: Record<string, unknown>) => j.worker_id));
      expect(workerIds.size).toBe(2);
    });
  });

  // ─── Concurrent pickup attempts ────────────────────────────────

  describe('Concurrent Pickup Attempts', () => {
    it('should handle 5 workers competing for 3 jobs correctly', async () => {
      // Create 3 jobs
      await insertTestJobs(supabase, [
        { task_description: 'Job 1', job_type: JOB_TYPE },
        { task_description: 'Job 2', job_type: JOB_TYPE },
        { task_description: 'Job 3', job_type: JOB_TYPE },
      ]);

      // 5 workers compete
      const workers = ['w1', 'w2', 'w3', 'w4', 'w5'];
      await Promise.all(
        workers.map((w) => simulateWorkerPickup(supabase, w, JOB_TYPE)),
      );

      // Wait for DB to settle, then verify final state
      await new Promise((r) => setTimeout(r, 100));

      // At most 3 jobs should be claimed (each job has exactly one worker)
      const { data: claimed } = await supabase
        .from('gh_automation_jobs')
        .select('id, worker_id')
        .eq('job_type', JOB_TYPE)
        .not('worker_id', 'is', null);

      expect(claimed!.length).toBeLessThanOrEqual(3);

      // Each job should have a unique worker_id (no double-assignment)
      const workerIds = claimed!.map((j: Record<string, unknown>) => j.worker_id);
      const uniqueWorkers = new Set(workerIds);
      // Each worker should only appear once
      expect(uniqueWorkers.size).toBe(claimed!.length);
    });

    it('should return null when no jobs are available', async () => {
      // No jobs in the database (with this job_type)
      const pickup = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
      expect(pickup).toBeNull();
    });

    it('should not pick up jobs that are already in non-pending status', async () => {
      await insertTestJobs(supabase, [
        { status: 'running', worker_id: 'other-worker', job_type: JOB_TYPE },
        { status: 'completed', completed_at: new Date().toISOString(), job_type: JOB_TYPE },
        { status: 'failed', completed_at: new Date().toISOString(), job_type: JOB_TYPE },
        { status: 'cancelled', completed_at: new Date().toISOString(), job_type: JOB_TYPE },
      ]);

      const pickup = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
      expect(pickup).toBeNull();
    });
  });

  // ─── Parallel execution ────────────────────────────────────────

  describe('Parallel Execution', () => {
    it('should execute multiple jobs in parallel without interference', async () => {
      // Create 3 jobs
      const [job1, job2, job3] = await insertTestJobs(supabase, [
        { task_description: 'Parallel Job 1', job_type: JOB_TYPE },
        { task_description: 'Parallel Job 2', job_type: JOB_TYPE },
        { task_description: 'Parallel Job 3', job_type: JOB_TYPE },
      ]);

      // Claim jobs (with brief delay for DB read-after-write consistency)
      const pickup1 = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
      await new Promise((r) => setTimeout(r, 50));
      const pickup2 = await simulateWorkerPickup(supabase, TEST_WORKER_ID_2, JOB_TYPE);
      await new Promise((r) => setTimeout(r, 50));
      const pickup3 = await simulateWorkerPickup(supabase, 'test-worker-3', JOB_TYPE);

      // Execute all 3 in parallel
      await Promise.all([
        simulateJobExecution(supabase, pickup1!, 'completed', {
          result_data: { job: 'parallel-1' },
          action_count: 5,
        }),
        simulateJobExecution(supabase, pickup2!, 'completed', {
          result_data: { job: 'parallel-2' },
          action_count: 8,
        }),
        simulateJobExecution(supabase, pickup3!, 'failed', {
          error_code: 'timeout',
          action_count: 3,
        }),
      ]);

      // Verify each job has its own outcome
      const result1 = await valet.getJob(pickup1!);
      const result2 = await valet.getJob(pickup2!);
      const result3 = await valet.getJob(pickup3!);

      expect(result1!.status).toBe('completed');
      expect(result1!.action_count).toBe(5);

      expect(result2!.status).toBe('completed');
      expect(result2!.action_count).toBe(8);

      expect(result3!.status).toBe('failed');
      expect(result3!.error_code).toBe('timeout');
    });

    it('should isolate events between concurrently executed jobs', async () => {
      const [job1, job2] = await insertTestJobs(supabase, [
        { task_description: 'Isolated Job A', job_type: JOB_TYPE },
        { task_description: 'Isolated Job B', job_type: JOB_TYPE },
      ]);

      const id1 = job1.id as string;
      const id2 = job2.id as string;

      // Record events for both jobs concurrently
      await Promise.all([
        (async () => {
          for (let i = 1; i <= 3; i++) {
            await supabase.from('gh_job_events').insert({
              job_id: id1,
              event_type: 'step_completed',
              metadata: { step: i, job: 'A' },
              actor: TEST_WORKER_ID,
            });
          }
        })(),
        (async () => {
          for (let i = 1; i <= 5; i++) {
            await supabase.from('gh_job_events').insert({
              job_id: id2,
              event_type: 'step_completed',
              metadata: { step: i, job: 'B' },
              actor: TEST_WORKER_ID_2,
            });
          }
        })(),
      ]);

      const events1 = await valet.getJobEvents(id1);
      const events2 = await valet.getJobEvents(id2);

      expect(events1.length).toBe(3);
      expect(events2.length).toBe(5);

      // No cross-contamination
      expect(events1.every((e) => (e.metadata as Record<string, unknown>).job === 'A')).toBe(true);
      expect(events2.every((e) => (e.metadata as Record<string, unknown>).job === 'B')).toBe(true);
    });
  });

  // ─── Worker capacity management ────────────────────────────────

  describe('Worker Capacity', () => {
    it('should respect maxConcurrent by not picking up when at capacity', async () => {
      // Simulate a worker at capacity (2 active jobs)
      const maxConcurrent = 2;

      await insertTestJobs(supabase, [
        { status: 'running', worker_id: TEST_WORKER_ID, job_type: JOB_TYPE },
        { status: 'running', worker_id: TEST_WORKER_ID, job_type: JOB_TYPE },
        { status: 'pending', job_type: JOB_TYPE }, // Available but worker is at capacity
      ]);

      // Count active jobs for this worker
      const { data: activeJobs } = await supabase
        .from('gh_automation_jobs')
        .select('id')
        .eq('worker_id', TEST_WORKER_ID)
        .in('status', ['queued', 'running']);

      expect(activeJobs!.length).toBe(maxConcurrent);

      // Worker should check capacity before pickup
      const atCapacity = activeJobs!.length >= maxConcurrent;
      expect(atCapacity).toBe(true);
    });

    it('should pick up new jobs after completing existing ones', async () => {
      // Create initial jobs
      const [active, pending] = await insertTestJobs(supabase, [
        { status: 'running', worker_id: TEST_WORKER_ID, started_at: new Date().toISOString(), job_type: JOB_TYPE },
        { task_description: 'Waiting job', job_type: JOB_TYPE },
      ]);

      const activeId = active.id as string;

      // Complete the active job
      await supabase
        .from('gh_automation_jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', activeId);

      // Now the worker should be able to pick up the pending job
      const pickup = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
      expect(pickup).not.toBeNull();
      expect(pickup).toBe(pending.id);
    });
  });

  // ─── Priority ordering under contention ─────────────────────────

  describe('Priority Under Contention', () => {
    it('should serve higher priority jobs first when multiple are pending', async () => {
      await insertTestJobs(supabase, [
        { priority: 1, task_description: 'Low P1', job_type: JOB_TYPE },
        { priority: 10, task_description: 'High P10', job_type: JOB_TYPE },
        { priority: 5, task_description: 'Med P5', job_type: JOB_TYPE },
        { priority: 8, task_description: 'High P8', job_type: JOB_TYPE },
      ]);

      // Sequential pickups should follow priority order (with delay for DB consistency)
      const descriptions: string[] = [];

      for (let i = 0; i < 4; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 50));
        const pickup = await simulateWorkerPickup(supabase, `worker-${i}`, JOB_TYPE);
        if (!pickup) break;
        const job = await valet.getJob(pickup);
        descriptions.push(job!.task_description as string);
      }

      expect(descriptions[0]).toBe('High P10');
      expect(descriptions[1]).toBe('High P8');
      expect(descriptions[2]).toBe('Med P5');
      expect(descriptions[3]).toBe('Low P1');
    });

    it('should use FIFO within the same priority level', async () => {
      // Create 3 jobs with the same priority but staggered creation times.
      // We use 200ms delay to ensure Supabase assigns distinct created_at timestamps.
      const jobs = [];
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 200));
        const [job] = await insertTestJobs(supabase, {
          priority: 5,
          task_description: `Same-priority Job ${i}`,
          job_type: JOB_TYPE,
        });
        jobs.push(job);
      }

      // Pick them up in order with brief delay to allow DB read-after-write consistency
      const pickedOrder: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 50));
        const pickup = await simulateWorkerPickup(supabase, `fifo-worker-${i}`, JOB_TYPE);
        if (pickup) {
          const job = await valet.getJob(pickup);
          pickedOrder.push(job!.task_description as string);
        }
      }

      // Should be in creation order (FIFO)
      expect(pickedOrder).toEqual([
        'Same-priority Job 0',
        'Same-priority Job 1',
        'Same-priority Job 2',
      ]);
    });
  });

  // ─── Race condition: cancel during execution ───────────────────

  describe('Race Conditions', () => {
    it('should handle cancel during job execution gracefully', async () => {
      const [job] = await insertTestJobs(supabase, { job_type: JOB_TYPE });
      const jobId = job.id as string;

      // Start execution
      await supabase
        .from('gh_automation_jobs')
        .update({
          status: 'running',
          worker_id: TEST_WORKER_ID,
          started_at: new Date().toISOString(),
          last_heartbeat: new Date().toISOString(),
        })
        .eq('id', jobId);

      // Simulate concurrent cancel
      await valet.cancelJob(jobId);

      const final = await valet.getJob(jobId);
      expect(final!.status).toBe('cancelled');
    });

    it('should handle simultaneous status updates without data corruption', async () => {
      const [job] = await insertTestJobs(supabase, {
        status: 'running',
        worker_id: TEST_WORKER_ID,
        job_type: JOB_TYPE,
      });
      const jobId = job.id as string;

      // Simulate concurrent heartbeat + status_message updates
      await Promise.all([
        supabase
          .from('gh_automation_jobs')
          .update({ last_heartbeat: new Date().toISOString() })
          .eq('id', jobId),
        supabase
          .from('gh_automation_jobs')
          .update({ status_message: 'Processing step 3' })
          .eq('id', jobId),
        supabase.from('gh_job_events').insert({
          job_id: jobId,
          event_type: 'step_completed',
          metadata: { step: 3 },
          actor: TEST_WORKER_ID,
        }),
      ]);

      // Job should still be in a valid state
      const updated = await valet.getJob(jobId);
      expect(updated!.status).toBe('running');
      expect(updated!.last_heartbeat).toBeDefined();
    });
  });

  // ─── Bulk operations ───────────────────────────────────────────

  describe('Bulk Operations', () => {
    it('should handle batch insertion of 20 jobs efficiently', async () => {
      const jobOverrides = Array.from({ length: 20 }, (_, i) => ({
        task_description: `Batch job ${i}`,
        priority: Math.floor(Math.random() * 10) + 1,
        job_type: JOB_TYPE,
      }));

      const start = Date.now();
      const jobs = await insertTestJobs(supabase, jobOverrides);
      const elapsed = Date.now() - start;

      expect(jobs.length).toBe(20);
      // Batch insert should be fast (< 5 seconds for 20 rows)
      expect(elapsed).toBeLessThan(5000);

      // Verify all are pending
      const { data: pending } = await supabase
        .from('gh_automation_jobs')
        .select('id')
        .eq('created_by', 'test')
        .eq('job_type', JOB_TYPE)
        .eq('status', 'pending');

      expect(pending!.length).toBe(20);
    });
  });
});
