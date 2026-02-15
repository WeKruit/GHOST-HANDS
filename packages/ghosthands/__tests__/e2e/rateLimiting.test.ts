/**
 * E2E: Rate Limiting
 *
 * Tests rate limiting behavior including 429 responses, rate limit headers,
 * per-tier limits, per-platform limits, and sliding window mechanics.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  checkUserTierLimit,
  checkPlatformLimit,
  resetAllLimits,
  type RateLimitResult,
} from '../../src/security/rateLimit';
import { RATE_LIMITS, type UserTier, type Platform } from '../../src/config/rateLimits';

describe('Rate Limiting', () => {
  beforeEach(() => {
    resetAllLimits();
  });

  afterAll(() => {
    resetAllLimits();
  });

  // ─── User tier limits ───────────────────────────────────────────

  describe('User Tier Limits', () => {
    it('should allow requests within the free tier hourly limit', () => {
      const userId = 'user-rate-free-1';
      const tier: UserTier = 'free';
      const hourlyLimit = RATE_LIMITS.tiers.free.hourly; // 3

      // First N requests should pass
      for (let i = 0; i < hourlyLimit; i++) {
        const result = checkUserTierLimit(userId, tier);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBeGreaterThanOrEqual(0);
      }
    });

    it('should block requests exceeding the free tier hourly limit', () => {
      const userId = 'user-rate-free-2';
      const tier: UserTier = 'free';
      const hourlyLimit = RATE_LIMITS.tiers.free.hourly; // 3

      // Exhaust the limit
      for (let i = 0; i < hourlyLimit; i++) {
        checkUserTierLimit(userId, tier);
      }

      // Next request should be blocked
      const blocked = checkUserTierLimit(userId, tier);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.source).toMatch(/user_tier/);
    });

    it('should include retry-after information in blocked responses', () => {
      const userId = 'user-rate-retry-1';
      const tier: UserTier = 'free';
      const hourlyLimit = RATE_LIMITS.tiers.free.hourly;

      // Exhaust
      for (let i = 0; i < hourlyLimit; i++) {
        checkUserTierLimit(userId, tier);
      }

      const blocked = checkUserTierLimit(userId, tier);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeDefined();
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.resetEpochSeconds).toBeGreaterThan(0);
    });

    it('should return correct rate limit headers for allowed requests', () => {
      const userId = 'user-rate-headers-1';
      const tier: UserTier = 'starter';

      const result = checkUserTierLimit(userId, tier);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBeGreaterThan(0);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      expect(result.resetEpochSeconds).toBeGreaterThan(0);
    });

    it('should track limits independently per user', () => {
      const tier: UserTier = 'free';
      const hourlyLimit = RATE_LIMITS.tiers.free.hourly;

      // Exhaust user A's limit
      for (let i = 0; i < hourlyLimit; i++) {
        checkUserTierLimit('user-a', tier);
      }

      // User A should be blocked
      expect(checkUserTierLimit('user-a', tier).allowed).toBe(false);

      // User B should still be allowed
      expect(checkUserTierLimit('user-b', tier).allowed).toBe(true);
    });

    it('should enforce daily limits independently from hourly limits', () => {
      const userId = 'user-rate-daily-1';
      const tier: UserTier = 'free';
      const hourlyLimit = RATE_LIMITS.tiers.free.hourly; // 3
      const dailyLimit = RATE_LIMITS.tiers.free.daily; // 5
      const hourlyWindowMs = RATE_LIMITS.windows.hourly;

      resetAllLimits();

      // Simulate multiple hourly windows to exhaust the daily limit.
      // Each hourly window allows `hourlyLimit` requests, so we advance
      // time by hourlyWindowMs between batches so hourly counters expire
      // while daily counters remain active.
      let fakeNow = Date.now();
      let totalSent = 0;

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
    });

    it('should allow higher limits for premium tier', () => {
      const userId = 'user-rate-premium-1';
      const tier: UserTier = 'premium';
      const hourlyLimit = RATE_LIMITS.tiers.premium.hourly; // 20

      // All 20 should pass
      for (let i = 0; i < hourlyLimit; i++) {
        const result = checkUserTierLimit(userId, tier);
        expect(result.allowed).toBe(true);
      }

      // 21st should be blocked
      const blocked = checkUserTierLimit(userId, tier);
      expect(blocked.allowed).toBe(false);
    });

    it('should grant unlimited access to enterprise tier', () => {
      const userId = 'user-rate-enterprise-1';
      const tier: UserTier = 'enterprise';

      // Enterprise should never be blocked
      for (let i = 0; i < 100; i++) {
        const result = checkUserTierLimit(userId, tier);
        expect(result.allowed).toBe(true);
      }
    });
  });

  // ─── Platform limits ────────────────────────────────────────────

  describe('Platform Limits', () => {
    it('should enforce LinkedIn hourly limit (most restrictive)', () => {
      const userId = 'user-platform-li-1';
      const platform: Platform = 'linkedin';
      const hourlyLimit = RATE_LIMITS.platforms.linkedin.hourly; // 5

      for (let i = 0; i < hourlyLimit; i++) {
        const result = checkPlatformLimit(userId, platform);
        expect(result.allowed).toBe(true);
      }

      const blocked = checkPlatformLimit(userId, platform);
      expect(blocked.allowed).toBe(false);
      expect(blocked.source).toMatch(/platform/);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('should allow higher limits for less restrictive platforms', () => {
      const userId = 'user-platform-gh-1';
      const platform: Platform = 'greenhouse';
      const hourlyLimit = RATE_LIMITS.platforms.greenhouse.hourly; // 30

      // Should be able to make 30 requests
      for (let i = 0; i < hourlyLimit; i++) {
        const result = checkPlatformLimit(userId, platform);
        expect(result.allowed).toBe(true);
      }

      // 31st should be blocked
      const blocked = checkPlatformLimit(userId, platform);
      expect(blocked.allowed).toBe(false);
    });

    it('should track platform limits per user independently', () => {
      const platform: Platform = 'linkedin';
      const hourlyLimit = RATE_LIMITS.platforms.linkedin.hourly;

      // Exhaust user A's LinkedIn limit
      for (let i = 0; i < hourlyLimit; i++) {
        checkPlatformLimit('user-plat-a', platform);
      }

      expect(checkPlatformLimit('user-plat-a', platform).allowed).toBe(false);
      expect(checkPlatformLimit('user-plat-b', platform).allowed).toBe(true);
    });

    it('should track different platforms independently for the same user', () => {
      const userId = 'user-multi-plat-1';
      const linkedinLimit = RATE_LIMITS.platforms.linkedin.hourly; // 5

      // Exhaust LinkedIn
      for (let i = 0; i < linkedinLimit; i++) {
        checkPlatformLimit(userId, 'linkedin');
      }

      // LinkedIn blocked
      expect(checkPlatformLimit(userId, 'linkedin').allowed).toBe(false);

      // Greenhouse should still work
      expect(checkPlatformLimit(userId, 'greenhouse').allowed).toBe(true);
    });
  });

  // ─── Combined checks ───────────────────────────────────────────

  describe('Combined User + Platform Limits', () => {
    it('should block when user tier limit is reached even if platform has capacity', () => {
      const userId = 'user-combined-1';
      const tier: UserTier = 'free'; // hourly: 3
      const platform: Platform = 'greenhouse'; // hourly: 30

      // Exhaust user tier limit (3 requests)
      for (let i = 0; i < RATE_LIMITS.tiers.free.hourly; i++) {
        checkUserTierLimit(userId, tier);
        checkPlatformLimit(userId, platform);
      }

      // User tier should be blocked
      const tierResult = checkUserTierLimit(userId, tier);
      expect(tierResult.allowed).toBe(false);

      // Platform would still allow, but the middleware checks tier first
      const platResult = checkPlatformLimit(userId, platform);
      expect(platResult.allowed).toBe(true);
    });

    it('should block when platform limit is reached even if user tier has capacity', () => {
      const userId = 'user-combined-2';
      const tier: UserTier = 'premium'; // hourly: 20
      const platform: Platform = 'linkedin'; // hourly: 5

      // Exhaust LinkedIn limit (5 requests)
      for (let i = 0; i < RATE_LIMITS.platforms.linkedin.hourly; i++) {
        checkUserTierLimit(userId, tier);
        checkPlatformLimit(userId, platform);
      }

      // User tier still has capacity
      const tierResult = checkUserTierLimit(userId, tier);
      expect(tierResult.allowed).toBe(true);

      // But platform is blocked
      const platResult = checkPlatformLimit(userId, platform);
      expect(platResult.allowed).toBe(false);
    });
  });

  // ─── Remaining count accuracy ───────────────────────────────────

  describe('Remaining Count', () => {
    it('should decrement remaining count on each request', () => {
      const userId = 'user-remaining-1';
      const tier: UserTier = 'starter'; // hourly: 10

      const results: RateLimitResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(checkUserTierLimit(userId, tier));
      }

      // Each successive request should have fewer remaining
      for (let i = 1; i < results.length; i++) {
        expect(results[i].remaining).toBeLessThanOrEqual(results[i - 1].remaining);
      }
    });

    it('should show 0 remaining when at the limit', () => {
      const userId = 'user-remaining-2';
      const tier: UserTier = 'free';
      const limit = RATE_LIMITS.tiers.free.hourly;

      let lastResult: RateLimitResult;
      for (let i = 0; i < limit; i++) {
        lastResult = checkUserTierLimit(userId, tier);
      }

      // After exhausting, remaining should be 0
      expect(lastResult!.remaining).toBe(0);
    });
  });

  // ─── Reset behavior ────────────────────────────────────────────

  describe('Reset', () => {
    it('should clear all limits when resetAllLimits is called', () => {
      const userId = 'user-reset-1';
      const tier: UserTier = 'free';

      // Exhaust
      for (let i = 0; i < RATE_LIMITS.tiers.free.hourly; i++) {
        checkUserTierLimit(userId, tier);
      }
      expect(checkUserTierLimit(userId, tier).allowed).toBe(false);

      // Reset
      resetAllLimits();

      // Should be allowed again
      expect(checkUserTierLimit(userId, tier).allowed).toBe(true);
    });
  });

  // ─── Rate limit configuration ──────────────────────────────────

  describe('Configuration', () => {
    it('should have all expected tier configurations', () => {
      const expectedTiers: UserTier[] = ['free', 'starter', 'pro', 'premium', 'enterprise'];
      for (const tier of expectedTiers) {
        expect(RATE_LIMITS.tiers[tier]).toBeDefined();
        expect(RATE_LIMITS.tiers[tier].hourly).toBeDefined();
        expect(RATE_LIMITS.tiers[tier].daily).toBeDefined();
      }
    });

    it('should have all expected platform configurations', () => {
      const expectedPlatforms: Platform[] = [
        'linkedin', 'greenhouse', 'lever', 'workday',
        'icims', 'taleo', 'smartrecruiters', 'other',
      ];
      for (const platform of expectedPlatforms) {
        expect(RATE_LIMITS.platforms[platform]).toBeDefined();
        expect(RATE_LIMITS.platforms[platform].hourly).toBeGreaterThan(0);
        expect(RATE_LIMITS.platforms[platform].daily).toBeGreaterThan(0);
      }
    });

    it('should have LinkedIn as the most restrictive platform', () => {
      const linkedinHourly = RATE_LIMITS.platforms.linkedin.hourly;
      for (const [platform, config] of Object.entries(RATE_LIMITS.platforms)) {
        if (platform !== 'linkedin') {
          expect(config.hourly).toBeGreaterThanOrEqual(linkedinHourly);
        }
      }
    });

    it('should have ascending limits from free to premium tiers', () => {
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
});
