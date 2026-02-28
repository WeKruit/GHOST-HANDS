import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { CallbackNotifier } from '../../../src/workers/callbackNotifier.js';
import type { CallbackPayload } from '../../../src/workers/callbackNotifier.js';

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

describe('WEK-162: kasm_url in callback payloads', () => {
  let notifier: CallbackNotifier;
  let capture: ReturnType<typeof createFetchCapture>;
  const originalEnv = process.env.KASM_SESSION_URL;

  const CALLBACK_URL = 'https://valet.example.com/callback';
  const JOB_ID = 'job-kasm-001';
  const VALET_TASK_ID = 'valet-task-kasm-001';
  const WORKER_ID = 'worker-kasm-1';
  const KASM_URL = 'https://kasm.example.com/#/session/abc-123';

  beforeEach(() => {
    notifier = new CallbackNotifier();
    capture = createFetchCapture();
    delete process.env.KASM_SESSION_URL;
  });

  afterEach(() => {
    capture.restore();
    if (originalEnv !== undefined) {
      process.env.KASM_SESSION_URL = originalEnv;
    } else {
      delete process.env.KASM_SESSION_URL;
    }
  });

  // ── notifyRunning ──────────────────────────────────────────────────

  test('notifyRunning includes kasm_url from metadata', async () => {
    await notifier.notifyRunning(
      JOB_ID, CALLBACK_URL, VALET_TASK_ID,
      { kasm_url: KASM_URL },
      WORKER_ID,
    );

    expect(capture.payloads).toHaveLength(1);
    const payload = capture.payloads[0]!;
    expect(payload.status).toBe('running');
    expect(payload.kasm_url).toBe(KASM_URL);
    expect(payload.worker_id).toBe(WORKER_ID);
  });

  test('notifyRunning includes kasm_url from KASM_SESSION_URL env', async () => {
    process.env.KASM_SESSION_URL = 'https://kasm.example.com/#/session/env-123';

    await notifier.notifyRunning(JOB_ID, CALLBACK_URL, VALET_TASK_ID, {}, WORKER_ID);

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]!.kasm_url).toBe('https://kasm.example.com/#/session/env-123');
  });

  test('notifyRunning metadata kasm_url takes precedence over env', async () => {
    process.env.KASM_SESSION_URL = 'https://kasm.example.com/#/session/env-fallback';

    await notifier.notifyRunning(
      JOB_ID, CALLBACK_URL, VALET_TASK_ID,
      { kasm_url: KASM_URL },
      WORKER_ID,
    );

    expect(capture.payloads[0]!.kasm_url).toBe(KASM_URL);
  });

  test('notifyRunning omits kasm_url when not available', async () => {
    await notifier.notifyRunning(JOB_ID, CALLBACK_URL, VALET_TASK_ID, {}, WORKER_ID);

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]!.kasm_url).toBeUndefined();
  });

  // ── notifyHumanNeeded ──────────────────────────────────────────────

  test('notifyHumanNeeded includes kasm_url', async () => {
    await notifier.notifyHumanNeeded(
      JOB_ID, CALLBACK_URL,
      { type: 'captcha', description: 'reCAPTCHA detected' },
      VALET_TASK_ID, WORKER_ID, undefined,
      KASM_URL,
    );

    expect(capture.payloads).toHaveLength(1);
    const payload = capture.payloads[0]!;
    expect(payload.status).toBe('needs_human');
    expect(payload.kasm_url).toBe(KASM_URL);
    expect(payload.interaction?.type).toBe('captcha');
  });

  test('notifyHumanNeeded falls back to KASM_SESSION_URL env', async () => {
    process.env.KASM_SESSION_URL = KASM_URL;

    await notifier.notifyHumanNeeded(
      JOB_ID, CALLBACK_URL,
      { type: '2fa', description: '2FA required' },
      VALET_TASK_ID, WORKER_ID,
    );

    expect(capture.payloads[0]!.kasm_url).toBe(KASM_URL);
  });

  // ── notifyResumed ──────────────────────────────────────────────────

  test('notifyResumed includes kasm_url', async () => {
    await notifier.notifyResumed(JOB_ID, CALLBACK_URL, VALET_TASK_ID, WORKER_ID, KASM_URL);

    expect(capture.payloads).toHaveLength(1);
    const payload = capture.payloads[0]!;
    expect(payload.status).toBe('resumed');
    expect(payload.kasm_url).toBe(KASM_URL);
  });

  test('notifyResumed falls back to KASM_SESSION_URL env', async () => {
    process.env.KASM_SESSION_URL = KASM_URL;

    await notifier.notifyResumed(JOB_ID, CALLBACK_URL, VALET_TASK_ID, WORKER_ID);

    expect(capture.payloads[0]!.kasm_url).toBe(KASM_URL);
  });

  test('notifyResumed omits kasm_url when not available', async () => {
    await notifier.notifyResumed(JOB_ID, CALLBACK_URL, VALET_TASK_ID, WORKER_ID);

    expect(capture.payloads[0]!.kasm_url).toBeUndefined();
  });

  // ── notifyFromJob ──────────────────────────────────────────────────

  test('notifyFromJob includes kasm_url from job metadata.kasm_session_url', async () => {
    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'completed',
      worker_id: WORKER_ID,
      result_data: { submitted: true },
      metadata: { kasm_session_url: KASM_URL },
    });

    expect(capture.payloads).toHaveLength(1);
    expect(capture.payloads[0]!.kasm_url).toBe(KASM_URL);
  });

  test('notifyFromJob includes kasm_url from job metadata.kasm_url', async () => {
    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'completed',
      metadata: { kasm_url: KASM_URL },
    });

    expect(capture.payloads[0]!.kasm_url).toBe(KASM_URL);
  });

  test('notifyFromJob falls back to KASM_SESSION_URL env', async () => {
    process.env.KASM_SESSION_URL = KASM_URL;

    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'failed',
      error_code: 'TIMEOUT',
      error_details: { message: 'Timed out' },
    });

    expect(capture.payloads[0]!.kasm_url).toBe(KASM_URL);
  });

  test('notifyFromJob omits kasm_url when not in metadata or env', async () => {
    await notifier.notifyFromJob({
      id: JOB_ID,
      valet_task_id: VALET_TASK_ID,
      callback_url: CALLBACK_URL,
      status: 'completed',
    });

    expect(capture.payloads[0]!.kasm_url).toBeUndefined();
  });

  // ── backward compatibility ─────────────────────────────────────────

  test('kasm_url is optional — existing payloads without it still work', async () => {
    await notifier.notifyRunning(JOB_ID, CALLBACK_URL, VALET_TASK_ID, undefined, WORKER_ID);

    const payload = capture.payloads[0]!;
    expect(payload.job_id).toBe(JOB_ID);
    expect(payload.status).toBe('running');
    expect(payload.worker_id).toBe(WORKER_ID);
    expect(payload.kasm_url).toBeUndefined();
    // completed_at is only set for terminal statuses (completed/failed)
    expect(payload.completed_at).toBeUndefined();
  });
});
