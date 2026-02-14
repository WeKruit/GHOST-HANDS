import type { Page } from 'playwright';
import type { ZodSchema } from 'zod';

/**
 * Abstraction over browser automation engines (Magnitude, Stagehand, Actionbook).
 *
 * All browser interactions in GHOST-HANDS go through this interface.
 * Only adapter implementations may import from magnitude-core or stagehand directly.
 */
export interface BrowserAutomationAdapter {
  /** Adapter identifier */
  readonly type: AdapterType;

  // -- Lifecycle --

  /** Initialize the adapter with browser and LLM configuration */
  start(options: AdapterStartOptions): Promise<void>;

  /** Stop the adapter, close browser connections, release resources */
  stop(): Promise<void>;

  /** Whether the adapter is currently active */
  isActive(): boolean;

  // -- Core Actions --

  /** Execute a natural-language action on the current page */
  act(instruction: string, context?: ActionContext): Promise<ActionResult>;

  /** Extract structured data from the current page using a Zod schema */
  extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T>;

  // -- Observation (optional) --

  /**
   * Discover interactive elements on the page without executing actions.
   * Native to Stagehand; simulated via screenshot analysis for Magnitude;
   * uses searchActions for Actionbook.
   */
  observe?(instruction: string): Promise<ObservedElement[] | undefined>;

  // -- Navigation --

  /** Navigate to a URL */
  navigate(url: string): Promise<void>;

  /** Get the current page URL */
  getCurrentUrl(): Promise<string>;

  // -- State --

  /** Take a screenshot of the current page */
  screenshot(): Promise<Buffer>;

  /** Access the underlying browser page for escape-hatch operations */
  get page(): Page;

  // -- Credentials --

  /** Register sensitive values that should not be sent to LLMs */
  registerCredentials(creds: Record<string, string>): void;

  // -- Events --

  /** Subscribe to adapter lifecycle events */
  on(event: AdapterEvent, handler: (...args: any[]) => void): void;
  off(event: AdapterEvent, handler: (...args: any[]) => void): void;
}

// -- Types --

export type AdapterType = 'magnitude' | 'stagehand' | 'actionbook' | 'hybrid' | 'mock';

export type AdapterEvent =
  | 'actionStarted'
  | 'actionDone'
  | 'tokensUsed'
  | 'thought'
  | 'error'
  | 'progress';

export interface AdapterStartOptions {
  /** Initial URL to navigate to */
  url?: string;
  /** LLM configuration */
  llm: LLMConfig;
  /** CDP WebSocket URL for connecting to existing browser */
  cdpUrl?: string;
  /** Browser launch options (ignored if cdpUrl provided) */
  browserOptions?: BrowserLaunchOptions;
  /** Connectors to pass to the underlying agent (Magnitude-specific) */
  connectors?: any[];
  /** System prompt for the LLM */
  systemPrompt?: string;
  /** Per-application budget limit in USD */
  budgetLimit?: number;
}

export interface ActionContext {
  /** Additional LLM instructions for this action */
  prompt?: string;
  /** Data to substitute into the instruction */
  data?: Record<string, any>;
}

export interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Human-readable description of what happened */
  message: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Tokens consumed, if trackable */
  tokensUsed?: number;
}

export interface ObservedElement {
  /** CSS or XPath selector */
  selector: string;
  /** Human-readable description */
  description: string;
  /** Interaction method */
  method: string;
  /** Arguments for the method */
  arguments: unknown[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
}

export interface LLMConfig {
  provider: string;
  options: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    headers?: Record<string, string>;
  };
  /** LLM roles for multi-model setups (Magnitude) */
  roles?: ('act' | 'extract' | 'query')[];
}

export interface BrowserLaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  args?: string[];
}
