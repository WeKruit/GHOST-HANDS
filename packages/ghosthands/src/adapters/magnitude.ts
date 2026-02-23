import {
  BrowserAgent,
  startBrowserAgent,
} from 'magnitude-core';
import type { ModelUsage } from 'magnitude-core';
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
import type { StagehandObserver } from '../engine/StagehandObserver';
import type { ObservedElement as EngineObservedElement } from '../engine/types';
import type { Page } from 'playwright';
import type { ZodSchema } from 'zod';
import EventEmitter from 'eventemitter3';
import { loadModelConfig, type ResolvedModel } from '../config/models';

export class MagnitudeAdapter implements HitlCapableAdapter {
  readonly type = 'magnitude' as const;
  private agent: BrowserAgent | null = null;
  private emitter = new EventEmitter();
  private active = false;
  private _credentials: Record<string, string> = {};
  private _observer: StagehandObserver | null = null;
  private _resolvedModel: ResolvedModel | null = null;
  private _resolvedImageModel: ResolvedModel | null = null;
  /** Map from full model identifier to resolved pricing for cost lookup */
  private _modelPricingMap = new Map<string, { input: number; output: number }>();
  /** Promise-based pause gate for HITL */
  private _paused = false;
  private _pauseGateResolve: (() => void) | null = null;
  private _pauseGate: Promise<void> | null = null;
  private _lastResolutionContext: ResolutionContext | null = null;

  async start(options: AdapterStartOptions): Promise<void> {
    // Resolve model configs to get pricing info for cost calculation
    try {
      this._resolvedModel = loadModelConfig(options.llm.options.model);
      this._modelPricingMap.set(this._resolvedModel.model, this._resolvedModel.cost);
    } catch {
      this._resolvedModel = null;
    }

    if (options.imageLlm) {
      try {
        this._resolvedImageModel = loadModelConfig(options.imageLlm.options.model);
        this._modelPricingMap.set(this._resolvedImageModel.model, this._resolvedImageModel.cost);
      } catch {
        this._resolvedImageModel = null;
      }
    }

    // Build LLM config(s) for Magnitude
    // Magnitude v0.3.1 supports LLMClient[] with roles
    const buildLlmConfig = (llm: typeof options.llm, roles?: string[]) => ({
      provider: llm.provider,
      options: {
        model: llm.options.model,
        apiKey: llm.options.apiKey,
        ...(llm.options.baseUrl && { baseUrl: llm.options.baseUrl }),
        ...(llm.options.temperature !== undefined && { temperature: llm.options.temperature }),
        ...(llm.options.headers && { headers: llm.options.headers }),
      },
      ...(roles && { roles }),
    });

    let llmConfig: any;
    if (options.imageLlm) {
      // Dual-model: image model handles 'act' (screenshot analysis),
      // reasoning model handles 'extract' and 'query'
      llmConfig = [
        buildLlmConfig(options.imageLlm, ['act']),
        buildLlmConfig(options.llm, ['extract', 'query']),
      ];
    } else {
      llmConfig = buildLlmConfig(options.llm);
    }

    this.agent = await startBrowserAgent({
      url: options.url,
      llm: llmConfig,
      connectors: options.connectors,
      prompt: options.systemPrompt,
      browser: options.cdpUrl
        ? { cdp: options.cdpUrl }
        : options.browserOptions as any,
    });

    // Remove dangerous actions the LLM should never use.
    // Scroll is handled by our orchestrator; navigation is handled by DOM code.
    const blockedActions = new Set(['mouse:scroll', 'mouse:drag', 'keyboard:tab', 'browser:nav', 'browser:nav:back', 'browser:tab:new', 'browser:tab:switch']);
    const agentAny = this.agent as any;
    agentAny.actions = agentAny.actions.filter(
      (a: { name: string }) => !blockedActions.has(a.name),
    );

    // Wire Magnitude events to adapter events
    this.agent.events.on('actionStarted', (action) => {
      this.emitter.emit('actionStarted', { variant: action.variant });
    });
    this.agent.events.on('actionDone', (action) => {
      this.emitter.emit('actionDone', { variant: action.variant });
    });
    this.agent.events.on('tokensUsed', (usage: ModelUsage) => {
      // Magnitude emits token counts but NOT costs.
      // Calculate costs from our pricing registry using the model identifier
      // from the event (supports multi-model setups).
      let inputCost = usage.inputCost ?? 0;
      let outputCost = usage.outputCost ?? 0;

      if (inputCost === 0 && outputCost === 0) {
        // Look up pricing by the model identifier Magnitude reports
        const pricing = this._modelPricingMap.get(usage.llm?.model ?? '')
          ?? (this._resolvedModel ? this._resolvedModel.cost : null);

        if (pricing) {
          inputCost = usage.inputTokens * (pricing.input / 1_000_000);
          outputCost = usage.outputTokens * (pricing.output / 1_000_000);
        }
      }

      const tokenUsage: TokenUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        inputCost,
        outputCost,
      };
      this.emitter.emit('tokensUsed', tokenUsage);
    });
    this.agent.events.on('thought', (reasoning) => {
      this.emitter.emit('thought', reasoning);
    });

    this.active = true;
  }

  async act(instruction: string, context?: ActionContext): Promise<ActionResult> {
    const start = Date.now();
    const ACT_TIMEOUT_MS = context?.timeoutMs ?? 60_000; // default 60s per act() call
    try {
      await Promise.race([
        this.requireAgent().act(instruction, {
          prompt: context?.prompt,
          data: context?.data,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`act() timed out after ${ACT_TIMEOUT_MS}ms`)), ACT_TIMEOUT_MS),
        ),
      ]);
      return {
        success: true,
        message: `Completed: ${instruction}`,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }

  async extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T> {
    return this.requireAgent().extract(instruction, schema);
  }

  /** Attach a StagehandObserver to enable observe() support. */
  setObserver(observer: StagehandObserver): void {
    this._observer = observer;
  }

  /** Discover interactive elements via StagehandObserver. Returns undefined if no observer set. */
  async observe(instruction: string): Promise<ObservedElement[] | undefined> {
    if (!this._observer || !this._observer.isInitialized()) return undefined;

    const engineElements: EngineObservedElement[] = await this._observer.observe(instruction);
    return engineElements.map((el) => ({
      selector: el.selector,
      description: el.description,
      method: el.action === 'unknown' ? 'click' : el.action,
      arguments: [],
    }));
  }

  /** The resolved reasoning model configuration (for cost calculation and diagnostics). */
  getResolvedModel(): ResolvedModel | null {
    return this._resolvedModel;
  }

  /** The resolved image/vision model configuration (null if single-model mode). */
  getResolvedImageModel(): ResolvedModel | null {
    return this._resolvedImageModel;
  }

  /** Whether this adapter is running in dual-model mode. */
  isDualModel(): boolean {
    return this._resolvedImageModel !== null;
  }

  async navigate(url: string): Promise<void> {
    await this.requireAgent().page.goto(url);
  }

  async getCurrentUrl(): Promise<string> {
    return this.requireAgent().page.url();
  }

  async screenshot(): Promise<Buffer> {
    const raw = await this.requireAgent().page.screenshot();
    return Buffer.from(raw);
  }

  get page(): Page {
    return this.requireAgent().page;
  }

  async getBrowserSession(): Promise<string | null> {
    try {
      const context = this.requireAgent().page.context();
      const state = await context.storageState();
      return JSON.stringify(state);
    } catch {
      return null;
    }
  }

  registerCredentials(creds: Record<string, string>): void {
    this._credentials = { ...this._credentials, ...creds };
    // magnitude-core 0.3.1 does not expose registerCredentials on BrowserAgent.
    // Credentials are stored locally and can be accessed by custom connectors
    // or injected into prompts as needed.
  }

  on(event: AdapterEvent, handler: (...args: any[]) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: AdapterEvent, handler: (...args: any[]) => void): void {
    this.emitter.off(event, handler);
  }

  async pause(): Promise<void> {
    if (this._paused) return;
    this._paused = true;
    this._pauseGate = new Promise<void>((resolve) => {
      this._pauseGateResolve = resolve;
    });
    // Also pause the underlying Magnitude agent if available
    if (this.agent) {
      try { this.agent.pause(); } catch { /* best effort */ }
    }
  }

  async resume(context?: ResolutionContext): Promise<void> {
    if (!this._paused) return;

    // Store context for potential inspection by callers
    this._lastResolutionContext = context ?? null;

    this._paused = false;
    // Resume the underlying Magnitude agent if available
    if (this.agent) {
      try { this.agent.resume(); } catch { /* best effort */ }
    }
    // Resolve the gate to unblock anything awaiting it
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

  /**
   * Await this to block execution while the adapter is paused.
   * Returns immediately if not paused.
   */
  async waitIfPaused(): Promise<void> {
    if (this._paused && this._pauseGate) {
      await this._pauseGate;
    }
  }

  /**
   * Perform an enriched observation with blocker detection.
   * Combines observe() results with a screenshot and page URL.
   */
  async observeWithBlockerDetection(instruction: string): Promise<ObservationResult> {
    const url = await this.getCurrentUrl();
    const elements = await this.observe(instruction) ?? [];
    const screenshotBuf = await this.screenshot();

    // Classify blockers from observed elements using heuristic patterns
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

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    if (!this.agent || !this.active) return false;
    try {
      const page = this.agent.page;
      const context = page.context();
      const browser = context.browser();
      // browser() returns null if the browser has been disconnected
      if (!browser || !browser.isConnected()) return false;
      // Verify at least one page is open in the context
      return context.pages().length > 0;
    } catch {
      // Any access failure means the browser is gone
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.agent) {
      await this.agent.stop();
      this.agent = null;
    }
    this.active = false;
  }

  private requireAgent(): BrowserAgent {
    if (!this.agent) {
      throw new Error('MagnitudeAdapter: not started. Call start() first.');
    }
    return this.agent;
  }
}
