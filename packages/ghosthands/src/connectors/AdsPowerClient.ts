/**
 * AdsPower Local API client.
 *
 * Wraps the three core AdsPower REST endpoints needed to launch and
 * manage anti-detect browser profiles for use with Magnitude via CDP.
 *
 * @see https://localapi-doc-en.adspower.com/
 */

export interface AdsPowerConfig {
  /** Base URL of the AdsPower Local API (e.g. http://local.adspower.net:50325) */
  baseUrl: string;
  /** Optional API key for authenticated AdsPower instances */
  apiKey?: string;
}

export interface AdsPowerBrowserResult {
  /** WebSocket CDP URL suitable for Playwright / Magnitude connection */
  cdpUrl: string;
  /** Debug port the browser is listening on */
  debugPort: string;
}

interface AdsPowerApiResponse {
  code: number;
  msg: string;
  data?: {
    ws?: {
      puppeteer?: string;
      selenium?: string;
    };
    debug_port?: string;
    status?: string;
  };
}

export class AdsPowerClient {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(config: AdsPowerConfig) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  /**
   * Start (or connect to) a browser profile.
   *
   * GET /api/v1/browser/start?user_id={profileId}
   *
   * Returns the CDP WebSocket URL from `data.ws.puppeteer`.
   */
  async startBrowser(profileId: string): Promise<AdsPowerBrowserResult> {
    const url = this.buildUrl('/api/v1/browser/start', { user_id: profileId });
    const res = await this.request(url);

    if (res.code !== 0) {
      throw new Error(`AdsPower startBrowser failed (code=${res.code}): ${res.msg}`);
    }

    const cdpUrl = res.data?.ws?.puppeteer;
    if (!cdpUrl) {
      throw new Error('AdsPower startBrowser: missing CDP URL in response (data.ws.puppeteer)');
    }

    return {
      cdpUrl,
      debugPort: res.data?.debug_port ?? '',
    };
  }

  /**
   * Stop a running browser profile.
   *
   * GET /api/v1/browser/stop?user_id={profileId}
   */
  async stopBrowser(profileId: string): Promise<void> {
    const url = this.buildUrl('/api/v1/browser/stop', { user_id: profileId });
    const res = await this.request(url);

    if (res.code !== 0) {
      throw new Error(`AdsPower stopBrowser failed (code=${res.code}): ${res.msg}`);
    }
  }

  /**
   * Check whether a browser profile is currently active.
   *
   * GET /api/v1/browser/active?user_id={profileId}
   *
   * Returns `true` if the profile browser is running, `false` otherwise.
   */
  async isActive(profileId: string): Promise<boolean> {
    const url = this.buildUrl('/api/v1/browser/active', { user_id: profileId });
    const res = await this.request(url);

    if (res.code !== 0) {
      return false;
    }

    return res.data?.status === 'Active';
  }

  /**
   * Start an AdsPower profile and return a connected BrowserContext.
   *
   * Uses Patchright's connectOverCDP to establish a CDP connection,
   * then reuses AdsPower's existing context to preserve fingerprint.
   * This is the recommended way to connect — avoids CDP detection issues.
   */
  async connectContext(profileId: string): Promise<{
    context: import('playwright').BrowserContext;
    cdpUrl: string;
  }> {
    const { chromium } = await import('playwright');

    // Start profile (or reuse if already running)
    const result = await this.startBrowser(profileId);
    const cdpUrl = result.cdpUrl;

    // Poll until the browser is fully active
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const active = await this.isActive(profileId);
      if (active) break;
      await new Promise(r => setTimeout(r, 1_000));
    }

    // Connect via CDP using Patchright (mapped from 'playwright' in package.json)
    const browser = await chromium.connectOverCDP(cdpUrl);

    // Reuse existing context to preserve AdsPower fingerprint
    const context = browser.contexts().length > 0
      ? browser.contexts()[0]
      : await browser.newContext();

    return { context, cdpUrl };
  }

  // --- Internal helpers ---

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (this.apiKey) {
      url.searchParams.set('api_key', this.apiKey);
    }
    return url.toString();
  }

  private async request(url: string): Promise<AdsPowerApiResponse> {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`AdsPower API HTTP error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as AdsPowerApiResponse;
  }
}
