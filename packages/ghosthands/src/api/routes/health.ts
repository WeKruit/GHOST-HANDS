import { Hono } from 'hono';
import * as os from 'os';
import { readFileSync } from 'fs';

const startedAt = Date.now();

/** Read MemAvailable from /proc/meminfo (Linux only). Falls back to os.freemem(). */
function getAvailableMemory(): number {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)/);
    if (match) return parseInt(match[1], 10) * 1024; // kB → bytes
  } catch {
    // Not Linux or /proc not available
  }
  return os.freemem();
}

// Cached DB health check — avoids hitting the DB on every /health request.
// TTL: 30 seconds. Defaults to true if Supabase is not configured (e.g. tests).
let dbHealthy = true;
let dbHealthCheckedAt = 0;
const DB_HEALTH_TTL_MS = 30_000;

async function checkDbHealth(): Promise<boolean> {
  const now = Date.now();
  if (now - dbHealthCheckedAt < DB_HEALTH_TTL_MS) return dbHealthy;

  try {
    const { getSupabaseClient } = await import('../../db/client.js');
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('gh_worker_registry')
      .select('worker_id', { count: 'exact', head: true });
    dbHealthy = !error;
  } catch {
    // Supabase not configured (e.g. unit tests) — default healthy
    dbHealthy = true;
  }
  dbHealthCheckedAt = now;
  return dbHealthy;
}

const health = new Hono();

health.get('/', async (c) => {
  const apiHealthy = await checkDbHealth();
  return c.json({
    status: 'ok',
    service: 'ghosthands',
    version: '0.1.0',
    environment: process.env.GH_ENVIRONMENT || process.env.NODE_ENV || 'development',
    commit_sha: process.env.COMMIT_SHA || 'unknown',
    api_healthy: apiHealthy,
    timestamp: new Date().toISOString(),
  });
});

health.get('/version', (c) => {
  return c.json({
    service: 'ghosthands',
    environment: process.env.GH_ENVIRONMENT || process.env.NODE_ENV || 'development',
    commit_sha: process.env.COMMIT_SHA || 'unknown',
    image_tag: process.env.IMAGE_TAG || 'unknown',
    build_time: process.env.BUILD_TIME || 'unknown',
    uptime_ms: Date.now() - startedAt,
    node_env: process.env.NODE_ENV || 'development',
  });
});

health.get('/system', (c) => {
  const totalMem = os.totalmem();
  const availableMem = getAvailableMemory();
  const usedMem = totalMem - availableMem;
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  return c.json({
    cpu: {
      usagePercent: Math.round(loadAvg[0] / cpus.length * 100 * 100) / 100, // 1-min load avg as % of cores
      cores: cpus.length,
      loadAvg1m: loadAvg[0],
      loadAvg5m: loadAvg[1],
      loadAvg15m: loadAvg[2],
    },
    memory: {
      usedMb: Math.round(usedMem / 1024 / 1024),
      totalMb: Math.round(totalMem / 1024 / 1024),
      usagePercent: Math.round(usedMem / totalMem * 100 * 100) / 100,
    },
    disk: {
      usedGb: 0,
      totalGb: 0,
      usagePercent: 0,
    },
    timestamp: new Date().toISOString(),
  });
});

export { health };
