/**
 * PRD V5.2 Section 14 — Resume Coordinator Unit Tests
 *
 * Tests the worker-side resume coordination logic for Mastra workflows:
 * - Resume discriminator (isMastraResume)
 * - Dispatch mode helpers (getDispatchMode, isQueueModeResumeSupported)
 * - Atomic resume claim (claimResume)
 * - Mastra run ID persistence (persistMastraRunId)
 * - Resolution data read-and-clear (readResolutionData)
 *
 * All database interactions are mocked via a fake pg.Pool.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';

import {
  isMastraResume,
  getDispatchMode,
  isQueueModeResumeSupported,
  persistMastraRunId,
  claimResume,
  readResolutionData,
} from '../../../../src/workflows/mastra/resumeCoordinator.js';

import type { AutomationJob } from '../../../../src/workers/taskHandlers/types.js';

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

function createMockPool() {
  return { query: vi.fn() };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal AutomationJob for testing
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    job_type: 'apply',
    target_url: 'https://jobs.example.com/apply',
    task_description: 'Apply to this job',
    input_data: {},
    user_id: 'user-1',
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    metadata: {},
    priority: 0,
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. isMastraResume
// ---------------------------------------------------------------------------

describe('isMastraResume', () => {
  test('returns true only when all 3 conditions are met', () => {
    const job = makeJob({
      execution_mode: 'mastra',
      metadata: { mastra_run_id: 'run-abc', resume_requested: true },
    });
    expect(isMastraResume(job)).toBe(true);
  });

  test('returns false for non-mastra execution_mode', () => {
    const job = makeJob({
      execution_mode: 'smart_apply',
      metadata: { mastra_run_id: 'run-abc', resume_requested: true },
    });
    expect(isMastraResume(job)).toBe(false);
  });

  test('returns false when mastra_run_id is missing', () => {
    const job = makeJob({
      execution_mode: 'mastra',
      metadata: { resume_requested: true },
    });
    expect(isMastraResume(job)).toBe(false);
  });

  test('returns false when resume_requested is false', () => {
    const job = makeJob({
      execution_mode: 'mastra',
      metadata: { mastra_run_id: 'run-abc', resume_requested: false },
    });
    expect(isMastraResume(job)).toBe(false);
  });

  test('returns false when resume_requested is absent', () => {
    const job = makeJob({
      execution_mode: 'mastra',
      metadata: { mastra_run_id: 'run-abc' },
    });
    expect(isMastraResume(job)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. getDispatchMode
// ---------------------------------------------------------------------------

describe('getDispatchMode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.JOB_DISPATCH_MODE;
  });

  test('returns "legacy" by default', () => {
    expect(getDispatchMode()).toBe('legacy');
  });

  test('returns "queue" when JOB_DISPATCH_MODE env is set to "queue"', () => {
    process.env.JOB_DISPATCH_MODE = 'queue';
    expect(getDispatchMode()).toBe('queue');
  });

  test('returns "legacy" for any unrecognized JOB_DISPATCH_MODE value', () => {
    process.env.JOB_DISPATCH_MODE = 'something_else';
    expect(getDispatchMode()).toBe('legacy');
  });
});

// ---------------------------------------------------------------------------
// 3. isQueueModeResumeSupported
// ---------------------------------------------------------------------------

describe('isQueueModeResumeSupported', () => {
  test('returns false (Phase 1 guard)', () => {
    expect(isQueueModeResumeSupported()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. persistMastraRunId
// ---------------------------------------------------------------------------

describe('persistMastraRunId', () => {
  test('calls pool.query with correct SQL and parameters', async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValue({ rows: [] });

    const jobId = '550e8400-e29b-41d4-a716-446655440000';
    const runId = 'run-xyz-123';

    await persistMastraRunId(pool as any, jobId, runId);

    expect(pool.query).toHaveBeenCalledTimes(1);

    const [sql, params] = pool.query.mock.calls[0];
    // Verify the SQL updates gh_automation_jobs with jsonb_set for mastra_run_id
    expect(sql).toContain('UPDATE gh_automation_jobs');
    expect(sql).toContain('mastra_run_id');
    expect(sql).toContain('jsonb_set');
    expect(params).toEqual([jobId, runId]);
  });

  test('propagates pool.query errors', async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValue(new Error('connection refused'));

    await expect(
      persistMastraRunId(pool as any, 'job-1', 'run-1'),
    ).rejects.toThrow('connection refused');
  });
});

// ---------------------------------------------------------------------------
// 5. claimResume
// ---------------------------------------------------------------------------

describe('claimResume', () => {
  test('returns metadata on success (rows returned)', async () => {
    const pool = createMockPool();
    const expectedMetadata = { mastra_run_id: 'run-abc', resume_requested: false };
    pool.query.mockResolvedValue({ rows: [{ metadata: expectedMetadata }] });

    const result = await claimResume(pool as any, 'job-1', 'run-abc');

    expect(result).toEqual(expectedMetadata);
    expect(pool.query).toHaveBeenCalledTimes(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('UPDATE gh_automation_jobs');
    expect(sql).toContain('resume_requested');
    expect(params).toEqual(['job-1', 'run-abc']);
  });

  test('returns null when no rows returned (already claimed or preconditions unmet)', async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValue({ rows: [] });

    const result = await claimResume(pool as any, 'job-1', 'run-abc');

    expect(result).toBeNull();
  });

  test('propagates query errors', async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValue(new Error('deadlock detected'));

    await expect(claimResume(pool as any, 'job-1', 'run-abc')).rejects.toThrow(
      'deadlock detected',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. readResolutionData
// ---------------------------------------------------------------------------

describe('readResolutionData', () => {
  test('reads and clears resolution data on success', async () => {
    const pool = createMockPool();
    // First query: SELECT interaction_data
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'code_entry',
            resolution_data: { code: '123456' },
            resolved_by: 'user',
            resolved_at: '2026-03-01T00:00:00Z',
          },
        },
      ],
    });
    // Second query: UPDATE to clear resolution fields
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await readResolutionData(pool as any, 'job-1');

    expect(result).toEqual({
      resolutionType: 'code_entry',
      resolutionData: { code: '123456' },
    });

    // Verify two queries were made: SELECT then UPDATE (clear)
    expect(pool.query).toHaveBeenCalledTimes(2);

    const [selectSql] = pool.query.mock.calls[0];
    expect(selectSql).toContain('SELECT interaction_data');

    const [updateSql] = pool.query.mock.calls[1];
    expect(updateSql).toContain('UPDATE gh_automation_jobs');
    expect(updateSql).toContain('resolution_type');
    expect(updateSql).toContain('resolution_data');
    expect(updateSql).toContain('resolved_by');
    expect(updateSql).toContain('resolved_at');
  });

  test('returns null when no interaction_data exists', async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ interaction_data: null }],
    });

    const result = await readResolutionData(pool as any, 'job-1');

    expect(result).toBeNull();
    // Only the SELECT query should have been called (no clear needed)
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('returns null when interaction_data has no resolution_type', async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ interaction_data: { some_other_field: 'value' } }],
    });

    const result = await readResolutionData(pool as any, 'job-1');

    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('returns null resolution_data when resolution_data field is absent', async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'manual',
            // no resolution_data field
          },
        },
      ],
    });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await readResolutionData(pool as any, 'job-1');

    expect(result).toEqual({
      resolutionType: 'manual',
      resolutionData: null,
    });
  });

  test('propagates query errors', async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValue(new Error('timeout'));

    await expect(readResolutionData(pool as any, 'job-1')).rejects.toThrow('timeout');
  });
});
