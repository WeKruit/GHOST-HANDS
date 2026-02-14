import { getMetrics } from '../../monitoring/metrics.js';

/**
 * Hono middleware that records API request metrics (path, status, duration).
 */
export function metricsMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const start = Date.now();

    await next();

    const durationMs = Date.now() - start;
    const path = c.req.routePath ?? c.req.path;
    const status = c.res.status;

    getMetrics().recordAPIRequest(path, status, durationMs);
  };
}
