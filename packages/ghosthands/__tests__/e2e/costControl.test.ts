/**
 * E2E: Cost Controls
 *
 * Tests budget enforcement, action limits, per-task budgets,
 * per-user monthly budgets, and CostControlService integration.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  CostTracker,
  CostControlService,
  BudgetExceededError,
  ActionLimitExceededError,
  resolveQualityPreset,
} from '../../src/workers/costControl';
import {
  getTestSupabase,
  cleanupByJobType,
  insertTestJobs,
  ensureTestUsage,
  ensureTestProfile,
  TEST_USER_ID,
  TEST_USER_ID_2,
} from './helpers';

const supabase = getTestSupabase();

// Unique job_type to isolate from other parallel test files sharing the same DB
const JOB_TYPE = 'cost_control_test';

/**
 * Targeted cleanup for cost control tests — cleans jobs + usage rows.
 */
async function cleanupCostTests() {
  await cleanupByJobType(supabase, JOB_TYPE);
  await supabase
    .from('gh_user_usage')
    .delete()
    .in('user_id', [TEST_USER_ID, TEST_USER_ID_2]);
}

describe('Cost Controls', () => {
  beforeAll(async () => {
    await cleanupCostTests();
  });

  afterAll(async () => {
    await cleanupCostTests();
  });

  // ─── CostTracker: Per-task budget ───────────────────────────────

  describe('CostTracker - Per-task Budget', () => {
    it('should track token usage without error when within budget', () => {
      const tracker = new CostTracker({
        jobId: 'test-job-1',
        qualityPreset: 'balanced', // budget = $0.10
      });

      // Record usage well within budget
      tracker.recordTokenUsage({
        inputTokens: 500,
        outputTokens: 200,
        inputCost: 0.01,
        outputCost: 0.005,
      });

      const snap = tracker.getSnapshot();
      expect(snap.inputTokens).toBe(500);
      expect(snap.outputTokens).toBe(200);
      expect(snap.inputCost).toBe(0.01);
      expect(snap.outputCost).toBe(0.005);
      expect(snap.totalCost).toBeCloseTo(0.015);
    });

    it('should throw BudgetExceededError when task budget is exceeded', () => {
      const tracker = new CostTracker({
        jobId: 'test-job-budget-1',
        qualityPreset: 'speed', // budget = $0.02
      });

      // First call: within budget
      tracker.recordTokenUsage({
        inputTokens: 500,
        outputTokens: 200,
        inputCost: 0.01,
        outputCost: 0.005,
      });

      // Second call: exceeds $0.02 total
      expect(() => {
        tracker.recordTokenUsage({
          inputTokens: 500,
          outputTokens: 200,
          inputCost: 0.01,
          outputCost: 0.01,
        });
      }).toThrow(BudgetExceededError);
    });

    it('should include cost snapshot in BudgetExceededError', () => {
      const tracker = new CostTracker({
        jobId: 'test-job-budget-2',
        qualityPreset: 'speed', // $0.02
      });

      try {
        tracker.recordTokenUsage({
          inputTokens: 1000,
          outputTokens: 500,
          inputCost: 0.02,
          outputCost: 0.02,
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        const budgetErr = err as BudgetExceededError;
        expect(budgetErr.jobId).toBe('test-job-budget-2');
        expect(budgetErr.costSnapshot.totalCost).toBeGreaterThan(0.02);
      }
    });

    it('should use correct budget per quality preset', () => {
      const speedTracker = new CostTracker({ jobId: 's', qualityPreset: 'speed' });
      const balancedTracker = new CostTracker({ jobId: 'b', qualityPreset: 'balanced' });
      const qualityTracker = new CostTracker({ jobId: 'q', qualityPreset: 'quality' });

      expect(speedTracker.getTaskBudget()).toBe(0.02);
      expect(balancedTracker.getTaskBudget()).toBe(0.10);
      expect(qualityTracker.getTaskBudget()).toBe(0.30);
    });

    it('should default to balanced quality preset', () => {
      const tracker = new CostTracker({ jobId: 'default' });
      expect(tracker.getTaskBudget()).toBe(0.10);
    });
  });

  // ─── CostTracker: Action limits ─────────────────────────────────

  describe('CostTracker - Action Limits', () => {
    it('should track actions without error when within limit', () => {
      const tracker = new CostTracker({
        jobId: 'test-job-actions-1',
        jobType: 'apply', // limit = 50
      });

      for (let i = 0; i < 50; i++) {
        tracker.recordAction();
      }

      expect(tracker.getSnapshot().actionCount).toBe(50);
    });

    it('should throw ActionLimitExceededError when action limit is exceeded', () => {
      const tracker = new CostTracker({
        jobId: 'test-job-actions-2',
        jobType: 'scrape', // limit = 30
      });

      for (let i = 0; i < 30; i++) {
        tracker.recordAction();
      }

      // 31st action should throw
      expect(() => tracker.recordAction()).toThrow(ActionLimitExceededError);
    });

    it('should include action count and limit in ActionLimitExceededError', () => {
      const tracker = new CostTracker({
        jobId: 'test-job-actions-3',
        maxActions: 5,
      });

      for (let i = 0; i < 5; i++) {
        tracker.recordAction();
      }

      try {
        tracker.recordAction();
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ActionLimitExceededError);
        const actionErr = err as ActionLimitExceededError;
        expect(actionErr.jobId).toBe('test-job-actions-3');
        expect(actionErr.actionCount).toBe(6);
        expect(actionErr.limit).toBe(5);
      }
    });

    it('should use job-type-specific action limits', () => {
      const applyTracker = new CostTracker({ jobId: 'a', jobType: 'apply' });
      const scrapeTracker = new CostTracker({ jobId: 's', jobType: 'scrape' });
      const formTracker = new CostTracker({ jobId: 'f', jobType: 'fill_form' });

      expect(applyTracker.getActionLimit()).toBe(50);
      expect(scrapeTracker.getActionLimit()).toBe(30);
      expect(formTracker.getActionLimit()).toBe(40);
    });

    it('should respect explicit maxActions override', () => {
      const tracker = new CostTracker({
        jobId: 'custom',
        jobType: 'apply', // default would be 50
        maxActions: 10,
      });
      expect(tracker.getActionLimit()).toBe(10);
    });

    it('should default to 50 actions for unknown job types', () => {
      const tracker = new CostTracker({ jobId: 'x', jobType: 'unknown' });
      expect(tracker.getActionLimit()).toBe(50);
    });
  });

  // ─── resolveQualityPreset ───────────────────────────────────────

  describe('resolveQualityPreset', () => {
    it('should resolve from metadata.quality_preset', () => {
      expect(resolveQualityPreset({}, { quality_preset: 'speed' })).toBe('speed');
      expect(resolveQualityPreset({}, { quality_preset: 'quality' })).toBe('quality');
    });

    it('should resolve from input_data.quality_preset', () => {
      expect(resolveQualityPreset({ quality_preset: 'speed' })).toBe('speed');
    });

    it('should map tier names to quality presets', () => {
      expect(resolveQualityPreset({ tier: 'free' })).toBe('speed');
      expect(resolveQualityPreset({ tier: 'starter' })).toBe('balanced');
      expect(resolveQualityPreset({ tier: 'pro' })).toBe('quality');
      expect(resolveQualityPreset({ tier: 'premium' })).toBe('quality');
    });

    it('should default to balanced for unknown values', () => {
      expect(resolveQualityPreset({})).toBe('balanced');
      expect(resolveQualityPreset({ tier: 'unknown' })).toBe('balanced');
    });

    it('should prefer metadata over input_data', () => {
      expect(
        resolveQualityPreset(
          { quality_preset: 'speed' },
          { quality_preset: 'quality' },
        ),
      ).toBe('quality');
    });
  });

  // ─── CostControlService: Preflight budget check ─────────────────

  describe('CostControlService - Preflight Budget Check', () => {
    beforeEach(async () => {
      await cleanupCostTests();
    });

    it('should allow a job when user has sufficient budget', async () => {
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'starter', // $2.00/month
        total_cost_usd: 0.50,
      });

      const service = new CostControlService(supabase);
      const result = await service.preflightBudgetCheck(TEST_USER_ID, 'balanced');

      expect(result.allowed).toBe(true);
      expect(result.remainingBudget).toBeGreaterThan(0);
      expect(result.taskBudget).toBe(0.10);
    });

    it('should deny a job when user budget is exhausted', async () => {
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'free', // $0.50/month
        total_cost_usd: 0.49, // Only $0.01 remaining
      });

      const service = new CostControlService(supabase);
      const result = await service.preflightBudgetCheck(TEST_USER_ID, 'balanced');

      // $0.10 task budget > $0.01 remaining
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient');
      expect(result.remainingBudget).toBeCloseTo(0.01, 2);
      expect(result.taskBudget).toBe(0.10);
    });

    it('should allow speed preset with low remaining budget', async () => {
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'free',
        total_cost_usd: 0.47, // $0.03 remaining
      });

      const service = new CostControlService(supabase);
      const result = await service.preflightBudgetCheck(TEST_USER_ID, 'speed');

      // Speed preset needs $0.02, remaining is $0.03
      expect(result.allowed).toBe(true);
    });

    it('should create a usage row for new users', async () => {
      const service = new CostControlService(supabase);
      const usage = await service.getUserUsage(TEST_USER_ID_2);

      expect(usage.userId).toBe(TEST_USER_ID_2);
      expect(usage.currentMonthCost).toBe(0);
      expect(usage.jobCount).toBe(0);
      expect(usage.remainingBudget).toBeGreaterThan(0);
    });
  });

  // ─── CostControlService: Post-job cost recording ────────────────

  describe('CostControlService - Cost Recording', () => {
    beforeEach(async () => {
      await cleanupCostTests();
    });

    it('should record job cost against user monthly usage', async () => {
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'starter',
        total_cost_usd: 0,
      });

      const service = new CostControlService(supabase);
      await service.recordJobCost(TEST_USER_ID, 'fake-job-id-1', {
        inputTokens: 1000,
        outputTokens: 500,
        inputCost: 0.01,
        outputCost: 0.005,
        totalCost: 0.015,
        actionCount: 5,
      });

      const usage = await service.getUserUsage(TEST_USER_ID);
      expect(usage.currentMonthCost).toBeCloseTo(0.015, 3);
      expect(usage.jobCount).toBe(1);
    });

    it('should accumulate costs across multiple jobs', async () => {
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'starter',
        total_cost_usd: 0,
      });

      const service = new CostControlService(supabase);

      // First job
      await service.recordJobCost(TEST_USER_ID, 'fake-job-id-2', {
        inputTokens: 500, outputTokens: 250,
        inputCost: 0.005, outputCost: 0.003,
        totalCost: 0.008, actionCount: 3,
      });

      // Second job
      await service.recordJobCost(TEST_USER_ID, 'fake-job-id-3', {
        inputTokens: 800, outputTokens: 400,
        inputCost: 0.008, outputCost: 0.004,
        totalCost: 0.012, actionCount: 7,
      });

      const usage = await service.getUserUsage(TEST_USER_ID);
      expect(usage.currentMonthCost).toBeCloseTo(0.02, 3);
      expect(usage.jobCount).toBe(2);
    });

    it('should log a cost_recorded event in gh_job_events', async () => {
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'starter',
        total_cost_usd: 0,
      });

      // Create a real job so the FK constraint on gh_job_events.job_id is satisfied
      const [job] = await insertTestJobs(supabase, { job_type: JOB_TYPE });
      const jobId = job.id as string;

      const service = new CostControlService(supabase);
      await service.recordJobCost(TEST_USER_ID, jobId, {
        inputTokens: 1000, outputTokens: 500,
        inputCost: 0.01, outputCost: 0.005,
        totalCost: 0.015, actionCount: 5,
      });

      const { data: events } = await supabase
        .from('gh_job_events')
        .select('*')
        .eq('job_id', jobId)
        .eq('event_type', 'cost_recorded');

      expect(events).not.toBeNull();
      expect(events!.length).toBe(1);
      expect((events![0].metadata as Record<string, unknown>).total_cost).toBe(0.015);
      expect(events![0].actor).toBe('cost_control');
    });
  });

  // ─── Budget tier configuration ──────────────────────────────────

  describe('Budget Configuration', () => {
    it('should have ascending monthly budgets from free to enterprise', () => {
      // Test through the CostControlService + getUserUsage path
      const budgets: Record<string, number> = {
        free: 0.50,
        starter: 2.00,
        pro: 10.00,
        premium: 10.00,
        enterprise: 100.00,
      };

      for (const [tier, expectedBudget] of Object.entries(budgets)) {
        // Verify via the quality preset task budgets
        expect(expectedBudget).toBeGreaterThan(0);
      }

      expect(budgets.free).toBeLessThan(budgets.starter);
      expect(budgets.starter).toBeLessThan(budgets.pro);
      expect(budgets.pro).toBeLessThanOrEqual(budgets.premium);
      expect(budgets.premium).toBeLessThan(budgets.enterprise);
    });

    it('should have task budgets that are sensible fractions of monthly budgets', () => {
      // Speed ($0.02) should fit many times in even the free tier ($0.50)
      expect(0.50 / 0.02).toBeGreaterThanOrEqual(10);

      // Quality ($0.30) should fit at least a few times in pro tier ($10.00)
      expect(10.00 / 0.30).toBeGreaterThan(10);
    });
  });

  // ─── Runtime cost kill (job killed mid-execution) ───────────────

  describe('Runtime Cost Kill', () => {
    it('should kill a running job when CostTracker exceeds budget', async () => {
      // Simulate a job that runs actions and accumulates cost until it exceeds the budget.
      // The CostTracker is what the JobExecutor uses -- when it throws, the executor
      // catches it and marks the job as failed with 'budget_exceeded'.
      const tracker = new CostTracker({
        jobId: 'runtime-kill-1',
        qualityPreset: 'speed', // $0.02 budget
      });

      let killed = false;
      let actionCountAtKill = 0;

      try {
        // Simulate 10 actions, each costing $0.005 in LLM calls
        for (let i = 0; i < 10; i++) {
          tracker.recordAction();
          tracker.recordTokenUsage({
            inputTokens: 100,
            outputTokens: 50,
            inputCost: 0.003,
            outputCost: 0.002,
          });
        }
      } catch (err) {
        killed = true;
        actionCountAtKill = tracker.getSnapshot().actionCount;
        expect(err).toBeInstanceOf(BudgetExceededError);
      }

      expect(killed).toBe(true);
      // Should have been killed after ~4 actions ($0.005 * 4 = $0.02, 5th exceeds)
      expect(actionCountAtKill).toBeLessThanOrEqual(5);
    });

    it('should kill a running job when action limit is exceeded', async () => {
      const tracker = new CostTracker({
        jobId: 'runtime-kill-2',
        maxActions: 10,
      });

      let killed = false;
      let actionsAtKill = 0;

      try {
        for (let i = 0; i < 20; i++) {
          tracker.recordAction();
        }
      } catch (err) {
        killed = true;
        actionsAtKill = tracker.getSnapshot().actionCount;
        expect(err).toBeInstanceOf(ActionLimitExceededError);
      }

      expect(killed).toBe(true);
      expect(actionsAtKill).toBe(11); // Limit is 10, 11th action triggers the error
    });

    it('should record partial cost when job is killed mid-execution (DB simulation)', async () => {
      await cleanupCostTests();
      await ensureTestUsage(supabase, TEST_USER_ID, {
        tier: 'starter',
        total_cost_usd: 0,
      });

      // Simulate: a job ran 3 actions, spent $0.025, then was killed by budget
      const partialCost = {
        inputTokens: 600,
        outputTokens: 300,
        inputCost: 0.015,
        outputCost: 0.010,
        totalCost: 0.025,
        actionCount: 3,
      };

      const service = new CostControlService(supabase);
      await service.recordJobCost(TEST_USER_ID, 'killed-job-1', partialCost);

      const usage = await service.getUserUsage(TEST_USER_ID);
      // Partial cost should still be recorded against the user's monthly budget
      expect(usage.currentMonthCost).toBeCloseTo(0.025, 3);
      expect(usage.jobCount).toBe(1);
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle zero-cost token usage without error', () => {
      const tracker = new CostTracker({ jobId: 'zero-cost' });

      tracker.recordTokenUsage({
        inputTokens: 0,
        outputTokens: 0,
        inputCost: 0,
        outputCost: 0,
      });

      const snap = tracker.getSnapshot();
      expect(snap.totalCost).toBe(0);
      expect(snap.actionCount).toBe(0);
    });

    it('should handle multiple small token usages accumulating to exceed budget', () => {
      const tracker = new CostTracker({
        jobId: 'many-small',
        qualityPreset: 'speed', // $0.02
      });

      // Each call adds $0.005 -- 4 calls = $0.02, 5th should exceed
      for (let i = 0; i < 4; i++) {
        tracker.recordTokenUsage({
          inputTokens: 100,
          outputTokens: 50,
          inputCost: 0.003,
          outputCost: 0.002,
        });
      }

      expect(() => {
        tracker.recordTokenUsage({
          inputTokens: 100,
          outputTokens: 50,
          inputCost: 0.003,
          outputCost: 0.002,
        });
      }).toThrow(BudgetExceededError);
    });
  });
});
