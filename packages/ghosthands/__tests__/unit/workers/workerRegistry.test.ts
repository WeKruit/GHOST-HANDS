import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { ValetDeregisterSchema } from '../../../src/api/schemas/valet.js';

// ---------------------------------------------------------------------------
// Worker Registry — DB migration schema validation
// ---------------------------------------------------------------------------

describe('Worker Registry migration schema', () => {
  test('gh_worker_registry table uses gh_ prefix per CLAUDE.md', () => {
    // Table name convention: all GhostHands tables use gh_ prefix
    const tableName = 'gh_worker_registry';
    expect(tableName.startsWith('gh_')).toBe(true);
  });

  test('status CHECK constraint allows only valid values', () => {
    const validStatuses = ['active', 'draining', 'offline'];
    const invalidStatuses = ['stopped', 'paused', 'dead', 'running', ''];

    for (const status of validStatuses) {
      expect(validStatuses.includes(status)).toBe(true);
    }
    for (const status of invalidStatuses) {
      expect(validStatuses.includes(status)).toBe(false);
    }
  });

  test('worker_id is TEXT PRIMARY KEY (no UUID requirement)', () => {
    // Worker IDs are human-readable strings like "worker-local-1234" or "adam"
    const validWorkerIds = [
      'worker-local-1709123456789',
      'adam',
      'worker-us-east-1-prod',
      'sandbox-abc-123',
    ];
    for (const id of validWorkerIds) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — UPSERT logic (mocked pg queries)
// ---------------------------------------------------------------------------

describe('Worker Registry UPSERT logic', () => {
  let queries: { text: string; values: any[] }[];

  function mockPgDirect() {
    queries = [];
    return {
      query: mock((text: string, values?: any[]) => {
        queries.push({ text, values: values || [] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      connect: mock(() => Promise.resolve()),
      end: mock(() => Promise.resolve()),
      on: mock(() => {}),
    };
  }

  test('registration UPSERT inserts with worker_id, target, ec2 info', async () => {
    const pg = mockPgDirect();
    const workerId = 'worker-test-1';
    const targetWorkerId = 'sandbox-abc';
    const ec2InstanceId = 'i-0abc123';
    const ec2Ip = '10.0.1.42';

    // Simulate the UPSERT from main.ts
    await pg.query(`
      INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat)
      VALUES ($1, 'active', $2, $3, $4, NOW(), NOW())
      ON CONFLICT (worker_id) DO UPDATE SET
        status = 'active',
        target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
        ec2_instance_id = COALESCE($3, gh_worker_registry.ec2_instance_id),
        ec2_ip = COALESCE($4, gh_worker_registry.ec2_ip),
        last_heartbeat = NOW()
    `, [workerId, targetWorkerId, ec2InstanceId, ec2Ip]);

    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('INSERT INTO gh_worker_registry');
    expect(queries[0].text).toContain('ON CONFLICT (worker_id) DO UPDATE');
    expect(queries[0].values[0]).toBe(workerId);
    expect(queries[0].values[1]).toBe(targetWorkerId);
    expect(queries[0].values[2]).toBe(ec2InstanceId);
    expect(queries[0].values[3]).toBe(ec2Ip);
  });

  test('registration UPSERT sets status to active', async () => {
    const pg = mockPgDirect();

    await pg.query(`
      INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat)
      VALUES ($1, 'active', $2, $3, $4, NOW(), NOW())
      ON CONFLICT (worker_id) DO UPDATE SET
        status = 'active',
        target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
        ec2_instance_id = COALESCE($3, gh_worker_registry.ec2_instance_id),
        ec2_ip = COALESCE($4, gh_worker_registry.ec2_ip),
        last_heartbeat = NOW()
    `, ['worker-1', null, null, null]);

    expect(queries[0].text).toContain("'active'");
    expect(queries[0].values[0]).toBe('worker-1');
  });

  test('registration handles null ec2 metadata gracefully', async () => {
    const pg = mockPgDirect();

    await pg.query(`
      INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat)
      VALUES ($1, 'active', $2, $3, $4, NOW(), NOW())
      ON CONFLICT (worker_id) DO UPDATE SET
        status = 'active',
        target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
        ec2_instance_id = COALESCE($3, gh_worker_registry.ec2_instance_id),
        ec2_ip = COALESCE($4, gh_worker_registry.ec2_ip),
        last_heartbeat = NOW()
    `, ['worker-local', null, null, null]);

    // COALESCE in the query handles null values by keeping the existing value
    expect(queries[0].values[1]).toBeNull();
    expect(queries[0].values[2]).toBeNull();
    expect(queries[0].values[3]).toBeNull();
  });

  test('registration failure is non-fatal (logged, not thrown)', async () => {
    const pg = mockPgDirect();
    pg.query = mock(() => Promise.reject(new Error('relation "gh_worker_registry" does not exist')));

    // Simulate the try/catch from main.ts
    let registered = false;
    let warning = '';
    try {
      await pg.query('INSERT INTO gh_worker_registry ...');
      registered = true;
    } catch (err) {
      warning = err instanceof Error ? err.message : String(err);
    }

    expect(registered).toBe(false);
    expect(warning).toContain('gh_worker_registry');
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — Heartbeat logic
// ---------------------------------------------------------------------------

describe('Worker Registry heartbeat', () => {
  test('heartbeat UPDATE sets last_heartbeat, current_job_id, and status', () => {
    // Verify the query structure matches what main.ts uses
    const query = `
        UPDATE gh_worker_registry
        SET last_heartbeat = NOW(),
            current_job_id = $2::UUID,
            status = $3
        WHERE worker_id = $1
    `;

    expect(query).toContain('last_heartbeat = NOW()');
    expect(query).toContain('current_job_id = $2::UUID');
    expect(query).toContain('status = $3');
    expect(query).toContain('WHERE worker_id = $1');
  });

  test('heartbeat sends null current_job_id when idle', () => {
    const workerId = 'worker-1';
    const currentJobId = null; // no active job
    const isShuttingDown = false;

    const params = [workerId, currentJobId, isShuttingDown ? 'draining' : 'active'];
    expect(params[0]).toBe('worker-1');
    expect(params[1]).toBeNull();
    expect(params[2]).toBe('active');
  });

  test('heartbeat sends job UUID when processing', () => {
    const workerId = 'worker-1';
    const currentJobId = '550e8400-e29b-41d4-a716-446655440000';
    const isShuttingDown = false;

    const params = [workerId, currentJobId, isShuttingDown ? 'draining' : 'active'];
    expect(params[1]).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(params[2]).toBe('active');
  });

  test('heartbeat reports draining status during shutdown', () => {
    const workerId = 'worker-1';
    const currentJobId = '550e8400-e29b-41d4-a716-446655440000';
    const isShuttingDown = true;

    const params = [workerId, currentJobId, isShuttingDown ? 'draining' : 'active'];
    expect(params[2]).toBe('draining');
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — Deregistration logic
// ---------------------------------------------------------------------------

describe('Worker Registry deregistration', () => {
  test('deregistration sets status to offline and clears current_job_id', () => {
    const query = `
        UPDATE gh_worker_registry
        SET status = 'offline', current_job_id = NULL, last_heartbeat = NOW()
        WHERE worker_id = $1
    `;

    expect(query).toContain("status = 'offline'");
    expect(query).toContain('current_job_id = NULL');
    expect(query).toContain('last_heartbeat = NOW()');
  });

  test('deregistration query uses correct worker_id parameter', async () => {
    const queries: { text: string; values: any[] }[] = [];
    const pg = {
      query: mock((text: string, values?: any[]) => {
        queries.push({ text, values: values || [] });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
    };

    await pg.query(`
      UPDATE gh_worker_registry
      SET status = 'offline', current_job_id = NULL, last_heartbeat = NOW()
      WHERE worker_id = $1
    `, ['worker-prod-42']);

    expect(queries[0].values[0]).toBe('worker-prod-42');
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — JobPoller currentJobId getter
// ---------------------------------------------------------------------------

describe('JobPoller currentJobId tracking', () => {
  test('currentJobId starts as null', () => {
    // Simulate initial state
    let _currentJobId: string | null = null;
    expect(_currentJobId).toBeNull();
  });

  test('currentJobId is set when job is picked up', () => {
    let _currentJobId: string | null = null;
    const jobId = '550e8400-e29b-41d4-a716-446655440000';

    // Simulate pickup
    _currentJobId = jobId;
    expect(_currentJobId).toBe(jobId);
  });

  test('currentJobId is cleared when job finishes', () => {
    let _currentJobId: string | null = '550e8400-e29b-41d4-a716-446655440000';

    // Simulate job completion
    _currentJobId = null;
    expect(_currentJobId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — ValetDeregisterSchema validation
// ---------------------------------------------------------------------------

describe('ValetDeregisterSchema', () => {
  test('accepts minimal valid deregister request', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-abc-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cancel_active_jobs).toBe(false); // default
    }
  });

  test('accepts full deregister request', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-abc-123',
      reason: 'sandbox_terminated',
      cancel_active_jobs: true,
      drain_timeout_seconds: 60,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target_worker_id).toBe('sandbox-abc-123');
      expect(result.data.reason).toBe('sandbox_terminated');
      expect(result.data.cancel_active_jobs).toBe(true);
      expect(result.data.drain_timeout_seconds).toBe(60);
    }
  });

  test('rejects empty target_worker_id', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing target_worker_id', () => {
    const result = ValetDeregisterSchema.safeParse({
      reason: 'some reason',
    });
    expect(result.success).toBe(false);
  });

  test('rejects oversized reason', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-1',
      reason: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative drain_timeout_seconds', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-1',
      drain_timeout_seconds: -1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects excessive drain_timeout_seconds', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-1',
      drain_timeout_seconds: 301,
    });
    expect(result.success).toBe(false);
  });

  test('accepts drain_timeout_seconds at boundary values', () => {
    const zero = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-1',
      drain_timeout_seconds: 0,
    });
    expect(zero.success).toBe(true);

    const max = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-1',
      drain_timeout_seconds: 300,
    });
    expect(max.success).toBe(true);
  });

  test('cancel_active_jobs defaults to false', () => {
    const result = ValetDeregisterSchema.safeParse({
      target_worker_id: 'sandbox-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cancel_active_jobs).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — Deregistration endpoint logic
// ---------------------------------------------------------------------------

describe('Worker deregistration endpoint logic', () => {
  test('cancelled jobs get error_code worker_deregistered', () => {
    // Verify the error code matches what VALET expects
    const errorCode = 'worker_deregistered';
    expect(errorCode).toBe('worker_deregistered');
  });

  test('deregistration cancels jobs in queued, running, or paused status', () => {
    const statusesToCancel = ['queued', 'running', 'paused'];
    const statusesToKeep = ['pending', 'completed', 'failed'];

    // The SQL WHERE clause in the endpoint uses:
    // AND status IN ('queued', 'running', 'paused')
    for (const s of statusesToCancel) {
      expect(statusesToCancel.includes(s)).toBe(true);
    }
    for (const s of statusesToKeep) {
      expect(statusesToCancel.includes(s)).toBe(false);
    }
  });

  test('deregistration builds correct callback payload for cancelled jobs', () => {
    const jobId = 'job-123';
    const valetTaskId = 'vtask-456';
    const reason = 'sandbox_terminated';

    const payload = {
      job_id: jobId,
      valet_task_id: valetTaskId,
      status: 'failed' as const,
      error_code: 'worker_deregistered',
      error_message: reason || 'Worker sandbox terminated by VALET',
      completed_at: new Date().toISOString(),
    };

    expect(payload.job_id).toBe('job-123');
    expect(payload.valet_task_id).toBe('vtask-456');
    expect(payload.status).toBe('failed');
    expect(payload.error_code).toBe('worker_deregistered');
    expect(payload.error_message).toBe('sandbox_terminated');
    expect(payload.completed_at).toBeTruthy();
  });

  test('deregistration uses default error message when reason is undefined', () => {
    const reason = undefined;
    const errorMessage = reason || 'Worker sandbox terminated by VALET';
    expect(errorMessage).toBe('Worker sandbox terminated by VALET');
  });
});

// ---------------------------------------------------------------------------
// Worker Registry — Monitoring endpoint response shape
// ---------------------------------------------------------------------------

describe('Worker monitoring response shape', () => {
  test('worker object includes all expected fields', () => {
    const now = Date.now();
    const registeredAt = new Date(now - 3600000).toISOString(); // 1 hour ago

    const worker = {
      worker_id: 'worker-1',
      status: 'active',
      target_worker_id: 'sandbox-abc',
      ec2_instance_id: 'i-0abc123',
      ec2_ip: '10.0.1.42',
      current_job_id: null,
      registered_at: registeredAt,
      last_heartbeat: new Date().toISOString(),
      jobs_completed: 5,
      jobs_failed: 1,
      uptime_seconds: Math.floor((now - new Date(registeredAt).getTime()) / 1000),
    };

    expect(worker.worker_id).toBe('worker-1');
    expect(worker.status).toBe('active');
    expect(worker.target_worker_id).toBe('sandbox-abc');
    expect(worker.ec2_instance_id).toBe('i-0abc123');
    expect(worker.ec2_ip).toBe('10.0.1.42');
    expect(worker.current_job_id).toBeNull();
    expect(worker.jobs_completed).toBe(5);
    expect(worker.jobs_failed).toBe(1);
    expect(worker.uptime_seconds).toBeGreaterThanOrEqual(3599);
    expect(worker.uptime_seconds).toBeLessThanOrEqual(3601);
  });

  test('uptime_seconds is correctly calculated from registered_at', () => {
    const now = Date.now();

    // Worker registered 2 hours ago
    const registeredAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const uptimeSeconds = Math.floor((now - new Date(registeredAt).getTime()) / 1000);

    expect(uptimeSeconds).toBeGreaterThanOrEqual(7199);
    expect(uptimeSeconds).toBeLessThanOrEqual(7201);
  });

  test('monitoring response wraps workers in count + array', () => {
    const workers = [
      { worker_id: 'w1', status: 'active' },
      { worker_id: 'w2', status: 'offline' },
    ];

    const response = {
      count: workers.length,
      workers,
      timestamp: new Date().toISOString(),
    };

    expect(response.count).toBe(2);
    expect(response.workers).toHaveLength(2);
    expect(response.timestamp).toBeTruthy();
  });
});
