/**
 * Integration tests: ActionBook seeding flow.
 *
 * Tests the full pipeline:
 *   ActionBook SDK -> seedFromActionBook -> ManualStore.saveFromActionBook
 *
 * All external dependencies (ActionBook API, Supabase) are mocked.
 * These tests verify the components work together correctly.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { seedFromActionBook } from '../../../src/engine/actionBookSeeder';
import { ActionBookConnector } from '../../../src/connectors/actionbookConnector';
import { ManualStore } from '../../../src/engine/ManualStore';
import type { ActionManual, ManualStep } from '../../../src/engine/types';
import type { ApiClient, ChunkSearchResult, ChunkActionDetail, ParsedElements } from '@actionbookdev/sdk';

// ── Mock factories ──────────────────────────────────────────────────────

function mockSearchResult(overrides: Partial<ChunkSearchResult> = {}): ChunkSearchResult {
  return {
    success: true,
    query: 'apply workday.com',
    results: [{
      action_id: 'https://workday.com/apply-form',
      content: 'Workday application form with login, personal info, and submission',
      score: 0.92,
      createdAt: '2026-01-15T00:00:00Z',
    }],
    count: 1,
    total: 1,
    hasMore: false,
    ...overrides,
  };
}

function mockActionDetail(overrides: Partial<ChunkActionDetail> = {}): ChunkActionDetail {
  return {
    action_id: 'https://workday.com/apply-form',
    content: 'Workday application form page',
    elements: JSON.stringify({
      email_input: {
        css_selector: 'input[data-automation-id="email"]',
        element_type: 'input',
        allow_methods: ['click', 'type'],
        description: 'Email address input field',
      },
      first_name: {
        css_selector: 'input[data-automation-id="firstName"]',
        element_type: 'input',
        allow_methods: ['click', 'type'],
        description: 'First name input',
        depends_on: 'email_input',
      },
      last_name: {
        css_selector: 'input[data-automation-id="lastName"]',
        element_type: 'input',
        allow_methods: ['click', 'type'],
        description: 'Last name input',
        depends_on: 'first_name',
      },
      country_select: {
        css_selector: 'select[data-automation-id="country"]',
        element_type: 'select',
        allow_methods: ['select'],
        description: 'Country dropdown',
        depends_on: 'last_name',
      },
      submit_button: {
        css_selector: 'button[data-automation-id="submit"]',
        element_type: 'button',
        allow_methods: ['click'],
        description: 'Submit application button',
        depends_on: 'country_select',
      },
    } satisfies ParsedElements),
    createdAt: '2026-01-15T00:00:00Z',
    documentId: 42,
    documentTitle: 'Workday Application',
    documentUrl: 'https://workday.com',
    chunkIndex: 0,
    heading: 'Apply Form',
    tokenCount: 250,
    ...overrides,
  };
}

function createMockApiClient(overrides: {
  searchResult?: ChunkSearchResult;
  actionDetail?: ChunkActionDetail;
  searchError?: Error;
  detailError?: Error;
} = {}): ApiClient {
  return {
    searchActionsLegacy: overrides.searchError
      ? mock(() => Promise.reject(overrides.searchError))
      : mock(() => Promise.resolve(overrides.searchResult ?? mockSearchResult())),
    getActionById: overrides.detailError
      ? mock(() => Promise.reject(overrides.detailError))
      : mock(() => Promise.resolve(overrides.actionDetail ?? mockActionDetail())),
    healthCheck: mock(() => Promise.resolve(true)),
    searchActions: mock(() => Promise.resolve('')),
    getActionByAreaId: mock(() => Promise.resolve('')),
    listSources: mock(() => Promise.resolve({ success: true, results: [], count: 0 })),
    searchSources: mock(() => Promise.resolve({ success: true, query: '', results: [], count: 0 })),
  } as unknown as ApiClient;
}

/**
 * Creates a mock ManualStore that actually stores data in memory,
 * allowing integration tests to verify the full write → read flow.
 */
function createInMemoryManualStore() {
  const storage: Map<string, any> = new Map();

  function createQueryChain(data: any = null, error: any = null) {
    const chain: any = {
      _result: { data, error },
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      single: () => chain,
      maybeSingle: () => chain,
      insert: (row: any) => {
        const id = crypto.randomUUID();
        const saved = { ...row, id };
        storage.set(id, saved);
        chain._result = { data: saved, error: null };
        return chain;
      },
      update: () => chain,
      then: (resolve: (v: any) => void) => resolve(chain._result),
    };
    return chain;
  }

  const client = {
    from: mock((_table: string) => createQueryChain()),
  };

  // Override to capture inserts
  const store = new ManualStore({ supabase: client as any });
  return { store, storage, client };
}

// ── Integration Tests ───────────────────────────────────────────────────

describe('ActionBook Seeding Integration', () => {

  describe('full seed pipeline: search → fetch → convert → save', () => {
    test('seeds a Workday cookbook with correctly ordered steps', async () => {
      const apiClient = createMockApiClient();
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://acme.workday.com/en-US/apply/12345',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).not.toBeNull();
      expect(result!.source).toBe('actionbook');
      // Health score should be 0.8 (80 / 100) for actionbook source
      expect(result!.health_score).toBeCloseTo(0.8, 2);
    });

    test('seeded manual steps preserve ActionBook ordering (depends_on)', async () => {
      const apiClient = createMockApiClient();
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://acme.workday.com/en-US/apply/12345',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).not.toBeNull();
      const steps = result!.steps;

      // Steps should follow depends_on chain:
      // email_input -> first_name -> last_name -> country_select -> submit_button
      expect(steps.length).toBe(5);
      const descriptions = steps.map((s: ManualStep) => s.description);
      expect(descriptions).toEqual([
        'Email address input field',
        'First name input',
        'Last name input',
        'Country dropdown',
        'Submit application button',
      ]);
    });

    test('seeded steps map CSS selectors to locator.css', async () => {
      const apiClient = createMockApiClient();
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://acme.workday.com/en-US/apply/12345',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      const emailStep = result!.steps.find(
        (s: ManualStep) => s.description === 'Email address input field',
      );
      expect(emailStep).toBeDefined();
      expect(emailStep!.locator.css).toBe('input[data-automation-id="email"]');
    });

    test('seeded steps map allow_methods to correct actions', async () => {
      const apiClient = createMockApiClient();
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://acme.workday.com/en-US/apply/12345',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      // 'type' in allow_methods maps to 'fill' action
      const emailStep = result!.steps.find(
        (s: ManualStep) => s.description === 'Email address input field',
      );
      expect(emailStep!.action).toBe('fill');

      // 'select' in allow_methods maps to 'select' action
      const countryStep = result!.steps.find(
        (s: ManualStep) => s.description === 'Country dropdown',
      );
      expect(countryStep!.action).toBe('select');

      // 'click' only maps to 'click'
      const submitStep = result!.steps.find(
        (s: ManualStep) => s.description === 'Submit application button',
      );
      expect(submitStep!.action).toBe('click');
    });
  });

  describe('ActionBook search with domain extraction', () => {
    test('extracts domain from URL for search query', async () => {
      const apiClient = createMockApiClient();
      const { store } = createInMemoryManualStore();

      await seedFromActionBook({
        url: 'https://boards.greenhouse.io/company/jobs/123',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(apiClient.searchActionsLegacy).toHaveBeenCalledWith({
        query: 'apply greenhouse.io',
        limit: 5,
      });
    });

    test('uses custom domain when provided', async () => {
      const apiClient = createMockApiClient();
      const { store } = createInMemoryManualStore();

      await seedFromActionBook({
        url: 'https://acme.workday.com/apply',
        taskType: 'apply',
        domain: 'workday.com',
        apiClient,
        manualStore: store,
      });

      expect(apiClient.searchActionsLegacy).toHaveBeenCalledWith({
        query: 'apply workday.com',
        limit: 5,
      });
    });
  });

  describe('graceful fallback scenarios', () => {
    test('returns null when ActionBook search finds nothing', async () => {
      const apiClient = createMockApiClient({
        searchResult: {
          success: true,
          query: 'apply unknown.com',
          results: [],
          count: 0,
          total: 0,
          hasMore: false,
        },
      });
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://unknown.com/apply',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).toBeNull();
    });

    test('returns null when ActionBook API is down', async () => {
      const apiClient = createMockApiClient({
        searchError: new Error('ECONNREFUSED'),
      });
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://workday.com/apply',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).toBeNull();
    });

    test('returns null when action detail has null elements', async () => {
      const apiClient = createMockApiClient({
        actionDetail: mockActionDetail({ elements: null }),
      });
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://workday.com/apply',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).toBeNull();
    });

    test('returns null when elements JSON is malformed', async () => {
      const apiClient = createMockApiClient({
        actionDetail: mockActionDetail({ elements: '{invalid json]]' }),
      });
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://workday.com/apply',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).toBeNull();
    });

    test('returns null when all elements lack selectors', async () => {
      const apiClient = createMockApiClient({
        actionDetail: mockActionDetail({
          elements: JSON.stringify({
            text_only: { description: 'Just a label', element_type: 'span' },
            another_text: { description: 'Another label' },
          }),
        }),
      });
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://workday.com/apply',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).toBeNull();
    });

    test('returns null when getActionById fails', async () => {
      const apiClient = createMockApiClient({
        detailError: new Error('Rate limited'),
      });
      const { store } = createInMemoryManualStore();

      const result = await seedFromActionBook({
        url: 'https://workday.com/apply',
        taskType: 'apply',
        apiClient,
        manualStore: store,
      });

      expect(result).toBeNull();
    });
  });

  describe('ActionBookConnector.convertToManual edge cases', () => {
    test('handles elements with only xpath selectors', async () => {
      const connector = new ActionBookConnector();
      const elements: ParsedElements = {
        nav_link: {
          xpath_selector: '//nav/a[contains(@class, "active")]',
          element_type: 'link',
          allow_methods: ['click'],
          description: 'Active nav link',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:nav', '*');
      expect(manual.steps.length).toBe(1);
      expect(manual.steps[0].locator.xpath).toBe('//nav/a[contains(@class, "active")]');
      expect(manual.steps[0].locator.css).toBeUndefined();
    });

    test('handles elements with both CSS and XPath selectors', async () => {
      const connector = new ActionBookConnector();
      const elements: ParsedElements = {
        dual_selector: {
          css_selector: 'button.submit',
          xpath_selector: '//button[@class="submit"]',
          allow_methods: ['click'],
          description: 'Submit',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:dual', '*');
      expect(manual.steps[0].locator.css).toBe('button.submit');
      expect(manual.steps[0].locator.xpath).toBe('//button[@class="submit"]');
    });

    test('handles circular depends_on without infinite loop', async () => {
      const connector = new ActionBookConnector();
      const elements: ParsedElements = {
        a: { css_selector: '.a', allow_methods: ['click'], description: 'A', depends_on: 'b' },
        b: { css_selector: '.b', allow_methods: ['click'], description: 'B', depends_on: 'a' },
      };

      // Should not throw / infinite loop
      const manual = connector.convertToManual(elements, 'test:/:cycle', '*');
      expect(manual.steps.length).toBe(2);
    });

    test('handles comma-separated depends_on', async () => {
      const connector = new ActionBookConnector();
      const elements: ParsedElements = {
        field_a: { css_selector: '.a', allow_methods: ['type'], description: 'A' },
        field_b: { css_selector: '.b', allow_methods: ['type'], description: 'B' },
        submit: {
          css_selector: '.submit',
          allow_methods: ['click'],
          description: 'Submit',
          depends_on: 'field_a, field_b',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:multi', '*');
      const descriptions = manual.steps.map((s) => s.description);
      // Submit should come after both field_a and field_b
      expect(descriptions.indexOf('Submit')).toBeGreaterThan(descriptions.indexOf('A'));
      expect(descriptions.indexOf('Submit')).toBeGreaterThan(descriptions.indexOf('B'));
    });
  });

  describe('API key configuration', () => {
    test('ActionBookConnector works without API key (key is optional)', () => {
      // Should not throw
      const connector = new ActionBookConnector();
      expect(connector.id).toBe('actionbook');
      expect(connector.getActionSpace().length).toBe(2);
    });

    test('ActionBookConnector instructions mention checking ActionBook first', async () => {
      const connector = new ActionBookConnector();
      const instructions = await connector.getInstructions();
      expect(instructions).toContain('ActionBook');
      expect(instructions).toContain('actionbook:lookup');
    });
  });
});
