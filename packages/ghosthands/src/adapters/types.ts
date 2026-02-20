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

  /**
   * Check if the underlying browser connection is still alive.
   * Returns false if the browser process has exited, the CDP connection
   * dropped, or all pages have been closed.
   */
  isConnected(): boolean;

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

  /**
   * Export the current browser session state (cookies + localStorage)
   * as a JSON string from Playwright's context.storageState().
   * Returns null if the browser context is unavailable.
   */
  getBrowserSession?(): Promise<string | null>;

  // -- Credentials --

  /** Register sensitive values that should not be sent to LLMs */
  registerCredentials(creds: Record<string, string>): void;

  // -- Pause / Resume (HITL) --

  /** Pause the automation agent (e.g. for human intervention) */
  pause?(): Promise<void>;

  /** Resume a paused automation agent */
  resume?(context?: ResolutionContext): Promise<void>;

  /** Whether the agent is currently paused */
  isPaused?(): boolean;

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
  /** LLM configuration (used for all roles unless imageLlm is also provided) */
  llm: LLMConfig;
  /** Optional separate LLM for vision/screenshot tasks (must have vision: true) */
  imageLlm?: LLMConfig;
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
  /** Pre-loaded browser session state (cookies + localStorage) from a previous run */
  storageState?: Record<string, unknown>;
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

// -- HITL types --

/** Context passed to adapter.resume() when the human provides credentials or codes */
export interface ResolutionContext {
  /** How the blocker was resolved */
  resolutionType: 'manual' | 'code_entry' | 'credentials' | 'skip';
  /** Credential data (2FA code, login creds, etc.) — NEVER log this */
  resolutionData?: Record<string, unknown>;
}

export type BlockerCategory = 'captcha' | 'login' | '2fa' | 'bot_check' | 'rate_limited' | 'verification' | 'unknown';

export interface ObservationBlocker {
  /** Classification of the blocker */
  category: BlockerCategory;
  /** 0-1 confidence that this is actually a blocker */
  confidence: number;
  /** CSS selector that matched, if available */
  selector?: string;
  /** Human-readable description */
  description: string;
}

export interface ObservationResult {
  /** Observed interactive elements on the page */
  elements: ObservedElement[];
  /** Detected blockers (CAPTCHAs, login walls, etc.) */
  blockers: ObservationBlocker[];
  /** Current page URL at time of observation */
  url: string;
  /** Timestamp of the observation */
  timestamp: number;
  /** Screenshot buffer at time of observation, if captured */
  screenshot?: Buffer;
}

/**
 * Adapter interface with required HITL (Human-in-the-Loop) methods.
 *
 * Extends BrowserAutomationAdapter by making observe, pause, resume, and
 * isPaused required rather than optional. All production adapters must
 * implement this interface to support HITL workflows.
 */
export interface HitlCapableAdapter extends BrowserAutomationAdapter {
  /** Inspect the page for interactive elements and blockers. Always defined. */
  observe(instruction: string): Promise<ObservedElement[] | undefined>;

  /** Pause execution for human intervention. Always defined. */
  pause(): Promise<void>;

  /** Resume execution after human intervention. Always defined. */
  resume(context?: ResolutionContext): Promise<void>;

  /** Whether the adapter is currently paused. Always defined. */
  isPaused(): boolean;

  /** Take a screenshot (already required on base, re-declared for clarity). */
  screenshot(): Promise<Buffer>;

  /** Get the current page URL (already required on base, re-declared for clarity). */
  getCurrentUrl(): Promise<string>;

  /**
   * Perform a full observation that includes structured blocker detection.
   * This is the HITL-specific enriched observation that returns both elements
   * and blocker info in a single call.
   */
  observeWithBlockerDetection(instruction: string): Promise<ObservationResult>;
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
