/**
 * WEK-83: ECR Authentication Module Tests
 *
 * Unit tests for the ECR auth module (scripts/lib/ecr-auth.ts).
 * All tests mock the AWS SDK to avoid real ECR API calls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the AWS SDK before importing the module under test
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  GetAuthorizationTokenCommand: vi.fn().mockImplementation((input) => ({
    _input: input,
  })),
}));

// Import after mocks are set up
import { getEcrAuth, clearEcrAuthCache, getEcrImageRef } from '../../../../scripts/lib/ecr-auth';

/**
 * Builds a mock ECR GetAuthorizationToken response.
 *
 * @param overrides - Properties to override in the response
 * @returns Mock ECR response matching AWS SDK shape
 */
function buildMockEcrResponse(overrides: {
  authorizationToken?: string | null;
  proxyEndpoint?: string | null;
  expiresAt?: Date | null;
} = {}) {
  // Default: base64("AWS:mock-password")
  const defaultToken = Buffer.from('AWS:mock-password').toString('base64');

  return {
    authorizationData: [
      {
        authorizationToken: overrides.authorizationToken === null
          ? undefined
          : (overrides.authorizationToken ?? defaultToken),
        proxyEndpoint: overrides.proxyEndpoint === null
          ? undefined
          : (overrides.proxyEndpoint ?? 'https://471112621974.dkr.ecr.us-east-1.amazonaws.com'),
        expiresAt: overrides.expiresAt === null
          ? undefined
          : (overrides.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000)),
      },
    ],
  };
}

describe('ECR Auth Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEcrAuthCache();
  });

  afterEach(() => {
    clearEcrAuthCache();
  });

  describe('getEcrAuth', () => {
    test('returns correctly formatted Docker auth token (base64 JSON with username/password/serveraddress)', async () => {
      mockSend.mockResolvedValueOnce(buildMockEcrResponse());

      const result = await getEcrAuth();

      // The token should be base64-encoded JSON
      const decoded = JSON.parse(Buffer.from(result.token, 'base64').toString('utf-8'));
      expect(decoded).toHaveProperty('username', 'AWS');
      expect(decoded).toHaveProperty('password', 'mock-password');
      expect(decoded).toHaveProperty('serveraddress', 'https://471112621974.dkr.ecr.us-east-1.amazonaws.com');
    });

    test('returns registryUrl without https:// prefix', async () => {
      mockSend.mockResolvedValueOnce(buildMockEcrResponse());

      const result = await getEcrAuth();

      expect(result.registryUrl).toBe('471112621974.dkr.ecr.us-east-1.amazonaws.com');
      expect(result.registryUrl).not.toContain('https://');
    });

    test('returns expiresAt from ECR response', async () => {
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({ expiresAt }));

      const result = await getEcrAuth();

      expect(result.expiresAt).toEqual(expiresAt);
    });

    test('defaults expiresAt to 12 hours from now when ECR response omits it', async () => {
      const before = Date.now();
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({ expiresAt: null }));

      const result = await getEcrAuth();
      const after = Date.now();

      // Should be approximately 12 hours from now (within 2 seconds tolerance)
      const twelveHoursMs = 12 * 60 * 60 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + twelveHoursMs - 2000);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + twelveHoursMs + 2000);
    });

    test('token caching: second call returns cached token without hitting ECR API', async () => {
      // Token expires 12 hours from now (well within the 30-min buffer)
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({ expiresAt }));

      const first = await getEcrAuth();
      const second = await getEcrAuth();

      // ECR API should only be called once
      expect(mockSend).toHaveBeenCalledTimes(1);
      // Both calls should return the same token
      expect(second.token).toBe(first.token);
      expect(second.expiresAt).toEqual(first.expiresAt);
    });

    test('token refresh: expired token triggers new ECR API call', async () => {
      // First token expires in 10 minutes (below the 30-min buffer)
      const nearExpiry = new Date(Date.now() + 10 * 60 * 1000);
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({ expiresAt: nearExpiry }));

      const first = await getEcrAuth();

      // Second call should detect the token is about to expire and fetch a new one
      const freshExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000);
      const freshToken = Buffer.from('AWS:fresh-password').toString('base64');
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({
        authorizationToken: freshToken,
        expiresAt: freshExpiry,
      }));

      const second = await getEcrAuth();

      // ECR API should be called twice
      expect(mockSend).toHaveBeenCalledTimes(2);
      // The tokens should be different
      expect(second.token).not.toBe(first.token);
    });

    test('token refresh: exactly at 30-minute buffer triggers refresh', async () => {
      // Token expires in exactly 30 minutes (the buffer boundary) - should trigger refresh
      const exactBuffer = new Date(Date.now() + 30 * 60 * 1000);
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({ expiresAt: exactBuffer }));

      await getEcrAuth();

      // Second call: the remaining time (30 min) is NOT greater than the buffer (30 min),
      // so it should fetch a new token
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      }));

      await getEcrAuth();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    test('error handling: ECR API returns no auth data throws descriptive error', async () => {
      mockSend.mockResolvedValueOnce({
        authorizationData: [],
      });

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed/);
    });

    test('error handling: ECR API returns null authorizationToken throws descriptive error', async () => {
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({
        authorizationToken: null,
      }));

      await expect(getEcrAuth()).rejects.toThrow('ECR authentication failed');
    });

    test('error handling: ECR API returns null proxyEndpoint throws descriptive error', async () => {
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({
        proxyEndpoint: null,
      }));

      await expect(getEcrAuth()).rejects.toThrow('ECR authentication failed');
    });

    test('error handling: ECR API returns token with invalid format (no colon separator)', async () => {
      const badToken = Buffer.from('no-colon-separator').toString('base64');
      mockSend.mockResolvedValueOnce(buildMockEcrResponse({
        authorizationToken: badToken,
      }));

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed.*invalid format/);
    });

    test('error handling: ECR SDK throws error is wrapped with descriptive message', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(getEcrAuth()).rejects.toThrow('ECR authentication failed: Network timeout');
    });

    test('error handling: non-Error thrown by SDK is wrapped', async () => {
      mockSend.mockRejectedValueOnce('string error');

      await expect(getEcrAuth()).rejects.toThrow('ECR authentication failed: unknown error');
    });

    test('uses AWS_REGION env var when no region argument provided', async () => {
      const { ECRClient } = await import('@aws-sdk/client-ecr');
      const originalRegion = process.env.AWS_REGION;
      process.env.AWS_REGION = 'eu-west-1';

      mockSend.mockResolvedValueOnce(buildMockEcrResponse());

      await getEcrAuth();

      expect(ECRClient).toHaveBeenCalledWith({ region: 'eu-west-1' });

      // Restore
      if (originalRegion !== undefined) {
        process.env.AWS_REGION = originalRegion;
      } else {
        delete process.env.AWS_REGION;
      }
    });

    test('region argument overrides AWS_REGION env var', async () => {
      const { ECRClient } = await import('@aws-sdk/client-ecr');
      const originalRegion = process.env.AWS_REGION;
      process.env.AWS_REGION = 'eu-west-1';

      mockSend.mockResolvedValueOnce(buildMockEcrResponse());

      await getEcrAuth('ap-southeast-1');

      expect(ECRClient).toHaveBeenCalledWith({ region: 'ap-southeast-1' });

      // Restore
      if (originalRegion !== undefined) {
        process.env.AWS_REGION = originalRegion;
      } else {
        delete process.env.AWS_REGION;
      }
    });
  });

  describe('clearEcrAuthCache', () => {
    test('resets cache so next getEcrAuth hits ECR API again', async () => {
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
      mockSend.mockResolvedValue(buildMockEcrResponse({ expiresAt }));

      // First call populates cache
      await getEcrAuth();
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Clear cache
      clearEcrAuthCache();

      // Second call should hit the API again
      await getEcrAuth();
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    test('can be called when cache is already empty without error', () => {
      expect(() => clearEcrAuthCache()).not.toThrow();
    });
  });

  describe('getEcrImageRef', () => {
    test('returns full ECR image reference with tag', () => {
      const ref = getEcrImageRef('v1.2.3');
      expect(ref).toContain('/wekruit/ghosthands:v1.2.3');
    });

    test('uses default registry when ECR_REGISTRY env var is not set', () => {
      const originalRegistry = process.env.ECR_REGISTRY;
      delete process.env.ECR_REGISTRY;

      const ref = getEcrImageRef('latest');
      expect(ref).toBe('471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands:latest');

      // Restore
      if (originalRegistry !== undefined) {
        process.env.ECR_REGISTRY = originalRegistry;
      }
    });

    test('uses ECR_REGISTRY env var when set', () => {
      const originalRegistry = process.env.ECR_REGISTRY;
      process.env.ECR_REGISTRY = 'custom.ecr.registry.com';

      const ref = getEcrImageRef('staging-abc123');
      expect(ref).toBe('custom.ecr.registry.com/wekruit/ghosthands:staging-abc123');

      // Restore
      if (originalRegistry !== undefined) {
        process.env.ECR_REGISTRY = originalRegistry;
      } else {
        delete process.env.ECR_REGISTRY;
      }
    });

    test('handles special characters in tag', () => {
      const ref = getEcrImageRef('staging-abc123-special.tag');
      expect(ref).toContain(':staging-abc123-special.tag');
    });
  });
});
