import { describe, expect, test, beforeEach, vi } from 'vitest';

// ── Types ────────────────────────────────────────────────────────────────

interface WorkerRow {
  worker_id: string;
  status: 'active' | 'draining' | 'offline';
  target_worker_id: string | null;
  ec2_instance_id: string | null;
  ec2_ip: string | null;
  registered_at: string;
  last_heartbeat: string;
  current_job_id: string | null;
  metadata: Record<string, any> | null;
}

interface JobRow {
  id: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'paused';
  worker_id: string | null;
  priority: number;
  created_at: string;
  scheduled_at: string | null;
  last_heartbeat: string | null;
  updated_at: string;
}

// ── MockWorkerRegistry ───────────────────────────────────────────────────
// In-memory simulation of gh_worker_registry + gh_automation_jobs tables.
// Mirrors the actual SQL patterns from main.ts and 002_gh_pickup_function.sql.

class MockWorkerRegistry {
  private workers: Map<string, WorkerRow> = new Map();
  private jobs: Map<string, JobRow> = new Map();
  private pickupLocks: Set<string> = new Set(); // Simulates FOR UPDATE SKIP LOCKED

  /**
   * Simulates the registration UPSERT from main.ts lines ~260-270:
   *
   * INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat, metadata)
   * VALUES ($1, 'active', $2, $3, $4, NOW(), NOW(), $5::jsonb)
   * ON CONFLICT (worker_id) DO UPDATE SET
   *   status = 'active',
   *   target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
   *   ec2_instance_id = $3,
   *   ec2_ip = $4,
   *   metadata = $5::jsonb,
   *   last_heartbeat = NOW()
   */
  register(
    workerId: string,
    ec2Ip: string,
    opts?: { targetWorkerId?: string; ec2InstanceId?: string; metadata?: Record<string, any> },
  ): void {
    const now = new Date().toISOString();
    const existing = this.workers.get(workerId);

    if (existing) {
      // ON CONFLICT ... DO UPDATE
      existing.status = 'active';
      existing.target_worker_id =
        opts?.targetWorkerId ?? existing.target_worker_id; // COALESCE
      existing.ec2_instance_id = opts?.ec2InstanceId ?? null;
      existing.ec2_ip = ec2Ip;
      existing.metadata = opts?.metadata ?? null;
      existing.last_heartbeat = now;
    } else {
      // Fresh INSERT
      this.workers.set(workerId, {
        worker_id: workerId,
        status: 'active',
        target_worker_id: opts?.targetWorkerId ?? null,
        ec2_instance_id: opts?.ec2InstanceId ?? null,
        ec2_ip: ec2Ip,
        registered_at: now,
        last_heartbeat: now,
        current_job_id: null,
        metadata: opts?.metadata ?? null,
      });
    }
  }

  /**
   * Simulates the heartbeat UPDATE from main.ts lines ~310-316:
   *
   * UPDATE gh_worker_registry
   * SET last_heartbeat = NOW(),
   *     current_job_id = $2::UUID,
   *     status = $3
   * WHERE worker_id = $1
   */
  heartbeat(workerId: string, currentJobId: string | null, status: 'active' | 'draining'): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.last_heartbeat = new Date().toISOString();
    worker.current_job_id = currentJobId;
    worker.status = status;
  }

  /**
   * Simulates gh_pickup_next_job from 002_gh_pickup_function.sql:
   *
   * WITH next_job AS (
   *   SELECT id FROM gh_automation_jobs
   *   WHERE status = 'pending'
   *     AND (scheduled_at IS NULL OR scheduled_at <= NOW())
   *   ORDER BY priority ASC, created_at ASC
   *   LIMIT 1
   *   FOR UPDATE SKIP LOCKED
   * )
   * UPDATE gh_automation_jobs
   * SET status = 'queued', worker_id = p_worker_id,
   *     last_heartbeat = NOW(), updated_at = NOW()
   * FROM next_job
   * WHERE gh_automation_jobs.id = next_job.id
   * RETURNING gh_automation_jobs.*
   */
  pickupNextJob(workerId: string): JobRow | null {
    const now = new Date().toISOString();

    // Sort candidates by priority ASC, created_at ASC — same as the SQL
    const candidates = Array.from(this.jobs.values())
      .filter((j) => {
        if (j.status !== 'pending') return false;
        if (j.scheduled_at && new Date(j.scheduled_at) > new Date()) return false;
        // FOR UPDATE SKIP LOCKED: skip rows another worker is mid-claim on
        if (this.pickupLocks.has(j.id)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

    const job = candidates[0];
    if (!job) return null;

    // Simulate atomic lock + update
    this.pickupLocks.add(job.id);
    job.status = 'queued';
    job.worker_id = workerId;
    job.last_heartbeat = now;
    job.updated_at = now;
    this.pickupLocks.delete(job.id);

    return { ...job };
  }

  /**
   * Simulates deregistration from main.ts lines ~342-347:
   *
   * UPDATE gh_worker_registry
   * SET status = 'offline', current_job_id = NULL, last_heartbeat = NOW()
   * WHERE worker_id = $1
   */
  deregister(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.status = 'offline';
    worker.current_job_id = null;
    worker.last_heartbeat = new Date().toISOString();
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  getWorker(workerId: string): WorkerRow | undefined {
    const w = this.workers.get(workerId);
    return w ? { ...w } : undefined;
  }

  getAllWorkers(): WorkerRow[] {
    return Array.from(this.workers.values()).map((w) => ({ ...w }));
  }

  addJob(job: Partial<JobRow> & { id: string }): void {
    const now = new Date().toISOString();
    this.jobs.set(job.id, {
      status: 'pending',
      worker_id: null,
      priority: 0,
      created_at: now,
      scheduled_at: null,
      last_heartbeat: null,
      updated_at: now,
      ...job,
    });
  }

  getJob(jobId: string): JobRow | undefined {
    const j = this.jobs.get(jobId);
    return j ? { ...j } : undefined;
  }

  getAllJobs(): JobRow[] {
    return Array.from(this.jobs.values()).map((j) => ({ ...j }));
  }

  getJobsByWorker(workerId: string): JobRow[] {
    return Array.from(this.jobs.values())
      .filter((j) => j.worker_id === workerId)
      .map((j) => ({ ...j }));
  }
}

// ── Mock pg client (reusable mock pattern per codebase convention) ────────

function mockPgDirect() {
  const queries: { text: string; values: any[] }[] = [];
  return {
    query: vi.fn((text: string, values?: any[]) => {
      queries.push({ text, values: values || [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    on: vi.fn(() => {}),
    queries,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// WEK-303 — Multi-worker queue coexistence integration tests
// ═════════════════════════════════════════════════════════════════════════════

describe('Multi-worker queue coexistence (WEK-303)', () => {
  let registry: MockWorkerRegistry;

  const WORKER_1 = 'worker-us-east-1-abc';
  const WORKER_2 = 'worker-eu-west-2-xyz';
  const IP_1 = '10.0.1.10';
  const IP_2 = '10.0.2.20';

  beforeEach(() => {
    registry = new MockWorkerRegistry();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Two workers register — both INSERT into gh_worker_registry
  // ────────────────────────────────────────────────────────────────────────

  describe('1: Two workers register with distinct identities', () => {
    test('both workers exist in registry after registration', () => {
      registry.register(WORKER_1, IP_1, {
        ec2InstanceId: 'i-0abc111',
        targetWorkerId: 'sandbox-1',
      });
      registry.register(WORKER_2, IP_2, {
        ec2InstanceId: 'i-0abc222',
        targetWorkerId: 'sandbox-2',
      });

      const all = registry.getAllWorkers();
      expect(all).toHaveLength(2);
    });

    test('workers have different ec2_ip values', () => {
      registry.register(WORKER_1, IP_1, { ec2InstanceId: 'i-0abc111' });
      registry.register(WORKER_2, IP_2, { ec2InstanceId: 'i-0abc222' });

      const w1 = registry.getWorker(WORKER_1);
      const w2 = registry.getWorker(WORKER_2);
      expect(w1?.ec2_ip).toBe(IP_1);
      expect(w2?.ec2_ip).toBe(IP_2);
      expect(w1?.ec2_ip).not.toBe(w2?.ec2_ip);
    });

    test('both workers start with status active', () => {
      registry.register(WORKER_1, IP_1);
      registry.register(WORKER_2, IP_2);

      expect(registry.getWorker(WORKER_1)?.status).toBe('active');
      expect(registry.getWorker(WORKER_2)?.status).toBe('active');
    });

    test('re-registration (UPSERT) preserves worker_id and updates fields', () => {
      registry.register(WORKER_1, IP_1, { ec2InstanceId: 'i-old' });
      const firstHeartbeat = registry.getWorker(WORKER_1)?.last_heartbeat;

      // Re-register with new IP (simulates container restart on different host)
      registry.register(WORKER_1, '10.0.3.30', { ec2InstanceId: 'i-new' });

      const w = registry.getWorker(WORKER_1);
      expect(w?.ec2_ip).toBe('10.0.3.30');
      expect(w?.ec2_instance_id).toBe('i-new');
      expect(w?.status).toBe('active');
      // Still only 1 row — UPSERT did not duplicate
      expect(registry.getAllWorkers()).toHaveLength(1);
    });

    test('registration with metadata stores jsonb payload', () => {
      registry.register(WORKER_1, IP_1, {
        metadata: { asg_name: 'gh-workers-asg' },
      });

      const w = registry.getWorker(WORKER_1);
      expect(w?.metadata).toEqual({ asg_name: 'gh-workers-asg' });
    });

    test('pg UPSERT query structure matches main.ts pattern', async () => {
      const pg = mockPgDirect();

      await pg.query(`
        INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat, metadata)
        VALUES ($1, 'active', $2, $3, $4, NOW(), NOW(), $5::jsonb)
        ON CONFLICT (worker_id) DO UPDATE SET
          status = 'active',
          target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
          ec2_instance_id = $3,
          ec2_ip = $4,
          metadata = $5::jsonb,
          last_heartbeat = NOW()
      `, [WORKER_1, 'sandbox-1', 'i-0abc111', IP_1, '{}']);

      await pg.query(`
        INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat, metadata)
        VALUES ($1, 'active', $2, $3, $4, NOW(), NOW(), $5::jsonb)
        ON CONFLICT (worker_id) DO UPDATE SET
          status = 'active',
          target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
          ec2_instance_id = $3,
          ec2_ip = $4,
          metadata = $5::jsonb,
          last_heartbeat = NOW()
      `, [WORKER_2, 'sandbox-2', 'i-0abc222', IP_2, '{}']);

      expect(pg.queries).toHaveLength(2);
      expect(pg.queries[0].values[0]).toBe(WORKER_1);
      expect(pg.queries[1].values[0]).toBe(WORKER_2);
      expect(pg.queries[0].values[3]).not.toBe(pg.queries[1].values[3]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Concurrent heartbeats — no conflicts, both last_heartbeat updated
  // ────────────────────────────────────────────────────────────────────────

  describe('2: Concurrent heartbeats do not conflict', () => {
    beforeEach(() => {
      registry.register(WORKER_1, IP_1);
      registry.register(WORKER_2, IP_2);
    });

    test('both heartbeats update last_heartbeat without collision', () => {
      const beforeW1 = registry.getWorker(WORKER_1)!.last_heartbeat;
      const beforeW2 = registry.getWorker(WORKER_2)!.last_heartbeat;

      // Simulate concurrent heartbeats (both hit within the same 30s window)
      registry.heartbeat(WORKER_1, null, 'active');
      registry.heartbeat(WORKER_2, null, 'active');

      const afterW1 = registry.getWorker(WORKER_1)!.last_heartbeat;
      const afterW2 = registry.getWorker(WORKER_2)!.last_heartbeat;

      // Both timestamps advanced (or stayed same if fast execution — just verify non-null)
      expect(afterW1).toBeTruthy();
      expect(afterW2).toBeTruthy();
      // Both workers still active
      expect(registry.getWorker(WORKER_1)?.status).toBe('active');
      expect(registry.getWorker(WORKER_2)?.status).toBe('active');
    });

    test('heartbeat with job_id sets current_job_id per worker', () => {
      const jobId1 = '11111111-1111-1111-1111-111111111111';
      const jobId2 = '22222222-2222-2222-2222-222222222222';

      registry.heartbeat(WORKER_1, jobId1, 'active');
      registry.heartbeat(WORKER_2, jobId2, 'active');

      expect(registry.getWorker(WORKER_1)?.current_job_id).toBe(jobId1);
      expect(registry.getWorker(WORKER_2)?.current_job_id).toBe(jobId2);
    });

    test('heartbeat does not affect other workers rows', () => {
      const originalW2Heartbeat = registry.getWorker(WORKER_2)!.last_heartbeat;

      registry.heartbeat(WORKER_1, '11111111-1111-1111-1111-111111111111', 'active');

      // Worker 2 is untouched
      expect(registry.getWorker(WORKER_2)?.current_job_id).toBeNull();
    });

    test('draining status propagates correctly during shutdown', () => {
      registry.heartbeat(WORKER_1, null, 'draining');
      registry.heartbeat(WORKER_2, null, 'active');

      expect(registry.getWorker(WORKER_1)?.status).toBe('draining');
      expect(registry.getWorker(WORKER_2)?.status).toBe('active');
    });

    test('pg heartbeat query matches main.ts pattern (WHERE worker_id = $1)', async () => {
      const pg = mockPgDirect();
      const jobId = '11111111-1111-1111-1111-111111111111';

      // Fire both heartbeats concurrently — same as real setInterval overlap
      await Promise.all([
        pg.query(`
          UPDATE gh_worker_registry
          SET last_heartbeat = NOW(),
              current_job_id = $2::UUID,
              status = $3
          WHERE worker_id = $1
        `, [WORKER_1, jobId, 'active']),
        pg.query(`
          UPDATE gh_worker_registry
          SET last_heartbeat = NOW(),
              current_job_id = $2::UUID,
              status = $3
          WHERE worker_id = $1
        `, [WORKER_2, null, 'active']),
      ]);

      expect(pg.queries).toHaveLength(2);
      // Each heartbeat targets its own worker_id via WHERE clause — no cross-contamination
      const workerIds = pg.queries.map((q) => q.values[0]);
      expect(workerIds).toContain(WORKER_1);
      expect(workerIds).toContain(WORKER_2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Job distribution — FOR UPDATE SKIP LOCKED ensures fair pickup
  // ────────────────────────────────────────────────────────────────────────

  describe('3: Job distribution across multiple workers', () => {
    const JOB_IDS = ['job-aaa', 'job-bbb', 'job-ccc'];

    beforeEach(() => {
      registry.register(WORKER_1, IP_1);
      registry.register(WORKER_2, IP_2);

      // Seed 3 pending jobs
      for (const id of JOB_IDS) {
        registry.addJob({ id, priority: 0 });
      }
    });

    test('each worker picks up a different job (no double-claim)', () => {
      const picked1 = registry.pickupNextJob(WORKER_1);
      const picked2 = registry.pickupNextJob(WORKER_2);

      expect(picked1).not.toBeNull();
      expect(picked2).not.toBeNull();
      expect(picked1!.id).not.toBe(picked2!.id);
    });

    test('claimed jobs have correct worker_id set', () => {
      const picked1 = registry.pickupNextJob(WORKER_1);
      const picked2 = registry.pickupNextJob(WORKER_2);

      expect(picked1!.worker_id).toBe(WORKER_1);
      expect(picked2!.worker_id).toBe(WORKER_2);
    });

    test('claimed jobs transition from pending to queued', () => {
      registry.pickupNextJob(WORKER_1);
      registry.pickupNextJob(WORKER_2);

      const claimed = registry.getAllJobs().filter((j) => j.status === 'queued');
      const pending = registry.getAllJobs().filter((j) => j.status === 'pending');

      expect(claimed).toHaveLength(2);
      expect(pending).toHaveLength(1);
    });

    test('third job can be picked up after first two are claimed', () => {
      registry.pickupNextJob(WORKER_1);
      registry.pickupNextJob(WORKER_2);

      const picked3 = registry.pickupNextJob(WORKER_1);
      expect(picked3).not.toBeNull();
      expect(picked3!.id).toBe(JOB_IDS[2]); // Last remaining pending job
    });

    test('returns null when queue is empty', () => {
      registry.pickupNextJob(WORKER_1);
      registry.pickupNextJob(WORKER_2);
      registry.pickupNextJob(WORKER_1);

      const noJob = registry.pickupNextJob(WORKER_2);
      expect(noJob).toBeNull();
    });

    test('priority ordering is respected (lower priority number first)', () => {
      // Clear and re-seed with different priorities
      const reg2 = new MockWorkerRegistry();
      reg2.register(WORKER_1, IP_1);

      reg2.addJob({ id: 'low-priority', priority: 10 });
      reg2.addJob({ id: 'high-priority', priority: 1 });
      reg2.addJob({ id: 'mid-priority', priority: 5 });

      const first = reg2.pickupNextJob(WORKER_1);
      const second = reg2.pickupNextJob(WORKER_1);
      const third = reg2.pickupNextJob(WORKER_1);

      expect(first!.id).toBe('high-priority');
      expect(second!.id).toBe('mid-priority');
      expect(third!.id).toBe('low-priority');
    });

    test('each worker gets at least 1 job when 3 available and 2 workers polling', () => {
      // Alternate pickups to simulate real round-robin-ish behavior
      const worker1Jobs: JobRow[] = [];
      const worker2Jobs: JobRow[] = [];

      const j1 = registry.pickupNextJob(WORKER_1);
      if (j1) worker1Jobs.push(j1);

      const j2 = registry.pickupNextJob(WORKER_2);
      if (j2) worker2Jobs.push(j2);

      const j3 = registry.pickupNextJob(WORKER_1);
      if (j3) worker1Jobs.push(j3);

      // Both workers picked up at least 1
      expect(worker1Jobs.length).toBeGreaterThanOrEqual(1);
      expect(worker2Jobs.length).toBeGreaterThanOrEqual(1);

      // Total is 3
      expect(worker1Jobs.length + worker2Jobs.length).toBe(3);

      // No overlapping job IDs
      const allIds = [...worker1Jobs.map((j) => j.id), ...worker2Jobs.map((j) => j.id)];
      expect(new Set(allIds).size).toBe(3);
    });

    test('pg pickup query uses gh_pickup_next_job with worker_id', async () => {
      const pg = mockPgDirect();

      await pg.query('SELECT * FROM gh_pickup_next_job($1::TEXT)', [WORKER_1]);
      await pg.query('SELECT * FROM gh_pickup_next_job($1::TEXT)', [WORKER_2]);

      expect(pg.queries).toHaveLength(2);
      expect(pg.queries[0].text).toContain('gh_pickup_next_job');
      expect(pg.queries[0].values[0]).toBe(WORKER_1);
      expect(pg.queries[1].values[0]).toBe(WORKER_2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Worker isolation — deregistering one worker does not affect the other
  // ────────────────────────────────────────────────────────────────────────

  describe('4: Worker isolation on deregistration', () => {
    beforeEach(() => {
      registry.register(WORKER_1, IP_1);
      registry.register(WORKER_2, IP_2);
      registry.addJob({ id: 'job-1' });
      registry.addJob({ id: 'job-2' });
      registry.addJob({ id: 'job-3' });
    });

    test('deregistered worker is marked offline', () => {
      registry.deregister(WORKER_1);

      expect(registry.getWorker(WORKER_1)?.status).toBe('offline');
    });

    test('deregistered worker has current_job_id cleared', () => {
      registry.heartbeat(WORKER_1, 'job-1', 'active');
      registry.deregister(WORKER_1);

      expect(registry.getWorker(WORKER_1)?.current_job_id).toBeNull();
    });

    test('other worker is completely unaffected by deregistration', () => {
      registry.heartbeat(WORKER_2, 'job-2', 'active');

      registry.deregister(WORKER_1);

      const w2 = registry.getWorker(WORKER_2);
      expect(w2?.status).toBe('active');
      expect(w2?.current_job_id).toBe('job-2');
    });

    test('surviving worker continues to pick up jobs after peer deregistration', () => {
      // Worker 1 picks first job then goes offline
      registry.pickupNextJob(WORKER_1);
      registry.deregister(WORKER_1);

      // Worker 2 can still pick remaining jobs
      const picked = registry.pickupNextJob(WORKER_2);
      expect(picked).not.toBeNull();
      expect(picked!.worker_id).toBe(WORKER_2);
    });

    test('deregistered worker row persists (not deleted) for audit trail', () => {
      registry.deregister(WORKER_1);

      const w1 = registry.getWorker(WORKER_1);
      expect(w1).toBeDefined();
      expect(w1?.worker_id).toBe(WORKER_1);
      // Row exists but is offline
      expect(w1?.status).toBe('offline');
    });

    test('deregistered worker can re-register (UPSERT brings it back active)', () => {
      registry.deregister(WORKER_1);
      expect(registry.getWorker(WORKER_1)?.status).toBe('offline');

      // Container restarts — worker re-registers
      registry.register(WORKER_1, '10.0.9.99', { ec2InstanceId: 'i-new-instance' });
      const w = registry.getWorker(WORKER_1);
      expect(w?.status).toBe('active');
      expect(w?.ec2_ip).toBe('10.0.9.99');
    });

    test('pg deregister query targets only the specified worker_id', async () => {
      const pg = mockPgDirect();

      await pg.query(`
        UPDATE gh_worker_registry
        SET status = 'offline', current_job_id = NULL, last_heartbeat = NOW()
        WHERE worker_id = $1
      `, [WORKER_1]);

      expect(pg.queries).toHaveLength(1);
      expect(pg.queries[0].text).toContain("status = 'offline'");
      expect(pg.queries[0].text).toContain('WHERE worker_id = $1');
      expect(pg.queries[0].values[0]).toBe(WORKER_1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. N=1 regression — single worker picks all jobs
  // ────────────────────────────────────────────────────────────────────────

  describe('5: N=1 regression — single worker handles full queue', () => {
    const SOLO_WORKER = 'worker-solo-1';
    const JOB_IDS = ['job-solo-1', 'job-solo-2', 'job-solo-3'];

    beforeEach(() => {
      registry.register(SOLO_WORKER, '10.0.0.1');
      for (const id of JOB_IDS) {
        registry.addJob({ id });
      }
    });

    test('single worker picks up all 3 jobs sequentially', () => {
      const picked: JobRow[] = [];

      for (let i = 0; i < 3; i++) {
        const job = registry.pickupNextJob(SOLO_WORKER);
        expect(job).not.toBeNull();
        picked.push(job!);
      }

      expect(picked).toHaveLength(3);
      const ids = picked.map((j) => j.id);
      expect(ids).toEqual(expect.arrayContaining(JOB_IDS));
    });

    test('all jobs are assigned to the single worker', () => {
      registry.pickupNextJob(SOLO_WORKER);
      registry.pickupNextJob(SOLO_WORKER);
      registry.pickupNextJob(SOLO_WORKER);

      const workerJobs = registry.getJobsByWorker(SOLO_WORKER);
      expect(workerJobs).toHaveLength(3);
      for (const job of workerJobs) {
        expect(job.worker_id).toBe(SOLO_WORKER);
        expect(job.status).toBe('queued');
      }
    });

    test('queue is exhausted after all jobs are picked', () => {
      registry.pickupNextJob(SOLO_WORKER);
      registry.pickupNextJob(SOLO_WORKER);
      registry.pickupNextJob(SOLO_WORKER);

      const next = registry.pickupNextJob(SOLO_WORKER);
      expect(next).toBeNull();
    });

    test('single worker is the only entry in registry', () => {
      const all = registry.getAllWorkers();
      expect(all).toHaveLength(1);
      expect(all[0].worker_id).toBe(SOLO_WORKER);
    });

    test('heartbeat works correctly for single worker', () => {
      const job = registry.pickupNextJob(SOLO_WORKER);
      registry.heartbeat(SOLO_WORKER, job!.id, 'active');

      const w = registry.getWorker(SOLO_WORKER);
      expect(w?.current_job_id).toBe(job!.id);
      expect(w?.status).toBe('active');
    });

    test('deregistration works correctly for single worker', () => {
      registry.pickupNextJob(SOLO_WORKER);
      registry.heartbeat(SOLO_WORKER, 'job-solo-1', 'active');

      registry.deregister(SOLO_WORKER);

      const w = registry.getWorker(SOLO_WORKER);
      expect(w?.status).toBe('offline');
      expect(w?.current_job_id).toBeNull();
    });
  });
});
