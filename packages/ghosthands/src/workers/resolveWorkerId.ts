import { getLogger } from '../monitoring/logger.js';
import { discoverImdsInstanceId } from './asg-lifecycle.js';

const logger = getLogger({ service: 'Worker' });

/**
 * Resolves worker ID from multiple sources (in priority order):
 *   1. CLI arg (--worker-id=VALUE) — explicit override
 *   2. GH_WORKER_ID env var — backward compat, docker-compose deploys
 *   3. EC2 IMDS — strict, no env fallback (prevents stale EC2_INSTANCE_ID)
 *   4. Generated fallback — worker-{region|env|local}-{timestamp}
 *
 * IMDS-unavailable contract:
 *   When running outside EC2 (local dev, CI, non-AWS infra) or when IMDS is
 *   unreachable, discoverImdsInstanceId() returns null and the worker falls
 *   through to a generated ID (e.g. "worker-local-1709312400000"). The worker
 *   self-registers with this temporary ID. Targeted routing must use this
 *   generated ID — there is no instance ID available. If IMDS recovers on a
 *   subsequent restart, the worker ID changes to the real instance ID. This is
 *   expected: the old generated-ID registration becomes stale and is cleaned up
 *   by the heartbeat stale-worker reaper.
 */
export async function resolveWorkerId(): Promise<string> {
  // 1. CLI arg (explicit override)
  const arg = process.argv.find((a) => a.startsWith('--worker-id='));
  if (arg) {
    const id = arg.split('=')[1];
    if (!id) {
      throw new Error('--worker-id requires a value (e.g. --worker-id=adam)');
    }
    logger.info('Worker ID resolved', { source: 'cli', workerId: id });
    return id;
  }

  // 2. Environment variable (backward compat, docker-compose deploys)
  if (process.env.GH_WORKER_ID) {
    logger.info('Worker ID resolved', { source: 'env', workerId: process.env.GH_WORKER_ID });
    return process.env.GH_WORKER_ID;
  }

  // 3. EC2 IMDS — strict, no env fallback (prevents stale EC2_INSTANCE_ID from leaking in)
  const instanceId = await discoverImdsInstanceId();
  if (instanceId) {
    logger.info('Worker ID resolved', { source: 'imds', workerId: instanceId });
    return instanceId;
  }

  // 4. Fallback — generated ID (see IMDS-unavailable contract in JSDoc above)
  const generated = `worker-${process.env.FLY_REGION || process.env.NODE_ENV || 'local'}-${Date.now()}`;
  logger.info('Worker ID resolved', { source: 'generated', workerId: generated });
  return generated;
}
