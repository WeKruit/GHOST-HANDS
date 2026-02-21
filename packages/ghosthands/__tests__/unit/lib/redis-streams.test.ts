import { describe, expect, test, vi, beforeEach } from 'vitest';
import {
  streamKey,
  xaddEvent,
  setStreamTTL,
  xtrimStream,
  deleteStream,
  type StreamEventFields,
} from '../../../src/lib/redis-streams.js';

// ── Mock Redis client ──────────────────────────────────────────────────────

function createMockRedis() {
  return {
    xadd: vi.fn().mockResolvedValue('1234567890-0'),
    expire: vi.fn().mockResolvedValue(1),
    xtrim: vi.fn().mockResolvedValue(0),
    del: vi.fn().mockResolvedValue(1),
  };
}

// ── streamKey ──────────────────────────────────────────────────────────────

describe('streamKey', () => {
  test('returns correct key format for a UUID job ID', () => {
    const jobId = '550e8400-e29b-41d4-a716-446655440000';
    expect(streamKey(jobId)).toBe('gh:events:550e8400-e29b-41d4-a716-446655440000');
  });

  test('returns correct key format for a simple job ID', () => {
    expect(streamKey('abc-123')).toBe('gh:events:abc-123');
  });

  test('handles empty string', () => {
    expect(streamKey('')).toBe('gh:events:');
  });
});

// ── xaddEvent ──────────────────────────────────────────────────────────────

describe('xaddEvent', () => {
  let redis: ReturnType<typeof createMockRedis>;

  const sampleEvent: StreamEventFields = {
    step: 'filling',
    progress_pct: 45,
    description: 'Filling form fields',
    action_index: 3,
    total_actions_estimate: 8,
    current_action: 'Typing first name',
    started_at: '2026-02-20T10:00:00Z',
    elapsed_ms: 1200,
    eta_ms: 1500,
    timestamp: '2026-02-20T10:00:01Z',
  };

  beforeEach(() => {
    redis = createMockRedis();
  });

  test('calls redis.xadd with correct stream key', async () => {
    const jobId = 'job-123';
    await xaddEvent(redis as any, jobId, sampleEvent);

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const args = redis.xadd.mock.calls[0];
    expect(args[0]).toBe('gh:events:job-123');
  });

  test('calls redis.xadd with MAXLEN ~ 1000 and *', async () => {
    await xaddEvent(redis as any, 'job-123', sampleEvent);

    const args = redis.xadd.mock.calls[0];
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe('1000');
    expect(args[4]).toBe('*');
  });

  test('flattens event fields to string key-value pairs', async () => {
    await xaddEvent(redis as any, 'job-123', sampleEvent);

    const args = redis.xadd.mock.calls[0];
    // After MAXLEN ~ 1000 * comes the flattened fields
    const fields = args.slice(5);

    // Should contain key-value pairs
    const fieldMap = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      fieldMap.set(fields[i], fields[i + 1]);
    }

    expect(fieldMap.get('step')).toBe('filling');
    expect(fieldMap.get('progress_pct')).toBe('45');
    expect(fieldMap.get('description')).toBe('Filling form fields');
    expect(fieldMap.get('action_index')).toBe('3');
    expect(fieldMap.get('total_actions_estimate')).toBe('8');
    expect(fieldMap.get('current_action')).toBe('Typing first name');
    expect(fieldMap.get('elapsed_ms')).toBe('1200');
    expect(fieldMap.get('eta_ms')).toBe('1500');
    expect(fieldMap.get('timestamp')).toBe('2026-02-20T10:00:01Z');
  });

  test('omits undefined and null fields', async () => {
    const eventWithOptionals: StreamEventFields = {
      step: 'navigating',
      progress_pct: 10,
      description: 'Loading page',
      action_index: 1,
      total_actions_estimate: 8,
      // current_action is undefined (optional)
      started_at: '2026-02-20T10:00:00Z',
      elapsed_ms: 500,
      eta_ms: null, // null
      timestamp: '2026-02-20T10:00:00Z',
      // execution_mode is undefined (optional)
      // manual_id is undefined (optional)
    };

    await xaddEvent(redis as any, 'job-123', eventWithOptionals);

    const args = redis.xadd.mock.calls[0];
    const fields = args.slice(5);

    // Should NOT contain current_action, execution_mode, manual_id, or eta_ms
    const fieldKeys: string[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      fieldKeys.push(fields[i]);
    }

    expect(fieldKeys).not.toContain('current_action');
    expect(fieldKeys).not.toContain('execution_mode');
    expect(fieldKeys).not.toContain('manual_id');
    expect(fieldKeys).not.toContain('eta_ms');
  });

  test('returns the message ID from Redis', async () => {
    redis.xadd.mockResolvedValue('9999999999-5');
    const result = await xaddEvent(redis as any, 'job-123', sampleEvent);
    expect(result).toBe('9999999999-5');
  });
});

// ── setStreamTTL ───────────────────────────────────────────────────────────

describe('setStreamTTL', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  test('calls redis.expire with correct key and default TTL (86400)', async () => {
    await setStreamTTL(redis as any, 'job-456');

    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith('gh:events:job-456', 86400);
  });

  test('calls redis.expire with custom TTL', async () => {
    await setStreamTTL(redis as any, 'job-456', 3600);

    expect(redis.expire).toHaveBeenCalledWith('gh:events:job-456', 3600);
  });
});

// ── xtrimStream ────────────────────────────────────────────────────────────

describe('xtrimStream', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  test('calls redis.xtrim with correct key and default maxLen', async () => {
    await xtrimStream(redis as any, 'job-789');

    expect(redis.xtrim).toHaveBeenCalledTimes(1);
    expect(redis.xtrim).toHaveBeenCalledWith('gh:events:job-789', 'MAXLEN', '~', 1000);
  });

  test('calls redis.xtrim with custom maxLen', async () => {
    await xtrimStream(redis as any, 'job-789', 500);

    expect(redis.xtrim).toHaveBeenCalledWith('gh:events:job-789', 'MAXLEN', '~', 500);
  });
});

// ── deleteStream ───────────────────────────────────────────────────────────

describe('deleteStream', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  test('calls redis.del with correct stream key', async () => {
    await deleteStream(redis as any, 'job-999');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('gh:events:job-999');
  });

  test('returns the number of keys deleted', async () => {
    redis.del.mockResolvedValue(1);
    const result = await deleteStream(redis as any, 'job-999');
    expect(result).toBe(1);
  });
});
