import { Hono } from 'hono';

const startedAt = Date.now();

const health = new Hono();

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'ghosthands',
    version: '0.1.0',
    commit_sha: process.env.COMMIT_SHA || 'unknown',
    timestamp: new Date().toISOString(),
  });
});

health.get('/version', (c) => {
  return c.json({
    service: 'ghosthands',
    commit_sha: process.env.COMMIT_SHA || 'unknown',
    image_tag: process.env.IMAGE_TAG || 'unknown',
    build_time: process.env.BUILD_TIME || 'unknown',
    uptime_ms: Date.now() - startedAt,
    node_env: process.env.NODE_ENV || 'development',
  });
});

export { health };
