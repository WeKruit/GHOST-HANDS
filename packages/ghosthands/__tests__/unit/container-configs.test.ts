/**
 * WEK-83: Container Configuration Tests
 *
 * Unit tests for the container config definitions (scripts/lib/container-configs.ts).
 * Tests service definitions, env var passthrough from process.env, and startup/shutdown ordering.
 *
 * getEnvVarsFromProcess reads from process.env (populated by docker-compose env_file
 * and/or AWS Secrets Manager). Tests set process.env directly before calling.
 *
 * getServiceConfigs tests spy on getEnvVarsFromProcess to inject known env vars
 * without polluting the real process.env.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as containerConfigs from '../../../../scripts/lib/container-configs';

import {
  getEnvVarsFromProcess,
  getServiceConfigs,
  type ServiceDefinition,
} from '../../../../scripts/lib/container-configs';

// -- Mock env vars for getServiceConfigs tests --

const SAMPLE_ENV_VARS = [
  'DATABASE_URL=postgres://localhost/db',
  'SUPABASE_URL=https://example.supabase.co',
  'GH_SERVICE_SECRET=test-secret',
];

describe('Container Configs Module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getEnvVarsFromProcess', () => {
    /** Helper: set env vars, call getEnvVarsFromProcess, then clean up */
    function withEnv(vars: Record<string, string>, fn: (result: string[]) => void) {
      const keys = Object.keys(vars);
      const originals: Record<string, string | undefined> = {};
      for (const k of keys) {
        originals[k] = process.env[k];
        process.env[k] = vars[k];
      }
      try {
        const result = getEnvVarsFromProcess();
        fn(result);
      } finally {
        for (const k of keys) {
          if (originals[k] === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = originals[k];
          }
        }
      }
    }

    test('includes DATABASE_ prefixed vars', () => {
      withEnv({ DATABASE_URL: 'postgres://localhost/db' }, (result) => {
        expect(result).toContain('DATABASE_URL=postgres://localhost/db');
      });
    });

    test('includes SUPABASE_ prefixed vars', () => {
      withEnv({ SUPABASE_URL: 'https://example.supabase.co' }, (result) => {
        expect(result).toContain('SUPABASE_URL=https://example.supabase.co');
      });
    });

    test('includes GH_ prefixed vars', () => {
      withEnv({ GH_SERVICE_SECRET: 'test-secret' }, (result) => {
        expect(result).toContain('GH_SERVICE_SECRET=test-secret');
      });
    });

    test('includes ANTHROPIC_ prefixed vars', () => {
      withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, (result) => {
        expect(result).toContain('ANTHROPIC_API_KEY=sk-ant-test');
      });
    });

    test('includes NODE_ENV', () => {
      withEnv({ NODE_ENV: 'production' }, (result) => {
        expect(result).toContain('NODE_ENV=production');
      });
    });

    test('excludes system vars like PATH, HOME, USER', () => {
      // PATH, HOME, USER should already be set in process.env
      const result = getEnvVarsFromProcess();
      const hasSystemVar = result.some(
        (v) => v.startsWith('PATH=') || v.startsWith('HOME=') || v.startsWith('USER='),
      );
      expect(hasSystemVar).toBe(false);
    });

    test('excludes vars with empty values', () => {
      withEnv({ GH_EMPTY_VAR: '' }, (result) => {
        expect(result.some((v) => v.startsWith('GH_EMPTY_VAR='))).toBe(false);
      });
    });

    test('includes multiple matching prefixes', () => {
      withEnv(
        {
          DATABASE_URL: 'pg://db',
          REDIS_URL: 'redis://localhost',
          AWS_REGION: 'us-east-1',
          OPENAI_API_KEY: 'sk-test',
        },
        (result) => {
          expect(result).toContain('DATABASE_URL=pg://db');
          expect(result).toContain('REDIS_URL=redis://localhost');
          expect(result).toContain('AWS_REGION=us-east-1');
          expect(result).toContain('OPENAI_API_KEY=sk-test');
        },
      );
    });
  });

  describe('getServiceConfigs', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Set process.env directly so getEnvVarsFromProcess picks them up
      // (vi.spyOn on named exports doesn't intercept internal calls in bun)
      savedEnv.DATABASE_URL = process.env.DATABASE_URL;
      savedEnv.SUPABASE_URL = process.env.SUPABASE_URL;
      savedEnv.GH_SERVICE_SECRET = process.env.GH_SERVICE_SECRET;
      process.env.DATABASE_URL = 'postgres://localhost/db';
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.GH_SERVICE_SECRET = 'test-secret';
    });

    afterEach(() => {
      // Restore original env
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
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
        '168495702277.dkr.ecr.us-east-1.amazonaws.com/ghosthands:staging-abc123';

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

    test('environment variables from process.env are included in all containers', () => {
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
          'packages/ghosthands/src/api/server.ts',
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
        expect(getWorkerService().drainEndpoint).toBe('http://localhost:3101/worker/drain');
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
        expect(getWorkerService().healthEndpoint).toBe('http://localhost:3101/worker/health');
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
          'scripts/deploy-server.ts',
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
          '168495702277.dkr.ecr.us-east-1.amazonaws.com/ghosthands:prod-v1.2.3';

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
