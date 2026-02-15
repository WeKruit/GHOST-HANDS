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
import { createJobRoutes } from './routes/jobs.js';
import { createValetRoutes } from './routes/valet.js';
import { createUsageRoutes } from './routes/usage.js';
import { requestLoggingMiddleware } from '../monitoring/logger.js';
import { metricsMiddleware } from './middleware/metrics.js';
import { createMonitoringRoutes } from './routes/monitoring.js';

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
  const pgPool = new Pool({ connectionString: poolUrl, max: 5 });
  const jobController = new JobController({ pool: pgPool });

  api.route('/jobs', createJobRoutes(jobController));
  api.route('/valet', createValetRoutes(pgPool));
  api.route('/', createUsageRoutes());

  // Mount under versioned prefix
  app.route('/api/v1/gh', api);

  // ─── 404 Fallback ─────────────────────────────────────────────

  app.notFound((c) => {
    return c.json({ error: 'not_found', message: 'Route not found' }, 404);
  });

  return app;
}

/**
 * Start the server if this file is run directly.
 * Uses Bun.serve or Node's built-in fetch adapter.
 */
export function startServer(port: number = 3100) {
  const app = createApp();

  console.log(`GhostHands API starting on port ${port}`);

  // Bun-native serve
  if (typeof Bun !== 'undefined') {
    return Bun.serve({
      port,
      fetch: app.fetch,
    });
  }

  // Node.js fallback via @hono/node-server
  // Users should install @hono/node-server if not using Bun
  return import('@hono/node-server').then(({ serve }) => {
    serve({ fetch: app.fetch, port });
    console.log(`GhostHands API listening on http://localhost:${port}`);
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
