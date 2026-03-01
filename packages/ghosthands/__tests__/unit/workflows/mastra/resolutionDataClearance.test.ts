/**
 * BUG-2: Inconsistent secret field clearing between two code paths
 *
 * There are two functions that read and clear resolution data from
 * `interaction_data` in `gh_automation_jobs`:
 *
 * 1. `readAndClearResolutionData` in steps/factory.ts (Supabase path)
 *    Clears: resolution_data, resolution_type, resolved_by, resolved_at, otp, credentials
 *
 * 2. `readResolutionData` in resumeCoordinator.ts (pg.Pool path)
 *    Clears: resolution_type, resolution_data, resolved_by, resolved_at
 *    MISSING: otp, credentials
 *
 * When the coordinator path is used (JobExecutor.executeMastraWorkflow),
 * the `otp` and `credentials` fields persist in the database after resolution.
 * This is a security issue: sensitive data (passwords, 2FA codes) can linger
 * in plain text longer than necessary.
 *
 * These tests expose the inconsistency. They will FAIL until BUG-2 is fixed.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';

import {
  readResolutionData,
} from '../../../../src/workflows/mastra/resumeCoordinator.js';

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

function createMockPool() {
  return { query: vi.fn() };
}

// ---------------------------------------------------------------------------
// 1. Coordinator path: readResolutionData must clear `otp` field
// ---------------------------------------------------------------------------

describe('BUG-2: readResolutionData must clear ALL secret fields', () => {
  test('UPDATE SQL clears `otp` from interaction_data (FAILS until BUG-2 is fixed)', async () => {
    const pool = createMockPool();

    // SELECT returns interaction_data with otp present
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'code_entry',
            resolution_data: { code: '789012' },
            resolved_by: 'user',
            resolved_at: '2026-03-01T12:00:00Z',
            otp: '789012',
            blocker_type: 'captcha',
          },
        },
      ],
    });

    // UPDATE to clear resolution fields
    pool.query.mockResolvedValueOnce({ rows: [] });

    await readResolutionData(pool as any, 'job-otp-test');

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [updateSql] = pool.query.mock.calls[1];

    // This assertion will FAIL: the coordinator SQL does not include 'otp'
    expect(updateSql).toContain("- 'otp'");
  });

  test('UPDATE SQL clears `credentials` from interaction_data (FAILS until BUG-2 is fixed)', async () => {
    const pool = createMockPool();

    // SELECT returns interaction_data with credentials present
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'login_credentials',
            resolution_data: { username: 'user@example.com', password: 's3cret!' },
            resolved_by: 'user',
            resolved_at: '2026-03-01T12:00:00Z',
            credentials: { username: 'user@example.com', password: 's3cret!' },
            blocker_type: 'login',
          },
        },
      ],
    });

    // UPDATE to clear resolution fields
    pool.query.mockResolvedValueOnce({ rows: [] });

    await readResolutionData(pool as any, 'job-cred-test');

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [updateSql] = pool.query.mock.calls[1];

    // This assertion will FAIL: the coordinator SQL does not include 'credentials'
    expect(updateSql).toContain("- 'credentials'");
  });

  test('UPDATE SQL clears both `otp` AND `credentials` together (FAILS until BUG-2 is fixed)', async () => {
    const pool = createMockPool();

    // SELECT returns interaction_data with both otp and credentials
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'code_entry',
            resolution_data: { code: '112233' },
            resolved_by: 'user',
            resolved_at: '2026-03-01T12:00:00Z',
            otp: '112233',
            credentials: { username: 'u', password: 'p' },
            blocker_type: '2fa',
          },
        },
      ],
    });

    pool.query.mockResolvedValueOnce({ rows: [] });

    await readResolutionData(pool as any, 'job-both-test');

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [updateSql] = pool.query.mock.calls[1];

    // Both must be present in the clear operation
    expect(updateSql).toContain("- 'otp'");
    expect(updateSql).toContain("- 'credentials'");
  });
});

// ---------------------------------------------------------------------------
// 2. Reference: verify the coordinator clears the 4 fields it already handles
// ---------------------------------------------------------------------------

describe('readResolutionData: baseline field clearance (currently passing)', () => {
  test('UPDATE SQL clears resolution_type, resolution_data, resolved_by, resolved_at', async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'code_entry',
            resolution_data: { code: '000000' },
            resolved_by: 'user',
            resolved_at: '2026-03-01T00:00:00Z',
          },
        },
      ],
    });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await readResolutionData(pool as any, 'job-baseline');

    expect(pool.query).toHaveBeenCalledTimes(2);

    const [updateSql] = pool.query.mock.calls[1];

    // These 4 fields are already cleared by the coordinator — should pass
    expect(updateSql).toContain("- 'resolution_type'");
    expect(updateSql).toContain("- 'resolution_data'");
    expect(updateSql).toContain("- 'resolved_by'");
    expect(updateSql).toContain("- 'resolved_at'");
  });
});

// ---------------------------------------------------------------------------
// 3. Consistency contract: coordinator must clear the same set of fields as factory
// ---------------------------------------------------------------------------

describe('BUG-2 consistency contract: coordinator vs factory field sets', () => {
  /**
   * The factory path (readAndClearResolutionData in steps/factory.ts) clears:
   *   resolution_data, resolution_type, resolved_by, resolved_at, otp, credentials
   *
   * The coordinator path (readResolutionData in resumeCoordinator.ts) must clear
   * the same set. This test reads the SQL emitted by readResolutionData and
   * verifies all 6 fields are covered.
   */
  const FIELDS_CLEARED_BY_FACTORY = [
    'resolution_data',
    'resolution_type',
    'resolved_by',
    'resolved_at',
    'otp',
    'credentials',
  ] as const;

  test('coordinator UPDATE SQL removes every field that the factory path deletes (FAILS until BUG-2 is fixed)', async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'manual',
            resolution_data: null,
            resolved_by: 'user',
            resolved_at: '2026-03-01T00:00:00Z',
            otp: '999999',
            credentials: { user: 'a', pass: 'b' },
          },
        },
      ],
    });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await readResolutionData(pool as any, 'job-contract');

    const [updateSql] = pool.query.mock.calls[1];

    const missingFields: string[] = [];
    for (const field of FIELDS_CLEARED_BY_FACTORY) {
      if (!updateSql.includes(`'${field}'`)) {
        missingFields.push(field);
      }
    }

    // This will FAIL reporting exactly which fields are missing:
    // Expected: [] (no missing fields)
    // Received: ['otp', 'credentials']
    expect(missingFields).toEqual([]);
  });

  test('lists the exact fields missing from coordinator path for diagnostic clarity', async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          interaction_data: {
            resolution_type: 'code_entry',
            resolution_data: { code: '555' },
            resolved_by: 'system',
            resolved_at: '2026-03-01T00:00:00Z',
          },
        },
      ],
    });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await readResolutionData(pool as any, 'job-diag');

    const [updateSql] = pool.query.mock.calls[1];

    // BUG-2 is now fixed — coordinator clears all 6 fields including otp/credentials
    expect(updateSql).toContain("'otp'");
    expect(updateSql).toContain("'credentials'");
  });
});
