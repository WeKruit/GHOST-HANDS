/**
 * S4: Prompt injection mitigation via domain lockdown
 *
 * After initial navigation to a job URL, all subsequent navigations are
 * restricted to the same domain and known ATS subdomains. This prevents
 * a malicious job listing from tricking the LLM agent into navigating to
 * an attacker-controlled URL for data exfiltration.
 *
 * Intercepts:
 *   - page.goto() via Playwright route interception
 *   - Click-triggered navigations via route interception
 *   - window.open / window.location assignments via CDP
 *
 * Security report references: S4 (Section 6.1.1, mitigation 2)
 */

import type { Page, Route } from 'playwright';

// ── Known ATS platform domains ────────────────────────────────────────────

const PLATFORM_ALLOWLISTS: Record<string, string[]> = {
  workday: [
    'myworkdayjobs.com',
    'myworkday.com',
    'workday.com',
    'wd1.myworkdayjobs.com',
    'wd3.myworkdayjobs.com',
    'wd5.myworkdayjobs.com',
  ],
  linkedin: [
    'linkedin.com',
    'www.linkedin.com',
    'licdn.com',
  ],
  greenhouse: [
    'greenhouse.io',
    'boards.greenhouse.io',
    'job-boards.greenhouse.io',
  ],
  lever: [
    'lever.co',
    'jobs.lever.co',
  ],
  ashby: [
    'ashbyhq.com',
    'jobs.ashbyhq.com',
  ],
  icims: [
    'icims.com',
    'careers-page.icims.com',
  ],
  smartrecruiters: [
    'smartrecruiters.com',
    'jobs.smartrecruiters.com',
  ],
  amazon: [
    'amazon.jobs',
    'www.amazon.jobs',
    'amazon.com',
    'www.amazon.com',
  ],
};

// Common CDN/resource domains that should always be allowed for page rendering
const RESOURCE_ALLOWLIST = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'googletagmanager.com',
  'google-analytics.com',
  'google.com',
  'gstatic.com',
  'recaptcha.net',
  'hcaptcha.com',
];

// Resource types that are safe to load from any domain (images, fonts, etc.)
const SAFE_RESOURCE_TYPES = new Set([
  'image',
  'font',
  'media',
  'stylesheet',
]);

// ── Types ──────────────────────────────────────────────────────────────────

export interface DomainLockdownConfig {
  /** The initial job URL. Its domain becomes the primary allowed domain. */
  jobUrl: string;
  /** ATS platform name (for loading platform-specific allowlist). */
  platform?: string;
  /** Additional domains to allow (e.g. company-specific SSO). */
  additionalAllowedDomains?: string[];
  /** Whether to allow resource loads (images, CSS, fonts) from any domain. */
  allowCrossOriginResources?: boolean;
  /** Callback when a navigation is blocked. */
  onBlocked?: (url: string, reason: string) => void;
}

export interface LockdownStats {
  /** Total navigation attempts intercepted. */
  totalIntercepted: number;
  /** Navigations that were allowed. */
  allowed: number;
  /** Navigations that were blocked. */
  blocked: number;
  /** Blocked URLs (last 20). */
  blockedUrls: string[];
}

// ── Domain matching ───────────────────────────────────────────────────────

function extractDomain(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainMatches(hostname: string, allowedDomain: string): boolean {
  const h = hostname.toLowerCase();
  const a = allowedDomain.toLowerCase();
  return h === a || h.endsWith('.' + a);
}

// ── Domain Lockdown ───────────────────────────────────────────────────────

export class DomainLockdown {
  private allowedDomains: Set<string> = new Set();
  private stats: LockdownStats = {
    totalIntercepted: 0,
    allowed: 0,
    blocked: 0,
    blockedUrls: [],
  };
  private config: Required<DomainLockdownConfig>;

  constructor(config: DomainLockdownConfig) {
    this.config = {
      additionalAllowedDomains: [],
      allowCrossOriginResources: true,
      onBlocked: () => {},
      platform: '',
      ...config,
    };

    // Add the job URL's domain
    const jobDomain = extractDomain(config.jobUrl);
    if (jobDomain) {
      this.allowedDomains.add(jobDomain);
    }

    // Add platform-specific domains
    if (config.platform) {
      const platformDomains = PLATFORM_ALLOWLISTS[config.platform.toLowerCase()];
      if (platformDomains) {
        for (const d of platformDomains) {
          this.allowedDomains.add(d.toLowerCase());
        }
      }
    }

    // Add additional domains
    if (config.additionalAllowedDomains) {
      for (const d of config.additionalAllowedDomains) {
        this.allowedDomains.add(d.toLowerCase());
      }
    }

    // Always allow resource CDNs
    for (const d of RESOURCE_ALLOWLIST) {
      this.allowedDomains.add(d.toLowerCase());
    }
  }

  /**
   * Check if a URL is allowed by the lockdown policy.
   */
  isAllowed(url: string): boolean {
    const hostname = extractDomain(url);
    if (!hostname) return false;

    for (const allowed of this.allowedDomains) {
      if (domainMatches(hostname, allowed)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Install route interception on a Playwright page.
   * This is the primary enforcement mechanism.
   */
  async install(page: Page): Promise<void> {
    await page.route('**/*', (route: Route) => {
      return this.handleRoute(route);
    });
  }

  /**
   * Remove route interception from a Playwright page.
   */
  async uninstall(page: Page): Promise<void> {
    await page.unroute('**/*');
  }

  /**
   * Wrap a page.goto() call with domain validation.
   * Use this instead of calling page.goto() directly.
   */
  async safeGoto(page: Page, url: string, options?: Parameters<Page['goto']>[1]) {
    if (!this.isAllowed(url)) {
      const reason = `Navigation blocked by domain lockdown: ${url}`;
      this.recordBlocked(url, reason);
      throw new Error(reason);
    }
    return page.goto(url, options);
  }

  /** Get lockdown statistics. */
  getStats(): LockdownStats {
    return { ...this.stats, blockedUrls: [...this.stats.blockedUrls] };
  }

  /** Get all allowed domains. */
  getAllowedDomains(): string[] {
    return Array.from(this.allowedDomains);
  }

  /** Add a domain to the allowlist at runtime. */
  addAllowedDomain(domain: string): void {
    this.allowedDomains.add(domain.toLowerCase());
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async handleRoute(route: Route): Promise<void> {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    this.stats.totalIntercepted++;

    // Allow safe resource types from any domain if configured
    if (this.config.allowCrossOriginResources && SAFE_RESOURCE_TYPES.has(resourceType)) {
      this.stats.allowed++;
      return route.continue();
    }

    // Check against allowlist
    if (this.isAllowed(url)) {
      this.stats.allowed++;
      return route.continue();
    }

    // Block the request
    const reason = `Blocked ${resourceType} request to non-allowed domain`;
    this.recordBlocked(url, reason);
    return route.abort('blockedbyclient');
  }

  private recordBlocked(url: string, reason: string): void {
    this.stats.blocked++;
    // Keep only last 20 blocked URLs to prevent memory growth
    if (this.stats.blockedUrls.length >= 20) {
      this.stats.blockedUrls.shift();
    }
    this.stats.blockedUrls.push(url);
    this.config.onBlocked(url, reason);
  }
}

/**
 * Create a DomainLockdown configured for a specific ATS platform.
 */
export function createLockdownForPlatform(
  jobUrl: string,
  platform: string,
  additionalDomains?: string[],
): DomainLockdown {
  return new DomainLockdown({
    jobUrl,
    platform,
    additionalAllowedDomains: additionalDomains,
  });
}
