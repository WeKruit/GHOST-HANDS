import {
  BrowserAgent,
  startBrowserAgent,
} from 'magnitude-core';
import type { ModelUsage } from 'magnitude-core';
import type {
  BrowserAutomationAdapter,
  AdapterStartOptions,
  AdapterEvent,
  ActionContext,
  ActionResult,
  TokenUsage,
} from './types';
import type { Page } from 'playwright';
import type { ZodSchema } from 'zod';
import EventEmitter from 'eventemitter3';

export class MagnitudeAdapter implements BrowserAutomationAdapter {
  readonly type = 'magnitude' as const;
  private agent: BrowserAgent | null = null;
  private emitter = new EventEmitter();
  private active = false;
  private _credentials: Record<string, string> = {};

  async start(options: AdapterStartOptions): Promise<void> {
    this.agent = await startBrowserAgent({
      url: options.url,
      llm: {
        provider: options.llm.provider,
        options: {
          model: options.llm.options.model,
          apiKey: options.llm.options.apiKey,
          ...(options.llm.options.baseUrl && { baseUrl: options.llm.options.baseUrl }),
          ...(options.llm.options.temperature !== undefined && { temperature: options.llm.options.temperature }),
          ...(options.llm.options.headers && { headers: options.llm.options.headers }),
        },
      } as any,
      connectors: options.connectors,
      prompt: options.systemPrompt,
      browser: options.cdpUrl
        ? { cdp: options.cdpUrl }
        : options.browserOptions as any,
    });

    // Wire Magnitude events to adapter events
    this.agent.events.on('actionStarted', (action) => {
      this.emitter.emit('actionStarted', { variant: action.variant });
    });
    this.agent.events.on('actionDone', (action) => {
      this.emitter.emit('actionDone', { variant: action.variant });
    });
    this.agent.events.on('tokensUsed', (usage: ModelUsage) => {
      const tokenUsage: TokenUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        inputCost: usage.inputCost ?? 0,
        outputCost: usage.outputCost ?? 0,
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
    try {
      await this.requireAgent().act(instruction, {
        prompt: context?.prompt,
        data: context?.data,
      });
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

  // observe() is NOT implemented for Magnitude (vision-based, no DOM discovery)

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

  isActive(): boolean {
    return this.active;
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
