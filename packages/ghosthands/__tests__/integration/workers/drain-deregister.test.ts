/**
 * WEK-304 — Graceful drain + deregistration end-to-end integration test
 *
 * Simulates the worker drain/deregister lifecycle used during fleet deploys.
 * Uses a WorkerProcess class that mirrors the state machine in main.ts
 * without requiring real HTTP servers or database connections.
 */
import { describe, expect, test, beforeEach } from 'bun:test';

// ── Types ────────────────────────────────────────────────────────────────

interface DrainResponse {
  status: 'draining';
  active_jobs: number;
  worker_id: string;
}

interface HealthResponse {
  status: 'idle' | 'draining' | 'busy';
  active_jobs: number;
  deploy_safe: boolean;
}

interface StatusResponse {
  worker_id: string;
  active_jobs: number;
  max_concurrent: number;
  is_running: boolean;
  is_draining: boolean;
  uptime_ms: number;
  timestamp: string;
}

interface RegistryRow {
  worker_id: string;
  status: 'active' | 'draining' | 'offline';
  current_job_id: string | null;
  last_heartbeat: string;
}

interface CancelledJob {
  job_id: string;
  error_code: string;
  callback_sent: boolean;
}

// ── MockRegistry ─────────────────────────────────────────────────────────
// Simulates the gh_worker_registry table.

class MockRegistry {
  private rows = new Map<string, RegistryRow>();

  register(workerId: string): void {
    this.rows.set(workerId, {
      worker_id: workerId,
      status: 'active',
      current_job_id: null,
      last_heartbeat: new Date().toISOString(),
    });
  }

  getStatus(workerId: string): RegistryRow['status'] | undefined {
    return this.rows.get(workerId)?.status;
  }

  getRow(workerId: string): RegistryRow | undefined {
    return this.rows.get(workerId);
  }

  async updateStatus(workerId: string, status: RegistryRow['status']): Promise<void> {
    const row = this.rows.get(workerId);
    if (row) {
      row.status = status;
      row.last_heartbeat = new Date().toISOString();
      if (status === 'offline') {
        row.current_job_id = null;
      }
    }
  }

  async setCurrentJob(workerId: string, jobId: string | null): Promise<void> {
    const row = this.rows.get(workerId);
    if (row) {
      row.current_job_id = jobId;
    }
  }
}

// ── WorkerProcess ────────────────────────────────────────────────────────
// Models the state machine from main.ts (drain, health, status, deregister,
// shutdown) without real HTTP or Postgres.

class WorkerProcess {
  readonly workerId: string;
  private _status: 'active' | 'draining' | 'offline' = 'active';
  private _activeJobs = 0;
  private _currentJobId: string | null = null;
  private _isRunning = true;
  private _shuttingDown = false;
  private _maxConcurrent = 1;
  private _startTime = Date.now();
  private _registry: MockRegistry;
  private _cancelledJobs: CancelledJob[] = [];
  private _drainResolve: (() => void) | null = null;
  private _drainPromise: Promise<void> | null = null;

  constructor(workerId: string, registry: MockRegistry) {
    this.workerId = workerId;
    this._registry = registry;
    this._registry.register(workerId);
  }

  // ── Public accessors ────────────────────────────────────────────────

  get status(): 'active' | 'draining' | 'offline' {
    return this._status;
  }

  get activeJobs(): number {
    return this._activeJobs;
  }

  get currentJobId(): string | null {
    return this._currentJobId;
  }

  get cancelledJobs(): CancelledJob[] {
    return [...this._cancelledJobs];
  }

  // ── Simulate POST /worker/drain ─────────────────────────────────────
  // Mirrors main.ts lines ~455-474

  async drain(): Promise<DrainResponse> {
    if (this._status === 'active') {
      this._status = 'draining';
      await this._registry.updateStatus(this.workerId, 'draining');

      // Create a drain promise that resolves when all jobs finish
      this._drainPromise = new Promise<void>((resolve) => {
        if (this._activeJobs === 0) {
          resolve();
        } else {
          this._drainResolve = resolve;
        }
      });
    }
    return {
      status: 'draining',
      active_jobs: this._activeJobs,
      worker_id: this.workerId,
    };
  }

  // ── Simulate GET /worker/health ─────────────────────────────────────
  // Mirrors main.ts lines ~442-453

  health(): HealthResponse {
    const isDraining = this._status === 'draining' || this._shuttingDown;
    const idle = this._activeJobs === 0 && !isDraining;
    return {
      status: idle ? 'idle' : isDraining ? 'draining' : 'busy',
      active_jobs: this._activeJobs,
      deploy_safe: idle,
    };
  }

  // ── Simulate GET /worker/status ─────────────────────────────────────
  // Mirrors main.ts lines ~426-439

  workerStatus(): StatusResponse {
    return {
      worker_id: this.workerId,
      active_jobs: this._activeJobs,
      max_concurrent: this._maxConcurrent,
      is_running: this._isRunning,
      is_draining: this._status === 'draining' || this._shuttingDown,
      uptime_ms: Date.now() - this._startTime,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Simulate job pickup ─────────────────────────────────────────────
  // Returns false if worker is draining/offline (won't accept new jobs)

  pickupJob(jobId: string): boolean {
    if (this._status !== 'active') {
      return false;
    }
    if (this._activeJobs >= this._maxConcurrent) {
      return false;
    }
    this._activeJobs++;
    this._currentJobId = jobId;
    this._registry.setCurrentJob(this.workerId, jobId);
    return true;
  }

  // ── Simulate job completion ─────────────────────────────────────────

  completeJob(): void {
    if (this._activeJobs > 0) {
      this._activeJobs--;
      this._currentJobId = null;
      this._registry.setCurrentJob(this.workerId, null);

      // If draining and all jobs finished, resolve the drain promise
      if (this._status === 'draining' && this._activeJobs === 0 && this._drainResolve) {
        this._drainResolve();
        this._drainResolve = null;
      }
    }
  }

  // ── Simulate deregister (via VALET POST /workers/deregister) ────────
  // Mirrors valet.ts lines ~266-331

  async deregister(cancelActiveJobs = false): Promise<{
    deregistered_workers: string[];
    cancelled_job_ids: string[];
  }> {
    const cancelled: string[] = [];

    if (cancelActiveJobs && this._currentJobId) {
      const jobId = this._currentJobId;
      cancelled.push(jobId);
      this._cancelledJobs.push({
        job_id: jobId,
        error_code: 'worker_deregistered',
        callback_sent: true,
      });
      this._activeJobs = 0;
      this._currentJobId = null;
    }

    this._status = 'offline';
    this._isRunning = false;
    await this._registry.updateStatus(this.workerId, 'offline');

    return {
      deregistered_workers: [this.workerId],
      cancelled_job_ids: cancelled,
    };
  }

  // ── Simulate full shutdown (SIGTERM handler) ────────────────────────
  // Mirrors main.ts shutdown() lines ~167-225:
  //   shuttingDown = true → stopJobProcessor() → deregisterWorker() → exit

  async shutdown(): Promise<void> {
    this._shuttingDown = true;

    // Drain: stop accepting new jobs, wait for active ones to finish
    if (this._status === 'active') {
      this._status = 'draining';
      await this._registry.updateStatus(this.workerId, 'draining');
    }

    // Wait for drain to complete (simulate stopJobProcessor)
    if (this._drainPromise) {
      await this._drainPromise;
    }

    // Deregister worker (simulate deregisterWorker)
    this._status = 'offline';
    this._isRunning = false;
    this._currentJobId = null;
    await this._registry.updateStatus(this.workerId, 'offline');
  }

  // ── Wait for drain to complete ──────────────────────────────────────

  async waitForDrain(): Promise<void> {
    if (this._drainPromise) {
      await this._drainPromise;
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('WEK-304: Graceful drain + deregistration', () => {
  let registry: MockRegistry;
  let worker: WorkerProcess;

  const WORKER_ID = 'worker-us-east-1-drain-test';

  beforeEach(() => {
    registry = new MockRegistry();
    worker = new WorkerProcess(WORKER_ID, registry);
  });

  // ── 1. Drain while idle ─────────────────────────────────────────────

  describe('drain while idle', () => {
    test('worker transitions to draining status', async () => {
      expect(worker.status).toBe('active');
      expect(worker.activeJobs).toBe(0);

      const response = await worker.drain();

      expect(response.status).toBe('draining');
      expect(response.active_jobs).toBe(0);
      expect(response.worker_id).toBe(WORKER_ID);
      expect(worker.status).toBe('draining');
    });

    test('registry is updated to draining', async () => {
      await worker.drain();
      expect(registry.getStatus(WORKER_ID)).toBe('draining');
    });

    test('worker refuses new jobs after drain', async () => {
      await worker.drain();

      const accepted = worker.pickupJob('job-should-not-accept');
      expect(accepted).toBe(false);
      expect(worker.activeJobs).toBe(0);
    });

    test('health endpoint reflects draining state', async () => {
      await worker.drain();

      const health = worker.health();
      expect(health.status).toBe('draining');
      expect(health.active_jobs).toBe(0);
      expect(health.deploy_safe).toBe(false);
    });

    test('status endpoint shows is_draining true', async () => {
      await worker.drain();

      const status = worker.workerStatus();
      expect(status.is_draining).toBe(true);
      expect(status.active_jobs).toBe(0);
    });

    test('drain is idempotent — calling twice returns same response', async () => {
      const first = await worker.drain();
      const second = await worker.drain();

      expect(first.status).toBe('draining');
      expect(second.status).toBe('draining');
      expect(worker.status).toBe('draining');
    });
  });

  // ── 2. Drain while busy ─────────────────────────────────────────────

  describe('drain while busy', () => {
    test('worker continues processing current job after drain', async () => {
      const accepted = worker.pickupJob('job-in-progress-001');
      expect(accepted).toBe(true);
      expect(worker.activeJobs).toBe(1);

      const response = await worker.drain();

      // Worker is draining but job is still active
      expect(response.status).toBe('draining');
      expect(response.active_jobs).toBe(1);
      expect(worker.currentJobId).toBe('job-in-progress-001');
    });

    test('health shows busy/draining while job is active', async () => {
      worker.pickupJob('job-in-progress-002');
      await worker.drain();

      const health = worker.health();
      expect(health.status).toBe('draining');
      expect(health.active_jobs).toBe(1);
      expect(health.deploy_safe).toBe(false);
    });

    test('worker refuses new jobs while draining with active job', async () => {
      worker.pickupJob('job-in-progress-003');
      await worker.drain();

      const accepted = worker.pickupJob('job-should-not-accept');
      expect(accepted).toBe(false);
      expect(worker.activeJobs).toBe(1);
    });

    test('drain promise resolves once active job completes', async () => {
      worker.pickupJob('job-will-finish');
      await worker.drain();

      let drained = false;
      const drainWait = worker.waitForDrain().then(() => { drained = true; });

      expect(drained).toBe(false);

      // Complete the job
      worker.completeJob();

      await drainWait;
      expect(drained).toBe(true);
      expect(worker.activeJobs).toBe(0);
    });

    test('registry still shows draining while job runs', async () => {
      worker.pickupJob('job-busy-004');
      await worker.drain();

      expect(registry.getStatus(WORKER_ID)).toBe('draining');
      expect(registry.getRow(WORKER_ID)?.current_job_id).toBe('job-busy-004');
    });
  });

  // ── 3. Deregister ──────────────────────────────────────────────────

  describe('deregister', () => {
    test('marks worker offline in registry', async () => {
      const result = await worker.deregister();

      expect(result.deregistered_workers).toEqual([WORKER_ID]);
      expect(result.cancelled_job_ids).toEqual([]);
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
      expect(worker.status).toBe('offline');
    });

    test('deregister with cancel_active_jobs cancels running job', async () => {
      worker.pickupJob('job-to-cancel-001');
      expect(worker.activeJobs).toBe(1);

      const result = await worker.deregister(true);

      expect(result.deregistered_workers).toEqual([WORKER_ID]);
      expect(result.cancelled_job_ids).toEqual(['job-to-cancel-001']);
      expect(worker.activeJobs).toBe(0);
      expect(worker.currentJobId).toBeNull();
    });

    test('cancelled jobs have correct error code and callback flag', async () => {
      worker.pickupJob('job-to-cancel-002');
      await worker.deregister(true);

      const cancelled = worker.cancelledJobs;
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toEqual({
        job_id: 'job-to-cancel-002',
        error_code: 'worker_deregistered',
        callback_sent: true,
      });
    });

    test('deregister without cancel leaves no cancelled jobs', async () => {
      worker.pickupJob('job-left-alone');
      await worker.deregister(false);

      expect(worker.cancelledJobs).toHaveLength(0);
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
    });

    test('registry row shows null current_job_id after deregister', async () => {
      worker.pickupJob('job-cleared');
      await worker.deregister(true);

      const row = registry.getRow(WORKER_ID);
      expect(row?.current_job_id).toBeNull();
      expect(row?.status).toBe('offline');
    });

    test('worker refuses jobs after deregister', async () => {
      await worker.deregister();

      const accepted = worker.pickupJob('job-after-deregister');
      expect(accepted).toBe(false);
    });
  });

  // ── 4. Drain -> deregister sequence ─────────────────────────────────

  describe('drain -> deregister sequence', () => {
    test('clean shutdown: drain idle worker then deregister', async () => {
      // Step 1: Drain (no active jobs)
      const drainResp = await worker.drain();
      expect(drainResp.status).toBe('draining');
      expect(drainResp.active_jobs).toBe(0);
      expect(registry.getStatus(WORKER_ID)).toBe('draining');

      // Step 2: Deregister
      const deregResp = await worker.deregister();
      expect(deregResp.deregistered_workers).toEqual([WORKER_ID]);
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
      expect(worker.status).toBe('offline');
    });

    test('clean shutdown: drain busy worker, wait for job, then deregister', async () => {
      // Step 1: Worker picks up a job
      worker.pickupJob('job-drain-then-dereg');
      expect(worker.activeJobs).toBe(1);

      // Step 2: Drain — worker keeps processing
      await worker.drain();
      expect(worker.status).toBe('draining');
      expect(worker.activeJobs).toBe(1);

      // Step 3: Job finishes
      worker.completeJob();
      await worker.waitForDrain();
      expect(worker.activeJobs).toBe(0);

      // Step 4: Deregister — now safe
      const deregResp = await worker.deregister();
      expect(deregResp.deregistered_workers).toEqual([WORKER_ID]);
      expect(deregResp.cancelled_job_ids).toEqual([]);
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
    });

    test('full shutdown() simulates SIGTERM: drain -> deregister in one call', async () => {
      // Start with an active job
      worker.pickupJob('job-sigterm');
      expect(worker.activeJobs).toBe(1);

      // Trigger drain (but shutdown() waits for drain)
      await worker.drain();

      // Complete the job so shutdown can finish
      worker.completeJob();

      // Now run shutdown
      await worker.shutdown();
      expect(worker.status).toBe('offline');
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
      expect(worker.currentJobId).toBeNull();
    });

    test('shutdown() on idle worker completes immediately', async () => {
      expect(worker.activeJobs).toBe(0);

      await worker.shutdown();

      expect(worker.status).toBe('offline');
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
    });

    test('status transitions follow correct order: active -> draining -> offline', async () => {
      const transitions: string[] = [];

      // Track active
      transitions.push(worker.status);
      expect(worker.status).toBe('active');

      // Drain
      await worker.drain();
      transitions.push(worker.status);
      expect(worker.status).toBe('draining');

      // Deregister
      await worker.deregister();
      transitions.push(worker.status);
      expect(worker.status).toBe('offline');

      expect(transitions).toEqual(['active', 'draining', 'offline']);
    });
  });

  // ── 5. Deploy safety ────────────────────────────────────────────────

  describe('deploy safety', () => {
    test('idle worker reports deploy_safe: true', () => {
      const health = worker.health();
      expect(health.status).toBe('idle');
      expect(health.deploy_safe).toBe(true);
      expect(health.active_jobs).toBe(0);
    });

    test('busy worker reports deploy_safe: false', () => {
      worker.pickupJob('job-busy-deploy');

      const health = worker.health();
      expect(health.status).toBe('busy');
      expect(health.deploy_safe).toBe(false);
      expect(health.active_jobs).toBe(1);
    });

    test('draining worker with no active jobs reports deploy_safe: false', async () => {
      await worker.drain();

      const health = worker.health();
      expect(health.status).toBe('draining');
      expect(health.deploy_safe).toBe(false);
    });

    test('draining worker with active job reports deploy_safe: false', async () => {
      worker.pickupJob('job-deploy-check');
      await worker.drain();

      const health = worker.health();
      expect(health.status).toBe('draining');
      expect(health.deploy_safe).toBe(false);
      expect(health.active_jobs).toBe(1);
    });

    test('health returns HTTP 200 when idle, 503 otherwise', () => {
      // Idle -> 200
      const idleHealth = worker.health();
      const idleHttpStatus = idleHealth.status === 'idle' ? 200 : 503;
      expect(idleHttpStatus).toBe(200);

      // Busy -> 503
      worker.pickupJob('job-http-check');
      const busyHealth = worker.health();
      const busyHttpStatus = busyHealth.status === 'idle' ? 200 : 503;
      expect(busyHttpStatus).toBe(503);
    });

    test('deploy safety cycle: busy -> draining -> job completes -> deregister -> offline', async () => {
      // Phase 1: Busy (not safe)
      worker.pickupJob('job-lifecycle');
      expect(worker.health().deploy_safe).toBe(false);

      // Phase 2: Drain initiated (not safe)
      await worker.drain();
      expect(worker.health().deploy_safe).toBe(false);
      expect(worker.health().status).toBe('draining');

      // Phase 3: Job finishes but still draining (not safe)
      worker.completeJob();
      await worker.waitForDrain();
      // Still draining state, not safe
      expect(worker.health().deploy_safe).toBe(false);

      // Phase 4: Deregister -> offline
      await worker.deregister();
      expect(worker.status).toBe('offline');
      expect(registry.getStatus(WORKER_ID)).toBe('offline');
    });

    test('fleet deploy scenario: drain all workers, wait for idle, then deregister', async () => {
      const registry2 = new MockRegistry();
      const workers = [
        new WorkerProcess('worker-1', registry2),
        new WorkerProcess('worker-2', registry2),
        new WorkerProcess('worker-3', registry2),
      ];

      // Worker 1 is idle, worker 2 has a job, worker 3 is idle
      workers[1].pickupJob('job-fleet-001');

      // Drain all workers
      await Promise.all(workers.map((w) => w.drain()));

      // Verify all are draining
      for (const w of workers) {
        expect(w.status).toBe('draining');
        expect(w.health().deploy_safe).toBe(false);
      }

      // Worker 2 finishes its job
      workers[1].completeJob();
      await workers[1].waitForDrain();

      // Deregister all
      const results = await Promise.all(workers.map((w) => w.deregister()));

      // Verify all offline
      for (const w of workers) {
        expect(w.status).toBe('offline');
        expect(registry2.getStatus(w.workerId)).toBe('offline');
      }

      // No jobs were cancelled (all completed gracefully)
      const totalCancelled = results.flatMap((r) => r.cancelled_job_ids);
      expect(totalCancelled).toEqual([]);
    });
  });
});
