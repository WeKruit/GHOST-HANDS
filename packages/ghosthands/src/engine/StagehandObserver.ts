/**
 * StagehandObserver — Wraps Stagehand v3 for DOM observation via CDP.
 *
 * Attaches to an existing browser (owned by Magnitude) via CDP WebSocket URL.
 * Uses Stagehand's observe() to discover interactive elements on the page,
 * then maps Stagehand's Action[] to our ObservedElement[] type.
 *
 * IMPORTANT: stop() does NOT close the browser — Magnitude owns the browser lifecycle.
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { Action, V3Options } from '@browserbasehq/stagehand';
import type { ObservedElement } from './types';

// ── Config ─────────────────────────────────────────────────────────────

export interface StagehandObserverConfig {
  /** CDP WebSocket URL for connecting to Magnitude's browser */
  cdpUrl: string;
  /** Stagehand model configuration — "provider/model" string or object */
  model: string | { modelName: string; apiKey?: string; baseURL?: string };
  /** Stagehand verbosity level (0 = silent, 1 = normal, 2 = debug) */
  verbose?: 0 | 1 | 2;
}

// ── Method mapping ─────────────────────────────────────────────────────
// Maps Stagehand Action.method to our ObservedElement.action enum.

const KNOWN_ACTIONS = new Set([
  'click', 'fill', 'select', 'check', 'hover', 'navigate', 'scroll', 'press',
]);

function mapMethod(method: string | undefined): ObservedElement['action'] {
  if (!method) return 'unknown';
  const normalized = method.toLowerCase();
  // Stagehand uses "type" for text input; we normalize to "fill"
  if (normalized === 'type') return 'fill';
  if (KNOWN_ACTIONS.has(normalized)) return normalized as ObservedElement['action'];
  return 'unknown';
}

// ── StagehandObserver ──────────────────────────────────────────────────

export class StagehandObserver {
  private stagehand: Stagehand | null = null;
  private readonly config: StagehandObserverConfig;
  private initialized = false;

  constructor(config: StagehandObserverConfig) {
    this.config = config;
  }

  /** Initialize Stagehand and attach to browser via CDP. */
  async init(): Promise<void> {
    if (this.initialized) {
      throw new Error('StagehandObserver: already initialized. Call stop() before re-initializing.');
    }

    const opts: V3Options = {
      env: 'LOCAL',
      localBrowserLaunchOptions: {
        cdpUrl: this.config.cdpUrl,
      },
      model: this.config.model as any,
      verbose: this.config.verbose ?? 0,
    };

    this.stagehand = new Stagehand(opts);
    await this.stagehand.init();
    this.initialized = true;
  }

  /**
   * Observe the current page and return discovered interactive elements.
   * Stagehand makes its own LLM calls internally — this is expected.
   */
  async observe(instruction: string): Promise<ObservedElement[]> {
    if (!this.initialized || !this.stagehand) {
      throw new Error('StagehandObserver: not initialized. Call init() first.');
    }

    const actions: Action[] = await this.stagehand.observe(instruction);
    return actions.map(mapAction);
  }

  /**
   * Tear down Stagehand without closing the browser.
   * Magnitude owns the browser lifecycle — we only detach.
   */
  async stop(): Promise<void> {
    if (!this.stagehand) return;

    try {
      await this.stagehand.close();
    } catch {
      // Best-effort cleanup — browser may already be gone
    }
    this.stagehand = null;
    this.initialized = false;
  }

  /** Whether the observer is ready to call observe(). */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function mapAction(action: Action): ObservedElement {
  return {
    selector: action.selector,
    description: action.description,
    action: mapMethod(action.method),
  };
}
