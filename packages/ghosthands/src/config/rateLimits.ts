/**
 * Rate limit configuration for GhostHands.
 *
 * Per-user tier limits use both hourly and daily sliding windows.
 * Per-platform limits use both hourly and daily sliding windows to avoid detection.
 * A value of -1 means unlimited.
 */

export type UserTier = 'free' | 'starter' | 'pro' | 'premium' | 'enterprise';

export type Platform =
  | 'linkedin'
  | 'greenhouse'
  | 'lever'
  | 'workday'
  | 'amazon'
  | 'icims'
  | 'taleo'
  | 'smartrecruiters'
  | 'other';

export interface TierLimit {
  daily: number;  // -1 = unlimited
  hourly: number; // -1 = unlimited
}

export interface PlatformLimit {
  hourly: number;
  daily: number;
}

export const RATE_LIMITS = {
  /** Per-user tier limits */
  tiers: {
    free: { daily: 5, hourly: 3 },
    starter: { daily: 25, hourly: 10 },
    pro: { daily: 50, hourly: 15 },
    premium: { daily: 100, hourly: 20 },
    enterprise: { daily: -1, hourly: -1 }, // unlimited
  } satisfies Record<UserTier, TierLimit>,

  /** Per-platform limits to avoid detection */
  platforms: {
    linkedin: { hourly: 5, daily: 20 },
    workday: { hourly: 20, daily: 100 },
    amazon: { hourly: 20, daily: 100 },
    greenhouse: { hourly: 30, daily: 150 },
    lever: { hourly: 30, daily: 150 },
    icims: { hourly: 30, daily: 150 },
    taleo: { hourly: 20, daily: 100 },
    smartrecruiters: { hourly: 30, daily: 150 },
    other: { hourly: 50, daily: 250 },
  } satisfies Record<Platform, PlatformLimit>,

  /** Window durations in milliseconds */
  windows: {
    daily: 24 * 60 * 60 * 1000,
    hourly: 60 * 60 * 1000,
  },
} as const;
