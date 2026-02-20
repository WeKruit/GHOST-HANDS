/**
 * GhostHands EC2 Deploy Server
 *
 * Lightweight HTTP server on port 8000 that VALET's DeployService calls
 * to trigger deploys and check health on each EC2 sandbox.
 *
 * Endpoints:
 *   GET  /health      — Returns worker health + active task count (no auth)
 *   GET  /metrics     — Returns system-level CPU/memory/disk stats (no auth)
 *   GET  /version     — Returns deploy server version + current image info
 *   GET  /containers  — Returns running Docker containers (no auth)
 *   GET  /workers     — Returns worker registry status (no auth)
 *   POST /deploy      — Rolling deploy via Docker Engine API (requires X-Deploy-Secret)
 *   POST /drain       — Triggers graceful worker drain (requires X-Deploy-Secret)
 *   POST /rollback    — Stub for future rollback support (requires X-Deploy-Secret)
 *
 * Auth:
 *   POST endpoints require X-Deploy-Secret header matching GH_DEPLOY_SECRET env var.
 *   GET endpoints are unauthenticated (monitoring/health checks).
 *
 * Usage:
 *   GH_DEPLOY_SECRET=<secret> bun scripts/deploy-server.ts
 *
 * Environment:
 *   GH_DEPLOY_SECRET     — Required. Shared secret for deploy auth.
 *   GH_DEPLOY_PORT       — Port to listen on (default: 8000)
 *   GH_API_PORT          — GH API health port (default: 3100)
 *   GH_WORKER_PORT       — GH worker status port (default: 3101)
 *   GH_ENVIRONMENT       — Deploy environment: staging | production (default: staging)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

import {
  pullImage,
  stopContainer,
  removeContainer,
  createContainer,
  startContainer,
  pruneImages,
} from './lib/docker-client';
import { getEcrAuth } from './lib/ecr-auth';
import { getServiceConfigs, type ServiceDefinition } from './lib/container-configs';

const DEPLOY_PORT = parseInt(process.env.GH_DEPLOY_PORT || '8000', 10);
const DEPLOY_SECRET = process.env.GH_DEPLOY_SECRET;
const API_HOST = process.env.GH_API_HOST || 'localhost';
const API_PORT = parseInt(process.env.GH_API_PORT || '3100', 10);
const WORKER_HOST = process.env.GH_WORKER_HOST || 'localhost';
const WORKER_PORT = parseInt(process.env.GH_WORKER_PORT || '3101', 10);

/** Deployment environment, determined from env vars */
const currentEnvironment: 'staging' | 'production' =
  (process.env.GH_ENVIRONMENT as 'staging' | 'production') ||
  (process.env.NODE_ENV === 'production' ? 'production' : 'staging');

const startedAt = Date.now();
let currentDeploy: { imageTag: string; startedAt: number; step: string } | null = null;

// ── Deploy Result Types ─────────────────────────────────────────────

interface DeployResult {
  success: true;
  duration: number;
  imageTag: string;
  spaceReclaimed: number;
}

interface DeployFailure {
  success: false;
  error: string;
  failedStep?: string;
  failedService?: string;
}

if (!DEPLOY_SECRET) {
  console.error('[deploy-server] FATAL: GH_DEPLOY_SECRET is required');
  process.exit(1);
}

function verifySecret(req: Request): boolean {
  const header = req.headers.get('x-deploy-secret');
  if (!header || !DEPLOY_SECRET) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(header),
      Buffer.from(DEPLOY_SECRET),
    );
  } catch {
    return false;
  }
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Deploy Helpers ────────────────────────────────────────────────

/**
 * Polls a service health endpoint until it returns 200 or the timeout expires.
 *
 * @param serviceName - Service name for logging
 * @param healthUrl - HTTP health check URL
 * @param timeoutMs - Maximum wait time in milliseconds
 * @throws Error if the service does not become healthy within timeoutMs
 */
async function waitForHealthy(
  serviceName: string,
  healthUrl: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!healthUrl) return;
  const deadline = Date.now() + timeoutMs;
  console.log(`[deploy] Waiting for ${serviceName} to become healthy (${healthUrl}, timeout ${timeoutMs}ms)`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        console.log(`[deploy] ${serviceName} is healthy`);
        return;
      }
    } catch {
      // Still starting up — retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${serviceName} failed health check after ${timeoutMs}ms`);
}

/**
 * Sends a POST to a service's drain endpoint for graceful shutdown.
 * Non-fatal: logs but does not throw on failure.
 *
 * @param drainUrl - HTTP endpoint to POST for graceful drain
 * @param timeoutMs - Maximum wait time in milliseconds
 */
async function drainService(drainUrl: string, timeoutMs: number): Promise<void> {
  try {
    console.log(`[deploy] Draining via ${drainUrl} (timeout ${timeoutMs}ms)`);
    await fetch(drainUrl, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    console.log(`[deploy] Drain completed`);
  } catch (err) {
    console.log(`[deploy] Drain failed (non-fatal): ${err}`);
  }
}

/**
 * Executes a full rolling deploy via Docker Engine API.
 *
 * Steps:
 *   1. Authenticate with ECR
 *   2. Pull new image
 *   3. Load service configs
 *   4. Stop phase: drain + stop + remove (respecting stopOrder)
 *   5. Start phase: create + start + health check (respecting startOrder)
 *   6. Prune old images
 *
 * @param imageTag - ECR image tag to deploy
 * @returns DeployResult on success, DeployFailure on error
 */
async function executeDeploy(imageTag: string): Promise<DeployResult | DeployFailure> {
  const startTime = Date.now();

  try {
    // 1. Authenticate with ECR
    if (currentDeploy) currentDeploy.step = 'ecr-auth';
    console.log('[deploy] Authenticating with ECR...');
    const ecrAuth = await getEcrAuth();
    console.log(`[deploy] ECR auth obtained (registry: ${ecrAuth.registryUrl})`);

    // 2. Pull new image
    if (currentDeploy) currentDeploy.step = 'pull-image';
    const fullImage = `${ecrAuth.registryUrl}/wekruit/ghosthands`;
    console.log(`[deploy] Pulling image: ${fullImage}:${imageTag}`);
    await pullImage(fullImage, imageTag, ecrAuth.token);
    console.log(`[deploy] Image pulled successfully`);

    // 3. Get service configs
    if (currentDeploy) currentDeploy.step = 'load-configs';
    const services = getServiceConfigs(imageTag, currentEnvironment);
    console.log(`[deploy] Loaded ${services.length} service configs (env: ${currentEnvironment})`);

    // 4. Stop phase (respect stopOrder — lower numbers stop first)
    if (currentDeploy) currentDeploy.step = 'stop-services';
    const stopOrder = [...services].sort((a, b) => a.stopOrder - b.stopOrder);
    for (const service of stopOrder) {
      if (service.skipOnSelfUpdate) {
        console.log(`[deploy] Skipping stop for ${service.name} (self-update protection)`);
        continue;
      }

      console.log(`[deploy] Stopping ${service.name} (stopOrder: ${service.stopOrder})`);

      // Drain if endpoint exists
      if (service.drainEndpoint) {
        await drainService(service.drainEndpoint, service.drainTimeout);
      }

      try {
        await stopContainer(service.name, 30);
        await removeContainer(service.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deploy] Failed to stop/remove ${service.name}: ${msg}`);
        return {
          success: false,
          error: `Failed to stop service: ${msg}`,
          failedStep: 'stop-services',
          failedService: service.name,
        };
      }
    }

    // 5. Start phase (respect startOrder — lower numbers start first)
    if (currentDeploy) currentDeploy.step = 'start-services';
    const startOrder = [...services].sort((a, b) => a.startOrder - b.startOrder);
    for (const service of startOrder) {
      if (service.skipOnSelfUpdate) {
        console.log(`[deploy] Skipping start for ${service.name} (self-update protection)`);
        continue;
      }

      console.log(`[deploy] Creating and starting ${service.name} (startOrder: ${service.startOrder})`);

      try {
        await createContainer(service.name, service.config);
        await startContainer(service.name);
        await waitForHealthy(service.name, service.healthEndpoint, service.healthTimeout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deploy] Failed to start ${service.name}: ${msg}`);
        return {
          success: false,
          error: `Failed to start service: ${msg}`,
          failedStep: 'start-services',
          failedService: service.name,
        };
      }
    }

    // 6. Prune old images
    if (currentDeploy) currentDeploy.step = 'prune-images';
    console.log('[deploy] Pruning old images...');
    let spaceReclaimed = 0;
    try {
      const pruneResult = await pruneImages();
      spaceReclaimed = pruneResult.spaceReclaimed;
      console.log(`[deploy] Pruned images, reclaimed ${spaceReclaimed} bytes`);
    } catch (err) {
      // Non-fatal: log but don't fail the deploy
      console.log(`[deploy] Image prune failed (non-fatal): ${err}`);
    }

    return {
      success: true,
      duration: Date.now() - startTime,
      imageTag,
      spaceReclaimed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const step = currentDeploy?.step ?? 'unknown';
    console.error(`[deploy] Deploy failed at step "${step}": ${msg}`);
    return {
      success: false,
      error: msg,
      failedStep: step,
    };
  }
}

if (typeof Bun !== 'undefined') {
  Bun.serve({
    port: DEPLOY_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // ── GET /health — Unauthenticated health check ──────────
      // Returns activeWorkers count for VALET's drain logic
      if (url.pathname === '/health' && req.method === 'GET') {
        // Check GH API health
        const apiHealth = await fetchJson(`http://${API_HOST}:${API_PORT}/health`);

        // Check worker status
        const workerHealth = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/health`);
        const workerStatus = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/status`);

        const activeWorkers = (workerStatus?.active_jobs as number) ?? 0;
        const deploySafe = (workerHealth?.deploy_safe as boolean) ?? (activeWorkers === 0);

        return Response.json({
          status: apiHealth ? 'ok' : 'degraded',
          activeWorkers,
          deploySafe,
          apiHealthy: !!apiHealth,
          workerStatus: workerHealth?.status ?? 'unknown',
          currentDeploy: currentDeploy
            ? { imageTag: currentDeploy.imageTag, elapsedMs: Date.now() - currentDeploy.startedAt }
            : null,
          uptimeMs: Date.now() - startedAt,
        });
      }

      // ── GET /version — Unauthenticated version info ─────────
      if (url.pathname === '/version' && req.method === 'GET') {
        const apiVersion = await fetchJson(`http://${API_HOST}:${API_PORT}/health/version`);
        return Response.json({
          deployServer: 'ghosthands-deploy-server',
          version: '1.0.0',
          ghosthands: apiVersion ?? { status: 'unreachable' },
          uptimeMs: Date.now() - startedAt,
        });
      }

      // ── GET /metrics — Unauthenticated system metrics ────────
      if (url.pathname === '/metrics' && req.method === 'GET') {
        // CPU usage: 1-minute load average
        const cpus = os.cpus();
        const cores = cpus.length;
        const loadAvg = os.loadavg()[0] ?? 0;
        const cpuPercent = Math.min(100, (loadAvg / cores) * 100);

        // Memory — use MemAvailable from /proc/meminfo on Linux
        // os.freemem() returns MemFree which excludes reclaimable buff/cache,
        // making usage appear ~95% when real usage is ~20%.
        const totalMem = os.totalmem();
        let availableMem = os.freemem(); // fallback for non-Linux
        try {
          const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
          const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
          if (match) {
            availableMem = parseInt(match[1], 10) * 1024; // kB → bytes
          }
        } catch {
          // /proc/meminfo not available (macOS), use os.freemem() fallback
        }
        const usedMem = totalMem - availableMem;

        // Disk usage via df
        let diskUsedGb = 0;
        let diskTotalGb = 0;
        try {
          const dfOut = execSync("df -BG / | tail -1 | awk '{print $2, $3}'", {
            encoding: 'utf-8',
            timeout: 3000,
          }).trim();
          const [totalStr, usedStr] = dfOut.split(/\s+/);
          diskTotalGb = parseFloat(totalStr?.replace('G', '') ?? '0');
          diskUsedGb = parseFloat(usedStr?.replace('G', '') ?? '0');
        } catch {
          // Disk metrics unavailable
        }

        return Response.json({
          cpu: {
            usagePercent: Math.round(cpuPercent * 10) / 10,
            cores,
          },
          memory: {
            usedMb: Math.round(usedMem / 1024 / 1024),
            totalMb: Math.round(totalMem / 1024 / 1024),
            usagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
          },
          disk: {
            usedGb: diskUsedGb,
            totalGb: diskTotalGb,
            usagePercent: diskTotalGb > 0 ? Math.round((diskUsedGb / diskTotalGb) * 1000) / 10 : 0,
          },
          network: {
            rxBytesPerSec: 0,
            txBytesPerSec: 0,
          },
        });
      }

      // ── GET /containers — Running Docker containers ───────────
      // Returns ContainerInfo[] matching VALET's expected schema
      if (url.pathname === '/containers' && req.method === 'GET') {
        try {
          const resp = await fetch('http://localhost/containers/json', {
            // @ts-ignore — Bun supports unix sockets via fetch
            unix: '/var/run/docker.sock',
            signal: AbortSignal.timeout(5000),
          });

          if (!resp.ok) throw new Error(`Docker API: ${resp.status}`);
          const raw = (await resp.json()) as Array<Record<string, unknown>>;

          // Return flat array matching ContainerInfo type
          const containers = raw.map((c) => ({
            id: ((c.Id as string) ?? '').slice(0, 12),
            name: ((c.Names as string[]) ?? [])[0]?.replace(/^\//, '') ?? 'unknown',
            image: (c.Image as string) ?? 'unknown',
            status: (c.Status as string) ?? 'unknown',
            state: (c.State as string) ?? 'unknown',
            ports: ((c.Ports as Array<{ PublicPort?: number; PrivatePort?: number; Type?: string }>) ?? [])
              .filter((p) => p.PublicPort)
              .map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type ?? 'tcp'}`),
            createdAt: c.Created ? new Date((c.Created as number) * 1000).toISOString() : '',
            labels: (c.Labels as Record<string, string>) ?? {},
          }));

          return Response.json(containers);
        } catch (err) {
          // Return empty array on error (client expects ContainerInfo[])
          return Response.json([]);
        }
      }

      // ── GET /workers — Worker registry status ─────────────────
      // Returns WorkerInfo[] matching VALET's expected schema
      if (url.pathname === '/workers' && req.method === 'GET') {
        const workerHealth = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/health`);
        const workerStatus = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/status`);

        const workerId = (workerHealth?.worker_id ?? workerStatus?.worker_id ?? 'unknown') as string;
        const uptimeMs = (workerHealth?.uptime as number) ?? 0;

        // Return flat array matching WorkerInfo type
        return Response.json([
          {
            workerId,
            containerId: '',
            containerName: 'ghosthands-worker-1',
            status: (workerHealth?.status as string) ?? 'unknown',
            activeJobs: (workerStatus?.active_jobs as number) ?? 0,
            statusPort: WORKER_PORT,
            uptime: Math.round(uptimeMs / 1000),
            image: 'ghosthands:latest',
          },
        ]);
      }

      // ── POST /deploy — Authenticated deploy trigger ─────────
      if (url.pathname === '/deploy' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        if (currentDeploy) {
          return Response.json(
            {
              success: false,
              message: `Deploy already in progress: ${currentDeploy.imageTag} (started ${Math.round((Date.now() - currentDeploy.startedAt) / 1000)}s ago)`,
            },
            { status: 409 },
          );
        }

        let body: { image_tag?: string } = {};
        try {
          body = (await req.json()) as { image_tag?: string };
        } catch {
          return Response.json(
            { success: false, message: 'Invalid JSON body' },
            { status: 400 },
          );
        }

        const imageTag = body.image_tag || 'latest';

        // Validate image_tag format (alphanumeric, dashes, dots, colons, slashes)
        if (!/^[a-zA-Z0-9._\-/:]+$/.test(imageTag)) {
          return Response.json(
            { success: false, message: 'Invalid image_tag format' },
            { status: 400 },
          );
        }

        console.log(`[deploy-server] Deploy requested: image_tag=${imageTag}`);

        currentDeploy = {
          imageTag,
          startedAt: Date.now(),
          step: 'initializing',
        };

        try {
          const result = await executeDeploy(imageTag);
          currentDeploy = null;

          if (result.success) {
            console.log(`[deploy-server] Deploy succeeded: ${imageTag} (${result.duration}ms)`);
            return Response.json({
              success: true,
              message: `Deploy successful: ${imageTag}`,
              duration: result.duration,
              imageTag: result.imageTag,
            });
          } else {
            console.error(`[deploy-server] Deploy failed: ${imageTag} — ${result.error}`);
            return Response.json(
              {
                success: false,
                error: result.error,
                failedStep: result.failedStep,
                failedService: result.failedService,
              },
              { status: 500 },
            );
          }
        } catch (err) {
          currentDeploy = null;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[deploy-server] Deploy error: ${msg}`);
          return Response.json(
            { success: false, error: `Deploy error: ${msg}` },
            { status: 500 },
          );
        }
      }

      // ── POST /drain — Authenticated drain trigger ───────────
      if (url.pathname === '/drain' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        console.log('[deploy-server] Drain requested');
        try {
          // Drain the worker via its HTTP endpoint
          await drainService(`http://${WORKER_HOST}:${WORKER_PORT}/drain`, 60_000);
          return Response.json({ success: true, message: 'Drain complete' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ success: false, message: `Drain failed: ${msg}` }, { status: 500 });
        }
      }

      // ── POST /rollback — Stub for future rollback support ──────
      if (url.pathname === '/rollback' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        // v1: rollback not yet implemented — report error
        return Response.json(
          { success: false, message: 'Rollback not yet implemented. Redeploy with a previous image tag.' },
          { status: 501 },
        );
      }

      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });

  console.log(`[deploy-server] Listening on port ${DEPLOY_PORT}`);
  console.log(`[deploy-server] GH API: ${API_HOST}:${API_PORT}, Worker: ${WORKER_HOST}:${WORKER_PORT}`);
  console.log(`[deploy-server] Environment: ${currentEnvironment}, Deploy method: Docker API`);
} else {
  console.error('[deploy-server] This server requires Bun runtime');
  process.exit(1);
}
