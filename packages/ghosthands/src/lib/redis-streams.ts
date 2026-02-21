import type Redis from 'ioredis';

/**
 * Redis Streams utilities for publishing real-time progress events.
 *
 * Stream key pattern: `gh:events:{jobId}`
 *
 * GH ProgressTracker publishes events here. VALET SSE endpoint consumes them.
 * DB writes in gh_job_events remain as the permanent audit trail.
 */

/** Build the canonical stream key for a job. */
export function streamKey(jobId: string): string {
  return `gh:events:${jobId}`;
}

/** Fields to publish to Redis Streams (all values serialized as strings). */
export interface StreamEventFields {
  step: string;
  progress_pct: number;
  description: string;
  action_index: number;
  total_actions_estimate: number;
  current_action?: string;
  started_at: string;
  elapsed_ms: number;
  eta_ms: number | null;
  execution_mode?: string;
  manual_id?: string;
  step_cost_cents?: number;
  timestamp: string;
}

/**
 * Publish a progress event to a Redis Stream via XADD.
 *
 * Uses MAXLEN ~1000 to cap stream size automatically.
 * Returns the message ID assigned by Redis.
 */
export async function xaddEvent(
  redis: Redis,
  jobId: string,
  event: StreamEventFields,
): Promise<string | null> {
  const key = streamKey(jobId);

  // Flatten event to string key-value pairs for XADD
  const fields: string[] = [];
  for (const [k, v] of Object.entries(event)) {
    if (v !== undefined && v !== null) {
      fields.push(k, String(v));
    }
  }

  // Auto-trim to ~1000 entries to prevent unbounded growth
  return redis.xadd(key, 'MAXLEN', '~', '1000', '*', ...fields);
}

/**
 * Trim a stream to approximately `maxLen` entries.
 */
export async function xtrimStream(
  redis: Redis,
  jobId: string,
  maxLen = 1000,
): Promise<number> {
  const key = streamKey(jobId);
  return redis.xtrim(key, 'MAXLEN', '~', maxLen);
}

/**
 * Delete a stream entirely.
 */
export async function deleteStream(
  redis: Redis,
  jobId: string,
): Promise<number> {
  const key = streamKey(jobId);
  return redis.del(key);
}

/**
 * Set a TTL on the stream key so it auto-expires after the retention period.
 * Call after job completion.
 *
 * @param ttlSeconds - Time to live in seconds (default: 86400 = 24 hours)
 */
export async function setStreamTTL(
  redis: Redis,
  jobId: string,
  ttlSeconds = 86400,
): Promise<void> {
  const key = streamKey(jobId);
  await redis.expire(key, ttlSeconds);
}
