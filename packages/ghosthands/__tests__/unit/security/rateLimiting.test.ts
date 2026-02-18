/**
 * Security Regression Tests: Rate Limiting (SEC-001 to SEC-010)
 *
 * Tests the sliding-window rate limiter for user-tier and platform limits.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import {
  checkUserTierLimit,
  checkPlatformLimit,
  resetAllLimits,
  type RateLimitResult,
} from '../../../src/security/rateLimit.js';
import { RATE_LIMITS, type UserTier, type Platform } from '../../../src/config/rateLimits.js';

describe('Security: Rate Limiting', () => {
  beforeEach(() => {
    resetAllLimits();
  });

  afterAll(() => {
    resetAllLimits();
  });

  // SEC-001: Free tier allows hourly limit requests then blocks N+1
  test('SEC-001: free tier allows hourly limit then blocks N+1', () => {
    const userId = 'sec001-user';
    const tier: UserTier = 'free';
    const hourlyLimit = RATE_LIMITS.tiers.free.hourly; // 3

    for (let i = 0; i < hourlyLimit; i++) {
      const result = checkUserTierLimit(userId, tier);
      expect(result.allowed).toBe(true);
    }

    const blocked = checkUserTierLimit(userId, tier);
    expect(blocked.allowed).toBe(false);
  });

  // SEC-002: Premium tier higher hourly limit — 20 requests all pass
  test('SEC-002: premium tier allows 20 hourly requests', () => {
    const userId = 'sec002-user';
    const tier: UserTier = 'premium';
    const hourlyLimit = RATE_LIMITS.tiers.premium.hourly; // 20

    for (let i = 0; i < hourlyLimit; i++) {
      const result = checkUserTierLimit(userId, tier);
      expect(result.allowed).toBe(true);
    }
  });

  // SEC-003: Enterprise tier unlimited — 100+ requests all allowed
  test('SEC-003: enterprise tier unlimited — 100+ requests all allowed', () => {
    const userId = 'sec003-user';
    const tier: UserTier = 'enterprise';

    for (let i = 0; i < 150; i++) {
      const result = checkUserTierLimit(userId, tier);
      expect(result.allowed).toBe(true);
    }
  });

  // SEC-004: Blocked response includes retryAfterSeconds > 0
  test('SEC-004: blocked response includes retryAfterSeconds > 0', () => {
    const userId = 'sec004-user';
    const tier: UserTier = 'free';
    const hourlyLimit = RATE_LIMITS.tiers.free.hourly;

    for (let i = 0; i < hourlyLimit; i++) {
      checkUserTierLimit(userId, tier);
    }

    const blocked = checkUserTierLimit(userId, tier);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeDefined();
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.resetEpochSeconds).toBeGreaterThan(0);
  });

  // SEC-005: User A blocked, user B still allowed (independent counters)
  test('SEC-005: user A blocked, user B still allowed', () => {
    const tier: UserTier = 'free';
    const hourlyLimit = RATE_LIMITS.tiers.free.hourly;

    // Exhaust user A
    for (let i = 0; i < hourlyLimit; i++) {
      checkUserTierLimit('sec005-userA', tier);
    }

    expect(checkUserTierLimit('sec005-userA', tier).allowed).toBe(false);
    expect(checkUserTierLimit('sec005-userB', tier).allowed).toBe(true);
  });

  // SEC-006: Daily limits exhausted even if hourly resets
  test('SEC-006: daily limits exhausted even after hourly window resets', () => {
    const userId = 'sec006-user';
    const tier: UserTier = 'free';
    const hourlyLimit = RATE_LIMITS.tiers.free.hourly; // 3
    const dailyLimit = RATE_LIMITS.tiers.free.daily;   // 5
    const hourlyWindowMs = RATE_LIMITS.windows.hourly;

    let fakeNow = Date.now();
    let totalSent = 0;

    // Send batches of hourly-limit-sized requests, advancing past hourly window each time
    while (totalSent < dailyLimit) {
      const batchSize = Math.min(hourlyLimit, dailyLimit - totalSent);
      for (let i = 0; i < batchSize; i++) {
        const result = checkUserTierLimit(userId, tier, fakeNow + i);
        expect(result.allowed).toBe(true);
      }
      totalSent += batchSize;
      // Advance past the hourly window so hourly counters expire
      fakeNow += hourlyWindowMs + 1;
    }

    // Daily limit is now exhausted; next request should be blocked
    const blocked = checkUserTierLimit(userId, tier, fakeNow);
    expect(blocked.allowed).toBe(false);
    expect(blocked.source).toBe('user_tier_daily');
  });

  // SEC-007: LinkedIn hourly=5, blocked at 6th request
  test('SEC-007: LinkedIn hourly=5, blocked at 6th request', () => {
    const userId = 'sec007-user';
    const platform: Platform = 'linkedin';
    const hourlyLimit = RATE_LIMITS.platforms.linkedin.hourly; // 5

    for (let i = 0; i < hourlyLimit; i++) {
      const result = checkPlatformLimit(userId, platform);
      expect(result.allowed).toBe(true);
    }

    const blocked = checkPlatformLimit(userId, platform);
    expect(blocked.allowed).toBe(false);
    expect(blocked.source).toMatch(/platform/);
  });

  // SEC-008: LinkedIn blocked but greenhouse still allowed (same user)
  test('SEC-008: LinkedIn blocked but greenhouse still allowed', () => {
    const userId = 'sec008-user';
    const linkedinLimit = RATE_LIMITS.platforms.linkedin.hourly; // 5

    // Exhaust LinkedIn
    for (let i = 0; i < linkedinLimit; i++) {
      checkPlatformLimit(userId, 'linkedin');
    }

    expect(checkPlatformLimit(userId, 'linkedin').allowed).toBe(false);
    expect(checkPlatformLimit(userId, 'greenhouse').allowed).toBe(true);
  });

  // SEC-009: Tier limit reached blocks even if platform has capacity
  test('SEC-009: tier limit reached blocks even if platform has capacity', () => {
    const userId = 'sec009-user';
    const tier: UserTier = 'free';        // hourly: 3
    const platform: Platform = 'greenhouse'; // hourly: 30

    // Exhaust user tier (3 requests)
    for (let i = 0; i < RATE_LIMITS.tiers.free.hourly; i++) {
      checkUserTierLimit(userId, tier);
      checkPlatformLimit(userId, platform);
    }

    // User tier should be blocked
    const tierResult = checkUserTierLimit(userId, tier);
    expect(tierResult.allowed).toBe(false);

    // Platform still has capacity
    const platResult = checkPlatformLimit(userId, platform);
    expect(platResult.allowed).toBe(true);
  });

  // SEC-010: Ascending limits: free.hourly <= starter.hourly <= pro.hourly <= premium.hourly
  test('SEC-010: ascending limits free <= starter <= pro <= premium', () => {
    const tiers: UserTier[] = ['free', 'starter', 'pro', 'premium'];

    for (let i = 1; i < tiers.length; i++) {
      expect(RATE_LIMITS.tiers[tiers[i]].hourly).toBeGreaterThanOrEqual(
        RATE_LIMITS.tiers[tiers[i - 1]].hourly,
      );
      expect(RATE_LIMITS.tiers[tiers[i]].daily).toBeGreaterThanOrEqual(
        RATE_LIMITS.tiers[tiers[i - 1]].daily,
      );
    }
  });
});
