/**
 * LocatorResolver — Multi-strategy element finder using Playwright locators.
 *
 * Given a LocatorDescriptor, tries strategies in priority order:
 * testId > role+name > ariaLabel > name > id > text > css > xpath
 *
 * Returns the first locator that resolves to a visible element on the page,
 * along with metadata about which strategy succeeded.
 *
 * Copied from packages/ghosthands/src/engine/LocatorResolver.ts for bundling isolation.
 */

import type { Page, Locator } from 'playwright';
import type { LocatorDescriptor } from './types';

export interface ResolveResult {
  locator: Locator | null;
  strategy: string;
  attempts: number;
}

export interface LocatorResolverOptions {
  /** Timeout per strategy attempt in milliseconds. Default: 3000 */
  timeout?: number;
  /** Maximum retries on stale element errors. Default: 1 */
  maxRetries?: number;
}

type Strategy = {
  name: string;
  build: (page: Page, descriptor: LocatorDescriptor) => Locator | null;
};

const STRATEGIES: Strategy[] = [
  {
    name: 'testId',
    build: (page, d) => d.testId ? page.getByTestId(d.testId) : null,
  },
  {
    name: 'role',
    build: (page, d) => d.role ? page.getByRole(d.role as any, d.name ? { name: d.name } : undefined) : null,
  },
  {
    name: 'ariaLabel',
    build: (page, d) => d.ariaLabel ? page.getByLabel(d.ariaLabel) : null,
  },
  {
    name: 'name',
    build: (page, d) => d.name && !d.role ? page.locator(`[name="${d.name}"]`) : null,
  },
  {
    name: 'id',
    build: (page, d) => d.id ? page.locator(`#${d.id}`) : null,
  },
  {
    name: 'text',
    build: (page, d) => d.text ? page.getByText(d.text, { exact: true }) : null,
  },
  {
    name: 'css',
    build: (page, d) => d.css ? page.locator(d.css) : null,
  },
  {
    name: 'xpath',
    build: (page, d) => d.xpath ? page.locator(d.xpath) : null,
  },
];

export class LocatorResolver {
  private timeout: number;
  private maxRetries: number;

  constructor(options?: LocatorResolverOptions) {
    this.timeout = options?.timeout ?? 3000;
    this.maxRetries = options?.maxRetries ?? 1;
  }

  /**
   * Resolve a LocatorDescriptor to a Playwright Locator.
   * Tries strategies in priority order, returning the first one that finds a visible element.
   */
  async resolve(page: Page, descriptor: LocatorDescriptor): Promise<ResolveResult> {
    let attempts = 0;

    for (const strategy of STRATEGIES) {
      const locator = strategy.build(page, descriptor);
      if (!locator) continue;

      attempts++;

      const found = await this.tryLocator(locator);
      if (found) {
        return { locator, strategy: strategy.name, attempts };
      }
    }

    return { locator: null, strategy: 'none', attempts };
  }

  /** Try to verify a locator resolves to at least one element, with retry for stale elements. */
  private async tryLocator(locator: Locator): Promise<boolean> {
    let retriesLeft = this.maxRetries;

    while (true) {
      try {
        const count = await locator.count();
        return count === 1;
      } catch (err: any) {
        const isStale =
          err?.message?.includes('stale') ||
          err?.message?.includes('detached') ||
          err?.message?.includes('Element is not attached');

        if (isStale && retriesLeft > 0) {
          retriesLeft--;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        return false;
      }
    }
  }
}
