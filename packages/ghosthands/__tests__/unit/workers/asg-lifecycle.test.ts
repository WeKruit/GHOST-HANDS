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

import { completeLifecycleAction, fetchEc2InstanceId } from '../../../src/workers/asg-lifecycle.js';

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
      .mockResolvedValueOnce({ text: async () => 'mock-token' } as Response)
      .mockResolvedValueOnce({ text: async () => 'i-metadata123' } as Response);

    const result = await fetchEc2InstanceId();
    expect(result).toBe('i-metadata123');
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
