// Security module barrel export

export {
  rateLimitMiddleware,
  checkUserTierLimit,
  checkPlatformLimit,
  pruneExpiredEntries,
  resetAllLimits,
} from './rateLimit.js';
export type { RateLimitResult } from './rateLimit.js';

export {
  DomainLockdown,
  createLockdownForPlatform,
} from './domainLockdown.js';
export type { DomainLockdownConfig, LockdownStats } from './domainLockdown.js';

export {
  encodeHTML,
  stripHTML,
  containsXSS,
  sanitizeXSS,
  containsSQLInjection,
  isValidUrl,
  sanitizeUrl,
  sanitizeString,
  sanitizeObject,
} from './sanitize.js';
export type { SanitizeOptions, SanitizeResult } from './sanitize.js';
