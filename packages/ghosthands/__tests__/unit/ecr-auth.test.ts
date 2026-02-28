/**
 * WEK-83: ECR Authentication Module Tests
 *
 * Unit tests for the ECR auth module (scripts/lib/ecr-auth.ts).
 * Uses real temp files instead of vi.mock('fs') to avoid mock leaks in bun's
 * single-process test runner.
 *
 * The module reads DOCKER_CONFIG_PATH at import time, so we must set the env var
 * BEFORE the module is first loaded. We use dynamic import() inside beforeAll to
 * ensure correct ordering (Bun hoists static import above other statements).
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Module functions — populated via dynamic import in beforeAll
let getEcrAuth: typeof import('../../../../scripts/lib/ecr-auth').getEcrAuth;
let clearEcrAuthCache: typeof import('../../../../scripts/lib/ecr-auth').clearEcrAuthCache;
let getEcrImageRef: typeof import('../../../../scripts/lib/ecr-auth').getEcrImageRef;

let tmpDir: string;
let configPath: string;

/**
 * Writes a mock Docker config.json to the temp file.
 */
function writeDockerConfig(overrides: {
  registry?: string;
  auth?: string | null;
  extraAuths?: Record<string, { auth?: string }>;
} = {}): void {
  const registry = overrides.registry ?? '168495702277.dkr.ecr.us-east-1.amazonaws.com';
  const auth = overrides.auth === null
    ? undefined
    : (overrides.auth ?? Buffer.from('AWS:mock-ecr-token').toString('base64'));

  const auths: Record<string, { auth?: string }> = {
    ...(overrides.extraAuths ?? {}),
  };

  if (auth !== undefined) {
    auths[registry] = { auth };
  } else {
    auths[registry] = {};
  }

  fs.writeFileSync(configPath, JSON.stringify({ auths }), 'utf-8');
}

describe('ECR Auth Module', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Create temp dir and config path BEFORE importing the module
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-ecr-test-'));
    configPath = path.join(tmpDir, 'config.json');

    // Set env var so the module picks up our temp path
    savedEnv.DOCKER_CONFIG_PATH = process.env.DOCKER_CONFIG_PATH;
    savedEnv.ECR_REGISTRY = process.env.ECR_REGISTRY;
    savedEnv.ECR_REPOSITORY = process.env.ECR_REPOSITORY;
    process.env.DOCKER_CONFIG_PATH = configPath;
    delete process.env.ECR_REGISTRY;
    delete process.env.ECR_REPOSITORY;

    // Dynamic import AFTER env is set — this ensures the module reads our temp path
    const mod = await import('../../../../scripts/lib/ecr-auth');
    getEcrAuth = mod.getEcrAuth;
    clearEcrAuthCache = mod.clearEcrAuthCache;
    getEcrImageRef = mod.getEcrImageRef;
  });

  beforeEach(() => {
    clearEcrAuthCache();
    delete process.env.ECR_REGISTRY;
    delete process.env.ECR_REPOSITORY;
    // Remove config file if it exists
    try { fs.unlinkSync(configPath); } catch { /* ok */ }
  });

  afterEach(() => {
    clearEcrAuthCache();
  });

  afterAll(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  });

  describe('getEcrAuth', () => {
    test('returns correctly formatted Docker auth token (base64 JSON with username/password/serveraddress)', async () => {
      writeDockerConfig();

      const result = await getEcrAuth();

      const decoded = JSON.parse(Buffer.from(result.token, 'base64').toString('utf-8'));
      expect(decoded).toHaveProperty('username', 'AWS');
      expect(decoded).toHaveProperty('password', 'mock-ecr-token');
      expect(decoded).toHaveProperty('serveraddress', 'https://168495702277.dkr.ecr.us-east-1.amazonaws.com');
    });

    test('returns registryUrl without https:// prefix', async () => {
      writeDockerConfig();

      const result = await getEcrAuth();

      expect(result.registryUrl).toBe('168495702277.dkr.ecr.us-east-1.amazonaws.com');
      expect(result.registryUrl).not.toContain('https://');
    });

    test('returns expiresAt approximately 30 minutes from now (cache TTL)', async () => {
      writeDockerConfig();
      const before = Date.now();

      const result = await getEcrAuth();
      const after = Date.now();

      const thirtyMinMs = 30 * 60 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyMinMs - 2000);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyMinMs + 2000);
    });

    test('token caching: second call returns cached token without re-reading file', async () => {
      writeDockerConfig();

      const first = await getEcrAuth();

      // Overwrite the file with different content — if caching works, second call returns same token
      writeDockerConfig({ auth: Buffer.from('AWS:different-token').toString('base64') });

      const second = await getEcrAuth();

      expect(second.token).toBe(first.token);
      expect(second.expiresAt).toEqual(first.expiresAt);
    });

    test('cache refresh: after clearing cache, re-reads file', async () => {
      writeDockerConfig();

      const first = await getEcrAuth();

      clearEcrAuthCache();

      writeDockerConfig({ auth: Buffer.from('AWS:new-token').toString('base64') });

      const second = await getEcrAuth();

      expect(second.token).not.toBe(first.token);
    });

    test('error handling: config.json has no auths section throws descriptive error', async () => {
      fs.writeFileSync(configPath, JSON.stringify({}), 'utf-8');

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed/);
    });

    test('error handling: no ECR registry entry in config.json throws descriptive error', async () => {
      fs.writeFileSync(configPath, JSON.stringify({
        auths: {
          'docker.io': { auth: Buffer.from('user:pass').toString('base64') },
        },
      }), 'utf-8');

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed/);
    });

    test('error handling: ECR entry with no auth field throws descriptive error', async () => {
      writeDockerConfig({ auth: null });

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed/);
    });

    test('error handling: config.json with invalid auth format (no colon separator)', async () => {
      const badAuth = Buffer.from('no-colon-separator').toString('base64');
      writeDockerConfig({ auth: badAuth });

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed/);
    });

    test('error handling: missing config file throws descriptive error', async () => {
      // config file doesn't exist (we removed it in beforeEach)

      await expect(getEcrAuth()).rejects.toThrow(/ECR authentication failed/);
    });

    test('finds ECR registry entry among multiple auths', async () => {
      writeDockerConfig({
        extraAuths: {
          'docker.io': { auth: Buffer.from('docker:token').toString('base64') },
          'ghcr.io': { auth: Buffer.from('gh:token').toString('base64') },
        },
      });

      const result = await getEcrAuth();
      expect(result.registryUrl).toContain('.dkr.ecr.');
    });
  });

  describe('clearEcrAuthCache', () => {
    test('resets cache so next getEcrAuth re-reads file', async () => {
      writeDockerConfig();

      const first = await getEcrAuth();

      clearEcrAuthCache();
      writeDockerConfig({ auth: Buffer.from('AWS:refreshed-token').toString('base64') });

      const second = await getEcrAuth();
      expect(second.token).not.toBe(first.token);
    });

    test('can be called when cache is already empty without error', () => {
      expect(() => clearEcrAuthCache()).not.toThrow();
    });
  });

  describe('getEcrImageRef', () => {
    test('uses cached registry URL from getEcrAuth', async () => {
      delete process.env.ECR_REGISTRY;
      writeDockerConfig();

      await getEcrAuth();

      const ref = getEcrImageRef('latest');
      expect(ref).toBe('168495702277.dkr.ecr.us-east-1.amazonaws.com/ghosthands:latest');
    });

    test('throws when ECR_REGISTRY not set and no cached auth', () => {
      delete process.env.ECR_REGISTRY;
      clearEcrAuthCache();

      expect(() => getEcrImageRef('latest')).toThrow(/ECR_REGISTRY/);
    });

    test('handles special characters in tag', async () => {
      delete process.env.ECR_REGISTRY;
      writeDockerConfig();
      await getEcrAuth();

      const ref = getEcrImageRef('staging-abc123-special.tag');
      expect(ref).toContain(':staging-abc123-special.tag');
    });
  });
});
