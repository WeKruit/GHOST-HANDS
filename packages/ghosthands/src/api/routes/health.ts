import { Hono } from 'hono';

const health = new Hono();

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'ghosthands',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

export { health };
