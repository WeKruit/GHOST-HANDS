import { Context, Next } from 'hono';
import { RATE_LIMITS, type UserTier, type Platform } from '../config/rateLimits.js';
import { getAuth } from '../api/middleware/auth.js';
import { getLogger } from '../monitoring/logger.js';

// ─── Sliding Window Store ──────────────────────────────────────────
// In-memory MVP. Swap for Redis ZSET in production.

interface WindowEntry {
  timestamps: number[];
}

const store = new Map<string, WindowEntry>();

/**
 * Record a timestamp and return the count of events within the window.
 * Prunes expired timestamps on each call.
 */
function recordAndCount(key: string, windowMs: number, now: number): number {
  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  const cutoff = now - windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
  entry.timestamps.push(now);

  return entry.timestamps.length;
}

/**
 * Peek at the current count without recording a new event.
 */
function peekCount(key: string, windowMs: number, now: number): number {
  const entry = store.get(key);
  if (!entry) return 0;

  const cutoff = now - windowMs;
  return entry.timestamps.filter((t) => t > cutoff).length;
}

/**
 * Remove the most recent timestamp (undo a speculative record).
 */
function rollbackLast(key: string): void {
  const entry = store.get(key);
  if (entry) {
    entry.timestamps.pop();
  }
}

/**
 * Calculate when the oldest active entry in the window expires (epoch seconds).
 */
function computeResetEpoch(key: string, windowMs: number, now: number): number {
  const entry = store.get(key);
  if (!entry || entry.timestamps.length === 0) {
    return Math.ceil((now + windowMs) / 1000);
  }
  const cutoff = now - windowMs;
  const oldest = entry.timestamps.find((t) => t > cutoff);
  if (!oldest) {
    return Math.ceil((now + windowMs) / 1000);
  }
  return Math.ceil((oldest + windowMs) / 1000);
}

// ─── Rate Limit Result ─────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetEpochSeconds: number;
  retryAfterSeconds?: number;
  source: 'user_tier_hourly' | 'user_tier_daily' | 'platform_hourly' | 'platform_daily';
}

// ─── Check Functions ───────────────────────────────────────────────

/**
 * Check user tier limits (both hourly and daily).
 * Records the event if allowed. Returns the most restrictive result.
 */
export function checkUserTierLimit(userId: string, tier: UserTier, nowOverride?: number): RateLimitResult {
  const config = RATE_LIMITS.tiers[tier];
  const now = nowOverride ?? Date.now();

  // Enterprise tier is unlimited
  if (config.daily === -1 && config.hourly === -1) {
    return { allowed: true, limit: -1, remaining: Infinity, resetEpochSeconds: 0, source: 'user_tier_daily' };
  }

  const hourlyKey = `user:${userId}:hourly`;
  const dailyKey = `user:${userId}:daily`;

  // Check hourly limit
  if (config.hourly !== -1) {
    const hourlyCount = peekCount(hourlyKey, RATE_LIMITS.windows.hourly, now);
    if (hourlyCount >= config.hourly) {
      const reset = computeResetEpoch(hourlyKey, RATE_LIMITS.windows.hourly, now);
      return {
        allowed: false,
        limit: config.hourly,
        remaining: 0,
        resetEpochSeconds: reset,
        retryAfterSeconds: Math.max(1, reset - Math.ceil(now / 1000)),
        source: 'user_tier_hourly',
      };
    }
  }

  // Check daily limit
  if (config.daily !== -1) {
    const dailyCount = peekCount(dailyKey, RATE_LIMITS.windows.daily, now);
    if (dailyCount >= config.daily) {
      const reset = computeResetEpoch(dailyKey, RATE_LIMITS.windows.daily, now);
      return {
        allowed: false,
        limit: config.daily,
        remaining: 0,
        resetEpochSeconds: reset,
        retryAfterSeconds: Math.max(1, reset - Math.ceil(now / 1000)),
        source: 'user_tier_daily',
      };
    }
  }

  // Both checks passed - record the event in both windows
  if (config.hourly !== -1) recordAndCount(hourlyKey, RATE_LIMITS.windows.hourly, now);
  if (config.daily !== -1) recordAndCount(dailyKey, RATE_LIMITS.windows.daily, now);

  // Return the most restrictive remaining count
  const hourlyRemaining = config.hourly === -1
    ? Infinity
    : Math.max(0, config.hourly - peekCount(hourlyKey, RATE_LIMITS.windows.hourly, now));
  const dailyRemaining = config.daily === -1
    ? Infinity
    : Math.max(0, config.daily - peekCount(dailyKey, RATE_LIMITS.windows.daily, now));

  const remaining = Math.min(hourlyRemaining, dailyRemaining);
  const effectiveLimit = hourlyRemaining <= dailyRemaining ? config.hourly : config.daily;
  const source = hourlyRemaining <= dailyRemaining ? 'user_tier_hourly' as const : 'user_tier_daily' as const;
  const resetKey = hourlyRemaining <= dailyRemaining ? hourlyKey : dailyKey;
  const resetWindow = hourlyRemaining <= dailyRemaining ? RATE_LIMITS.windows.hourly : RATE_LIMITS.windows.daily;

  return {
    allowed: true,
    limit: effectiveLimit,
    remaining,
    resetEpochSeconds: computeResetEpoch(resetKey, resetWindow, now),
    source,
  };
}

/**
 * Check platform limits (both hourly and daily).
 * Uses per-user-per-platform keys for fairness.
 */
export function checkPlatformLimit(userId: string, platform: Platform, nowOverride?: number): RateLimitResult {
  const config = RATE_LIMITS.platforms[platform];
  const now = nowOverride ?? Date.now();

  const hourlyKey = `platform:${userId}:${platform}:hourly`;
  const dailyKey = `platform:${userId}:${platform}:daily`;

  // Check hourly limit
  const hourlyCount = peekCount(hourlyKey, RATE_LIMITS.windows.hourly, now);
  if (hourlyCount >= config.hourly) {
    const reset = computeResetEpoch(hourlyKey, RATE_LIMITS.windows.hourly, now);
    return {
      allowed: false,
      limit: config.hourly,
      remaining: 0,
      resetEpochSeconds: reset,
      retryAfterSeconds: Math.max(1, reset - Math.ceil(now / 1000)),
      source: 'platform_hourly',
    };
  }

  // Check daily limit
  const dailyCount = peekCount(dailyKey, RATE_LIMITS.windows.daily, now);
  if (dailyCount >= config.daily) {
    const reset = computeResetEpoch(dailyKey, RATE_LIMITS.windows.daily, now);
    return {
      allowed: false,
      limit: config.daily,
      remaining: 0,
      resetEpochSeconds: reset,
      retryAfterSeconds: Math.max(1, reset - Math.ceil(now / 1000)),
      source: 'platform_daily',
    };
  }

  // Record in both windows
  recordAndCount(hourlyKey, RATE_LIMITS.windows.hourly, now);
  recordAndCount(dailyKey, RATE_LIMITS.windows.daily, now);

  const hourlyRemaining = Math.max(0, config.hourly - peekCount(hourlyKey, RATE_LIMITS.windows.hourly, now));
  const dailyRemaining = Math.max(0, config.daily - peekCount(dailyKey, RATE_LIMITS.windows.daily, now));
  const remaining = Math.min(hourlyRemaining, dailyRemaining);
  const effectiveLimit = hourlyRemaining <= dailyRemaining ? config.hourly : config.daily;
  const source = hourlyRemaining <= dailyRemaining ? 'platform_hourly' as const : 'platform_daily' as const;
  const resetKey = hourlyRemaining <= dailyRemaining ? hourlyKey : dailyKey;
  const resetWindow = hourlyRemaining <= dailyRemaining ? RATE_LIMITS.windows.hourly : RATE_LIMITS.windows.daily;

  return {
    allowed: true,
    limit: effectiveLimit,
    remaining,
    resetEpochSeconds: computeResetEpoch(resetKey, resetWindow, now),
    source,
  };
}

/**
 * Roll back user tier counters (undo a speculative record).
 */
function rollbackUserTier(userId: string): void {
  rollbackLast(`user:${userId}:hourly`);
  rollbackLast(`user:${userId}:daily`);
}

/**
 * Roll back platform counters (undo a speculative record).
 */
function rollbackPlatform(userId: string, platform: Platform): void {
  rollbackLast(`platform:${userId}:${platform}:hourly`);
  rollbackLast(`platform:${userId}:${platform}:daily`);
}

// ─── Middleware ─────────────────────────────────────────────────────

/**
 * Rate limiting middleware for job creation endpoints.
 *
 * Checks both user tier limits and platform limits (hourly + daily windows).
 * Service-to-service calls bypass rate limiting.
 *
 * Response headers on every request:
 *   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 * On 429 responses, also sets Retry-After.
 */
export function rateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const auth = getAuth(c);

    // Service-to-service calls bypass rate limits
    if (auth.type === 'service') {
      return next();
    }

    const userId = auth.userId;
    if (!userId) {
      return next();
    }

    // Extract tier and platform from the request body
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      // Body parsing will fail later in validation middleware
      return next();
    }

    const tier: UserTier = body?.input_data?.tier || 'free';
    const platform: Platform = body?.input_data?.platform || 'other';

    // Check user tier limit first
    const tierResult = checkUserTierLimit(userId, tier);
    if (!tierResult.allowed) {
      getLogger().warn('User exceeded tier limit', { userId, tier, source: tierResult.source, limit: tierResult.limit });

      c.header('X-RateLimit-Limit', String(tierResult.limit));
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', String(tierResult.resetEpochSeconds));
      c.header('Retry-After', String(tierResult.retryAfterSeconds));

      return c.json(
        {
          error: 'rate_limit_exceeded',
          message: `Job limit exceeded for ${tier} tier. Upgrade your plan for higher limits.`,
          limit: tierResult.limit,
          reset_at: new Date(tierResult.resetEpochSeconds * 1000).toISOString(),
        },
        429,
      );
    }

    // Check platform limit
    const platformResult = checkPlatformLimit(userId, platform);
    if (!platformResult.allowed) {
      // Roll back the user tier records since this request is blocked
      rollbackUserTier(userId);

      getLogger().warn('User exceeded platform limit', { userId, platform, source: platformResult.source, limit: platformResult.limit });

      c.header('X-RateLimit-Limit', String(platformResult.limit));
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', String(platformResult.resetEpochSeconds));
      c.header('Retry-After', String(platformResult.retryAfterSeconds));

      return c.json(
        {
          error: 'rate_limit_exceeded',
          message: `Rate limit exceeded for ${platform}. Try again later to avoid platform detection.`,
          limit: platformResult.limit,
          reset_at: new Date(platformResult.resetEpochSeconds * 1000).toISOString(),
        },
        429,
      );
    }

    // Set rate limit headers using the most restrictive of all checks
    const effectiveRemaining = Math.min(tierResult.remaining, platformResult.remaining);
    const effectiveLimit = tierResult.remaining <= platformResult.remaining
      ? tierResult.limit
      : platformResult.limit;
    const effectiveReset = Math.min(
      tierResult.resetEpochSeconds || Infinity,
      platformResult.resetEpochSeconds || Infinity,
    );

    c.header('X-RateLimit-Limit', String(effectiveLimit));
    c.header('X-RateLimit-Remaining', String(effectiveRemaining));
    if (effectiveReset !== Infinity) {
      c.header('X-RateLimit-Reset', String(effectiveReset));
    }

    return next();
  };
}

// ─── Cleanup (prevent memory leaks in long-running processes) ──────

/**
 * Prune all expired entries from the store.
 * Call periodically (e.g. every 10 minutes) in production.
 */
export function pruneExpiredEntries(): void {
  const now = Date.now();
  // Use the larger window (daily) as the max retention
  const maxWindow = RATE_LIMITS.windows.daily;

  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > now - maxWindow);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}

/** Clear all rate limit state. Primarily for testing. */
export function resetAllLimits(): void {
  store.clear();
}
