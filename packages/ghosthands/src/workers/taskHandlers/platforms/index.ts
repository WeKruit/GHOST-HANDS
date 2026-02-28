import type { PlatformConfig } from './types.js';
import { GenericPlatformConfig } from './genericConfig.js';
import { WorkdayPlatformConfig } from './workdayConfig.js';
import { AmazonPlatformConfig } from './amazonConfig.js';

export type { PlatformConfig, PageState, PageType } from './types.js';
export { GenericPlatformConfig } from './genericConfig.js';
export { WorkdayPlatformConfig } from './workdayConfig.js';
export { AmazonPlatformConfig } from './amazonConfig.js';

// ---------------------------------------------------------------------------
// Platform Registry
// ---------------------------------------------------------------------------

const platformConfigs = new Map<string, PlatformConfig>();

/** Register a platform config by its platformId. */
export function registerPlatformConfig(config: PlatformConfig): void {
  platformConfigs.set(config.platformId, config);
}

/** Get a platform config by ID. Returns GenericPlatformConfig if not found. */
export function getPlatformConfig(platformId: string): PlatformConfig {
  return platformConfigs.get(platformId) ?? platformConfigs.get('generic')!;
}

// ---------------------------------------------------------------------------
// URL-based platform detection
// ---------------------------------------------------------------------------

const URL_PATTERNS: Array<{ match: (url: string) => boolean; platformId: string }> = [
  {
    match: (url) => url.includes('myworkdayjobs.com') || url.includes('myworkday.com') || url.includes('wd5.myworkdaysite.com'),
    platformId: 'workday',
  },
  {
    match: (url) => url.includes('amazon.jobs') || url.includes('www.amazon.jobs'),
    platformId: 'amazon',
  },
];

/**
 * Detect the platform from a job URL and return the appropriate PlatformConfig.
 * Falls back to GenericPlatformConfig for unrecognized URLs.
 */
export function detectPlatformFromUrl(url: string): PlatformConfig {
  const normalizedUrl = url.toLowerCase();
  for (const pattern of URL_PATTERNS) {
    if (pattern.match(normalizedUrl)) {
      const config = platformConfigs.get(pattern.platformId);
      if (config) return config;
    }
  }
  return platformConfigs.get('generic')!;
}

// ---------------------------------------------------------------------------
// Auto-register built-in configs
// ---------------------------------------------------------------------------

registerPlatformConfig(new GenericPlatformConfig());
registerPlatformConfig(new WorkdayPlatformConfig());
registerPlatformConfig(new AmazonPlatformConfig());
