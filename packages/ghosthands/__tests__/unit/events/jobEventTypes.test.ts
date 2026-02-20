import { describe, expect, test, beforeEach } from 'vitest';
import { JOB_EVENT_TYPES, ThoughtThrottle } from '../../../src/events/JobEventTypes';
import type { JobEventType } from '../../../src/events/JobEventTypes';

// ── JOB_EVENT_TYPES ──────────────────────────────────────────────────────

describe('JOB_EVENT_TYPES', () => {
  test('all values are unique strings', () => {
    const values = Object.values(JOB_EVENT_TYPES);
    expect(values.length).toBeGreaterThan(0);

    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);

    for (const v of values) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  test('all values are lowercase snake_case', () => {
    for (const [key, value] of Object.entries(JOB_EVENT_TYPES)) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test('contains expected lifecycle events', () => {
    expect(JOB_EVENT_TYPES.JOB_STARTED).toBe('job_started');
    expect(JOB_EVENT_TYPES.JOB_COMPLETED).toBe('job_completed');
    expect(JOB_EVENT_TYPES.JOB_FAILED).toBe('job_failed');
  });

  test('contains expected mode events', () => {
    expect(JOB_EVENT_TYPES.MODE_SELECTED).toBe('mode_selected');
    expect(JOB_EVENT_TYPES.MODE_SWITCHED).toBe('mode_switched');
  });

  test('contains expected step events', () => {
    expect(JOB_EVENT_TYPES.STEP_STARTED).toBe('step_started');
    expect(JOB_EVENT_TYPES.STEP_COMPLETED).toBe('step_completed');
  });

  test('contains thought event', () => {
    expect(JOB_EVENT_TYPES.THOUGHT).toBe('thought');
  });

  test('contains observation events', () => {
    expect(JOB_EVENT_TYPES.OBSERVATION_STARTED).toBe('observation_started');
    expect(JOB_EVENT_TYPES.OBSERVATION_COMPLETED).toBe('observation_completed');
  });

  test('contains cookbook events', () => {
    expect(JOB_EVENT_TYPES.COOKBOOK_STEP_STARTED).toBe('cookbook_step_started');
    expect(JOB_EVENT_TYPES.COOKBOOK_STEP_COMPLETED).toBe('cookbook_step_completed');
    expect(JOB_EVENT_TYPES.COOKBOOK_STEP_FAILED).toBe('cookbook_step_failed');
  });

  test('contains cost event', () => {
    expect(JOB_EVENT_TYPES.TOKENS_USED).toBe('tokens_used');
  });

  test('contains manual events', () => {
    expect(JOB_EVENT_TYPES.MANUAL_FOUND).toBe('manual_found');
    expect(JOB_EVENT_TYPES.MANUAL_CREATED).toBe('manual_created');
  });

  test('contains session events', () => {
    expect(JOB_EVENT_TYPES.SESSION_RESTORED).toBe('session_restored');
    expect(JOB_EVENT_TYPES.SESSION_SAVED).toBe('session_saved');
  });

  test('contains HITL events', () => {
    expect(JOB_EVENT_TYPES.HITL_PAUSED).toBe('hitl_paused');
    expect(JOB_EVENT_TYPES.HITL_RESUMED).toBe('hitl_resumed');
    expect(JOB_EVENT_TYPES.HITL_TIMEOUT).toBe('hitl_timeout');
  });

  test('contains browser crash events', () => {
    expect(JOB_EVENT_TYPES.BROWSER_CRASH_DETECTED).toBe('browser_crash_detected');
    expect(JOB_EVENT_TYPES.BROWSER_CRASH_RECOVERED).toBe('browser_crash_recovered');
  });

  test('contains trace recording events', () => {
    expect(JOB_EVENT_TYPES.TRACE_RECORDING_STARTED).toBe('trace_recording_started');
    expect(JOB_EVENT_TYPES.TRACE_RECORDING_COMPLETED).toBe('trace_recording_completed');
  });

  test('contains progress and budget events', () => {
    expect(JOB_EVENT_TYPES.PROGRESS_UPDATE).toBe('progress_update');
    expect(JOB_EVENT_TYPES.BUDGET_PREFLIGHT_FAILED).toBe('budget_preflight_failed');
  });

  test('has at least 25 event types', () => {
    const count = Object.keys(JOB_EVENT_TYPES).length;
    expect(count).toBeGreaterThanOrEqual(25);
  });
});

// ── ThoughtThrottle ──────────────────────────────────────────────────────

describe('ThoughtThrottle', () => {
  test('first call always emits', () => {
    const throttle = new ThoughtThrottle(2000);
    expect(throttle.shouldEmit()).toBe(true);
  });

  test('second call within interval is blocked', () => {
    const throttle = new ThoughtThrottle(2000);
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);
  });

  test('emits after interval has passed', async () => {
    const throttle = new ThoughtThrottle(50); // short interval for test
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);

    // Wait for interval to pass
    await new Promise((r) => setTimeout(r, 60));

    expect(throttle.shouldEmit()).toBe(true);
  });

  test('reset clears the timer', () => {
    const throttle = new ThoughtThrottle(2000);
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);

    throttle.reset();
    expect(throttle.shouldEmit()).toBe(true);
  });

  test('getLastEmitTime returns correct timestamp', () => {
    const throttle = new ThoughtThrottle(2000);
    expect(throttle.getLastEmitTime()).toBe(0);

    const before = Date.now();
    throttle.shouldEmit();
    const after = Date.now();

    expect(throttle.getLastEmitTime()).toBeGreaterThanOrEqual(before);
    expect(throttle.getLastEmitTime()).toBeLessThanOrEqual(after);
  });

  test('default interval is 2000ms', () => {
    const throttle = new ThoughtThrottle();
    expect(throttle.shouldEmit()).toBe(true);
    // Immediate second call should be blocked (2000ms has not passed)
    expect(throttle.shouldEmit()).toBe(false);
  });

  test('custom interval works', async () => {
    const throttle = new ThoughtThrottle(30);
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);

    await new Promise((r) => setTimeout(r, 40));
    expect(throttle.shouldEmit()).toBe(true);
  });
});
