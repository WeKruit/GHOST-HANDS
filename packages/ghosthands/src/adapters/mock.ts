import type {
  BrowserAutomationAdapter,
  AdapterStartOptions,
  AdapterEvent,
  ActionContext,
  ActionResult,
  ObservedElement,
} from './types';
import type { Page } from 'playwright';
import type { ZodSchema } from 'zod';
import EventEmitter from 'eventemitter3';

export interface MockAdapterConfig {
  actionCount?: number;
  totalTokens?: number;
  costPerToken?: number;
  failAtAction?: number;
  failWithError?: Error;
  extractResult?: any;
  actionDelayMs?: number;
}

/**
 * Mock adapter for unit/integration tests.
 * Does NOT launch a browser -- emits fake events to simulate
 * the same lifecycle as MagnitudeAdapter or StagehandAdapter.
 */
export class MockAdapter implements BrowserAutomationAdapter {
  readonly type = 'mock' as const;
  private emitter = new EventEmitter();
  private config: Required<MockAdapterConfig>;
  private active = false;
  private _paused = false;
  private _currentUrl = 'about:blank';

  constructor(config: MockAdapterConfig = {}) {
    this.config = {
      actionCount: config.actionCount ?? 5,
      totalTokens: config.totalTokens ?? 1000,
      costPerToken: config.costPerToken ?? 0.000001,
      failAtAction: config.failAtAction ?? -1,
      failWithError: config.failWithError ?? new Error('Mock failure'),
      extractResult: config.extractResult ?? { submitted: true },
      actionDelayMs: config.actionDelayMs ?? 1,
    };
  }

  async start(options: AdapterStartOptions): Promise<void> {
    this._currentUrl = options.url ?? 'about:blank';
    this.active = true;
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
    return [
      { selector: '#mock-input', description: 'Mock input field', method: 'fill', arguments: [] },
      { selector: '#mock-button', description: 'Mock submit button', method: 'click', arguments: [] },
    ];
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
    } as unknown as Page;
  }

  async pause(): Promise<void> {
    this._paused = true;
  }

  async resume(): Promise<void> {
    this._paused = false;
  }

  isPaused(): boolean {
    return this._paused;
  }

  isActive(): boolean {
    return this.active;
  }

  async stop(): Promise<void> {
    this.active = false;
  }
}
