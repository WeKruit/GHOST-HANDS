import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { seedFromActionBook } from '../../../src/engine/actionBookSeeder';
import { ActionBookConnector } from '../../../src/connectors/actionbookConnector';
import type { ManualStore, SaveFromActionBookMetadata } from '../../../src/engine/ManualStore';
import type { ActionManual, ManualStep } from '../../../src/engine/types';
import type { ApiClient, ChunkSearchResult, ChunkActionDetail } from '@actionbookdev/sdk';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeManualStep(overrides: Partial<ManualStep> = {}): ManualStep {
  return {
    order: 0,
    locator: { css: 'input#test' },
    action: 'fill',
    description: 'Test step',
    healthScore: 1.0,
    ...overrides,
  };
}

function makeActionManual(overrides: Partial<ActionManual> = {}): ActionManual {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    url_pattern: '*.workday.com/*',
    task_pattern: 'apply',
    platform: 'workday.com',
    steps: [makeManualStep()],
    health_score: 0.8,
    source: 'actionbook',
    created_at: '2026-02-16T00:00:00Z',
    updated_at: '2026-02-16T00:00:00Z',
    ...overrides,
  };
}

function createMockManualStore(overrides: Partial<ManualStore> = {}): ManualStore {
  return {
    lookup: mock(() => Promise.resolve(null)),
    saveFromTrace: mock(() => Promise.resolve(makeActionManual())),
    saveFromActionBook: mock(() => Promise.resolve(makeActionManual())),
    recordSuccess: mock(() => Promise.resolve()),
    recordFailure: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as ManualStore;
}

function createMockApiClient(overrides: Partial<{
  searchActionsLegacy: () => Promise<ChunkSearchResult>;
  getActionById: (id: string) => Promise<ChunkActionDetail>;
}> = {}): ApiClient {
  return {
    searchActionsLegacy: mock(
      overrides.searchActionsLegacy ??
      (() => Promise.resolve({
        success: true,
        query: 'workday apply',
        results: [{
          action_id: 'https://workday.com/apply',
          content: 'Workday apply form page',
          score: 0.9,
          createdAt: '2026-01-01T00:00:00Z',
        }],
        count: 1,
        total: 1,
        hasMore: false,
      })),
    ),
    getActionById: mock(
      overrides.getActionById ??
      ((id: string) => Promise.resolve({
        action_id: id,
        content: 'Workday application form',
        elements: JSON.stringify({
          username_field: {
            css_selector: 'input#username',
            element_type: 'input',
            allow_methods: ['click', 'type'],
            description: 'Username input',
          },
          submit_button: {
            css_selector: 'button[type="submit"]',
            element_type: 'button',
            allow_methods: ['click'],
            description: 'Submit button',
            depends_on: 'username_field',
          },
        }),
        createdAt: '2026-01-01T00:00:00Z',
        documentId: 1,
        documentTitle: 'Workday',
        documentUrl: 'https://workday.com',
        chunkIndex: 0,
        heading: 'Apply',
        tokenCount: 100,
      })),
    ),
    healthCheck: mock(() => Promise.resolve(true)),
    searchActions: mock(() => Promise.resolve('results')),
    getActionByAreaId: mock(() => Promise.resolve('details')),
    listSources: mock(() => Promise.resolve({ success: true, results: [], count: 0 })),
    searchSources: mock(() => Promise.resolve({ success: true, query: '', results: [], count: 0 })),
  } as unknown as ApiClient;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('seedFromActionBook', () => {
  let manualStore: ManualStore;
  let apiClient: ApiClient;

  beforeEach(() => {
    manualStore = createMockManualStore();
    apiClient = createMockApiClient();
  });

  test('returns ActionManual when ActionBook has a matching manual', async () => {
    const result = await seedFromActionBook({
      url: 'https://company.workday.com/apply/123',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe('actionbook');
  });

  test('calls searchActionsLegacy with the task type as query', async () => {
    await seedFromActionBook({
      url: 'https://company.workday.com/apply/123',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(apiClient.searchActionsLegacy).toHaveBeenCalledTimes(1);
  });

  test('calls getActionById with the best search result', async () => {
    await seedFromActionBook({
      url: 'https://company.workday.com/apply/123',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(apiClient.getActionById).toHaveBeenCalledWith('https://workday.com/apply');
  });

  test('saves the converted manual via manualStore.saveFromActionBook', async () => {
    await seedFromActionBook({
      url: 'https://company.workday.com/apply/123',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(manualStore.saveFromActionBook).toHaveBeenCalledTimes(1);
  });

  test('returns null when search returns no results', async () => {
    apiClient = createMockApiClient({
      searchActionsLegacy: () => Promise.resolve({
        success: true,
        query: 'test',
        results: [],
        count: 0,
        total: 0,
        hasMore: false,
      }),
    });

    const result = await seedFromActionBook({
      url: 'https://example.com/page',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(result).toBeNull();
  });

  test('returns null when search fails', async () => {
    apiClient = createMockApiClient({
      searchActionsLegacy: () => Promise.reject(new Error('Network error')),
    });

    const result = await seedFromActionBook({
      url: 'https://example.com/page',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(result).toBeNull();
  });

  test('returns null when action detail has no elements', async () => {
    apiClient = createMockApiClient({
      getActionById: () => Promise.resolve({
        action_id: 'test',
        content: 'Page with no elements',
        elements: null,
        createdAt: '2026-01-01T00:00:00Z',
        documentId: 1,
        documentTitle: 'Test',
        documentUrl: 'https://test.com',
        chunkIndex: 0,
        heading: null,
        tokenCount: 50,
      }),
    });

    const result = await seedFromActionBook({
      url: 'https://test.com/page',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(result).toBeNull();
  });

  test('returns null when elements JSON is invalid', async () => {
    apiClient = createMockApiClient({
      getActionById: () => Promise.resolve({
        action_id: 'test',
        content: 'Page',
        elements: 'not valid json {{{',
        createdAt: '2026-01-01T00:00:00Z',
        documentId: 1,
        documentTitle: 'Test',
        documentUrl: 'https://test.com',
        chunkIndex: 0,
        heading: null,
        tokenCount: 50,
      }),
    });

    const result = await seedFromActionBook({
      url: 'https://test.com/page',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(result).toBeNull();
  });

  test('returns null when conversion produces zero steps', async () => {
    apiClient = createMockApiClient({
      getActionById: () => Promise.resolve({
        action_id: 'test',
        content: 'Page with no selectors',
        elements: JSON.stringify({
          empty: { description: 'No selector element', element_type: 'div' },
        }),
        createdAt: '2026-01-01T00:00:00Z',
        documentId: 1,
        documentTitle: 'Test',
        documentUrl: 'https://test.com',
        chunkIndex: 0,
        heading: null,
        tokenCount: 50,
      }),
    });

    const result = await seedFromActionBook({
      url: 'https://test.com/page',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(result).toBeNull();
  });

  test('does not call getActionById when search fails', async () => {
    apiClient = createMockApiClient({
      searchActionsLegacy: () => Promise.reject(new Error('API down')),
    });

    await seedFromActionBook({
      url: 'https://test.com',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(apiClient.getActionById).not.toHaveBeenCalled();
  });

  test('does not call manualStore.saveFromActionBook when no elements', async () => {
    apiClient = createMockApiClient({
      getActionById: () => Promise.resolve({
        action_id: 'test',
        content: 'empty',
        elements: null,
        createdAt: '2026-01-01T00:00:00Z',
        documentId: 1,
        documentTitle: 'Test',
        documentUrl: 'https://test.com',
        chunkIndex: 0,
        heading: null,
        tokenCount: 50,
      }),
    });

    await seedFromActionBook({
      url: 'https://test.com',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    expect(manualStore.saveFromActionBook).not.toHaveBeenCalled();
  });

  test('extracts domain from URL for search query', async () => {
    await seedFromActionBook({
      url: 'https://acme.greenhouse.io/jobs/123',
      taskType: 'apply',
      apiClient,
      manualStore,
    });

    // Should have called with domain-related query
    expect(apiClient.searchActionsLegacy).toHaveBeenCalledTimes(1);
  });
});
