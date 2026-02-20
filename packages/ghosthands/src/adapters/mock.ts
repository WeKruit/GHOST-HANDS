import type {
  HitlCapableAdapter,
  AdapterStartOptions,
  AdapterEvent,
  ActionContext,
  ActionResult,
  ObservedElement,
  ObservationResult,
  ObservationBlocker,
  BlockerCategory,
  ResolutionContext,
} from './types';
import type { Page } from 'playwright';
import type { ZodSchema } from 'zod';
import EventEmitter from 'eventemitter3';

export interface MockBlockerConfig {
  category: BlockerCategory;
  confidence: number;
  selector?: string;
  description: string;
}

export interface MockAdapterConfig {
  actionCount?: number;
  totalTokens?: number;
  costPerToken?: number;
  failAtAction?: number;
  failWithError?: Error;
  extractResult?: any;
  actionDelayMs?: number;
  /** Start in a disconnected/crashed state (default: false) */
  startDisconnected?: boolean;
  /** Custom observation results to return from observe() */
  observationResults?: ObservedElement[];
  /** Simulated blockers to return from observeWithBlockerDetection() */
  simulatedBlockers?: MockBlockerConfig[];
}

/**
 * Mock adapter for unit/integration tests.
 * Does NOT launch a browser -- emits fake events to simulate
 * the same lifecycle as MagnitudeAdapter or StagehandAdapter.
 */
export class MockAdapter implements HitlCapableAdapter {
  readonly type = 'mock' as const;
  private emitter = new EventEmitter();
  private config: Required<Omit<MockAdapterConfig, 'observationResults' | 'simulatedBlockers'>> & {
    observationResults: ObservedElement[] | undefined;
    simulatedBlockers: MockBlockerConfig[] | undefined;
  };
  private active = false;
  private _paused = false;
  private _connected = true;
  private _currentUrl = 'about:blank';
  private _pauseGateResolve: (() => void) | null = null;
  private _pauseGate: Promise<void> | null = null;
  private _lastResolutionContext: ResolutionContext | null = null;

  constructor(config: MockAdapterConfig = {}) {
    this.config = {
      actionCount: config.actionCount ?? 5,
      totalTokens: config.totalTokens ?? 1000,
      costPerToken: config.costPerToken ?? 0.000001,
      failAtAction: config.failAtAction ?? -1,
      failWithError: config.failWithError ?? new Error('Mock failure'),
      extractResult: config.extractResult ?? { submitted: true },
      actionDelayMs: config.actionDelayMs ?? 1,
      startDisconnected: config.startDisconnected ?? false,
      observationResults: config.observationResults,
      simulatedBlockers: config.simulatedBlockers,
    };
  }

  async start(options: AdapterStartOptions): Promise<void> {
    this._currentUrl = options.url ?? 'about:blank';
    this.active = true;
    this._connected = !this.config.startDisconnected;
  }

  async act(instruction: string, _context?: ActionContext): Promise<ActionResult> {
    const start = Date.now();
    const tokensPerAction = Math.floor(this.config.totalTokens / this.config.actionCount);
    const costPerAction = tokensPerAction * this.config.costPerToken;

    try {
      for (let i = 0; i < this.config.actionCount; i++) {
        if (this.config.failAtAction === i) {
          throw this.config.failWithError;
        }

        this.emitter.emit('actionStarted', { variant: `mock_action_${i}` });
        await new Promise(r => setTimeout(r, this.config.actionDelayMs));

        this.emitter.emit('tokensUsed', {
          inputTokens: tokensPerAction,
          outputTokens: tokensPerAction,
          inputCost: costPerAction,
          outputCost: costPerAction,
        });

        this.emitter.emit('actionDone', { variant: `mock_action_${i}` });
      }

      return {
        success: true,
        message: `Mock completed: ${instruction}`,
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

  async extract<T>(_instruction: string, _schema: ZodSchema<T>): Promise<T> {
    return this.config.extractResult as T;
  }

  async observe(_instruction: string): Promise<ObservedElement[]> {
    if (this.config.observationResults) {
      return this.config.observationResults;
    }
    return [
      { selector: '#mock-input', description: 'Mock input field', method: 'fill', arguments: [] },
      { selector: '#mock-button', description: 'Mock submit button', method: 'click', arguments: [] },
    ];
  }

  async observeWithBlockerDetection(instruction: string): Promise<ObservationResult> {
    const elements = await this.observe(instruction);
    const blockers: ObservationBlocker[] = (this.config.simulatedBlockers ?? []).map((b) => ({
      category: b.category,
      confidence: b.confidence,
      selector: b.selector,
      description: b.description,
    }));

    return {
      elements,
      blockers,
      url: this._currentUrl,
      timestamp: Date.now(),
      screenshot: Buffer.from('fake-png-data'),
    };
  }

  async navigate(url: string): Promise<void> {
    this._currentUrl = url;
  }

  async getCurrentUrl(): Promise<string> {
    return this._currentUrl;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png-data');
  }

  async getBrowserSession(): Promise<string | null> {
    return JSON.stringify({
      cookies: [{ name: 'mock_session', value: 'abc123', domain: 'example.com', path: '/' }],
      origins: [],
    });
  }

  registerCredentials(_creds: Record<string, string>): void {
    // No-op in mock
  }

  on(event: AdapterEvent, handler: (...args: any[]) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: AdapterEvent, handler: (...args: any[]) => void): void {
    this.emitter.off(event, handler);
  }

  get page(): Page {
    return {
      screenshot: async () => Buffer.from('fake-png'),
      route: async () => {},
      unroute: async () => {},
      goto: async () => null,
      url: () => this._currentUrl,
      evaluate: async (_fn: Function, arg?: any) => {
        // Support BlockerDetector DOM detection calls:
        // - Array arg = selector patterns → return empty (no DOM in mock)
        // - No arg = body text → return empty string
        if (Array.isArray(arg)) return [];
        return '';
      },
    } as unknown as Page;
  }

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

  /**
   * Await this to block execution while the adapter is paused.
   * Returns immediately if not paused.
   */
  async waitIfPaused(): Promise<void> {
    if (this._paused && this._pauseGate) {
      await this._pauseGate;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  isConnected(): boolean {
    return this.active && this._connected;
  }

  /**
   * Simulate a browser crash for testing.
   * After calling this, isConnected() returns false.
   */
  simulateCrash(): void {
    this._connected = false;
  }

  async stop(): Promise<void> {
    this.active = false;
    this._connected = false;
  }
}
