import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { CallbackNotifier } from '../../../src/workers/callbackNotifier.js';
import type { CallbackPayload } from '../../../src/workers/callbackNotifier.js';
import { createValetRoutes } from '../../../src/api/routes/valet.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Capture all payloads sent by CallbackNotifier via fetch. */
function createFetchCapture() {
  const payloads: CallbackPayload[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    payloads.push(JSON.parse(init!.body as string));
    return new Response('OK', { status: 200 });
  }) as typeof fetch;

  return {
    payloads,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

// ── worker_id propagation through all callback types ────────────────────

describe('worker_id propagation through callback chain', () => {
  let notifier: CallbackNotifier;
  let capture: ReturnType<typeof createFetchCapture>;

  const CALLBACK_URL = 'https://valet.example.com/callback';
  const WORKER_ID = 'worker-us-east-1-abc';
  const JOB_ID = 'job-int-001';
  const VALET_TASK_ID = 'valet-task-int-001';

  beforeEach(() => {
    notifier = new CallbackNotifier();
    capture = createFetchCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  test('full lifecycle: running -> completed includes worker_id', async () => {
    // Step 1: Job starts running
    await notifier.notifyRunning(JOB_ID, CALLBACK_URL, VALET_TASK_ID, undefined, WORKER_ID);

    // Step 2: Job completes
    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'completed',
      worker_id: WORKER_ID,
      result_data: { submitted: true },
      result_summary: 'Application submitted',
      llm_cost_cents: 5,
      action_count: 8,
      total_tokens: 1500,
    });

    expect(capture.payloads).toHaveLength(2);

    // Running callback
    const running = capture.payloads[0];
    expect(running.status).toBe('running');
    expect(running.worker_id).toBe(WORKER_ID);
    expect(running.job_id).toBe(JOB_ID);

    // Completed callback
    const completed = capture.payloads[1];
    expect(completed.status).toBe('completed');
    expect(completed.worker_id).toBe(WORKER_ID);
    expect(completed.result_summary).toBe('Application submitted');
  });

  test('full lifecycle: running -> failed includes worker_id', async () => {
    await notifier.notifyRunning(JOB_ID, CALLBACK_URL, VALET_TASK_ID, undefined, WORKER_ID);

    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'failed',
      worker_id: WORKER_ID,
      error_code: 'timeout',
      error_details: { message: 'Job execution timeout' },
    });

    expect(capture.payloads).toHaveLength(2);

    const running = capture.payloads[0];
    expect(running.worker_id).toBe(WORKER_ID);

    const failed = capture.payloads[1];
    expect(failed.status).toBe('failed');
    expect(failed.worker_id).toBe(WORKER_ID);
    expect(failed.error_code).toBe('timeout');
  });

  test('HITL lifecycle: running -> needs_human -> resumed -> completed includes worker_id', async () => {
    // 1. Running
    await notifier.notifyRunning(JOB_ID, CALLBACK_URL, VALET_TASK_ID, undefined, WORKER_ID);

    // 2. Needs human
    await notifier.notifyHumanNeeded(
      JOB_ID,
      CALLBACK_URL,
      {
        type: 'captcha',
        screenshot_url: 'https://screenshots.example.com/captcha.png',
        page_url: 'https://boards.greenhouse.io/apply',
        timeout_seconds: 300,
      },
      VALET_TASK_ID,
      WORKER_ID,
    );

    // 3. Resumed
    await notifier.notifyResumed(JOB_ID, CALLBACK_URL, VALET_TASK_ID, WORKER_ID);

    // 4. Completed
    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'completed',
      worker_id: WORKER_ID,
      result_data: { submitted: true },
    });

    expect(capture.payloads).toHaveLength(4);

    // All four callbacks carry worker_id
    for (const payload of capture.payloads) {
      expect(payload.worker_id).toBe(WORKER_ID);
      expect(payload.job_id).toBe(JOB_ID);
    }

    // Verify correct status sequence
    const statuses = capture.payloads.map((p) => p.status);
    expect(statuses).toEqual(['running', 'needs_human', 'resumed', 'completed']);
  });

  test('needs_human callback includes interaction data alongside worker_id', async () => {
    await notifier.notifyHumanNeeded(
      JOB_ID,
      CALLBACK_URL,
      {
        type: 'login',
        screenshot_url: 'https://screenshots.example.com/login.png',
        page_url: 'https://linkedin.com/login',
        timeout_seconds: 120,
      },
      VALET_TASK_ID,
      WORKER_ID,
    );

    expect(capture.payloads).toHaveLength(1);
    const payload = capture.payloads[0];
    expect(payload.worker_id).toBe(WORKER_ID);
    expect(payload.interaction).toEqual({
      type: 'login',
      screenshot_url: 'https://screenshots.example.com/login.png',
      page_url: 'https://linkedin.com/login',
      timeout_seconds: 120,
    });
  });

  test('completed callback includes cost data alongside worker_id', async () => {
    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'completed',
      worker_id: WORKER_ID,
      result_data: { submitted: true },
      llm_cost_cents: 250,
      action_count: 12,
      total_tokens: 5000,
      execution_mode: 'cookbook',
      final_mode: 'cookbook',
    });

    const payload = capture.payloads[0];
    expect(payload.worker_id).toBe(WORKER_ID);
    expect(payload.cost).toEqual({
      total_cost_usd: 2.5,
      action_count: 12,
      total_tokens: 5000,
    });
    expect(payload.execution_mode).toBe('cookbook');
    expect(payload.final_mode).toBe('cookbook');
  });

  test('worker_id is consistent across all callback types from same worker', async () => {
    const differentJobIds = ['job-a', 'job-b', 'job-c', 'job-d', 'job-e'];

    await notifier.notifyRunning(differentJobIds[0], CALLBACK_URL, null, undefined, WORKER_ID);
    await notifier.notifyFromJob({
      id: differentJobIds[1],
      callback_url: CALLBACK_URL,
      status: 'completed',
      worker_id: WORKER_ID,
    });
    await notifier.notifyFromJob({
      id: differentJobIds[2],
      callback_url: CALLBACK_URL,
      status: 'failed',
      worker_id: WORKER_ID,
      error_code: 'internal_error',
      error_details: { message: 'Something broke' },
    });
    await notifier.notifyHumanNeeded(
      differentJobIds[3], CALLBACK_URL, { type: 'captcha' }, null, WORKER_ID,
    );
    await notifier.notifyResumed(differentJobIds[4], CALLBACK_URL, null, WORKER_ID);

    expect(capture.payloads).toHaveLength(5);
    for (const payload of capture.payloads) {
      expect(payload.worker_id).toBe(WORKER_ID);
    }
  });
});

// ── Backward compatibility: no worker_id ────────────────────────────────

describe('backward compatibility — no worker_id', () => {
  let notifier: CallbackNotifier;
  let capture: ReturnType<typeof createFetchCapture>;

  const CALLBACK_URL = 'https://valet.example.com/callback';

  beforeEach(() => {
    notifier = new CallbackNotifier();
    capture = createFetchCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  test('notifyFromJob without worker_id does not include it in payload', async () => {
    await notifier.notifyFromJob({
      id: 'job-no-wid',
      callback_url: CALLBACK_URL,
      status: 'completed',
      result_data: { done: true },
    });

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]).not.toHaveProperty('worker_id');
  });

  test('notifyRunning without worker_id does not include it in payload', async () => {
    await notifier.notifyRunning('job-no-wid', CALLBACK_URL, 'vt-1');

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]).not.toHaveProperty('worker_id');
  });

  test('notifyHumanNeeded without worker_id does not include it in payload', async () => {
    await notifier.notifyHumanNeeded('job-no-wid', CALLBACK_URL, { type: 'captcha' }, 'vt-1');

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]).not.toHaveProperty('worker_id');
  });

  test('notifyResumed without worker_id does not include it in payload', async () => {
    await notifier.notifyResumed('job-no-wid', CALLBACK_URL, 'vt-1');

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]).not.toHaveProperty('worker_id');
  });
});

// ── VALET status endpoint returns worker_id ─────────────────────────────

describe('VALET status endpoint — worker_id', () => {
  function createMockPool(jobRow: Record<string, any> | null) {
    return {
      query: async (_sql: string, _params: any[]) => ({
        rows: jobRow ? [jobRow] : [],
        rowCount: jobRow ? 1 : 0,
      }),
    } as any;
  }

  test('GET /valet/status/:jobId returns worker_id when set', async () => {
    const pool = createMockPool({
      id: '11111111-1111-1111-1111-111111111111',
      status: 'running',
      status_message: 'Executing apply handler',
      result_data: null,
      result_summary: null,
      error_code: null,
      error_details: null,
      screenshot_urls: null,
      interaction_type: null,
      interaction_data: null,
      paused_at: null,
      started_at: '2026-02-18T06:00:00Z',
      completed_at: null,
      created_at: '2026-02-18T05:59:00Z',
      metadata: JSON.stringify({ source: 'valet' }),
      callback_url: 'https://valet.example.com/callback',
      valet_task_id: 'valet-task-001',
      execution_mode: 'auto',
      browser_mode: 'server',
      final_mode: null,
      worker_id: 'worker-us-east-1-abc',
    });

    const app = createValetRoutes(pool);
    const res = await app.request('/status/11111111-1111-1111-1111-111111111111');
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.worker_id).toBe('worker-us-east-1-abc');
    expect(body.status).toBe('running');
  });

  test('GET /valet/status/:jobId returns worker_id null when not set', async () => {
    const pool = createMockPool({
      id: '22222222-2222-2222-2222-222222222222',
      status: 'pending',
      status_message: null,
      result_data: null,
      result_summary: null,
      error_code: null,
      error_details: null,
      screenshot_urls: null,
      interaction_type: null,
      interaction_data: null,
      paused_at: null,
      started_at: null,
      completed_at: null,
      created_at: '2026-02-18T05:59:00Z',
      metadata: JSON.stringify({}),
      callback_url: null,
      valet_task_id: 'valet-task-002',
      execution_mode: 'auto',
      browser_mode: 'server',
      final_mode: null,
      worker_id: null,
    });

    const app = createValetRoutes(pool);
    const res = await app.request('/status/22222222-2222-2222-2222-222222222222');
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.worker_id).toBeNull();
  });

  test('GET /valet/status/:jobId returns worker_id alongside completed result', async () => {
    const pool = createMockPool({
      id: '33333333-3333-3333-3333-333333333333',
      status: 'completed',
      status_message: 'Done',
      result_data: {
        submitted: true,
        cost: { total_cost_usd: 0.05, action_count: 10, input_tokens: 1000, output_tokens: 500 },
      },
      result_summary: 'Application submitted',
      error_code: null,
      error_details: null,
      screenshot_urls: ['https://screenshots.example.com/final.png'],
      interaction_type: null,
      interaction_data: null,
      paused_at: null,
      started_at: '2026-02-18T06:00:00Z',
      completed_at: '2026-02-18T06:01:00Z',
      created_at: '2026-02-18T05:59:00Z',
      metadata: JSON.stringify({
        source: 'valet',
        engine: { manual_id: 'manual-1', manual_status: 'cookbook_success', health_score: 95 },
        cost_breakdown: { cookbook_steps: 5, magnitude_steps: 0, cookbook_cost_usd: 0.05, magnitude_cost_usd: 0 },
      }),
      callback_url: 'https://valet.example.com/callback',
      valet_task_id: 'valet-task-003',
      execution_mode: 'cookbook',
      browser_mode: 'server',
      final_mode: 'cookbook',
      worker_id: 'worker-eu-west-2-xyz',
    });

    const app = createValetRoutes(pool);
    const res = await app.request('/status/33333333-3333-3333-3333-333333333333');
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.worker_id).toBe('worker-eu-west-2-xyz');
    expect(body.status).toBe('completed');
    expect(body.result).not.toBeNull();
    expect(body.result.summary).toBe('Application submitted');
    expect(body.manual).toEqual({
      id: 'manual-1',
      status: 'cookbook_success',
      health_score: 95,
      fallback_reason: null,
    });
  });

  test('GET /valet/status/:jobId returns worker_id alongside failed error', async () => {
    const pool = createMockPool({
      id: '44444444-4444-4444-4444-444444444444',
      status: 'failed',
      status_message: 'Captcha detected',
      result_data: null,
      result_summary: null,
      error_code: 'captcha_blocked',
      error_details: { message: 'CAPTCHA detected on page' },
      screenshot_urls: null,
      interaction_type: null,
      interaction_data: null,
      paused_at: null,
      started_at: '2026-02-18T06:00:00Z',
      completed_at: '2026-02-18T06:00:30Z',
      created_at: '2026-02-18T05:59:00Z',
      metadata: JSON.stringify({}),
      callback_url: null,
      valet_task_id: 'valet-task-004',
      execution_mode: 'auto',
      browser_mode: 'server',
      final_mode: null,
      worker_id: 'worker-us-west-1-fail',
    });

    const app = createValetRoutes(pool);
    const res = await app.request('/status/44444444-4444-4444-4444-444444444444');
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.worker_id).toBe('worker-us-west-1-fail');
    expect(body.status).toBe('failed');
    expect(body.error).toEqual({
      code: 'captcha_blocked',
      details: { message: 'CAPTCHA detected on page' },
    });
  });

  test('GET /valet/status returns 404 for unknown job', async () => {
    const pool = createMockPool(null);
    const app = createValetRoutes(pool);
    const res = await app.request('/status/99999999-9999-9999-9999-999999999999');
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});
