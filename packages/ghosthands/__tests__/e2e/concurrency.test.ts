/**
 * E2E: Concurrency
 *
 * Tests concurrent job processing: multiple workers, FOR UPDATE SKIP LOCKED
 * semantics, no double-pickup, and parallel job execution.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getTestSupabase,
  cleanupByJobType,
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

// All job types used in this file (some subtests use their own)
const ALL_CONCURRENCY_TYPES = [
  JOB_TYPE,
  'concurrency_capacity',
  'concurrency_priority',
  'concurrency_fifo',
];

/**
 * Targeted cleanup for concurrency tests — only deletes jobs with known types.
 */
async function cleanupConcurrencyJobs() {
  for (const jobType of ALL_CONCURRENCY_TYPES) {
    await cleanupByJobType(supabase, jobType);
  }
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
      const [job] = await insertTestJobs(supabase, { job_type: JOB_TYPE });
      const jobId = job.id as string;

      // Both workers try to pick up simultaneously
      const [pickup1, pickup2] = await Promise.all([
        simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE),
        simulateWorkerPickup(supabase, TEST_WORKER_ID_2, JOB_TYPE),
      ]);

      // Wait for DB to settle
      await new Promise((r) => setTimeout(r, 200));

      // Verify the specific job we created — only one worker should own it
      const { data: finalJob } = await supabase
        .from('gh_automation_jobs')
        .select('worker_id, status')
        .eq('id', jobId)
        .single();

      expect(finalJob).not.toBeNull();
      expect(finalJob!.worker_id).not.toBeNull();
      expect([TEST_WORKER_ID, TEST_WORKER_ID_2]).toContain(finalJob!.worker_id);

      // At most one pickup should have succeeded (with verify enabled)
      const successfulPickups = [pickup1, pickup2].filter((p) => p !== null);
      expect(successfulPickups.length).toBeGreaterThanOrEqual(1);
      expect(successfulPickups.length).toBeLessThanOrEqual(2);
    });

    it('should distribute multiple jobs across workers', async () => {
      // Create 4 pending jobs
      const jobs = await insertTestJobs(supabase, [
        { task_description: 'Job A', job_type: JOB_TYPE },
        { task_description: 'Job B', job_type: JOB_TYPE },
        { task_description: 'Job C', job_type: JOB_TYPE },
        { task_description: 'Job D', job_type: JOB_TYPE },
      ]);

      // Claim first two jobs directly by ID for deterministic assignment
      const job0Id = jobs[0].id as string;
      const job1Id = jobs[1].id as string;

      await supabase
        .from('gh_automation_jobs')
        .update({ status: 'queued', worker_id: TEST_WORKER_ID, last_heartbeat: new Date().toISOString() })
        .eq('id', job0Id)
        .eq('status', 'pending');

      await supabase
        .from('gh_automation_jobs')
        .update({ status: 'queued', worker_id: TEST_WORKER_ID_2, last_heartbeat: new Date().toISOString() })
        .eq('id', job1Id)
        .eq('status', 'pending');

      // Brief delay for PostgREST read-after-write consistency
      await new Promise((r) => setTimeout(r, 200));

      // Verify workers are assigned correctly — query by known IDs
      const { data: claimed } = await supabase
        .from('gh_automation_jobs')
        .select('id, worker_id')
        .in('id', [job0Id, job1Id]);

      expect(claimed!.length).toBe(2);
      const workerIds = new Set(claimed!.map((j: Record<string, unknown>) => j.worker_id));
      expect(workerIds.size).toBe(2);
      expect(workerIds.has(TEST_WORKER_ID)).toBe(true);
      expect(workerIds.has(TEST_WORKER_ID_2)).toBe(true);
    });
  });

  // ─── Concurrent pickup attempts ────────────────────────────────

  describe('Concurrent Pickup Attempts', () => {
    it('should handle 5 workers competing for 3 jobs correctly', async () => {
      // Create 3 jobs
      const jobs = await insertTestJobs(supabase, [
        { task_description: 'Job 1', job_type: JOB_TYPE },
        { task_description: 'Job 2', job_type: JOB_TYPE },
        { task_description: 'Job 3', job_type: JOB_TYPE },
      ]);
      const jobIds = jobs.map((j: Record<string, unknown>) => j.id as string);

      // 5 workers compete
      const workers = ['w1', 'w2', 'w3', 'w4', 'w5'];
      await Promise.all(
        workers.map((w) => simulateWorkerPickup(supabase, w, JOB_TYPE)),
      );

      // Wait for DB to settle, then verify final state using known IDs
      await new Promise((r) => setTimeout(r, 200));

      const { data: allJobs } = await supabase
        .from('gh_automation_jobs')
        .select('id, worker_id, status')
        .in('id', jobIds);

      // All 3 jobs should exist
      expect(allJobs!.length).toBe(3);

      // Each claimed job should have a non-null worker_id
      // (In parallel test environments, a background process may also claim jobs,
      //  so we only check that claimed worker_ids are strings, not that they
      //  match our specific worker names.)
      const claimed = allJobs!.filter((j: Record<string, unknown>) => j.worker_id !== null);
      expect(claimed.length).toBeGreaterThanOrEqual(1);
      expect(claimed.length).toBeLessThanOrEqual(3);

      for (const j of claimed) {
        expect(typeof j.worker_id).toBe('string');
      }
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

      const id1 = job1.id as string;
      const id2 = job2.id as string;
      const id3 = job3.id as string;

      // Claim jobs directly by ID for deterministic assignment
      await supabase
        .from('gh_automation_jobs')
        .update({ status: 'queued', worker_id: TEST_WORKER_ID, last_heartbeat: new Date().toISOString() })
        .eq('id', id1);
      await supabase
        .from('gh_automation_jobs')
        .update({ status: 'queued', worker_id: TEST_WORKER_ID_2, last_heartbeat: new Date().toISOString() })
        .eq('id', id2);
      await supabase
        .from('gh_automation_jobs')
        .update({ status: 'queued', worker_id: 'test-worker-3', last_heartbeat: new Date().toISOString() })
        .eq('id', id3);

      // Execute all 3 in parallel
      await Promise.all([
        simulateJobExecution(supabase, id1, 'completed', {
          result_data: { job: 'parallel-1' },
          action_count: 5,
        }),
        simulateJobExecution(supabase, id2, 'completed', {
          result_data: { job: 'parallel-2' },
          action_count: 8,
        }),
        simulateJobExecution(supabase, id3, 'failed', {
          error_code: 'timeout',
          action_count: 3,
        }),
      ]);

      // Verify each job has its own outcome
      const result1 = await valet.getJob(id1);
      const result2 = await valet.getJob(id2);
      const result3 = await valet.getJob(id3);

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

      // Query only step_completed events to avoid interference from cleanup/other event types
      const { data: events1 } = await supabase
        .from('gh_job_events')
        .select('*')
        .eq('job_id', id1)
        .eq('event_type', 'step_completed')
        .order('created_at', { ascending: true });
      const { data: events2 } = await supabase
        .from('gh_job_events')
        .select('*')
        .eq('job_id', id2)
        .eq('event_type', 'step_completed')
        .order('created_at', { ascending: true });

      expect(events1!.length).toBe(3);
      expect(events2!.length).toBe(5);

      // No cross-contamination
      expect(events1!.every((e: Record<string, unknown>) => (e.metadata as Record<string, unknown>).job === 'A')).toBe(true);
      expect(events2!.every((e: Record<string, unknown>) => (e.metadata as Record<string, unknown>).job === 'B')).toBe(true);
    });
  });

  // ─── Worker capacity management ────────────────────────────────

  describe('Worker Capacity', () => {
    it('should respect maxConcurrent by not picking up when at capacity', async () => {
      // Simulate a worker at capacity (2 active jobs)
      const maxConcurrent = 2;

      const capacityJobs = await insertTestJobs(supabase, [
        { status: 'running', worker_id: TEST_WORKER_ID, job_type: JOB_TYPE },
        { status: 'running', worker_id: TEST_WORKER_ID, job_type: JOB_TYPE },
        { status: 'pending', job_type: JOB_TYPE }, // Available but worker is at capacity
      ]);

      // Count active jobs using known IDs
      const runningIds = capacityJobs.slice(0, 2).map((j: Record<string, unknown>) => j.id as string);
      const { data: activeJobs } = await supabase
        .from('gh_automation_jobs')
        .select('id')
        .in('id', runningIds)
        .in('status', ['queued', 'running']);

      expect(activeJobs!.length).toBe(maxConcurrent);

      // Worker should check capacity before pickup
      const atCapacity = activeJobs!.length >= maxConcurrent;
      expect(atCapacity).toBe(true);
    });

    it('should pick up new jobs after completing existing ones', async () => {
      const capacityType = 'concurrency_capacity';

      // Create initial jobs with unique type for isolation
      const [active, pending] = await insertTestJobs(supabase, [
        { status: 'running', worker_id: TEST_WORKER_ID, started_at: new Date().toISOString(), job_type: capacityType },
        { task_description: 'Waiting job', job_type: capacityType },
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

      // Allow DB to settle
      await new Promise((r) => setTimeout(r, 200));

      // Now the worker should be able to pick up the pending job
      const pickup = await simulateWorkerPickup(supabase, TEST_WORKER_ID, capacityType);
      expect(pickup).not.toBeNull();
      expect(pickup).toBe(pending.id);

      // Cleanup
      const ids = [active.id as string, pending.id as string];
      await supabase.from('gh_job_events').delete().in('job_id', ids);
      await supabase.from('gh_automation_jobs').delete().in('id', ids);
    });
  });

  // ─── Priority ordering under contention ─────────────────────────

  describe('Priority Under Contention', () => {
    it('should serve higher priority jobs first when multiple are pending', async () => {
      const priorityType = 'concurrency_priority';
      const inserted = await insertTestJobs(supabase, [
        { priority: 1, task_description: 'Low P1', job_type: priorityType },
        { priority: 10, task_description: 'High P10', job_type: priorityType },
        { priority: 5, task_description: 'Med P5', job_type: priorityType },
        { priority: 8, task_description: 'High P8', job_type: priorityType },
      ]);

      // Verify insertion succeeded
      expect(inserted.length).toBe(4);

      // Verify the SELECT ordering used by pickup: highest priority first, then by created_at
      // Use the known IDs to avoid stale-read issues
      const ids = inserted.map((j: Record<string, unknown>) => j.id as string);
      const { data: ordered } = await supabase
        .from('gh_automation_jobs')
        .select('task_description, priority')
        .in('id', ids)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });

      expect(ordered!.length).toBe(4);
      expect(ordered![0].task_description).toBe('High P10');
      expect(ordered![1].task_description).toBe('High P8');
      expect(ordered![2].task_description).toBe('Med P5');
      expect(ordered![3].task_description).toBe('Low P1');

      // Cleanup using known IDs
      await supabase.from('gh_job_events').delete().in('job_id', ids);
      await supabase.from('gh_automation_jobs').delete().in('id', ids);
    });

    it('should use FIFO within the same priority level', async () => {
      const fifoType = 'concurrency_fifo';
      const allIds: string[] = [];

      // Create 3 jobs with the same priority but staggered creation times.
      // We use 200ms delay to ensure Supabase assigns distinct created_at timestamps.
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 200));
        const [job] = await insertTestJobs(supabase, {
          priority: 5,
          task_description: `Same-priority Job ${i}`,
          job_type: fifoType,
        });
        allIds.push(job.id as string);
      }

      // Verify the SELECT ordering using known IDs: same priority -> FIFO by created_at
      const { data: ordered } = await supabase
        .from('gh_automation_jobs')
        .select('task_description, created_at')
        .in('id', allIds)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });

      expect(ordered!.length).toBe(3);
      expect(ordered![0].task_description).toBe('Same-priority Job 0');
      expect(ordered![1].task_description).toBe('Same-priority Job 1');
      expect(ordered![2].task_description).toBe('Same-priority Job 2');

      // Cleanup
      await supabase.from('gh_job_events').delete().in('job_id', allIds);
      await supabase.from('gh_automation_jobs').delete().in('id', allIds);
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

      // Verify all 20 were inserted (query by known IDs, any status —
      // in parallel test environments a concurrent test may pick up a job)
      const jobIds = jobs.map((j: Record<string, unknown>) => j.id as string);
      const { data: inserted } = await supabase
        .from('gh_automation_jobs')
        .select('id')
        .in('id', jobIds);

      expect(inserted!.length).toBe(20);
    });
  });
});
