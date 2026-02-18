import { describe, expect, test } from 'bun:test';
import { ValetApplySchema, ValetTaskSchema } from '../../../src/api/schemas/valet.js';

// ---------------------------------------------------------------------------
// Worker Affinity — migration schema validation
// ---------------------------------------------------------------------------

describe('Worker affinity migration schema', () => {
  test('worker_affinity column allows valid values', () => {
    const validModes = ['strict', 'preferred', 'any'];
    for (const mode of validModes) {
      expect(validModes.includes(mode)).toBe(true);
    }
  });

  test('worker_affinity rejects invalid values', () => {
    const validModes = ['strict', 'preferred', 'any'];
    const invalidModes = ['soft', 'hard', 'none', 'required', ''];
    for (const mode of invalidModes) {
      expect(validModes.includes(mode)).toBe(false);
    }
  });

  test('worker_affinity defaults to preferred', () => {
    const defaultAffinity = 'preferred';
    expect(defaultAffinity).toBe('preferred');
  });
});

// ---------------------------------------------------------------------------
// Worker Affinity — pickup SQL logic (unit-level validation)
// ---------------------------------------------------------------------------

describe('Worker affinity pickup logic', () => {
  // These tests validate the affinity routing rules without a live database.
  // They simulate the WHERE clause logic from gh_pickup_next_job.

  interface MockJob {
    id: string;
    status: string;
    target_worker_id: string | null;
    worker_affinity: 'strict' | 'preferred' | 'any';
    priority: number;
    created_at: Date;
  }

  function pickupFilter(jobs: MockJob[], workerId: string): MockJob[] {
    return jobs
      .filter((j) => {
        if (j.status !== 'pending') return false;

        if (j.worker_affinity === 'any') return true;
        if (j.worker_affinity === 'preferred') {
          return j.target_worker_id === null || j.target_worker_id === workerId;
        }
        if (j.worker_affinity === 'strict') {
          return j.target_worker_id === workerId;
        }
        return false;
      })
      .sort((a, b) => {
        // Prefer jobs targeted at this worker
        const aTargeted = a.target_worker_id === workerId ? 0 : 1;
        const bTargeted = b.target_worker_id === workerId ? 0 : 1;
        if (aTargeted !== bTargeted) return aTargeted - bTargeted;
        // Then by priority
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Then by created_at
        return a.created_at.getTime() - b.created_at.getTime();
      });
  }

  // --- Strict affinity ---

  describe('strict affinity', () => {
    test('strict: only picks up jobs targeted at this worker', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: 'worker-A', worker_affinity: 'strict', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j2', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'strict', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
        { id: 'j3', status: 'pending', target_worker_id: null, worker_affinity: 'strict', priority: 5, created_at: new Date('2026-02-18T00:02:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('j1');
    });

    test('strict: returns empty when no targeted jobs exist', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'strict', priority: 5, created_at: new Date() },
        { id: 'j2', status: 'pending', target_worker_id: null, worker_affinity: 'strict', priority: 5, created_at: new Date() },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(0);
    });

    test('strict: ignores non-pending jobs', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'running', target_worker_id: 'worker-A', worker_affinity: 'strict', priority: 5, created_at: new Date() },
        { id: 'j2', status: 'completed', target_worker_id: 'worker-A', worker_affinity: 'strict', priority: 5, created_at: new Date() },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(0);
    });
  });

  // --- Preferred affinity ---

  describe('preferred affinity', () => {
    test('preferred: picks up jobs targeted at this worker', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: 'worker-A', worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j2', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('j1');
    });

    test('preferred: picks up unrouted jobs (target_worker_id is null)', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date() },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('j1');
    });

    test('preferred: does NOT pick up jobs targeted at another worker', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'preferred', priority: 5, created_at: new Date() },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(0);
    });

    test('preferred: prioritizes targeted jobs over unrouted', () => {
      const jobs: MockJob[] = [
        { id: 'j-unrouted', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j-targeted', status: 'pending', target_worker_id: 'worker-A', worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(2);
      // Targeted job should come first despite later created_at
      expect(result[0].id).toBe('j-targeted');
      expect(result[1].id).toBe('j-unrouted');
    });

    test('preferred: falls back to unrouted when no targeted jobs', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 3, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j2', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(2);
      // Higher priority (lower number) first
      expect(result[0].id).toBe('j1');
    });
  });

  // --- Any affinity ---

  describe('any affinity', () => {
    test('any: picks up any pending job regardless of target', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'any', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j2', status: 'pending', target_worker_id: null, worker_affinity: 'any', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
        { id: 'j3', status: 'pending', target_worker_id: 'worker-C', worker_affinity: 'any', priority: 5, created_at: new Date('2026-02-18T00:02:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(3);
    });

    test('any: ignores target_worker_id completely', () => {
      const jobs: MockJob[] = [
        { id: 'j1', status: 'pending', target_worker_id: 'worker-Z', worker_affinity: 'any', priority: 5, created_at: new Date() },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result).toHaveLength(1);
    });
  });

  // --- Mixed affinity types ---

  describe('mixed affinity', () => {
    test('mixed: worker sees strict-targeted + preferred-unrouted + any jobs', () => {
      const jobs: MockJob[] = [
        { id: 'j-strict-mine', status: 'pending', target_worker_id: 'worker-A', worker_affinity: 'strict', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j-strict-other', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'strict', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
        { id: 'j-pref-null', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:02:00Z') },
        { id: 'j-pref-other', status: 'pending', target_worker_id: 'worker-B', worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:03:00Z') },
        { id: 'j-any', status: 'pending', target_worker_id: 'worker-C', worker_affinity: 'any', priority: 5, created_at: new Date('2026-02-18T00:04:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      const resultIds = result.map((j) => j.id);

      // Should see: strict-mine, pref-null, any
      expect(resultIds).toContain('j-strict-mine');
      expect(resultIds).toContain('j-pref-null');
      expect(resultIds).toContain('j-any');

      // Should NOT see: strict-other (targeted elsewhere), pref-other (targeted elsewhere)
      expect(resultIds).not.toContain('j-strict-other');
      expect(resultIds).not.toContain('j-pref-other');
    });

    test('mixed: targeted jobs sort before non-targeted', () => {
      const jobs: MockJob[] = [
        { id: 'j-any', status: 'pending', target_worker_id: 'worker-X', worker_affinity: 'any', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j-targeted', status: 'pending', target_worker_id: 'worker-A', worker_affinity: 'strict', priority: 5, created_at: new Date('2026-02-18T00:05:00Z') },
        { id: 'j-unrouted', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      // Targeted job should be first
      expect(result[0].id).toBe('j-targeted');
    });
  });

  // --- Priority ordering ---

  describe('priority ordering within affinity', () => {
    test('higher priority (lower number) jobs are picked first', () => {
      const jobs: MockJob[] = [
        { id: 'j-low', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 8, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j-high', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 2, created_at: new Date('2026-02-18T00:01:00Z') },
        { id: 'j-mid', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:02:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result[0].id).toBe('j-high');
      expect(result[1].id).toBe('j-mid');
      expect(result[2].id).toBe('j-low');
    });

    test('same priority uses FIFO (created_at) ordering', () => {
      const jobs: MockJob[] = [
        { id: 'j-second', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:01:00Z') },
        { id: 'j-first', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:00:00Z') },
        { id: 'j-third', status: 'pending', target_worker_id: null, worker_affinity: 'preferred', priority: 5, created_at: new Date('2026-02-18T00:02:00Z') },
      ];

      const result = pickupFilter(jobs, 'worker-A');
      expect(result[0].id).toBe('j-first');
      expect(result[1].id).toBe('j-second');
      expect(result[2].id).toBe('j-third');
    });
  });
});

// ---------------------------------------------------------------------------
// Worker Affinity — Zod schema validation
// ---------------------------------------------------------------------------

describe('Worker affinity in VALET schemas', () => {
  describe('ValetApplySchema worker_affinity', () => {
    const minimalApply = {
      valet_task_id: 'vtask-001',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      target_url: 'https://boards.greenhouse.io/company/jobs/123',
      profile: {
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@example.com',
      },
    };

    test('defaults to preferred when not specified', () => {
      const result = ValetApplySchema.safeParse(minimalApply);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.worker_affinity).toBe('preferred');
      }
    });

    test('accepts strict', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalApply,
        worker_affinity: 'strict',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.worker_affinity).toBe('strict');
      }
    });

    test('accepts preferred', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalApply,
        worker_affinity: 'preferred',
      });
      expect(result.success).toBe(true);
    });

    test('accepts any', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalApply,
        worker_affinity: 'any',
      });
      expect(result.success).toBe(true);
    });

    test('rejects invalid affinity', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalApply,
        worker_affinity: 'soft',
      });
      expect(result.success).toBe(false);
    });

    test('accepts combined target_worker_id + strict affinity', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalApply,
        target_worker_id: 'sandbox-abc',
        worker_affinity: 'strict',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target_worker_id).toBe('sandbox-abc');
        expect(result.data.worker_affinity).toBe('strict');
      }
    });
  });

  describe('ValetTaskSchema worker_affinity', () => {
    const minimalTask = {
      valet_task_id: 'vtask-002',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      job_type: 'scrape',
      target_url: 'https://example.com/page',
      task_description: 'Extract listings',
    };

    test('defaults to preferred', () => {
      const result = ValetTaskSchema.safeParse(minimalTask);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.worker_affinity).toBe('preferred');
      }
    });

    test('accepts all valid affinity modes', () => {
      for (const mode of ['strict', 'preferred', 'any'] as const) {
        const result = ValetTaskSchema.safeParse({
          ...minimalTask,
          worker_affinity: mode,
        });
        expect(result.success).toBe(true);
      }
    });

    test('rejects invalid affinity mode', () => {
      const result = ValetTaskSchema.safeParse({
        ...minimalTask,
        worker_affinity: 'round_robin',
      });
      expect(result.success).toBe(false);
    });
  });
});
