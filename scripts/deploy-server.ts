/**
 * GhostHands EC2 Deploy Server
 *
 * Lightweight HTTP server on port 8000 that VALET's DeployService calls
 * to trigger deploys and check health on each EC2 sandbox.
 *
 * Endpoints:
 *   GET  /health  — Returns worker health + active task count (no auth)
 *   POST /deploy  — Triggers deploy.sh with image_tag (requires X-Deploy-Secret)
 *   POST /drain   — Triggers graceful worker drain (requires X-Deploy-Secret)
 *   GET  /version — Returns deploy server version + current image info
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
 *   GHOSTHANDS_DIR       — Path to GH install dir (default: /opt/ghosthands)
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DEPLOY_PORT = parseInt(process.env.GH_DEPLOY_PORT || '8000', 10);
const DEPLOY_SECRET = process.env.GH_DEPLOY_SECRET;
const API_PORT = parseInt(process.env.GH_API_PORT || '3100', 10);
const WORKER_PORT = parseInt(process.env.GH_WORKER_PORT || '3101', 10);
const GHOSTHANDS_DIR = process.env.GHOSTHANDS_DIR || '/opt/ghosthands';
const DEPLOY_SCRIPT = `${GHOSTHANDS_DIR}/scripts/deploy.sh`;

const startedAt = Date.now();
let currentDeploy: { imageTag: string; startedAt: number; pid: number } | null = null;

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

function runDeployScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bash', [DEPLOY_SCRIPT, ...args], {
      cwd: GHOSTHANDS_DIR,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const str = data.toString();
      stdout += str;
      process.stdout.write(`[deploy.sh] ${str}`);
    });
    proc.stderr.on('data', (data: Buffer) => {
      const str = data.toString();
      stderr += str;
      process.stderr.write(`[deploy.sh] ${str}`);
    });

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ code: 1, stdout, stderr: stderr + '\nDeploy timed out after 5 minutes' });
    }, 5 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
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
        const apiHealth = await fetchJson(`http://localhost:${API_PORT}/health`);

        // Check worker status
        const workerHealth = await fetchJson(`http://localhost:${WORKER_PORT}/worker/health`);
        const workerStatus = await fetchJson(`http://localhost:${WORKER_PORT}/worker/status`);

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
        const apiVersion = await fetchJson(`http://localhost:${API_PORT}/health/version`);
        return Response.json({
          deployServer: 'ghosthands-deploy-server',
          version: '1.0.0',
          ghosthands: apiVersion ?? { status: 'unreachable' },
          uptimeMs: Date.now() - startedAt,
        });
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
          pid: 0,
        };

        try {
          const result = await runDeployScript(['deploy', imageTag]);
          const elapsedMs = Date.now() - currentDeploy.startedAt;
          currentDeploy = null;

          if (result.code === 0) {
            console.log(`[deploy-server] Deploy succeeded: ${imageTag} (${elapsedMs}ms)`);
            return Response.json({
              success: true,
              message: `Deploy successful: ${imageTag}`,
              imageTag,
              elapsedMs,
            });
          } else {
            console.error(`[deploy-server] Deploy failed: ${imageTag} (exit ${result.code})`);
            return Response.json(
              {
                success: false,
                message: `Deploy failed (exit ${result.code}): ${result.stderr.slice(-500)}`,
                imageTag,
                elapsedMs,
              },
              { status: 500 },
            );
          }
        } catch (err) {
          currentDeploy = null;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[deploy-server] Deploy error: ${msg}`);
          return Response.json(
            { success: false, message: `Deploy error: ${msg}` },
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
        const result = await runDeployScript(['drain']);

        return Response.json({
          success: result.code === 0,
          message: result.code === 0 ? 'Drain complete' : 'Drain failed',
        });
      }

      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });

  console.log(`[deploy-server] Listening on port ${DEPLOY_PORT}`);
  console.log(`[deploy-server] GH API: localhost:${API_PORT}, Worker: localhost:${WORKER_PORT}`);
  console.log(`[deploy-server] Deploy script: ${DEPLOY_SCRIPT}`);
} else {
  console.error('[deploy-server] This server requires Bun runtime');
  process.exit(1);
}
