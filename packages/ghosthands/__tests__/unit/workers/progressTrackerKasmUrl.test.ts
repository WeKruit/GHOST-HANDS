import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { ProgressTracker } from '../../../src/workers/progressTracker.js';

// Mock Supabase client
function createMockSupabase() {
  return {
    from: () => ({
      insert: mock(() => ({ error: null })),
    }),
  };
}

// Mock Redis client
function createMockRedis() {
  return {
    xadd: mock(async () => 'ok'),
    expire: mock(async () => 1),
  };
}

describe('WEK-162: kasm_url in progress events', () => {
  let tracker: ProgressTracker;
  const JOB_ID = 'job-kasm-progress-001';
  const WORKER_ID = 'worker-kasm-1';
  const KASM_URL = 'https://kasm.example.com/#/session/abc-123';

  beforeEach(() => {
    tracker = new ProgressTracker({
      jobId: JOB_ID,
      supabase: createMockSupabase() as any,
      workerId: WORKER_ID,
      redis: createMockRedis() as any,
    });
  });

  test('snapshot includes kasm_url after setKasmUrl()', () => {
    tracker.setKasmUrl(KASM_URL);

    const snapshot = tracker.getSnapshot();
    expect(snapshot.kasm_url).toBe(KASM_URL);
  });

  test('snapshot omits kasm_url when not set', () => {
    const snapshot = tracker.getSnapshot();
    expect(snapshot.kasm_url).toBeUndefined();
  });

  test('kasm_url persists across step changes', async () => {
    tracker.setKasmUrl(KASM_URL);
    await tracker.setStep('navigating');

    const snapshot = tracker.getSnapshot();
    expect(snapshot.step).toBe('navigating');
    expect(snapshot.kasm_url).toBe(KASM_URL);
  });

  test('kasm_url persists across action updates', async () => {
    tracker.setKasmUrl(KASM_URL);
    await tracker.onActionStarted('click');
    await tracker.onActionDone('click');

    const snapshot = tracker.getSnapshot();
    expect(snapshot.kasm_url).toBe(KASM_URL);
    expect(snapshot.action_index).toBe(1);
  });

  test('kasm_url coexists with execution_mode and manual_id', () => {
    tracker.setKasmUrl(KASM_URL);
    tracker.setExecutionMode('cookbook', 'manual-abc');

    const snapshot = tracker.getSnapshot();
    expect(snapshot.kasm_url).toBe(KASM_URL);
    expect(snapshot.execution_mode).toBe('cookbook');
    expect(snapshot.manual_id).toBe('manual-abc');
  });
});
