import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import pg from 'pg';
import { getSupabaseClient } from '../db/client.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { strictCSP } from './middleware/csp.js';
import { JobController } from './controllers/jobs.js';
import { health } from './routes/health.js';
import { models } from './routes/models.js';
import { createJobRoutes } from './routes/jobs.js';
import { createValetRoutes } from './routes/valet.js';
import { createUsageRoutes } from './routes/usage.js';
import { requestLoggingMiddleware, getLogger } from '../monitoring/logger.js';
import { metricsMiddleware } from './middleware/metrics.js';
import { createMonitoringRoutes } from './routes/monitoring.js';
import { browserSessionRegistry } from '../workers/browserSessionRegistry.js';

const { Pool } = pg;

/**
 * Create and configure the GhostHands Hono API application.
 * Designed to be imported by a server entry point or used in tests.
 */
export function createApp() {
  const app = new Hono();

  // ─── Global Middleware ─────────────────────────────────────────

  app.use('*', logger());
  app.use('*', requestLoggingMiddleware());
  app.use('*', metricsMiddleware());
  app.use('*', strictCSP());

  app.use('*', cors({
    origin: process.env.CORS_ORIGIN || '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-GH-Service-Key'],
    maxAge: 86400,
  }));

  // ─── Error Handler ─────────────────────────────────────────────

  app.onError(errorHandler);

  // ─── Health Check (no auth required) ───────────────────────────

  app.route('/health', health);

  // ─── Models Catalog (no auth required) ─────────────────────────

  app.route('/api/v1/gh/models', models);

  // ─── Monitoring Routes (no auth required) ──────────────────────

  const supabase = getSupabaseClient();
  const { app: monitoringApp } = createMonitoringRoutes({ supabase });
  app.route('/monitoring', monitoringApp);

  // ─── Authenticated API Routes ──────────────────────────────────

  const api = new Hono();
  api.use('*', authMiddleware);

  // Wire up controllers with PostgreSQL pool (bypasses JWT issues)
  // Prefer transaction-mode pooler (DATABASE_URL, port 6543) for API — handles many concurrent connections.
  // Fall back to session-mode (SUPABASE_DIRECT_URL, port 5432) if pooler URL not set.
  const poolUrl = process.env.DATABASE_URL || process.env.SUPABASE_DIRECT_URL || process.env.DATABASE_DIRECT_URL;
  if (!poolUrl) {
    throw new Error('Missing DATABASE_URL, SUPABASE_DIRECT_URL, or DATABASE_DIRECT_URL environment variable');
  }
  const pgPool = new Pool({ connectionString: poolUrl, max: 3, idleTimeoutMillis: 30_000 });
  const jobController = new JobController({ pool: pgPool });

  api.route('/jobs', createJobRoutes(jobController));
  api.route('/valet', createValetRoutes(pgPool));
  api.route('/', createUsageRoutes());

  // Mount under versioned prefix
  app.route('/api/v1/gh', api);

  // ─── Internal Browser Session Endpoint (service-key auth) ─────

  app.get('/internal/browser-session', (c) => {
    const serviceKey = c.req.header('X-GH-Service-Key');
    const expectedSecret = process.env.GH_SERVICE_SECRET;
    if (!expectedSecret) {
      return c.json({ error: 'server_config_error', message: 'Service secret not configured' }, 500);
    }
    if (!serviceKey || serviceKey !== expectedSecret) {
      return c.json({ error: 'unauthorized', message: 'Invalid service key' }, 401);
    }
    const snapshot = browserSessionRegistry.getPublicSnapshot();
    return c.json(snapshot);
  });

  // ─── 404 Fallback ─────────────────────────────────────────────

  app.notFound((c) => {
    return c.json({ error: 'not_found', message: 'Route not found' }, 404);
  });

  return app;
}

/** Data attached to each CDP proxy WebSocket connection */
export interface CdpProxyData { cdpWsUrl: string; jobId: string; cdpSocket?: WebSocket }

/** Validate X-GH-Service-Key from header or query param */
function validateServiceKey(req: Request): boolean {
  const expectedSecret = process.env.GH_SERVICE_SECRET;
  if (!expectedSecret) return false;
  // Check header first, then ?key= query param (for WebSocket clients)
  const headerKey = req.headers.get('X-GH-Service-Key');
  if (headerKey === expectedSecret) return true;
  const url = new URL(req.url);
  const queryKey = url.searchParams.get('key');
  return queryKey === expectedSecret;
}

/**
 * Start the server if this file is run directly.
 * Uses Bun.serve (with WebSocket support) or Node's built-in fetch adapter.
 */
export function startServer(port: number = 3100) {
  const app = createApp();
  const srvLogger = getLogger({ service: 'api-server' });

  srvLogger.info('GhostHands API starting', { port });

  // Bun-native serve with WebSocket CDP proxy
  if (typeof Bun !== 'undefined') {
    const server = Bun.serve<CdpProxyData>({
      port,
      fetch(req, server) {
        const url = new URL(req.url);

        // Handle CDP proxy WebSocket upgrade
        if (url.pathname === '/internal/cdp-proxy') {
          if (!validateServiceKey(req)) {
            return new Response(JSON.stringify({ error: 'unauthorized', message: 'Invalid service key' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const session = browserSessionRegistry.getCurrent();
          if (!session || !session.pausedForHuman) {
            return new Response(JSON.stringify({ error: 'no_paused_session', message: 'No paused browser session available' }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const upgraded = server.upgrade(req, {
            data: { cdpWsUrl: session.cdpWsUrl, jobId: session.jobId },
          });
          if (upgraded) return undefined;
          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        // All other routes handled by Hono
        return app.fetch(req, server);
      },
      websocket: {
        open(ws) {
          const { cdpWsUrl, jobId } = ws.data;
          srvLogger.info('CDP proxy WebSocket opened', { jobId });

          // Connect to internal Chrome CDP
          const cdpSocket = new WebSocket(cdpWsUrl);

          cdpSocket.addEventListener('open', () => {
            srvLogger.info('CDP proxy connected to Chrome', { jobId });
          });

          cdpSocket.addEventListener('message', (event) => {
            // Forward Chrome -> VALET
            const data = event.data;
            if (typeof data === 'string') {
              ws.send(data);
            } else if (data instanceof ArrayBuffer) {
              ws.send(new Uint8Array(data));
            } else if (data instanceof Blob) {
              data.arrayBuffer().then((buf) => ws.send(new Uint8Array(buf)));
            }
          });

          cdpSocket.addEventListener('close', () => {
            srvLogger.info('CDP upstream closed', { jobId });
            ws.close();
          });

          cdpSocket.addEventListener('error', (err) => {
            srvLogger.warn('CDP upstream error', { jobId, error: String(err) });
            ws.close();
          });

          // Store reference for message forwarding and cleanup
          ws.data.cdpSocket = cdpSocket;
        },
        message(ws, msg) {
          // Forward VALET -> Chrome CDP
          const { cdpSocket } = ws.data;
          if (cdpSocket?.readyState === WebSocket.OPEN) {
            if (typeof msg === 'string') {
              cdpSocket.send(msg);
            } else {
              cdpSocket.send(msg);
            }
          }
        },
        close(ws) {
          const { cdpSocket, jobId } = ws.data;
          srvLogger.info('CDP proxy WebSocket closed', { jobId });
          if (cdpSocket && cdpSocket.readyState !== WebSocket.CLOSED) {
            cdpSocket.close();
          }
        },
      },
    });

    return server;
  }

  // Node.js fallback via @hono/node-server (no WebSocket support)
  return import('@hono/node-server').then(({ serve }) => {
    serve({ fetch: app.fetch, port });
    srvLogger.info('GhostHands API listening (Node.js, no CDP proxy)', { url: `http://localhost:${port}` });
  });
}

// Auto-start when run directly
const isMainModule =
  typeof Bun !== 'undefined'
    ? Bun.main === import.meta.path
    : process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');

if (isMainModule) {
  const port = parseInt(process.env.GH_API_PORT || '3100', 10);
  startServer(port);
}
