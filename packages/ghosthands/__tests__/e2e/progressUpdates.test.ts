/**
 * E2E: Progress Updates
 *
 * Tests real-time progress events, job event recording, status transitions,
 * heartbeat tracking, and the event timeline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getTestSupabase,
  cleanupTestData,
  insertTestJobs,
  MockValetClient,
  simulateWorkerPickup,
  TEST_USER_ID,
  TEST_WORKER_ID,
} from './helpers';

const supabase = getTestSupabase();
const valet = new MockValetClient(supabase);

describe('Progress Updates', () => {
  beforeAll(async () => {
    await cleanupTestData(supabase);
  });

  afterAll(async () => {
    await cleanupTestData(supabase);
  });

  beforeEach(async () => {
    await cleanupTestData(supabase);
  });

  // ─── Event recording ────────────────────────────────────────────

  describe('Job Event Recording', () => {
    it('should record events with correct structure', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      await supabase.from('gh_job_events').insert({
        job_id: jobId,
        event_type: 'step_started',
        metadata: { action: 'click', step: 1 },
        actor: TEST_WORKER_ID,
      });

      const events = await valet.getJobEvents(jobId);
      expect(events.length).toBe(1);
      expect(events[0].job_id).toBe(jobId);
      expect(events[0].event_type).toBe('step_started');
      expect((events[0].metadata as Record<string, unknown>).action).toBe('click');
      expect(events[0].actor).toBe(TEST_WORKER_ID);
      expect(events[0].created_at).toBeDefined();
    });

    it('should record multiple events in chronological order', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      const eventSequence = [
        { event_type: 'job_started', metadata: { worker_id: TEST_WORKER_ID } },
        { event_type: 'step_started', metadata: { action: 'navigate', step: 1 } },
        { event_type: 'step_completed', metadata: { action: 'navigate', step: 1 } },
        { event_type: 'step_started', metadata: { action: 'fill_form', step: 2 } },
        { event_type: 'step_completed', metadata: { action: 'fill_form', step: 2 } },
        { event_type: 'step_started', metadata: { action: 'click_submit', step: 3 } },
        { event_type: 'step_completed', metadata: { action: 'click_submit', step: 3 } },
        { event_type: 'job_completed', metadata: { action_count: 3 } },
      ];

      for (const event of eventSequence) {
        await supabase.from('gh_job_events').insert({
          job_id: jobId,
          ...event,
          actor: TEST_WORKER_ID,
        });
        // Small delay to ensure ordering
        await new Promise((r) => setTimeout(r, 5));
      }

      const events = await valet.getJobEvents(jobId);
      expect(events.length).toBe(eventSequence.length);

      // Verify chronological order
      for (let i = 1; i < events.length; i++) {
        const prev = new Date(events[i - 1].created_at as string).getTime();
        const curr = new Date(events[i].created_at as string).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }

      // Verify event types in order
      expect(events[0].event_type).toBe('job_started');
      expect(events[events.length - 1].event_type).toBe('job_completed');
    });

    it('should support different event types throughout job lifecycle', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      const eventTypes = [
        'job_started',
        'budget_preflight_passed',
        'step_started',
        'step_completed',
        'cost_recorded',
        'job_completed',
      ];

      for (const eventType of eventTypes) {
        await supabase.from('gh_job_events').insert({
          job_id: jobId,
          event_type: eventType,
          metadata: { test: true },
          actor: TEST_WORKER_ID,
        });
      }

      const events = await valet.getJobEvents(jobId);
      const recordedTypes = events.map((e) => e.event_type);

      for (const type of eventTypes) {
        expect(recordedTypes).toContain(type);
      }
    });
  });

  // ─── Status transitions ─────────────────────────────────────────

  describe('Status Transitions', () => {
    it('should track status changes from pending through running to completed', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      // Verify initial status
      let status = await valet.getJobStatus(jobId);
      expect(status).toBe('pending');

      // Pickup: pending -> queued
      await supabase
        .from('gh_automation_jobs')
        .update({
          status: 'queued',
          worker_id: TEST_WORKER_ID,
          last_heartbeat: new Date().toISOString(),
        })
        .eq('id', jobId);

      status = await valet.getJobStatus(jobId);
      expect(status).toBe('queued');

      // Start: queued -> running
      await supabase
        .from('gh_automation_jobs')
        .update({
          status: 'running',
          started_at: new Date().toISOString(),
          status_message: 'Starting browser agent',
          last_heartbeat: new Date().toISOString(),
        })
        .eq('id', jobId);

      status = await valet.getJobStatus(jobId);
      expect(status).toBe('running');

      // Complete: running -> completed
      await supabase
        .from('gh_automation_jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          result_summary: 'Application submitted successfully',
        })
        .eq('id', jobId);

      status = await valet.getJobStatus(jobId);
      expect(status).toBe('completed');
    });

    it('should record status_message updates', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      const statusMessages = [
        'Starting browser agent',
        'Navigating to application page',
        'Filling form fields',
        'Uploading resume',
        'Submitting application',
        'Extracting confirmation',
      ];

      for (const msg of statusMessages) {
        await supabase
          .from('gh_automation_jobs')
          .update({
            status_message: msg,
            last_heartbeat: new Date().toISOString(),
          })
          .eq('id', jobId);
      }

      const finalJob = await valet.getJob(jobId);
      expect(finalJob!.status_message).toBe('Extracting confirmation');
    });
  });

  // ─── Heartbeat tracking ─────────────────────────────────────────

  describe('Heartbeat Tracking', () => {
    it('should update heartbeat timestamp on each beat', async () => {
      const [job] = await insertTestJobs(supabase, {
        status: 'running',
        worker_id: TEST_WORKER_ID,
        started_at: new Date().toISOString(),
      });
      const jobId = job.id as string;

      const timestamps: string[] = [];

      // Simulate 3 heartbeats
      for (let i = 0; i < 3; i++) {
        const now = new Date().toISOString();
        await supabase
          .from('gh_automation_jobs')
          .update({ last_heartbeat: now })
          .eq('id', jobId);
        timestamps.push(now);
        await new Promise((r) => setTimeout(r, 10));
      }

      const finalJob = await valet.getJob(jobId);
      expect(finalJob!.last_heartbeat).toBe(timestamps[timestamps.length - 1]);
    });

    it('should detect stale heartbeats (used for stuck job recovery)', async () => {
      const staleTime = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 min ago
      const freshTime = new Date().toISOString();

      await insertTestJobs(supabase, [
        {
          status: 'running',
          worker_id: 'worker-stale',
          last_heartbeat: staleTime,
          started_at: staleTime,
        },
        {
          status: 'running',
          worker_id: 'worker-fresh',
          last_heartbeat: freshTime,
          started_at: freshTime,
        },
      ]);

      // Query for stuck jobs (heartbeat > 2 minutes ago)
      const threshold = new Date(Date.now() - 120 * 1000).toISOString();

      const { data: stuckJobs } = await supabase
        .from('gh_automation_jobs')
        .select('id, worker_id')
        .eq('created_by', 'test')
        .in('status', ['queued', 'running'])
        .lt('last_heartbeat', threshold);

      expect(stuckJobs!.length).toBe(1);
      expect(stuckJobs![0].worker_id).toBe('worker-stale');
    });
  });

  // ─── Event timeline (audit log) ─────────────────────────────────

  describe('Event Timeline', () => {
    it('should provide a complete audit trail for a job', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      // Simulate a complete job lifecycle with events
      const events = [
        { event_type: 'job_started', metadata: { worker_id: TEST_WORKER_ID, quality_preset: 'balanced' } },
        { event_type: 'step_started', metadata: { action: 'navigate', action_count: 1 } },
        { event_type: 'step_completed', metadata: { action: 'navigate', action_count: 1 } },
        { event_type: 'step_started', metadata: { action: 'fill_input', action_count: 2 } },
        { event_type: 'step_completed', metadata: { action: 'fill_input', action_count: 2 } },
        { event_type: 'step_started', metadata: { action: 'click', action_count: 3 } },
        { event_type: 'step_completed', metadata: { action: 'click', action_count: 3 } },
        { event_type: 'job_completed', metadata: { action_count: 3, total_tokens: 1500, cost_cents: 2 } },
        { event_type: 'cost_recorded', metadata: { total_cost: 0.02, action_count: 3 } },
      ];

      for (const event of events) {
        await supabase.from('gh_job_events').insert({
          job_id: jobId,
          ...event,
          actor: event.event_type === 'cost_recorded' ? 'cost_control' : TEST_WORKER_ID,
        });
        await new Promise((r) => setTimeout(r, 5));
      }

      const timeline = await valet.getJobEvents(jobId);
      expect(timeline.length).toBe(events.length);

      // Verify start and end
      expect(timeline[0].event_type).toBe('job_started');
      expect(timeline[timeline.length - 1].event_type).toBe('cost_recorded');

      // Verify action count progresses
      const actionCounts = timeline
        .filter((e) => e.event_type === 'step_completed')
        .map((e) => (e.metadata as Record<string, unknown>).action_count);
      expect(actionCounts).toEqual([1, 2, 3]);
    });

    it('should record events from different actors', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      await supabase.from('gh_job_events').insert([
        { job_id: jobId, event_type: 'job_started', metadata: {}, actor: TEST_WORKER_ID },
        { job_id: jobId, event_type: 'cost_recorded', metadata: {}, actor: 'cost_control' },
        { job_id: jobId, event_type: 'job_cancelled', metadata: {}, actor: 'user:api' },
      ]);

      const timeline = await valet.getJobEvents(jobId);
      const actors = new Set(timeline.map((e) => e.actor));

      expect(actors.has(TEST_WORKER_ID)).toBe(true);
      expect(actors.has('cost_control')).toBe(true);
      expect(actors.has('user:api')).toBe(true);
    });

    it('should isolate events between different jobs', async () => {
      const [job1, job2] = await insertTestJobs(supabase, [
        { task_description: 'Job 1' },
        { task_description: 'Job 2' },
      ]);

      await supabase.from('gh_job_events').insert([
        { job_id: job1.id, event_type: 'job_started', metadata: { job: 1 }, actor: TEST_WORKER_ID },
        { job_id: job1.id, event_type: 'job_completed', metadata: { job: 1 }, actor: TEST_WORKER_ID },
        { job_id: job2.id, event_type: 'job_started', metadata: { job: 2 }, actor: TEST_WORKER_ID },
        { job_id: job2.id, event_type: 'job_failed', metadata: { job: 2 }, actor: TEST_WORKER_ID },
      ]);

      const events1 = await valet.getJobEvents(job1.id as string);
      const events2 = await valet.getJobEvents(job2.id as string);

      expect(events1.length).toBe(2);
      expect(events2.length).toBe(2);

      // Job 1 events should not contain job 2 events
      expect(events1.every((e) => e.job_id === job1.id)).toBe(true);
      expect(events2.every((e) => e.job_id === job2.id)).toBe(true);

      // Different outcomes
      expect(events1.some((e) => e.event_type === 'job_completed')).toBe(true);
      expect(events2.some((e) => e.event_type === 'job_failed')).toBe(true);
    });
  });

  // ─── Progress metadata ──────────────────────────────────────────

  describe('Progress Metadata', () => {
    it('should track action counts in event metadata', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      for (let i = 1; i <= 5; i++) {
        await supabase.from('gh_job_events').insert({
          job_id: jobId,
          event_type: 'step_completed',
          metadata: { action: `action_${i}`, action_count: i },
          actor: TEST_WORKER_ID,
        });
      }

      const events = await valet.getJobEvents(jobId);
      const completedSteps = events.filter((e) => e.event_type === 'step_completed');

      expect(completedSteps.length).toBe(5);

      // Last event should have the highest action count
      const lastStep = completedSteps[completedSteps.length - 1];
      expect((lastStep.metadata as Record<string, unknown>).action_count).toBe(5);
    });

    it('should include cost data in completion events', async () => {
      const [job] = await insertTestJobs(supabase, {});
      const jobId = job.id as string;

      await supabase.from('gh_job_events').insert({
        job_id: jobId,
        event_type: 'job_completed',
        metadata: {
          result_summary: 'Application submitted',
          submitted: true,
          action_count: 10,
          total_tokens: 3000,
          cost_cents: 5,
        },
        actor: TEST_WORKER_ID,
      });

      const events = await valet.getJobEvents(jobId);
      const completion = events.find((e) => e.event_type === 'job_completed');

      expect(completion).toBeDefined();
      const meta = completion!.metadata as Record<string, unknown>;
      expect(meta.action_count).toBe(10);
      expect(meta.total_tokens).toBe(3000);
      expect(meta.cost_cents).toBe(5);
      expect(meta.submitted).toBe(true);
    });
  });
});
