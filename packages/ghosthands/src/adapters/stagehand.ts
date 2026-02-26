/**
 * StagehandAdapter — Stagehand v3 implementation of HitlCapableAdapter.
 *
 * Replaces MagnitudeAdapter as the browser automation engine. Uses Stagehand's
 * act() / extract() / observe() APIs over CDP, with Playwright-compatible
 * shims via StagehandPageCompat for seamless integration with existing handlers.
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { Action, V3Options } from '@browserbasehq/stagehand';
import type {
  HitlCapableAdapter,
  AdapterStartOptions,
  AdapterEvent,
  ActionContext,
  ActionResult,
  TokenUsage,
  ObservedElement,
  ObservationResult,
  ObservationBlocker,
  ResolutionContext,
} from './types';
import { StagehandPageCompat, StagehandContextCompat } from './stagehandCompat';
import type { Page } from 'playwright';
import type { ZodSchema } from 'zod';
import EventEmitter from 'eventemitter3';
import { loadModelConfig, type ResolvedModel } from '../config/models';
import { getLogger } from '../monitoring/logger';

// ── Method mapping (reused from StagehandObserver) ──────────────────────

const KNOWN_ACTIONS = new Set([
  'click', 'fill', 'select', 'check', 'hover', 'navigate', 'scroll', 'press',
]);

function mapMethod(method: string | undefined): string {
  if (!method) return 'click';
  const normalized = method.toLowerCase();
  if (normalized === 'type') return 'fill';
  if (KNOWN_ACTIONS.has(normalized)) return normalized;
  return 'click';
}

function mapAction(action: Action): ObservedElement {
  return {
    selector: action.selector,
    description: action.description,
    method: mapMethod(action.method),
    arguments: action.arguments ?? [],
  };
}

// ── Metrics snapshot helper ─────────────────────────────────────────────

interface MetricsSnapshot {
  promptTokens: number;
  completionTokens: number;
}

function snapshotMetrics(stagehand: Stagehand): MetricsSnapshot {
  const m = stagehand.stagehandMetrics;
  return {
    promptTokens: m.totalPromptTokens,
    completionTokens: m.totalCompletionTokens,
  };
}

function deltaMetrics(before: MetricsSnapshot, after: MetricsSnapshot) {
  return {
    inputTokens: Math.max(0, after.promptTokens - before.promptTokens),
    outputTokens: Math.max(0, after.completionTokens - before.completionTokens),
  };
}

// ── StagehandAdapter ────────────────────────────────────────────────────

export class StagehandAdapter implements HitlCapableAdapter {
  readonly type = 'stagehand' as const;
  private _stagehand: Stagehand | null = null;
  private _pageCompat: StagehandPageCompat | null = null;
  private emitter = new EventEmitter();
  private _active = false;
  private _credentials: Record<string, string> = {};
  private _resolvedModel: ResolvedModel | null = null;
  private _resolvedImageModel: ResolvedModel | null = null;

  /** Promise-based pause gate for HITL */
  private _paused = false;
  private _pauseGateResolve: (() => void) | null = null;
  private _pauseGate: Promise<void> | null = null;
  private _lastResolutionContext: ResolutionContext | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(options: AdapterStartOptions): Promise<void> {
    // Resolve model configs for cost calculation
    try {
      this._resolvedModel = loadModelConfig(options.llm.options.model);
    } catch {
      this._resolvedModel = null;
    }

    if (options.imageLlm) {
      try {
        this._resolvedImageModel = loadModelConfig(options.imageLlm.options.model);
      } catch {
        this._resolvedImageModel = null;
      }
    }

    // Build Stagehand V3Options
    // Stagehand expects "provider/model" format (e.g. "anthropic/claude-sonnet-4-6")
    const rawModel = options.llm.options.model;
    const provider = options.llm.provider;
    const model = rawModel.includes('/') ? rawModel : `${provider}/${rawModel}`;

    // Build local browser launch options
    let localBrowserLaunchOptions: V3Options['localBrowserLaunchOptions'];
    if (options.cdpUrl) {
      localBrowserLaunchOptions = { cdpUrl: options.cdpUrl };
    } else if (options.browserOptions) {
      localBrowserLaunchOptions = {
        headless: options.browserOptions.headless,
        viewport: options.browserOptions.viewport,
        args: options.browserOptions.args,
      };
    }

    const logger = getLogger();

    this._stagehand = new Stagehand({
      env: 'LOCAL',
      model,
      verbose: 2,
      experimental: true,
      disableAPI: true,
      logInferenceToFile: true,
      systemPrompt: options.systemPrompt,
      // Log ALL Stagehand events to see what the LLM sees and returns
      logger: (line) => {
        // Always log action and inference categories
        if (line.category === 'inference' || line.category === 'action') {
          this.emitter.emit('thought', line.message);
          logger.info(`[Stagehand] ${line.message}`, { category: line.category });
        }
        // Log act handler details — element selection, normalization, DOM snapshot info
        if (line.category === 'act' || line.category === 'observe') {
          const aux = line.auxiliary || {};
          const auxStr = Object.entries(aux).map(([k, v]: [string, any]) => `${k}=${String(v?.value || '').slice(0, 300)}`).join(' ');
          logger.info(`[Stagehand:${line.category}] ${line.message}`, { aux: auxStr });
        }
      },
      ...(localBrowserLaunchOptions && { localBrowserLaunchOptions }),
    });
    await this._stagehand.init();

    // Navigate to initial URL if provided
    if (options.url) {
      const activePage = this._stagehand.context.activePage();
      if (activePage) {
        await activePage.goto(options.url);
      }
    }

    // Inject storage state if provided (cookies + localStorage from a previous session)
    if (options.storageState) {
      await this._injectStorageState(options.storageState);
    }

    // Create the Playwright-compatible page wrapper
    const activePage = this._stagehand.context.activePage();
    if (!activePage) {
      throw new Error('StagehandAdapter: no active page after init');
    }
    this._pageCompat = new StagehandPageCompat(activePage, this._stagehand);

    this._active = true;
  }

  async stop(): Promise<void> {
    if (this._stagehand) {
      try {
        await this._stagehand.close();
      } catch {
        // Best effort — browser may already be gone
      }
      this._stagehand = null;
    }
    this._pageCompat = null;
    this._active = false;
  }

  isActive(): boolean {
    return this._active;
  }

  isConnected(): boolean {
    if (!this._stagehand || !this._active) return false;
    try {
      const page = this._stagehand.context.activePage();
      return !!page;
    } catch {
      return false;
    }
  }

  // ── Core Actions ──────────────────────────────────────────────────────

  async act(instruction: string, context?: ActionContext): Promise<ActionResult> {
    const stagehand = this._requireStagehand();
    const logger = getLogger();
    const start = Date.now();
    const ACT_TIMEOUT_MS = context?.timeoutMs ?? 60_000;

    logger.info('[Stagehand] act()', { instruction: instruction.slice(0, 200) });

    // Snapshot metrics for delta calculation
    const metricsBefore = snapshotMetrics(stagehand);

    this.emitter.emit('actionStarted', { variant: instruction });

    try {
      const result = await Promise.race([
        stagehand.act(instruction, {
          timeout: ACT_TIMEOUT_MS,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`act() timed out after ${ACT_TIMEOUT_MS}ms`)), ACT_TIMEOUT_MS),
        ),
      ]);

      // After an action, check if a new tab was opened and switch to it
      await this._syncActivePage(logger);

      const durationMs = Date.now() - start;

      // Calculate token delta and emit cost event
      const metricsAfter = snapshotMetrics(stagehand);
      const delta = deltaMetrics(metricsBefore, metricsAfter);
      this._emitTokenUsage(delta);

      this.emitter.emit('actionDone', {
        variant: instruction,
        success: result.success,
        message: result.message,
      });

      logger.info('[Stagehand] act() result', {
        success: result.success,
        message: (result.message || '').slice(0, 300),
        durationMs,
        tokens: delta,
      });

      return {
        success: result.success,
        message: result.message || `Completed: ${instruction}`,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - start;

      // Still try to emit token usage for partial work
      try {
        const metricsAfter = snapshotMetrics(stagehand);
        const delta = deltaMetrics(metricsBefore, metricsAfter);
        this._emitTokenUsage(delta);
      } catch { /* best effort */ }

      this.emitter.emit('actionDone', {
        variant: instruction,
        success: false,
        message: (error as Error).message,
      });

      logger.warn('[Stagehand] act() failed', {
        instruction: instruction.slice(0, 200),
        error: (error as Error).message,
        durationMs,
      });

      return {
        success: false,
        message: (error as Error).message,
        durationMs,
      };
    }
  }

  async extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T> {
    const stagehand = this._requireStagehand();
    const logger = getLogger();

    logger.info('[Stagehand] extract()', { instruction: instruction.slice(0, 200) });

    // Snapshot metrics for delta calculation
    const metricsBefore = snapshotMetrics(stagehand);

    try {
      // Stagehand v3 extract() accepts (instruction, schema) directly with Zod
      const result = await stagehand.extract(instruction, schema as any);

      const metricsAfter = snapshotMetrics(stagehand);
      const delta = deltaMetrics(metricsBefore, metricsAfter);
      this._emitTokenUsage(delta);

      logger.info('[Stagehand] extract() result', {
        resultKeys: typeof result === 'object' && result ? Object.keys(result as object) : typeof result,
        tokens: delta,
      });

      return result as T;
    } catch (error) {
      // Still emit token usage for partial work
      try {
        const metricsAfter = snapshotMetrics(stagehand);
        const delta = deltaMetrics(metricsBefore, metricsAfter);
        this._emitTokenUsage(delta);
      } catch { /* best effort */ }

      throw error;
    }
  }

  // ── Observation ───────────────────────────────────────────────────────

  async observe(instruction: string): Promise<ObservedElement[] | undefined> {
    const stagehand = this._requireStagehand();
    const logger = getLogger();
    logger.info('[Stagehand] observe()', { instruction: instruction.slice(0, 200) });
    const actions: Action[] = await stagehand.observe(instruction);
    logger.info('[Stagehand] observe() found', { count: actions.length, actions: actions.map(a => a.description).slice(0, 5) });
    return actions.map(mapAction);
  }

  async observeWithBlockerDetection(instruction: string): Promise<ObservationResult> {
    const url = await this.getCurrentUrl();
    const elements = await this.observe(instruction) ?? [];
    const screenshotBuf = await this.screenshot();

    // Classify blockers using heuristic patterns (same as MagnitudeAdapter)
    const blockers: ObservationBlocker[] = [];
    for (const el of elements) {
      const desc = el.description.toLowerCase();
      const sel = el.selector.toLowerCase();

      if (/captcha|recaptcha|hcaptcha/i.test(desc) || /captcha|recaptcha|hcaptcha/i.test(sel)) {
        blockers.push({
          category: 'captcha',
          confidence: 0.9,
          selector: el.selector,
          description: el.description,
        });
      } else if (/login|sign.?in|password/i.test(desc) || /login|signin|password/i.test(sel)) {
        blockers.push({
          category: 'login',
          confidence: 0.8,
          selector: el.selector,
          description: el.description,
        });
      } else if (/two.?factor|2fa|verification code|authenticator/i.test(desc)) {
        blockers.push({
          category: '2fa',
          confidence: 0.85,
          selector: el.selector,
          description: el.description,
        });
      } else if (/bot.?check|cloudflare|challenge/i.test(desc) || /challenge/i.test(sel)) {
        blockers.push({
          category: 'bot_check',
          confidence: 0.85,
          selector: el.selector,
          description: el.description,
        });
      }
    }

    return {
      elements,
      blockers,
      url,
      timestamp: Date.now(),
      screenshot: screenshotBuf,
    };
  }

  // ── Navigation ────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    const page = this._requireStagehand().context.activePage();
    if (!page) throw new Error('StagehandAdapter: no active page');
    await page.goto(url);
  }

  async getCurrentUrl(): Promise<string> {
    const page = this._requireStagehand().context.activePage();
    if (!page) throw new Error('StagehandAdapter: no active page');
    return page.url();
  }

  // ── State ─────────────────────────────────────────────────────────────

  async screenshot(): Promise<Buffer> {
    const page = this._requireStagehand().context.activePage();
    if (!page) throw new Error('StagehandAdapter: no active page');
    const raw = await page.screenshot();
    return Buffer.from(raw);
  }

  get page(): Page {
    if (!this._pageCompat) {
      throw new Error('StagehandAdapter: not started. Call start() first.');
    }
    // Return the compat wrapper cast to Page — it implements all methods
    // our handlers actually use, even though it's not a real Playwright Page.
    return this._pageCompat as unknown as Page;
  }

  async getBrowserSession(): Promise<string | null> {
    if (!this._pageCompat) return null;
    try {
      const state = await this._pageCompat.context().storageState();
      return JSON.stringify(state);
    } catch {
      return null;
    }
  }

  // ── Credentials ───────────────────────────────────────────────────────

  registerCredentials(creds: Record<string, string>): void {
    this._credentials = { ...this._credentials, ...creds };
  }

  // ── HITL Pause / Resume ───────────────────────────────────────────────

  async pause(): Promise<void> {
    if (this._paused) return;
    this._paused = true;
    this._pauseGate = new Promise<void>((resolve) => {
      this._pauseGateResolve = resolve;
    });
  }

  async resume(context?: ResolutionContext): Promise<void> {
    if (!this._paused) return;

    this._lastResolutionContext = context ?? null;
    this._paused = false;

    if (this._pauseGateResolve) {
      this._pauseGateResolve();
      this._pauseGateResolve = null;
      this._pauseGate = null;
    }
  }

  get lastResolutionContext(): ResolutionContext | null {
    return this._lastResolutionContext;
  }

  isPaused(): boolean {
    return this._paused;
  }

  async waitIfPaused(): Promise<void> {
    if (this._paused && this._pauseGate) {
      await this._pauseGate;
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  on(event: AdapterEvent, handler: (...args: any[]) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: AdapterEvent, handler: (...args: any[]) => void): void {
    this.emitter.off(event, handler);
  }

  // ── Agent Mode ──────────────────────────────────────────────────────

  /** Get the raw Stagehand instance for agent mode */
  getStagehand(): Stagehand {
    return this._requireStagehand();
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  getResolvedModel(): ResolvedModel | null {
    return this._resolvedModel;
  }

  getResolvedImageModel(): ResolvedModel | null {
    return this._resolvedImageModel;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private _requireStagehand(): Stagehand {
    if (!this._stagehand) {
      throw new Error('StagehandAdapter: not started. Call start() first.');
    }
    return this._stagehand;
  }

  private _emitTokenUsage(delta: { inputTokens: number; outputTokens: number }): void {
    if (delta.inputTokens === 0 && delta.outputTokens === 0) return;

    let inputCost = 0;
    let outputCost = 0;

    if (this._resolvedModel) {
      inputCost = delta.inputTokens * (this._resolvedModel.cost.input / 1_000_000);
      outputCost = delta.outputTokens * (this._resolvedModel.cost.output / 1_000_000);
    }

    const tokenUsage: TokenUsage = {
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      inputCost,
      outputCost,
    };
    this.emitter.emit('tokensUsed', tokenUsage);
  }

  /**
   * After an action (click, navigate), check if the active page changed
   * (e.g. a new tab was opened). If so, update the compat wrapper to point
   * to the new active page so subsequent calls use the correct tab.
   */
  private async _syncActivePage(logger: ReturnType<typeof getLogger>): Promise<void> {
    if (!this._stagehand) return;

    try {
      // awaitActivePage waits briefly if a popup was just triggered
      const newPage = await this._stagehand.context.awaitActivePage(2000);
      if (!newPage) return;

      // Check if the page object changed (new tab opened)
      if (this._pageCompat && newPage !== (this._pageCompat as any)._raw) {
        logger.info('[Stagehand] New tab detected — switching to active page', {
          url: newPage.url(),
        });
        this._pageCompat = new StagehandPageCompat(newPage, this._stagehand);
      }
    } catch {
      // Best effort — page detection is not critical
    }
  }

  /** Inject storage state (cookies + localStorage) from a previous session */
  private async _injectStorageState(state: Record<string, unknown>): Promise<void> {
    if (!this._stagehand) return;
    const page = this._stagehand.context.activePage();
    if (!page) return;

    try {
      // Inject cookies via CDP
      const cookies = (state as any).cookies;
      if (Array.isArray(cookies)) {
        for (const cookie of cookies) {
          try {
            await (page as any).sendCDP('Network.setCookie', cookie);
          } catch { /* best effort */ }
        }
      }

      // Inject localStorage
      const origins = (state as any).origins;
      if (Array.isArray(origins)) {
        for (const origin of origins) {
          if (origin.localStorage && Array.isArray(origin.localStorage)) {
            await (page as any).evaluate((entries: { key: string; value: string }[]) => {
              for (const { key, value } of entries) {
                try { localStorage.setItem(key, value); } catch { /* best effort */ }
              }
            }, origin.localStorage);
          }
        }
      }
    } catch {
      // Best effort — storage state injection is not critical
    }
  }
}
