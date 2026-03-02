/**
 * WEK-96: ASG Lifecycle Hook Tests
 *
 * Unit tests for completeLifecycleAction and fetchEc2InstanceId
 * exported from workers/main.ts. All tests mock the AWS SDK and
 * global fetch to avoid real API calls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the AWS SDK before importing the module under test
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-auto-scaling', () => ({
  AutoScalingClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  CompleteLifecycleActionCommand: vi.fn().mockImplementation((input) => ({
    _input: input,
  })),
}));

// Suppress logger output during tests
vi.mock('../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { completeLifecycleAction, fetchEc2InstanceId, fetchEc2Ip, discoverImdsInstanceId } from '../../../src/workers/asg-lifecycle.js';

// ---------------------------------------------------------------------------
// completeLifecycleAction
// ---------------------------------------------------------------------------

describe('completeLifecycleAction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('calls CompleteLifecycleActionCommand when AWS_ASG_NAME is set', async () => {
    process.env.AWS_ASG_NAME = 'gh-workers-asg';
    process.env.AWS_LIFECYCLE_HOOK_NAME = 'my-hook';
    process.env.AWS_REGION = 'us-west-2';

    mockSend.mockResolvedValueOnce({});

    await completeLifecycleAction('i-abc123');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._input).toEqual({
      AutoScalingGroupName: 'gh-workers-asg',
      LifecycleHookName: 'my-hook',
      InstanceId: 'i-abc123',
      LifecycleActionResult: 'CONTINUE',
    });
  });

  test('skips when AWS_ASG_NAME is not set', async () => {
    delete process.env.AWS_ASG_NAME;

    await completeLifecycleAction('i-abc123');

    expect(mockSend).not.toHaveBeenCalled();
  });

  test('skips when instanceId is "unknown"', async () => {
    process.env.AWS_ASG_NAME = 'gh-workers-asg';

    await completeLifecycleAction('unknown');

    expect(mockSend).not.toHaveBeenCalled();
  });

  test('handles AWS SDK errors gracefully (does not throw)', async () => {
    process.env.AWS_ASG_NAME = 'gh-workers-asg';
    process.env.AWS_LIFECYCLE_HOOK_NAME = 'my-hook';

    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

    // Should NOT throw — error is caught and logged internally
    await expect(completeLifecycleAction('i-abc123')).resolves.toBeUndefined();
  });

  test('uses default hook name when AWS_LIFECYCLE_HOOK_NAME is not set', async () => {
    process.env.AWS_ASG_NAME = 'gh-workers-asg';
    delete process.env.AWS_LIFECYCLE_HOOK_NAME;

    mockSend.mockResolvedValueOnce({});

    await completeLifecycleAction('i-abc123');

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd._input.LifecycleHookName).toBe('ghosthands-drain-hook');
  });
});

// ---------------------------------------------------------------------------
// fetchEc2InstanceId
// ---------------------------------------------------------------------------

describe('fetchEc2InstanceId', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('returns instance ID from metadata service on success', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'mock-token' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => 'i-0abc123def456' } as Response);

    const result = await fetchEc2InstanceId();
    expect(result).toBe('i-0abc123def456');
  });

  test('falls back to EC2_INSTANCE_ID env var when metadata fails', async () => {
    process.env.EC2_INSTANCE_ID = 'i-env456';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await fetchEc2InstanceId();
    expect(result).toBe('i-env456');
  });

  test('returns "unknown" when metadata fails and no env var', async () => {
    delete process.env.EC2_INSTANCE_ID;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await fetchEc2InstanceId();
    expect(result).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// fetchEc2Ip
// ---------------------------------------------------------------------------

describe('fetchEc2Ip', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('returns public IP from metadata service on success', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'mock-token' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => '1.2.3.4' } as Response);

    const result = await fetchEc2Ip();
    expect(result).toBe('1.2.3.4');
  });

  test('falls back to EC2_IP env var when metadata fails', async () => {
    process.env.EC2_IP = '10.0.0.1';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await fetchEc2Ip();
    expect(result).toBe('10.0.0.1');
  });

  test('returns "local" when metadata fails and no env var', async () => {
    delete process.env.EC2_IP;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await fetchEc2Ip();
    expect(result).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// discoverImdsInstanceId (strict IMDS-only, no env fallback)
// ---------------------------------------------------------------------------

describe('discoverImdsInstanceId', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('returns valid instance ID on IMDS success', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'mock-token' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => 'i-0abc123def456' } as Response);

    const result = await discoverImdsInstanceId();
    expect(result).toBe('i-0abc123def456');
  });

  test('returns null on fetch failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    const result = await discoverImdsInstanceId();
    expect(result).toBeNull();
  });

  test('returns null on non-ok response', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'mock-token' } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as Response);

    const result = await discoverImdsInstanceId();
    expect(result).toBeNull();
  });

  test('returns null on invalid format', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => 'mock-token' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => 'not-an-instance-id' } as Response);

    const result = await discoverImdsInstanceId();
    expect(result).toBeNull();
  });

  test('does NOT fall back to EC2_INSTANCE_ID env var', async () => {
    process.env.EC2_INSTANCE_ID = 'i-envfallback999';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await discoverImdsInstanceId();
    // discoverImdsInstanceId is strict — returns null, not env value
    expect(result).toBeNull();
  });
});
