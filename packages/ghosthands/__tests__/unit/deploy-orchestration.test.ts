/**
 * WEK-83: Deploy Orchestration Tests
 *
 * Unit tests for the deploy orchestration flow. Since deploy-server.ts currently
 * uses a shell script (deploy.sh) for the actual deploy, these tests validate
 * the orchestration pattern: pull -> drain -> stop -> remove -> create -> start -> health check -> prune.
 *
 * Tests are structured around the Docker API client + container configs + ECR auth
 * modules that the deploy flow depends on.
 *
 * When the deploy flow is refactored (WEK-81) to use Docker API directly instead
 * of deploy.sh, these tests can be adjusted to import and test the executeDeploy
 * function directly.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────

// Mock ecr-auth
const mockGetEcrAuth = vi.fn();
const mockClearEcrAuthCache = vi.fn();

vi.mock('../../../../scripts/lib/ecr-auth', () => ({
  getEcrAuth: (...args: unknown[]) => mockGetEcrAuth(...args),
  clearEcrAuthCache: () => mockClearEcrAuthCache(),
}));

// Mock docker-client
const mockPullImage = vi.fn();
const mockStopContainer = vi.fn();
const mockRemoveContainer = vi.fn();
const mockCreateContainer = vi.fn();
const mockStartContainer = vi.fn();
const mockInspectContainer = vi.fn();
const mockPruneImages = vi.fn();

vi.mock('../../../../scripts/lib/docker-client', () => ({
  pullImage: (...args: unknown[]) => mockPullImage(...args),
  stopContainer: (...args: unknown[]) => mockStopContainer(...args),
  removeContainer: (...args: unknown[]) => mockRemoveContainer(...args),
  createContainer: (...args: unknown[]) => mockCreateContainer(...args),
  startContainer: (...args: unknown[]) => mockStartContainer(...args),
  inspectContainer: (...args: unknown[]) => mockInspectContainer(...args),
  pruneImages: () => mockPruneImages(),
  DockerApiError: class DockerApiError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
      public readonly dockerMessage?: string,
    ) {
      super(message);
      this.name = 'DockerApiError';
    }
  },
}));

// Mock container-configs
const mockGetServiceConfigs = vi.fn();
const mockLoadEnvFile = vi.fn();

vi.mock('../../../../scripts/lib/container-configs', () => ({
  getServiceConfigs: (...args: unknown[]) => mockGetServiceConfigs(...args),
  loadEnvFile: (...args: unknown[]) => mockLoadEnvFile(...args),
}));

// ── Types & Helpers ────────────────────────────────────────────────

import type { ServiceDefinition } from '../../../../scripts/lib/container-configs';
import type { ContainerCreateConfig } from '../../../../scripts/lib/docker-client';

/** Default mock ECR auth response */
const MOCK_ECR_AUTH = {
  token: 'mock-ecr-token-base64',
  registryUrl: '471112621974.dkr.ecr.us-east-1.amazonaws.com',
  expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
};

/** Builds a mock ServiceDefinition for testing */
function buildMockService(overrides: Partial<ServiceDefinition> & { name: string }): ServiceDefinition {
  const config: ContainerCreateConfig = {
    Image: '471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands:test-tag',
    Cmd: ['bun', 'run', 'server.js'],
    Env: ['DB_URL=postgres://localhost/db'],
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Labels: { 'gh.service': overrides.name, 'gh.managed': 'true' },
    ...overrides.config,
  };

  return {
    name: overrides.name,
    config,
    healthEndpoint: `http://localhost:3100/health`,
    healthTimeout: 30_000,
    drainEndpoint: undefined,
    drainTimeout: 0,
    skipOnSelfUpdate: false,
    startOrder: 1,
    stopOrder: 1,
    ...overrides,
    // config must use the merged version
    ...(overrides.config ? { config: { ...config, ...overrides.config } as ContainerCreateConfig } : { config }),
  };
}

/** Default mock services for a 3-service deploy */
function buildDefaultServices(): ServiceDefinition[] {
  return [
    buildMockService({
      name: 'ghosthands-api',
      healthEndpoint: 'http://localhost:3100/health',
      startOrder: 1,
      stopOrder: 3,
    }),
    buildMockService({
      name: 'ghosthands-worker',
      healthEndpoint: 'http://localhost:3101/health',
      drainEndpoint: 'http://localhost:3101/drain',
      drainTimeout: 60_000,
      startOrder: 2,
      stopOrder: 1,
    }),
    buildMockService({
      name: 'ghosthands-deploy-server',
      healthEndpoint: 'http://localhost:8000/health',
      skipOnSelfUpdate: true,
      startOrder: 3,
      stopOrder: 2,
    }),
  ];
}

/**
 * Simulates the deploy orchestration flow that would be performed by
 * a Docker API-based deploy function. This is the expected sequence:
 *
 * 1. Get ECR auth
 * 2. Pull new image
 * 3. For each service (sorted by stopOrder):
 *    a. Drain if drainEndpoint exists
 *    b. Stop container
 *    c. Remove container
 * 4. For each service (sorted by startOrder):
 *    a. Skip if skipOnSelfUpdate
 *    b. Create container
 *    c. Start container
 *    d. Wait for health check
 * 5. Prune old images
 */
async function simulateDeployFlow(
  imageTag: string,
  options: { skipSelfUpdate?: boolean } = {},
): Promise<{ success: boolean; error?: string; step?: string }> {
  const skipSelfUpdate = options.skipSelfUpdate ?? true;

  try {
    // Step 1: Get ECR auth
    const auth = await mockGetEcrAuth();

    // Step 2: Pull image
    const image = `471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands`;
    await mockPullImage(image, imageTag, auth.token);

    // Step 3: Get service configs
    const services = mockGetServiceConfigs(imageTag, 'staging') as ServiceDefinition[];

    // Step 4: Stop services (sorted by stopOrder)
    const stopSorted = [...services].sort((a, b) => a.stopOrder - b.stopOrder);
    for (const svc of stopSorted) {
      // Drain if endpoint exists
      if (svc.drainEndpoint) {
        try {
          await fetch(svc.drainEndpoint, {
            method: 'POST',
            signal: AbortSignal.timeout(svc.drainTimeout),
          });
        } catch {
          // Drain failure is not fatal
        }
      }
      await mockStopContainer(svc.name, 30);
      await mockRemoveContainer(svc.name);
    }

    // Step 5: Start services (sorted by startOrder)
    const startSorted = [...services].sort((a, b) => a.startOrder - b.startOrder);
    for (const svc of startSorted) {
      if (skipSelfUpdate && svc.skipOnSelfUpdate) {
        continue;
      }
      const containerId = await mockCreateContainer(svc.name, svc.config);
      await mockStartContainer(containerId);

      // Wait for health check
      if (svc.healthEndpoint) {
        const deadline = Date.now() + svc.healthTimeout;
        let healthy = false;
        while (Date.now() < deadline) {
          const inspection = await mockInspectContainer(containerId);
          if (inspection?.State?.Health?.Status === 'healthy' || inspection?.State?.Running) {
            healthy = true;
            break;
          }
        }
        if (!healthy) {
          throw new Error(`Health check timeout for ${svc.name}`);
        }
      }
    }

    // Step 6: Prune old images
    await mockPruneImages();

    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Deploy Orchestration Flow', () => {
  let originalFetch: typeof fetch;
  let mockGlobalFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockGetEcrAuth.mockResolvedValue(MOCK_ECR_AUTH);
    mockPullImage.mockResolvedValue(undefined);
    mockStopContainer.mockResolvedValue(undefined);
    mockRemoveContainer.mockResolvedValue(undefined);
    mockCreateContainer.mockImplementation((name: string) =>
      Promise.resolve(`${name}-container-id`),
    );
    mockStartContainer.mockResolvedValue(undefined);
    mockInspectContainer.mockResolvedValue({
      Id: 'mock-id',
      State: { Status: 'running', Running: true, Health: { Status: 'healthy' } },
      Config: { Image: 'test', Env: [], Labels: {} },
    });
    mockPruneImages.mockResolvedValue({ spaceReclaimed: 1024 });
    mockGetServiceConfigs.mockReturnValue(buildDefaultServices());
    mockLoadEnvFile.mockReturnValue(['DB_URL=postgres://localhost/db']);

    // Mock global fetch for drain endpoint
    originalFetch = globalThis.fetch;
    mockGlobalFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    globalThis.fetch = mockGlobalFetch as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Full deploy flow', () => {
    test('calls functions in correct order: auth -> pull -> stop -> remove -> create -> start -> prune', async () => {
      const callOrder: string[] = [];

      mockGetEcrAuth.mockImplementation(async () => {
        callOrder.push('getEcrAuth');
        return MOCK_ECR_AUTH;
      });
      mockPullImage.mockImplementation(async () => {
        callOrder.push('pullImage');
      });
      mockStopContainer.mockImplementation(async (name: string) => {
        callOrder.push(`stop:${name}`);
      });
      mockRemoveContainer.mockImplementation(async (name: string) => {
        callOrder.push(`remove:${name}`);
      });
      mockCreateContainer.mockImplementation(async (name: string) => {
        callOrder.push(`create:${name}`);
        return `${name}-id`;
      });
      mockStartContainer.mockImplementation(async (id: string) => {
        callOrder.push(`start:${id}`);
      });
      mockPruneImages.mockImplementation(async () => {
        callOrder.push('pruneImages');
        return { spaceReclaimed: 0 };
      });

      const result = await simulateDeployFlow('staging-abc123');

      expect(result.success).toBe(true);

      // Auth must come first
      expect(callOrder[0]).toBe('getEcrAuth');
      // Pull must come after auth
      expect(callOrder[1]).toBe('pullImage');

      // All stops must come before any creates
      const firstCreateIdx = callOrder.findIndex((c) => c.startsWith('create:'));
      const lastStopIdx = callOrder.reduce(
        (max, c, i) => (c.startsWith('stop:') ? i : max), -1,
      );
      expect(lastStopIdx).toBeLessThan(firstCreateIdx);

      // Prune must come last
      expect(callOrder[callOrder.length - 1]).toBe('pruneImages');
    });

    test('passes ECR auth token to pullImage', async () => {
      await simulateDeployFlow('test-tag');

      expect(mockPullImage).toHaveBeenCalledWith(
        expect.stringContaining('ghosthands'),
        'test-tag',
        MOCK_ECR_AUTH.token,
      );
    });

    test('passes correct image tag to pullImage', async () => {
      await simulateDeployFlow('prod-v2.0.0');

      expect(mockPullImage).toHaveBeenCalledWith(
        expect.any(String),
        'prod-v2.0.0',
        expect.any(String),
      );
    });
  });

  describe('Worker drain before stop', () => {
    test('worker drain endpoint is called before stop', async () => {
      const callOrder: string[] = [];
      const localMockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/drain')) {
          callOrder.push('drain:worker');
        }
        return new Response('OK', { status: 200 });
      });
      globalThis.fetch = localMockFetch as typeof fetch;

      mockStopContainer.mockImplementation(async (name: string) => {
        callOrder.push(`stop:${name}`);
      });

      await simulateDeployFlow('test-tag');

      // Drain should come before stop for worker
      const drainIdx = callOrder.indexOf('drain:worker');
      const stopIdx = callOrder.indexOf('stop:ghosthands-worker');

      expect(drainIdx).toBeGreaterThanOrEqual(0);
      expect(stopIdx).toBeGreaterThan(drainIdx);
    });

    test('API service has no drain call', async () => {
      const localMockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      globalThis.fetch = localMockFetch as typeof fetch;

      await simulateDeployFlow('test-tag');

      // Only drain calls should be for the worker endpoint
      const drainCalls = localMockFetch.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/drain'),
      );
      expect(drainCalls).toHaveLength(1);
      expect(drainCalls[0][0]).toContain('3101/drain');
    });

    test('drain failure does not abort the deploy', async () => {
      const localMockFetch = vi.fn().mockRejectedValue(new Error('Drain timeout'));
      globalThis.fetch = localMockFetch as typeof fetch;

      const result = await simulateDeployFlow('test-tag');

      // Deploy should still succeed (drain failure is non-fatal)
      expect(result.success).toBe(true);
      expect(mockStopContainer).toHaveBeenCalled();
    });
  });

  describe('Deploy-server skip on self-update', () => {
    test('deploy-server container is skipped when skipSelfUpdate=true', async () => {
      await simulateDeployFlow('test-tag', { skipSelfUpdate: true });

      // createContainer should NOT be called for deploy-server
      const createCalls = mockCreateContainer.mock.calls.map((c: unknown[]) => c[0]);
      expect(createCalls).not.toContain('ghosthands-deploy-server');
    });

    test('deploy-server container IS created when skipSelfUpdate=false', async () => {
      await simulateDeployFlow('test-tag', { skipSelfUpdate: false });

      // createContainer SHOULD be called for deploy-server
      const createCalls = mockCreateContainer.mock.calls.map((c: unknown[]) => c[0]);
      expect(createCalls).toContain('ghosthands-deploy-server');
    });

    test('API and worker containers are always created regardless of skipSelfUpdate', async () => {
      await simulateDeployFlow('test-tag', { skipSelfUpdate: true });

      const createCalls = mockCreateContainer.mock.calls.map((c: unknown[]) => c[0]);
      expect(createCalls).toContain('ghosthands-api');
      expect(createCalls).toContain('ghosthands-worker');
    });
  });

  describe('Health check polling', () => {
    test('health check polls inspectContainer until healthy', async () => {
      let inspectCallCount = 0;
      mockInspectContainer.mockImplementation(async () => {
        inspectCallCount++;
        // Return unhealthy first 2 calls, then healthy
        if (inspectCallCount <= 2) {
          return {
            Id: 'mock-id',
            State: { Status: 'starting', Running: false },
            Config: { Image: 'test', Env: [], Labels: {} },
          };
        }
        return {
          Id: 'mock-id',
          State: { Status: 'running', Running: true, Health: { Status: 'healthy' } },
          Config: { Image: 'test', Env: [], Labels: {} },
        };
      });

      const result = await simulateDeployFlow('test-tag');

      expect(result.success).toBe(true);
      expect(inspectCallCount).toBeGreaterThanOrEqual(3);
    });

    test('health check accepts Running=true as healthy', async () => {
      mockInspectContainer.mockResolvedValue({
        Id: 'mock-id',
        State: { Status: 'running', Running: true },
        Config: { Image: 'test', Env: [], Labels: {} },
      });

      const result = await simulateDeployFlow('test-tag');
      expect(result.success).toBe(true);
    });

    test('health check timeout throws error', async () => {
      // Override services with a very short health timeout
      mockGetServiceConfigs.mockReturnValue([
        buildMockService({
          name: 'ghosthands-api',
          healthEndpoint: 'http://localhost:3100/health',
          healthTimeout: 1, // 1ms timeout - will expire immediately
          startOrder: 1,
          stopOrder: 1,
        }),
      ]);

      // Always return unhealthy
      mockInspectContainer.mockResolvedValue({
        Id: 'mock-id',
        State: { Status: 'starting', Running: false },
        Config: { Image: 'test', Env: [], Labels: {} },
      });

      const result = await simulateDeployFlow('test-tag');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Health check timeout');
      expect(result.error).toContain('ghosthands-api');
    });
  });

  describe('Error during pull', () => {
    test('pull failure returns failure result', async () => {
      mockPullImage.mockRejectedValueOnce(new Error('Failed to pull image: 404 Not Found'));

      const result = await simulateDeployFlow('nonexistent-tag');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to pull image');
    });

    test('pull failure does not proceed to stop/create containers', async () => {
      mockPullImage.mockRejectedValueOnce(new Error('Pull failed'));

      await simulateDeployFlow('test-tag');

      expect(mockStopContainer).not.toHaveBeenCalled();
      expect(mockCreateContainer).not.toHaveBeenCalled();
      expect(mockStartContainer).not.toHaveBeenCalled();
    });
  });

  describe('Image prune after deploy', () => {
    test('pruneImages is called after successful deploy', async () => {
      await simulateDeployFlow('test-tag');
      expect(mockPruneImages).toHaveBeenCalledTimes(1);
    });

    test('pruneImages is NOT called when deploy fails during pull', async () => {
      mockPullImage.mockRejectedValueOnce(new Error('Pull failed'));

      await simulateDeployFlow('test-tag');

      expect(mockPruneImages).not.toHaveBeenCalled();
    });

    test('pruneImages is NOT called when deploy fails during container creation', async () => {
      mockCreateContainer.mockRejectedValueOnce(new Error('Create failed'));

      await simulateDeployFlow('test-tag');

      expect(mockPruneImages).not.toHaveBeenCalled();
    });
  });

  describe('ECR auth integration', () => {
    test('ECR auth failure prevents deploy', async () => {
      mockGetEcrAuth.mockRejectedValueOnce(new Error('ECR authentication failed'));

      const result = await simulateDeployFlow('test-tag');

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECR authentication failed');
      expect(mockPullImage).not.toHaveBeenCalled();
    });
  });

  describe('Stop ordering', () => {
    test('services are stopped in stopOrder (worker first, then deploy-server, then API)', async () => {
      const stopOrder: string[] = [];
      mockStopContainer.mockImplementation(async (name: string) => {
        stopOrder.push(name);
      });

      await simulateDeployFlow('test-tag');

      // Worker (stopOrder=1), then deploy-server (stopOrder=2), then API (stopOrder=3)
      expect(stopOrder[0]).toBe('ghosthands-worker');
      expect(stopOrder[1]).toBe('ghosthands-deploy-server');
      expect(stopOrder[2]).toBe('ghosthands-api');
    });

    test('services are started in startOrder (API first, then worker, then deploy-server)', async () => {
      const startOrder: string[] = [];
      mockCreateContainer.mockImplementation(async (name: string) => {
        startOrder.push(name);
        return `${name}-id`;
      });

      await simulateDeployFlow('test-tag', { skipSelfUpdate: false });

      // API (startOrder=1), then worker (startOrder=2), then deploy-server (startOrder=3)
      expect(startOrder[0]).toBe('ghosthands-api');
      expect(startOrder[1]).toBe('ghosthands-worker');
      expect(startOrder[2]).toBe('ghosthands-deploy-server');
    });
  });

  describe('Container lifecycle per service', () => {
    test('each service goes through stop -> remove -> create -> start', async () => {
      const ops: string[] = [];

      mockStopContainer.mockImplementation(async (name: string) => {
        ops.push(`stop:${name}`);
      });
      mockRemoveContainer.mockImplementation(async (name: string) => {
        ops.push(`remove:${name}`);
      });
      mockCreateContainer.mockImplementation(async (name: string) => {
        ops.push(`create:${name}`);
        return `${name}-id`;
      });
      mockStartContainer.mockImplementation(async (id: string) => {
        ops.push(`start:${id}`);
      });

      await simulateDeployFlow('test-tag', { skipSelfUpdate: false });

      // For each service, stop must come before remove
      for (const svcName of ['ghosthands-api', 'ghosthands-worker', 'ghosthands-deploy-server']) {
        const stopIdx = ops.indexOf(`stop:${svcName}`);
        const removeIdx = ops.indexOf(`remove:${svcName}`);
        const createIdx = ops.indexOf(`create:${svcName}`);
        const startIdx = ops.indexOf(`start:${svcName}-id`);

        expect(stopIdx).toBeGreaterThanOrEqual(0);
        expect(removeIdx).toBeGreaterThan(stopIdx);
        expect(createIdx).toBeGreaterThan(removeIdx);
        expect(startIdx).toBeGreaterThan(createIdx);
      }
    });
  });

  describe('Service config retrieval', () => {
    test('getServiceConfigs is called with correct image tag and environment', async () => {
      await simulateDeployFlow('staging-v3.1.0');

      expect(mockGetServiceConfigs).toHaveBeenCalledWith('staging-v3.1.0', 'staging');
    });

    test('deploy handles empty service list gracefully', async () => {
      mockGetServiceConfigs.mockReturnValue([]);

      const result = await simulateDeployFlow('test-tag');

      expect(result.success).toBe(true);
      expect(mockStopContainer).not.toHaveBeenCalled();
      expect(mockCreateContainer).not.toHaveBeenCalled();
      expect(mockPruneImages).toHaveBeenCalled();
    });
  });
});
