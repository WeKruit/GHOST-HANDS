import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { notifyHumanNeededMock } = vi.hoisted(() => ({
  notifyHumanNeededMock: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../src/workers/callbackNotifier.js', () => ({
  callbackNotifier: {
    notifyHumanNeeded: notifyHumanNeededMock,
  },
}));

import { JobPoller } from '../../../src/workers/JobPoller.js';

function createPoller(pgQueryMock: ReturnType<typeof vi.fn>) {
  return new JobPoller({
    supabase: {} as any,
    pgDirect: { query: pgQueryMock, on: vi.fn() } as any,
    workerId: 'worker-test-1',
    executor: { execute: vi.fn() } as any,
    maxConcurrent: 1,
  });
}

describe('JobPoller.recoverStuckJobs', () => {
  beforeEach(() => {
    notifyHumanNeededMock.mockClear();
  });

  test('marks stale no-progress jobs as needs_human (not pending) and sends needs_human callback', async () => {
    const pgQueryMock = vi.fn()
      // Find stuck jobs
      .mockResolvedValueOnce({
        rows: [{ id: 'job-stuck-1', callback_url: 'https://valet.test/callback', valet_task_id: 'vt-1' }],
      })
      // Check progress events
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      // Mark stuck job needs_human
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const poller = createPoller(pgQueryMock);
    await (poller as any).recoverStuckJobs();

    // Should mark needs_human instead of re-queueing
    const needsHumanUpdateCall = pgQueryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes("SET status = 'needs_human'"),
    );
    expect(needsHumanUpdateCall).toBeDefined();

    const pendingUpdateCall = pgQueryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes("SET status = 'pending'"),
    );
    expect(pendingUpdateCall).toBeUndefined();

    expect(notifyHumanNeededMock).toHaveBeenCalledTimes(1);
    expect(notifyHumanNeededMock).toHaveBeenCalledWith(
      'job-stuck-1',
      'https://valet.test/callback',
      expect.objectContaining({
        type: 'stuck_job_timeout',
      }),
      'vt-1',
      'worker-test-1',
    );
  });

  test('marks stale jobs with progress as completed and does not send needs_human callback', async () => {
    const pgQueryMock = vi.fn()
      // Find stuck jobs
      .mockResolvedValueOnce({
        rows: [{ id: 'job-progress-1', callback_url: 'https://valet.test/callback', valet_task_id: 'vt-2' }],
      })
      // Check progress events
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }] })
      // Complete recovered job
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const poller = createPoller(pgQueryMock);
    await (poller as any).recoverStuckJobs();

    const completedUpdateCall = pgQueryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes("SET status = 'completed'"),
    );
    expect(completedUpdateCall).toBeDefined();
    expect(notifyHumanNeededMock).not.toHaveBeenCalled();
  });

  test('does nothing when no stuck jobs are found', async () => {
    const pgQueryMock = vi.fn().mockResolvedValueOnce({ rows: [] });
    const poller = createPoller(pgQueryMock);

    await (poller as any).recoverStuckJobs();

    expect(pgQueryMock).toHaveBeenCalledTimes(1);
    expect(notifyHumanNeededMock).not.toHaveBeenCalled();
  });
});
