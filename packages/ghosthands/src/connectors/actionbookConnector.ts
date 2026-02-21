/**
 * ActionBookConnector — AgentConnector that provides ActionBook lookup
 * actions to the Magnitude agent.
 *
 * Implements the AgentConnector interface from magnitude-core so the LLM
 * can search ActionBook for pre-recorded manuals before exploring blindly.
 */

import { z } from 'zod';
import {
  Actionbook,
  type ParsedElements,
  type ActionbookOptions,
} from '@actionbookdev/sdk';
import type { ActionManual, ManualStep, LocatorDescriptor } from '../engine/types';

// ── Magnitude-core types (re-declared to avoid deep import issues) ──────
// The actual interface lives in magnitude-core's connectors/index.d.ts.
// We mirror it here so this file compiles without pathing into node_modules.

interface ActionDefinition<T> {
  name: string;
  description?: string;
  schema: z.ZodType<T>;
  resolver: (ctx: { input: T; agent: any }) => Promise<void | any>;
  render: (action: T) => string;
}

export interface AgentConnector {
  id: string;
  onStart?(): Promise<void>;
  onStop?(): Promise<void>;
  getActionSpace?(): ActionDefinition<any>[];
  collectObservations?(): Promise<any[]>;
  getInstructions?(): Promise<void | string>;
}

// ── Schemas for the two connector actions ───────────────────────────────

const lookupSchema = z.object({
  query: z.string().describe('Search query describing the action or page'),
  domain: z.string().optional().describe('Filter by website domain (e.g. "workday.com")'),
  url: z.string().optional().describe('Filter by specific page URL'),
});

const getManualSchema = z.object({
  area_id: z.string().describe('ActionBook area_id (e.g. "workday.com:/:default")'),
});

type LookupInput = z.infer<typeof lookupSchema>;
type GetManualInput = z.infer<typeof getManualSchema>;

// ── Action type mapping ─────────────────────────────────────────────────

const METHOD_TO_ACTION: Record<string, ManualStep['action']> = {
  click: 'click',
  type: 'fill',
  fill: 'fill',
  select: 'select',
  check: 'check',
  uncheck: 'uncheck',
  hover: 'hover',
  scroll: 'scroll',
  navigate: 'navigate',
  press: 'press',
  wait: 'wait',
};

function mapMethodToAction(methods?: string[]): ManualStep['action'] {
  if (!methods || methods.length === 0) return 'click';
  // Prefer 'type'/'fill' over 'click' when both are present
  for (const m of methods) {
    const mapped = METHOD_TO_ACTION[m.trim().toLowerCase()];
    if (mapped && mapped !== 'click') return mapped;
  }
  return METHOD_TO_ACTION[methods[0].trim().toLowerCase()] ?? 'click';
}

// ── Topological sort by depends_on ──────────────────────────────────────

function topoSort(elements: ParsedElements): string[] {
  const keys = Object.keys(elements);
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(key: string) {
    if (visited.has(key)) return;
    visited.add(key);
    const dep = elements[key]?.depends_on;
    if (dep) {
      // depends_on can be comma-separated
      for (const d of dep.split(',').map((s: string) => s.trim())) {
        if (elements[d]) visit(d);
      }
    }
    result.push(key);
  }

  for (const key of keys) visit(key);
  return result;
}

// ── ActionBookConnector ─────────────────────────────────────────────────

export class ActionBookConnector implements AgentConnector {
  readonly id = 'actionbook';
  private client: Actionbook;

  constructor(client?: Actionbook, options?: ActionbookOptions) {
    this.client = client ?? new Actionbook(options);
  }

  getActionSpace(): ActionDefinition<any>[] {
    return [
      this.createLookupAction(),
      this.createGetManualAction(),
    ];
  }

  async getInstructions(): Promise<string> {
    return [
      'ActionBook contains pre-recorded action manuals for common websites.',
      'BEFORE exploring a page with vision, use actionbook:lookup to search for an existing manual.',
      'If a manual is found, use actionbook:get-manual to retrieve selectors and steps.',
      'This avoids expensive LLM exploration and is much faster.',
    ].join('\n');
  }

  /**
   * Convert ActionBook ParsedElements to an ActionManual.
   *
   * Mapping rules:
   *  - css_selector   -> locator.css
   *  - xpath_selector -> locator.xpath
   *  - allow_methods  -> action type (click/fill/select/etc.)
   *  - description    -> step description
   *  - depends_on     -> ordering via topological sort
   *
   * Steps without any selector are skipped.
   * Health score starts at 0.8 for actionbook-sourced manuals.
   */
  convertToManual(
    elements: ParsedElements,
    areaId: string,
    urlPattern: string,
  ): ActionManual {
    const sortedKeys = topoSort(elements);
    const steps: ManualStep[] = [];

    for (const key of sortedKeys) {
      const el = elements[key];
      if (!el) continue;

      const locator: LocatorDescriptor = {};
      if (el.css_selector) locator.css = el.css_selector;
      if (el.xpath_selector) locator.xpath = el.xpath_selector;

      // Skip elements that have no usable locator
      if (!locator.css && !locator.xpath) continue;

      steps.push({
        order: steps.length,
        locator,
        action: mapMethodToAction(el.allow_methods),
        description: el.description ?? key,
        healthScore: 1.0,
      });
    }

    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      url_pattern: urlPattern,
      task_pattern: areaId,
      platform: areaId.split(':')[0] ?? 'unknown',
      steps,
      health_score: 0.8,
      source: 'actionbook',
      created_at: now,
      updated_at: now,
    };
  }

  // ── Private action builders ───────────────────────────────────────────

  private createLookupAction(): ActionDefinition<LookupInput> {
    const client = this.client;
    return {
      name: 'actionbook:lookup',
      description: 'Search ActionBook for pre-recorded action manuals matching a query, domain, or URL.',
      schema: lookupSchema,
      resolver: async ({ input }) => {
        try {
          const params: Record<string, string> = { query: input.query };
          if (input.domain) params.domain = input.domain;
          if (input.url) params.url = input.url;

          const text = await client.searchActions(params as any);
          return { type: 'text', text };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { type: 'text', text: `ActionBook lookup failed: ${msg}. Explore the page manually.` };
        }
      },
      render: (input) => `actionbook:lookup query="${input.query}"${input.domain ? ` domain=${input.domain}` : ''}`,
    };
  }

  private createGetManualAction(): ActionDefinition<GetManualInput> {
    const client = this.client;
    return {
      name: 'actionbook:get-manual',
      description: 'Retrieve a full action manual (selectors + steps) from ActionBook by area_id.',
      schema: getManualSchema,
      resolver: async ({ input }) => {
        try {
          const text = await client.getActionByAreaId(input.area_id);
          return { type: 'text', text };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { type: 'text', text: `ActionBook manual not found for "${input.area_id}": ${msg}` };
        }
      },
      render: (input) => `actionbook:get-manual area_id="${input.area_id}"`,
    };
  }
}
