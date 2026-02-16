/**
 * ActionBook Cookbook Seeder
 *
 * When no local cookbook exists for a URL/task, queries ActionBook's legacy
 * JSON API for pre-recorded action manuals. If found, converts them to
 * GhostHands ManualStep format and saves via ManualStore with source='actionbook'.
 *
 * This avoids expensive AI exploration for sites that ActionBook already knows.
 * On subsequent runs, the local cookbook is used directly (ActionBook not re-queried).
 */

import type { ApiClient, ParsedElements } from '@actionbookdev/sdk';
import { ActionBookConnector } from '../connectors/actionbookConnector';
import { ManualStore } from './ManualStore';
import type { ActionManual } from './types';

export interface SeedOptions {
  url: string;
  taskType: string;
  apiClient: ApiClient;
  manualStore: ManualStore;
  /** Optional: domain to pass to search. Extracted from URL if not provided. */
  domain?: string;
}

/**
 * Attempt to seed a cookbook from ActionBook.
 *
 * Flow:
 *   1. Search ActionBook with the task type + domain
 *   2. If results found, fetch the top result's detail
 *   3. Parse elements JSON from detail
 *   4. Convert to ManualStep[] via ActionBookConnector.convertToManual
 *   5. Save via ManualStore.saveFromActionBook
 *
 * Returns the seeded ActionManual, or null if nothing was found / errors occurred.
 * Never throws — all errors are caught and result in null return.
 */
export async function seedFromActionBook(options: SeedOptions): Promise<ActionManual | null> {
  const { url, taskType, apiClient, manualStore } = options;

  try {
    // 1. Extract domain from URL for search scoping
    const domain = options.domain ?? extractDomain(url);

    // 2. Search ActionBook for matching actions
    const searchResult = await apiClient.searchActionsLegacy({
      query: `${taskType} ${domain}`,
      limit: 5,
    });

    if (!searchResult.results || searchResult.results.length === 0) {
      return null;
    }

    // 3. Get detail for the top-scoring result
    const topResult = searchResult.results[0];
    const detail = await apiClient.getActionById(topResult.action_id);

    // 4. Parse elements from the detail
    if (!detail.elements) return null;

    let elements: ParsedElements;
    try {
      elements = JSON.parse(detail.elements);
    } catch {
      return null;
    }

    // 5. Convert ActionBook elements to ManualStep[] using the connector helper
    const connector = new ActionBookConnector();
    const urlPattern = ManualStore.urlToPattern ? ManualStore.urlToPattern(url) : `*.${domain}/*`;
    const manual = connector.convertToManual(elements, topResult.action_id, urlPattern);

    // Skip if conversion produced zero usable steps
    if (manual.steps.length === 0) return null;

    // 6. Save to local store
    const saved = await manualStore.saveFromActionBook(manual.steps, {
      urlPattern: manual.url_pattern,
      taskType,
      platform: manual.platform,
    });

    return saved;
  } catch {
    // Network errors, parse errors, etc. — silently return null
    return null;
  }
}

/**
 * Extract the base domain from a URL.
 * e.g. "https://acme.greenhouse.io/jobs/123" -> "greenhouse.io"
 */
function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    // Return last 2 parts (e.g. "greenhouse.io" from "acme.greenhouse.io")
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  } catch {
    return url;
  }
}
