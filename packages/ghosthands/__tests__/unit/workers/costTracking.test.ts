import { describe, expect, test, beforeEach } from 'bun:test';
import { CostTracker } from '../../../src/workers/costControl';
import { ProgressTracker } from '../../../src/workers/progressTracker';

// ---------------------------------------------------------------------------
// CostTracker — mode tracking
// ---------------------------------------------------------------------------

describe('CostTracker mode tracking', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker({ jobId: 'test-job-1' });
  });

  test('getSnapshot() includes cookbookSteps=0, magnitudeSteps=0 by default', () => {
    const snap = tracker.getSnapshot();
    expect(snap.cookbookSteps).toBe(0);
    expect(snap.magnitudeSteps).toBe(0);
    expect(snap.mode).toBeUndefined();
  });

  test('recordModeStep("cookbook") increments cookbookSteps', () => {
    tracker.recordModeStep('cookbook');
    const snap = tracker.getSnapshot();
    expect(snap.cookbookSteps).toBe(1);
    expect(snap.magnitudeSteps).toBe(0);
  });

  test('recordModeStep("magnitude") increments magnitudeSteps', () => {
    tracker.recordModeStep('magnitude');
    const snap = tracker.getSnapshot();
    expect(snap.magnitudeSteps).toBe(1);
    expect(snap.cookbookSteps).toBe(0);
  });

  test('setMode sets mode field in snapshot', () => {
    tracker.setMode('cookbook');
    expect(tracker.getSnapshot().mode).toBe('cookbook');

    tracker.setMode('magnitude');
    expect(tracker.getSnapshot().mode).toBe('magnitude');

    tracker.setMode('hybrid');
    expect(tracker.getSnapshot().mode).toBe('hybrid');
  });

  test('multiple recordModeStep calls accumulate correctly', () => {
    tracker.recordModeStep('cookbook');
    tracker.recordModeStep('cookbook');
    tracker.recordModeStep('cookbook');
    tracker.recordModeStep('magnitude');
    tracker.recordModeStep('magnitude');

    const snap = tracker.getSnapshot();
    expect(snap.cookbookSteps).toBe(3);
    expect(snap.magnitudeSteps).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ProgressTracker — mode tracking
// ---------------------------------------------------------------------------

const mockSupabase = {
  from: () => ({
    insert: () => Promise.resolve({ error: null }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  }),
} as any;

describe('ProgressTracker mode tracking', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker({
      jobId: 'test-job-2',
      supabase: mockSupabase,
      workerId: 'worker-1',
    });
  });

  test('getSnapshot() does not include execution_mode by default', () => {
    const snap = tracker.getSnapshot();
    expect(snap.execution_mode).toBeUndefined();
    expect(snap.manual_id).toBeUndefined();
  });

  test('setExecutionMode sets mode and manualId in snapshot', () => {
    tracker.setExecutionMode('cookbook', 'manual-abc-123');
    const snap = tracker.getSnapshot();
    expect(snap.execution_mode).toBe('cookbook');
    expect(snap.manual_id).toBe('manual-abc-123');
  });

  test('setExecutionMode without manualId only sets mode', () => {
    tracker.setExecutionMode('magnitude');
    const snap = tracker.getSnapshot();
    expect(snap.execution_mode).toBe('magnitude');
    expect(snap.manual_id).toBeUndefined();
  });
});
