import { describe, expect, test, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing PgBossConsumer
// ---------------------------------------------------------------------------

// Mock the logger to prevent actual log output in tests
vi.mock('../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
import { PgBossConsumer } from '../../../src/workers/PgBossConsumer.js';

// ---------------------------------------------------------------------------
// Helpers — create mock instances
// ---------------------------------------------------------------------------

function createMockBoss() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('pgboss-new-id'),
    fail: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPgClient(queryResults: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows: queryResults }),
  };
}

function createMockExecutor() {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

/** A sample DB row returned by SELECT * FROM gh_automation_jobs */
function sampleDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gh-job-001',
    user_id: 'user-123',
    job_type: 'apply',
    target_url: 'https://boards.greenhouse.io/company/jobs/123',
    task_description: 'Apply to this job',
    input_data: { resume_ref: 'resume-abc' },
    timeout_seconds: 1800,
    max_retries: 3,
    retry_count: 0,
    metadata: { source: 'valet' },
    priority: 5,
    tags: ['valet'],
    callback_url: 'https://valet-api-stg.fly.dev/api/v1/webhooks/ghosthands',
    valet_task_id: 'vtask-001',
    execution_mode: null,
    status: 'queued',
    ...overrides,
  };
}

/** A sample pg-boss Job<GhJobPayload> */
function samplePgBossJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pgboss-job-001',
    name: 'gh_apply_job',
    data: {
      ghJobId: 'gh-job-001',
      valetTaskId: 'vtask-001',
      userId: 'user-123',
      targetUrl: 'https://boards.greenhouse.io/company/jobs/123',
      jobType: 'apply',
      callbackUrl: 'https://valet-api-stg.fly.dev/api/v1/webhooks/ghosthands',
    },
    ...overrides,
  };
}

const WORKER_ID = 'test-worker-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PgBossConsumer', () => {
  let mockBoss: ReturnType<typeof createMockBoss>;
  let mockPg: ReturnType<typeof createMockPgClient>;
  let mockExecutor: ReturnType<typeof createMockExecutor>;

  beforeEach(() => {
    mockBoss = createMockBoss();
    mockPg = createMockPgClient();
    mockExecutor = createMockExecutor();
  });

  function createConsumer() {
    return new PgBossConsumer({
      boss: mockBoss as any,
      pgDirect: mockPg as any,
      workerId: WORKER_ID,
      executor: mockExecutor as any,
    });
  }

  // ── Test 1: Queue subscription ──────────────────────────────────────

  describe('start() — queue subscription', () => {
    test('creates both general and targeted queues with correct options', async () => {
      const consumer = createConsumer();
      await consumer.start();

      // Should create two queues
      expect(mockBoss.createQueue).toHaveBeenCalledTimes(2);

      // General queue
      expect(mockBoss.createQueue).toHaveBeenCalledWith('gh_apply_job', {
        retryLimit: 0,
        expireInSeconds: 1800,
      });

      // Targeted queue: gh_apply_job/{workerId}
      expect(mockBoss.createQueue).toHaveBeenCalledWith(`gh_apply_job/${WORKER_ID}`, {
        retryLimit: 0,
        expireInSeconds: 1800,
      });
    });

    test('subscribes to both queues via work()', async () => {
      const consumer = createConsumer();
      await consumer.start();

      expect(mockBoss.work).toHaveBeenCalledTimes(2);

      // General queue subscription
      expect(mockBoss.work).toHaveBeenCalledWith(
        'gh_apply_job',
        { batchSize: 1 },
        expect.any(Function),
      );

      // Targeted queue subscription
      expect(mockBoss.work).toHaveBeenCalledWith(
        `gh_apply_job/${WORKER_ID}`,
        { batchSize: 1 },
        expect.any(Function),
      );
    });

    test('sets isRunning to true', async () => {
      const consumer = createConsumer();
      expect(consumer.isRunning).toBe(false);
      await consumer.start();
      expect(consumer.isRunning).toBe(true);
    });

    test('start() succeeds even if createQueue throws (queue already exists)', async () => {
      mockBoss.createQueue.mockRejectedValue(new Error('queue already exists'));
      const consumer = createConsumer();

      // Should not throw — createQueue errors are caught
      await consumer.start();
      expect(mockBoss.work).toHaveBeenCalledTimes(2);
    });
  });

  // ── Test 2: Job handling ────────────────────────────────────────────

  describe('handleJob() — successful job processing', () => {
    test('looks up DB record, updates status, and calls executor.execute()', async () => {
      const dbRow = sampleDbRow();
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })  // SELECT
        .mockResolvedValueOnce({ rows: [] });       // UPDATE status

      const consumer = createConsumer();
      await consumer.start();

      // Extract the work callback from the first boss.work() call
      const workCallback = mockBoss.work.mock.calls[0][2];
      await workCallback([samplePgBossJob()]);

      // Should query for the job record
      expect(mockPg.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM gh_automation_jobs WHERE id = $1'),
        ['gh-job-001'],
      );

      // Should update status to running
      expect(mockPg.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'running'"),
        [WORKER_ID, 'gh-job-001'],
      );

      // Should call executor.execute with the mapped AutomationJob
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
      const executedJob = mockExecutor.execute.mock.calls[0][0];
      expect(executedJob.id).toBe('gh-job-001');
      expect(executedJob.job_type).toBe('apply');
      expect(executedJob.target_url).toBe('https://boards.greenhouse.io/company/jobs/123');
      expect(executedJob.user_id).toBe('user-123');
      expect(executedJob.input_data).toEqual({ resume_ref: 'resume-abc' });
      expect(executedJob.metadata).toEqual({ source: 'valet' });
      expect(executedJob.valet_task_id).toBe('vtask-001');
    });

    test('resets state after successful execution', async () => {
      const dbRow = sampleDbRow();
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];
      await workCallback([samplePgBossJob()]);

      // After completion, counters should reset
      expect(consumer.activeJobCount).toBe(0);
      expect(consumer.currentJobId).toBeNull();
    });
  });

  // ── Test 3: Concurrency guard ───────────────────────────────────────

  describe('concurrency guard', () => {
    test('re-enqueues job when already processing', async () => {
      // First job: slow execution (we need to trigger concurrency)
      const dbRow = sampleDbRow();
      let resolveFirstJob: () => void;
      const firstJobPromise = new Promise<void>((resolve) => {
        resolveFirstJob = resolve;
      });

      mockExecutor.execute.mockImplementationOnce(() => firstJobPromise);
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })   // SELECT for job 1
        .mockResolvedValueOnce({ rows: [] });        // UPDATE for job 1

      const consumer = createConsumer();
      await consumer.start();

      // Start processing first job (doesn't resolve yet)
      const workCallback = mockBoss.work.mock.calls[0][2];
      const firstJobHandle = workCallback([samplePgBossJob()]);

      // Second job arrives while first is still processing
      const secondJob = samplePgBossJob({
        id: 'pgboss-job-002',
        data: {
          ghJobId: 'gh-job-002',
          valetTaskId: 'vtask-002',
          userId: 'user-456',
          targetUrl: 'https://example.com/job2',
          jobType: 'apply',
        },
      });
      await workCallback([secondJob]);

      // Second job should be re-enqueued
      expect(mockBoss.send).toHaveBeenCalledWith(
        'gh_apply_job',
        secondJob.data,
      );

      // executor.execute should only be called once (for the first job)
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

      // Resolve first job to clean up
      resolveFirstJob!();
      await firstJobHandle;
    });

    test('re-enqueues targeted queue job back to the targeted queue', async () => {
      const dbRow = sampleDbRow();
      let resolveFirstJob: () => void;
      const firstJobPromise = new Promise<void>((resolve) => {
        resolveFirstJob = resolve;
      });

      mockExecutor.execute.mockImplementationOnce(() => firstJobPromise);
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      // Start processing first job on the general queue
      const workCallback = mockBoss.work.mock.calls[0][2];
      const firstJobHandle = workCallback([samplePgBossJob()]);

      // Second job arrives on the TARGETED queue while first is still processing
      const targetedQueueName = `gh_apply_job/${WORKER_ID}`;
      const targetedJob = samplePgBossJob({
        id: 'pgboss-job-003',
        name: targetedQueueName,
        data: {
          ghJobId: 'gh-job-003',
          valetTaskId: 'vtask-003',
          userId: 'user-789',
          targetUrl: 'https://example.com/job3',
          jobType: 'apply',
        },
      });

      // Use the targeted queue callback (second work() subscription)
      const targetedCallback = mockBoss.work.mock.calls[1][2];
      await targetedCallback([targetedJob]);

      // Should re-enqueue to the TARGETED queue (not the general queue)
      expect(mockBoss.send).toHaveBeenCalledWith(
        targetedQueueName,
        targetedJob.data,
      );

      resolveFirstJob!();
      await firstJobHandle;
    });
  });

  // ── Test 4: Error handling ──────────────────────────────────────────

  describe('error handling', () => {
    test('catches executor errors without re-throwing (prevents pg-boss retry)', async () => {
      const dbRow = sampleDbRow();
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      mockExecutor.execute.mockRejectedValueOnce(new Error('Browser crashed'));

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];

      // Should NOT throw — error is caught internally
      await workCallback([samplePgBossJob()]);

      // State should reset after error
      expect(consumer.activeJobCount).toBe(0);
      expect(consumer.currentJobId).toBeNull();
    });

    test('handles job record not found gracefully', async () => {
      // SELECT returns empty
      mockPg.query.mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];

      // Should NOT throw
      await workCallback([samplePgBossJob()]);

      // executor.execute should NOT be called
      expect(mockExecutor.execute).not.toHaveBeenCalled();

      // State should reset
      expect(consumer.activeJobCount).toBe(0);
      expect(consumer.currentJobId).toBeNull();
    });
  });

  // ── Test 5: releaseClaimedJobs ──────────────────────────────────────

  describe('releaseClaimedJobs()', () => {
    test('fails current pg-boss job and releases DB jobs', async () => {
      const dbRow = sampleDbRow();
      let resolveJob: () => void;
      const jobPromise = new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
      mockExecutor.execute.mockImplementationOnce(() => jobPromise);

      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })   // SELECT
        .mockResolvedValueOnce({ rows: [] })         // UPDATE to running
        .mockResolvedValueOnce({ rows: [{ id: 'gh-job-001' }] }); // releaseClaimedJobs UPDATE

      const consumer = createConsumer();
      await consumer.start();

      // Start processing a job
      const workCallback = mockBoss.work.mock.calls[0][2];
      const jobHandle = workCallback([samplePgBossJob()]);

      // While job is processing, call releaseClaimedJobs (simulates shutdown)
      await consumer.releaseClaimedJobs();

      // Should call boss.fail for the current pg-boss job
      expect(mockBoss.fail).toHaveBeenCalledWith(
        'gh_apply_job',
        'pgboss-job-001',
        { reason: 'worker_shutdown' },
      );

      // Should run UPDATE to reset gh_automation_jobs to pending
      const releaseQuery = mockPg.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes("status = 'pending'"),
      );
      expect(releaseQuery).toBeDefined();
      expect(releaseQuery![1]).toEqual([WORKER_ID]);

      // Clean up
      resolveJob!();
      await jobHandle;
    });

    test('handles boss.fail() errors gracefully', async () => {
      const dbRow = sampleDbRow();
      let resolveJob: () => void;
      const jobPromise = new Promise<void>((resolve) => {
        resolveJob = resolve;
      });
      mockExecutor.execute.mockImplementationOnce(() => jobPromise);

      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }); // releaseClaimedJobs

      mockBoss.fail.mockRejectedValueOnce(new Error('pg-boss connection lost'));

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];
      const jobHandle = workCallback([samplePgBossJob()]);

      // Should NOT throw even if boss.fail() fails
      await consumer.releaseClaimedJobs();

      // DB update should still be attempted
      const releaseQuery = mockPg.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes("status = 'pending'"),
      );
      expect(releaseQuery).toBeDefined();

      resolveJob!();
      await jobHandle;
    });

    test('skips boss.fail() when no job is active', async () => {
      const consumer = createConsumer();

      await consumer.releaseClaimedJobs();

      // boss.fail should NOT be called
      expect(mockBoss.fail).not.toHaveBeenCalled();

      // DB query should still run (to catch any stale claims)
      expect(mockPg.query).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 6: stop() ─────────────────────────────────────────────────

  describe('stop()', () => {
    test('sets isRunning to false', async () => {
      const consumer = createConsumer();
      await consumer.start();
      expect(consumer.isRunning).toBe(true);

      await consumer.stop();
      expect(consumer.isRunning).toBe(false);
    });

    test('does not call boss.stop() (pg-boss lifecycle is owned by main.ts)', async () => {
      const consumer = createConsumer();
      await consumer.start();
      await consumer.stop();

      // PgBoss instance is shared — stop is handled by the caller (main.ts)
      expect(mockBoss.stop).not.toHaveBeenCalled();
    });
  });

  // ── Test 7: AutomationJob mapping edge cases ────────────────────────

  describe('AutomationJob field mapping', () => {
    test('parses string input_data as JSON', async () => {
      const dbRow = sampleDbRow({ input_data: '{"resume_ref":"resume-xyz"}' });
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];
      await workCallback([samplePgBossJob()]);

      const executedJob = mockExecutor.execute.mock.calls[0][0];
      expect(executedJob.input_data).toEqual({ resume_ref: 'resume-xyz' });
    });

    test('falls back to payload values when DB fields are null', async () => {
      const dbRow = sampleDbRow({
        job_type: null,
        target_url: null,
        task_description: null,
        callback_url: null,
        valet_task_id: null,
      });
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      // Include taskDescription in payload to test the middle fallback branch
      const jobWithDescription = samplePgBossJob({
        data: {
          ghJobId: 'gh-job-001',
          valetTaskId: 'vtask-001',
          userId: 'user-123',
          targetUrl: 'https://boards.greenhouse.io/company/jobs/123',
          jobType: 'apply',
          taskDescription: 'Apply via payload fallback',
          callbackUrl: 'https://valet-api-stg.fly.dev/api/v1/webhooks/ghosthands',
        },
      });

      const workCallback = mockBoss.work.mock.calls[0][2];
      await workCallback([jobWithDescription]);

      const executedJob = mockExecutor.execute.mock.calls[0][0];
      // Should fall back to payload values
      expect(executedJob.job_type).toBe('apply');
      expect(executedJob.target_url).toBe('https://boards.greenhouse.io/company/jobs/123');
      expect(executedJob.task_description).toBe('Apply via payload fallback');
      expect(executedJob.callback_url).toBe('https://valet-api-stg.fly.dev/api/v1/webhooks/ghosthands');
      expect(executedJob.valet_task_id).toBe('vtask-001');
    });

    test('parses string metadata as JSON', async () => {
      const dbRow = sampleDbRow({ metadata: '{"source":"valet","quality_preset":"speed"}' });
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];
      await workCallback([samplePgBossJob()]);

      const executedJob = mockExecutor.execute.mock.calls[0][0];
      expect(executedJob.metadata).toEqual({ source: 'valet', quality_preset: 'speed' });
    });

    test('parses string tags as JSON array', async () => {
      const dbRow = sampleDbRow({ tags: '["valet","apply"]' });
      mockPg.query
        .mockResolvedValueOnce({ rows: [dbRow] })
        .mockResolvedValueOnce({ rows: [] });

      const consumer = createConsumer();
      await consumer.start();

      const workCallback = mockBoss.work.mock.calls[0][2];
      await workCallback([samplePgBossJob()]);

      const executedJob = mockExecutor.execute.mock.calls[0][0];
      expect(executedJob.tags).toEqual(['valet', 'apply']);
    });
  });
});
