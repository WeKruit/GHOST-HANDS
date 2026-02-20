/**
 * WEK-83: Container Configuration Tests
 *
 * Unit tests for the container config definitions (scripts/lib/container-configs.ts).
 * Tests service definitions, env file parsing, and startup/shutdown ordering.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock fs module — only readFileSync is used by container-configs
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  // Provide stubs for any other fs functions that might be imported
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  },
}));

import {
  loadEnvFile,
  getServiceConfigs,
  type ServiceDefinition,
} from '../../../../scripts/lib/container-configs';

/**
 * Helper: sets up readFileSync mock to return given content.
 */
function mockEnvFile(content: string): void {
  mockReadFileSync.mockReturnValue(content);
}

/**
 * Sample .env content for service config tests.
 */
const SAMPLE_ENV = `# Database config
DATABASE_URL=postgres://localhost/db
SUPABASE_URL=https://example.supabase.co
GH_SERVICE_SECRET=test-secret`;

describe('Container Configs Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadEnvFile', () => {
    test('parses KEY=VALUE lines from env file', () => {
      mockReadFileSync.mockReturnValue('KEY1=value1\nKEY2=value2\n');

      const result = loadEnvFile('/some/path/.env');
      expect(result).toEqual(['KEY1=value1', 'KEY2=value2']);
    });

    test('filters out comment lines starting with #', () => {
      mockReadFileSync.mockReturnValue(
        '# comment\nKEY1=value1\n# another comment\nKEY2=value2\n',
      );

      const result = loadEnvFile('/some/path/.env');
      expect(result).toEqual(['KEY1=value1', 'KEY2=value2']);
    });

    test('filters out empty lines', () => {
      mockReadFileSync.mockReturnValue('KEY1=value1\n\n\nKEY2=value2\n\n');

      const result = loadEnvFile('/some/path/.env');
      expect(result).toEqual(['KEY1=value1', 'KEY2=value2']);
    });

    test('handles comments, empty lines, and values with spaces', () => {
      const content = [
        '# comment',
        'KEY1=value1',
        '',
        'KEY2=value2',
        '# another comment',
        'KEY3=value with spaces',
      ].join('\n');

      mockReadFileSync.mockReturnValue(content);

      const result = loadEnvFile('/some/path/.env');
      expect(result).toEqual([
        'KEY1=value1',
        'KEY2=value2',
        'KEY3=value with spaces',
      ]);
    });

    test('trims whitespace from lines', () => {
      mockReadFileSync.mockReturnValue('  KEY1=value1  \n  KEY2=value2  \n');

      const result = loadEnvFile('/some/path/.env');
      expect(result).toEqual(['KEY1=value1', 'KEY2=value2']);
    });

    test('returns empty array for file with only comments and blanks', () => {
      mockReadFileSync.mockReturnValue('# just comments\n\n# nothing else\n');

      const result = loadEnvFile('/some/path/.env');
      expect(result).toEqual([]);
    });

    test('throws descriptive error when file does not exist', () => {
      mockReadFileSync.mockImplementation(() => {
        const error = new Error(
          "ENOENT: no such file or directory, open '/missing/.env'",
        ) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      expect(() => loadEnvFile('/missing/.env')).toThrow('ENOENT');
    });

    test('passes correct path and encoding to readFileSync', () => {
      mockReadFileSync.mockReturnValue('KEY=val');

      loadEnvFile('/opt/ghosthands/.env');

      expect(mockReadFileSync).toHaveBeenCalledWith('/opt/ghosthands/.env', 'utf-8');
    });
  });

  describe('getServiceConfigs', () => {
    beforeEach(() => {
      mockEnvFile(SAMPLE_ENV);
    });

    test('returns exactly 3 services', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');
      expect(services).toHaveLength(3);
    });

    test('services are sorted by startOrder (ascending)', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');
      const orders = services.map((s) => s.startOrder);
      expect(orders).toEqual([1, 2, 3]);
    });

    test('service names are ghosthands-api, ghosthands-worker, ghosthands-deploy-server', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');
      const names = services.map((s) => s.name);
      expect(names).toContain('ghosthands-api');
      expect(names).toContain('ghosthands-worker');
      expect(names).toContain('ghosthands-deploy-server');
    });

    test('all containers use the same ECR image built from the image tag', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');
      const expectedImage =
        '471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands:staging-abc123';

      for (const svc of services) {
        expect(svc.config.Image).toBe(expectedImage);
      }
    });

    test('all containers have NetworkMode: host', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');

      for (const svc of services) {
        expect(svc.config.HostConfig.NetworkMode).toBe('host');
      }
    });

    test('all containers have RestartPolicy: unless-stopped', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');

      for (const svc of services) {
        expect(svc.config.HostConfig.RestartPolicy).toEqual({
          Name: 'unless-stopped',
        });
      }
    });

    test('all containers have gh.managed=true label', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');

      for (const svc of services) {
        expect(svc.config.Labels?.['gh.managed']).toBe('true');
      }
    });

    test('environment variables from .env file are included in all containers', () => {
      const services = getServiceConfigs('staging-abc123', 'staging');

      for (const svc of services) {
        expect(svc.config.Env).toContain('DATABASE_URL=postgres://localhost/db');
        expect(svc.config.Env).toContain('SUPABASE_URL=https://example.supabase.co');
        expect(svc.config.Env).toContain('GH_SERVICE_SECRET=test-secret');
      }
    });

    describe('API service', () => {
      function getApiService(): ServiceDefinition {
        const services = getServiceConfigs('test-tag', 'staging');
        return services.find((s) => s.name === 'ghosthands-api')!;
      }

      test('has correct name', () => {
        expect(getApiService().name).toBe('ghosthands-api');
      });

      test('has health endpoint on port 3100', () => {
        expect(getApiService().healthEndpoint).toBe('http://localhost:3100/health');
      });

      test('has GH_API_PORT=3100 in env', () => {
        expect(getApiService().config.Env).toContain('GH_API_PORT=3100');
      });

      test('has gh.service=api label', () => {
        expect(getApiService().config.Labels?.['gh.service']).toBe('api');
      });

      test('has startOrder=1 (starts first)', () => {
        expect(getApiService().startOrder).toBe(1);
      });

      test('has stopOrder=3 (stops last)', () => {
        expect(getApiService().stopOrder).toBe(3);
      });

      test('skipOnSelfUpdate is false', () => {
        expect(getApiService().skipOnSelfUpdate).toBe(false);
      });

      test('has no drain endpoint', () => {
        expect(getApiService().drainEndpoint).toBeUndefined();
      });

      test('runs bun with correct command', () => {
        expect(getApiService().config.Cmd).toEqual([
          'bun',
          'run',
          'packages/ghosthands/dist/api/server.js',
        ]);
      });
    });

    describe('Worker service', () => {
      function getWorkerService(): ServiceDefinition {
        const services = getServiceConfigs('test-tag', 'staging');
        return services.find((s) => s.name === 'ghosthands-worker')!;
      }

      test('has correct name', () => {
        expect(getWorkerService().name).toBe('ghosthands-worker');
      });

      test('has drain endpoint on port 3101', () => {
        expect(getWorkerService().drainEndpoint).toBe('http://localhost:3101/drain');
      });

      test('has GH_WORKER_PORT=3101 in env', () => {
        expect(getWorkerService().config.Env).toContain('GH_WORKER_PORT=3101');
      });

      test('has MAX_CONCURRENT_JOBS=1 in env', () => {
        expect(getWorkerService().config.Env).toContain('MAX_CONCURRENT_JOBS=1');
      });

      test('has gh.service=worker label', () => {
        expect(getWorkerService().config.Labels?.['gh.service']).toBe('worker');
      });

      test('has startOrder=2', () => {
        expect(getWorkerService().startOrder).toBe(2);
      });

      test('has stopOrder=1 (stops first for draining)', () => {
        expect(getWorkerService().stopOrder).toBe(1);
      });

      test('skipOnSelfUpdate is false', () => {
        expect(getWorkerService().skipOnSelfUpdate).toBe(false);
      });

      test('has health endpoint on port 3101', () => {
        expect(getWorkerService().healthEndpoint).toBe('http://localhost:3101/health');
      });

      test('has 60-second drain timeout', () => {
        expect(getWorkerService().drainTimeout).toBe(60_000);
      });
    });

    describe('Deploy Server service', () => {
      function getDeployService(): ServiceDefinition {
        const services = getServiceConfigs('test-tag', 'staging');
        return services.find((s) => s.name === 'ghosthands-deploy-server')!;
      }

      test('has correct name', () => {
        expect(getDeployService().name).toBe('ghosthands-deploy-server');
      });

      test('skipOnSelfUpdate is true', () => {
        expect(getDeployService().skipOnSelfUpdate).toBe(true);
      });

      test('has volume binds for /opt/ghosthands and docker.sock', () => {
        const binds = getDeployService().config.HostConfig.Binds;
        expect(binds).toBeDefined();
        expect(binds).toContain('/opt/ghosthands:/opt/ghosthands:ro');
        expect(binds).toContain('/var/run/docker.sock:/var/run/docker.sock');
      });

      test('has gh.service=deploy-server label', () => {
        expect(getDeployService().config.Labels?.['gh.service']).toBe('deploy-server');
      });

      test('has GH_DEPLOY_PORT=8000 in env', () => {
        expect(getDeployService().config.Env).toContain('GH_DEPLOY_PORT=8000');
      });

      test('has startOrder=3 (starts last)', () => {
        expect(getDeployService().startOrder).toBe(3);
      });

      test('has stopOrder=2', () => {
        expect(getDeployService().stopOrder).toBe(2);
      });

      test('has no drain endpoint', () => {
        expect(getDeployService().drainEndpoint).toBeUndefined();
      });

      test('has health endpoint on port 8000', () => {
        expect(getDeployService().healthEndpoint).toBe('http://localhost:8000/health');
      });

      test('runs deploy-server.ts script', () => {
        expect(getDeployService().config.Cmd).toEqual([
          'bun',
          'run',
          '/opt/ghosthands/scripts/deploy-server.ts',
        ]);
      });
    });

    describe('Startup/shutdown ordering', () => {
      test('start ordering: API=1, Worker=2, Deploy=3', () => {
        const services = getServiceConfigs('test-tag', 'staging');
        const apiSvc = services.find((s) => s.name === 'ghosthands-api')!;
        const workerSvc = services.find((s) => s.name === 'ghosthands-worker')!;
        const deploySvc = services.find((s) => s.name === 'ghosthands-deploy-server')!;

        expect(apiSvc.startOrder).toBe(1);
        expect(workerSvc.startOrder).toBe(2);
        expect(deploySvc.startOrder).toBe(3);
      });

      test('stop ordering: Worker=1, Deploy=2, API=3', () => {
        const services = getServiceConfigs('test-tag', 'staging');
        const apiSvc = services.find((s) => s.name === 'ghosthands-api')!;
        const workerSvc = services.find((s) => s.name === 'ghosthands-worker')!;
        const deploySvc = services.find((s) => s.name === 'ghosthands-deploy-server')!;

        expect(workerSvc.stopOrder).toBe(1);
        expect(deploySvc.stopOrder).toBe(2);
        expect(apiSvc.stopOrder).toBe(3);
      });

      test('stop order sorted array places worker first, then deploy, then API', () => {
        const services = getServiceConfigs('test-tag', 'staging');
        const stopSorted = [...services].sort((a, b) => a.stopOrder - b.stopOrder);

        expect(stopSorted[0].name).toBe('ghosthands-worker');
        expect(stopSorted[1].name).toBe('ghosthands-deploy-server');
        expect(stopSorted[2].name).toBe('ghosthands-api');
      });
    });

    describe('Image tag handling', () => {
      test('builds correct ECR image reference from tag', () => {
        const services = getServiceConfigs('prod-v1.2.3', 'production');
        const expectedImage =
          '471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands:prod-v1.2.3';

        expect(services[0].config.Image).toBe(expectedImage);
      });

      test('different tags produce different image references', () => {
        const staging = getServiceConfigs('staging-abc', 'staging');
        const prod = getServiceConfigs('prod-xyz', 'production');

        expect(staging[0].config.Image).not.toBe(prod[0].config.Image);
        expect(staging[0].config.Image).toContain(':staging-abc');
        expect(prod[0].config.Image).toContain(':prod-xyz');
      });
    });
  });
});
