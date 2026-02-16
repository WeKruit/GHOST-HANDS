import { describe, expect, test, beforeEach, mock, spyOn } from 'bun:test';
import { ActionBookConnector } from '../../../src/connectors/actionbookConnector';
import type { Actionbook, ParsedElements, ChunkActionDetail } from '@actionbookdev/sdk';

// ── Helpers ──────────────────────────────────────────────────────────────

function createMockClient(overrides: Partial<Actionbook> = {}): Actionbook {
  return {
    searchActions: mock(() => Promise.resolve('area_id: workday.com:/:default\nDescription: Workday login page\n')),
    getActionByAreaId: mock(() => Promise.resolve(
      'Elements:\n' +
      '  username_field:\n' +
      '    css: input#username\n' +
      '    type: input\n' +
      '    allow_methods: click, type\n' +
      '  password_field:\n' +
      '    css: input#password\n' +
      '    type: input\n' +
      '    allow_methods: click, type\n' +
      '  login_button:\n' +
      '    css: button[data-testid="login"]\n' +
      '    type: button\n' +
      '    allow_methods: click\n' +
      '    depends_on: username_field, password_field'
    )),
    listSources: mock(() => Promise.resolve({ success: true, results: [], count: 0 })),
    searchSources: mock(() => Promise.resolve({ success: true, query: '', results: [], count: 0 })),
    ...overrides,
  } as unknown as Actionbook;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ActionBookConnector', () => {
  let connector: ActionBookConnector;
  let mockClient: Actionbook;

  beforeEach(() => {
    mockClient = createMockClient();
    connector = new ActionBookConnector(mockClient);
  });

  describe('interface compliance', () => {
    test('has id "actionbook"', () => {
      expect(connector.id).toBe('actionbook');
    });

    test('implements getActionSpace', () => {
      expect(typeof connector.getActionSpace).toBe('function');
    });

    test('implements getInstructions', () => {
      expect(typeof connector.getInstructions).toBe('function');
    });
  });

  describe('getActionSpace', () => {
    test('returns two actions: actionbook:lookup and actionbook:get-manual', () => {
      const actions = connector.getActionSpace();
      expect(actions).toHaveLength(2);

      const names = actions.map((a) => a.name);
      expect(names).toContain('actionbook:lookup');
      expect(names).toContain('actionbook:get-manual');
    });

    test('actionbook:lookup has correct schema shape', () => {
      const actions = connector.getActionSpace();
      const lookup = actions.find((a) => a.name === 'actionbook:lookup')!;
      expect(lookup).toBeDefined();
      expect(lookup.description).toBeTruthy();

      // Schema should accept { query: string, domain?: string, url?: string }
      const result = lookup.schema.safeParse({ query: 'workday login' });
      expect(result.success).toBe(true);
    });

    test('actionbook:get-manual has correct schema shape', () => {
      const actions = connector.getActionSpace();
      const getManual = actions.find((a) => a.name === 'actionbook:get-manual')!;
      expect(getManual).toBeDefined();

      const result = getManual.schema.safeParse({ area_id: 'workday.com:/:default' });
      expect(result.success).toBe(true);
    });
  });

  describe('getInstructions', () => {
    test('returns string containing ActionBook guidance', async () => {
      const instructions = await connector.getInstructions();
      expect(typeof instructions).toBe('string');
      expect(instructions).toContain('ActionBook');
    });

    test('mentions lookup before exploring', async () => {
      const instructions = await connector.getInstructions();
      expect(instructions).toContain('actionbook:lookup');
    });
  });

  describe('action: actionbook:lookup', () => {
    test('calls client.searchActions with query', async () => {
      const actions = connector.getActionSpace();
      const lookup = actions.find((a) => a.name === 'actionbook:lookup')!;

      const mockAgent = {} as any;
      await lookup.resolver({ input: { query: 'workday login' }, agent: mockAgent });

      expect(mockClient.searchActions).toHaveBeenCalledTimes(1);
    });

    test('passes domain and url when provided', async () => {
      const actions = connector.getActionSpace();
      const lookup = actions.find((a) => a.name === 'actionbook:lookup')!;

      const mockAgent = {} as any;
      await lookup.resolver({
        input: { query: 'login', domain: 'workday.com', url: 'https://workday.com/login' },
        agent: mockAgent,
      });

      expect(mockClient.searchActions).toHaveBeenCalledWith({
        query: 'login',
        domain: 'workday.com',
        url: 'https://workday.com/login',
      });
    });

    test('returns text content on success', async () => {
      const actions = connector.getActionSpace();
      const lookup = actions.find((a) => a.name === 'actionbook:lookup')!;

      const mockAgent = {} as any;
      const result = await lookup.resolver({
        input: { query: 'workday login' },
        agent: mockAgent,
      });

      // Result should contain text content
      expect(result).toBeDefined();
    });

    test('returns graceful message when no results', async () => {
      const noResultsClient = createMockClient({
        searchActions: mock(() => Promise.resolve('No actions found.')),
      });
      const noResultsConnector = new ActionBookConnector(noResultsClient);
      const actions = noResultsConnector.getActionSpace();
      const lookup = actions.find((a) => a.name === 'actionbook:lookup')!;

      const mockAgent = {} as any;
      const result = await lookup.resolver({
        input: { query: 'nonexistent-ats-12345' },
        agent: mockAgent,
      });

      expect(result).toBeDefined();
    });

    test('handles API errors gracefully', async () => {
      const errorClient = createMockClient({
        searchActions: mock(() => Promise.reject(new Error('API rate limited'))),
      });
      const errorConnector = new ActionBookConnector(errorClient);
      const actions = errorConnector.getActionSpace();
      const lookup = actions.find((a) => a.name === 'actionbook:lookup')!;

      const mockAgent = {} as any;
      const result = await lookup.resolver({
        input: { query: 'test' },
        agent: mockAgent,
      });

      // Should NOT throw, should return graceful fallback
      expect(result).toBeDefined();
    });
  });

  describe('action: actionbook:get-manual', () => {
    test('calls client.getActionByAreaId with area_id', async () => {
      const actions = connector.getActionSpace();
      const getManual = actions.find((a) => a.name === 'actionbook:get-manual')!;

      const mockAgent = {} as any;
      await getManual.resolver({
        input: { area_id: 'workday.com:/:default' },
        agent: mockAgent,
      });

      expect(mockClient.getActionByAreaId).toHaveBeenCalledWith('workday.com:/:default');
    });

    test('returns text content on success', async () => {
      const actions = connector.getActionSpace();
      const getManual = actions.find((a) => a.name === 'actionbook:get-manual')!;

      const mockAgent = {} as any;
      const result = await getManual.resolver({
        input: { area_id: 'workday.com:/:default' },
        agent: mockAgent,
      });

      expect(result).toBeDefined();
    });

    test('handles not-found errors gracefully', async () => {
      const notFoundClient = createMockClient({
        getActionByAreaId: mock(() => Promise.reject(new Error('Not found'))),
      });
      const notFoundConnector = new ActionBookConnector(notFoundClient);
      const actions = notFoundConnector.getActionSpace();
      const getManual = actions.find((a) => a.name === 'actionbook:get-manual')!;

      const mockAgent = {} as any;
      const result = await getManual.resolver({
        input: { area_id: 'nonexistent:/:default' },
        agent: mockAgent,
      });

      expect(result).toBeDefined();
    });
  });

  describe('convertToManual', () => {
    test('converts ActionBook elements to ActionManual steps', () => {
      const elements: ParsedElements = {
        username_field: {
          css_selector: 'input#username',
          element_type: 'input',
          allow_methods: ['click', 'type'],
          description: 'Username input field',
        },
        password_field: {
          css_selector: 'input#password',
          element_type: 'input',
          allow_methods: ['click', 'type'],
          description: 'Password input field',
          depends_on: 'username_field',
        },
        login_button: {
          css_selector: 'button[data-testid="login"]',
          element_type: 'button',
          allow_methods: ['click'],
          description: 'Login submit button',
          depends_on: 'password_field',
        },
      };

      const manual = connector.convertToManual(
        elements,
        'workday.com:/:default',
        'https://workday.com/*',
      );

      expect(manual.url_pattern).toBe('https://workday.com/*');
      expect(manual.source).toBe('actionbook');
      expect(manual.steps.length).toBe(3);
      expect(manual.health_score).toBe(0.8); // actionbook source starts at 80%

      // Verify step ordering respects depends_on
      const stepDescriptions = manual.steps.map((s) => s.description);
      expect(stepDescriptions).toEqual([
        'Username input field',
        'Password input field',
        'Login submit button',
      ]);
    });

    test('maps css_selector to locator.css', () => {
      const elements: ParsedElements = {
        search_box: {
          css_selector: 'input.search',
          element_type: 'input',
          allow_methods: ['type'],
          description: 'Search input',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:default', '*');
      expect(manual.steps[0].locator.css).toBe('input.search');
    });

    test('maps xpath_selector to locator.xpath', () => {
      const elements: ParsedElements = {
        link: {
          xpath_selector: '//a[@class="nav"]',
          element_type: 'link',
          allow_methods: ['click'],
          description: 'Nav link',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:default', '*');
      expect(manual.steps[0].locator.xpath).toBe('//a[@class="nav"]');
    });

    test('maps allow_methods to action type', () => {
      const elements: ParsedElements = {
        btn: {
          css_selector: 'button.submit',
          allow_methods: ['click'],
          description: 'Submit',
        },
        input: {
          css_selector: 'input.name',
          allow_methods: ['type', 'click'],
          description: 'Name',
        },
        dropdown: {
          css_selector: 'select.country',
          allow_methods: ['select'],
          description: 'Country',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:default', '*');
      expect(manual.steps.find((s) => s.description === 'Submit')!.action).toBe('click');
      expect(manual.steps.find((s) => s.description === 'Name')!.action).toBe('fill');
      expect(manual.steps.find((s) => s.description === 'Country')!.action).toBe('select');
    });

    test('handles elements with no selectors gracefully', () => {
      const elements: ParsedElements = {
        empty_element: {
          description: 'No selector element',
          element_type: 'div',
        },
      };

      // Should skip elements without any selectors
      const manual = connector.convertToManual(elements, 'test:/:default', '*');
      expect(manual.steps.length).toBe(0);
    });

    test('topological sort respects depends_on chains', () => {
      const elements: ParsedElements = {
        step_c: {
          css_selector: '.c',
          allow_methods: ['click'],
          description: 'Step C',
          depends_on: 'step_b',
        },
        step_a: {
          css_selector: '.a',
          allow_methods: ['click'],
          description: 'Step A',
        },
        step_b: {
          css_selector: '.b',
          allow_methods: ['click'],
          description: 'Step B',
          depends_on: 'step_a',
        },
      };

      const manual = connector.convertToManual(elements, 'test:/:default', '*');
      const descriptions = manual.steps.map((s) => s.description);
      expect(descriptions).toEqual(['Step A', 'Step B', 'Step C']);
    });
  });

  describe('constructor', () => {
    test('accepts client as first argument', () => {
      const client = createMockClient();
      const conn = new ActionBookConnector(client);
      expect(conn.id).toBe('actionbook');
    });

    test('creates default client when no args provided', () => {
      // Should not throw even without API key (key is optional)
      const conn = new ActionBookConnector();
      expect(conn.id).toBe('actionbook');
    });
  });
});
