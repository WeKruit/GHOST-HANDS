# 01 - Shared TypeScript Interfaces for Multi-Tier Sandbox System

> Complete interface definitions for the multi-tier browser automation system.
> These interfaces live in `packages/shared/src/types/` and are consumed by
> `apps/worker`, `apps/api`, `apps/web`, and the Chrome extension.

---

## Table of Contents

1. [Enums and Literal Types](#1-enums-and-literal-types)
2. [IBrowserEngine](#2-ibrowserengine)
3. [ISandboxController](#3-isandboxcontroller)
4. [IEngineOrchestrator](#4-iengineorchestrator)
5. [ISandboxProvider](#5-isandboxprovider)
6. [ISessionManager](#6-isessionmanager)
7. [IProxyManager](#7-iproxymanager)
8. [IHumanInterventionHandler](#8-ihumaninterventionhandler)
9. [IFormAnalyzer](#9-iformanalyzer)
10. [IQABank](#10-iqabank)
11. [IUsageMetering](#11-iusagemetering)
12. [IApplicationTracker](#12-iapplicationtracker)
13. [Engine Switching Types](#13-engine-switching-types)
14. [Implementation Mapping](#14-implementation-mapping)
15. [Dependency Graph](#15-dependency-graph)
16. [Serialization Constraints](#16-serialization-constraints)

---

## 1. Enums and Literal Types

These extend the existing types in `packages/shared/src/types/automation.ts`.

```typescript
// packages/shared/src/types/sandbox.ts

// ─── Engine Types ───

/** Browser automation engine identifier */
export type EngineType = "stagehand" | "magnitude" | "none";

/** Stagehand operating mode */
export type StagehandMode = "dom" | "cua" | "hybrid";

/** Sandbox tier determining infrastructure and capabilities */
export type SandboxTier = 1 | 2 | 3 | 4;

/** Sandbox provider identifier */
export type SandboxProviderType =
  | "adspower-ec2"    // Tier 1: Dedicated EC2 + AdsPower
  | "browserbase"     // Tier 2: Managed cloud
  | "local-desktop"   // Tier 2.5: Companion app on user's machine
  | "fly-machine"     // Tier 3: Ephemeral self-hosted
  | "api-direct";     // Tier 4: No browser

// ─── Failure & Switching Types ───

/**
 * Classification of an automation failure.
 * Used by the engine orchestrator to decide whether to retry,
 * switch engines, or escalate to human.
 */
export type FailureSignalType =
  | "selector_not_found"
  | "selector_ambiguous"
  | "action_no_effect"
  | "shadow_dom_blocked"
  | "iframe_unreachable"
  | "canvas_element"
  | "dynamic_rendering"
  | "cdp_disconnect"
  | "timeout"
  | "anti_bot_detected"
  | "captcha_detected"
  | "rate_limited"
  | "budget_exceeded"
  | "unknown";

/**
 * Human intervention reason codes.
 */
export type InterventionReason =
  | "captcha"
  | "login_required"
  | "ambiguous_field"
  | "review_before_submit"
  | "engine_exhausted"
  | "security_challenge"
  | "custom";

/**
 * Application state machine states.
 * Matches the `taskStatus` Zod enum in task.schema.ts but adds
 * internal workflow sub-states visible only to the worker.
 */
export type ApplicationPhase =
  | "provisioning"
  | "navigating"
  | "analyzing"
  | "filling"
  | "uploading"
  | "reviewing"
  | "submitting"
  | "verifying"
  | "waiting_human"
  | "completed"
  | "failed";

/**
 * Profile status for browser profile lifecycle.
 * Mirrors the `profileStatusEnum` in db schema.
 */
export type ProfileStatus = "available" | "in_use" | "error" | "retired";
```

---

## 2. IBrowserEngine

Common interface for both Stagehand (DOM-first) and Magnitude (vision-first).
Abstracts the primitives that every automation engine must provide.

```typescript
// packages/shared/src/types/sandbox.ts

import type { Platform } from "./automation.js";

/**
 * Snapshot of the current page state.
 * JSON-serializable so it can cross Hatchet task boundaries.
 */
export interface PageState {
  /** Current page URL */
  url: string;
  /** Document title */
  title: string;
  /** Horizontal scroll offset (CSS pixels) */
  scrollX: number;
  /** Vertical scroll offset (CSS pixels) */
  scrollY: number;
  /** Base64-encoded PNG screenshot, or undefined if capture failed */
  screenshotBase64?: string;
  /** ISO-8601 timestamp of when this state was captured */
  capturedAt: string;
}

/**
 * Result of an engine action (click, fill, type, etc.).
 */
export interface EngineActionResult {
  success: boolean;
  /** Human-readable description of what happened */
  message: string;
  /** Duration of the action in milliseconds */
  durationMs: number;
  /** LLM tokens consumed, if applicable */
  tokensUsed?: number;
}

/**
 * Result of a structured data extraction.
 */
export interface EngineExtractResult<T = Record<string, unknown>> {
  data: T;
  /** Duration of the extraction in milliseconds */
  durationMs: number;
  /** LLM tokens consumed */
  tokensUsed?: number;
}

/**
 * Observed interactive element on the page.
 */
export interface ObservedElement {
  /** CSS or XPath selector */
  selector: string;
  /** Human-readable description */
  description: string;
  /** Interaction method: click, fill, type, press, scroll, select */
  method: string;
  /** Arguments for the method */
  arguments: unknown[];
}

/**
 * IBrowserEngine — unified interface for browser automation engines.
 *
 * Implementations:
 *   - StagehandEngine (apps/worker/src/engines/stagehand-engine.ts)
 *   - MagnitudeEngine (apps/worker/src/engines/magnitude-engine.ts)
 *   - SeleniumEngine  (apps/worker/src/engines/selenium-engine.ts) [MVP]
 *   - MockEngine      (apps/worker/src/engines/mock-engine.ts)
 *
 * NOT serializable. Lives in worker process memory only.
 */
export interface IBrowserEngine {
  /** Engine identifier */
  readonly engineType: EngineType;

  /**
   * Connect to a running browser via CDP WebSocket URL.
   * The browser must already be started (by ISandboxProvider).
   * @param cdpUrl - WebSocket URL, e.g. ws://127.0.0.1:9222/devtools/browser/abc
   */
  connect(cdpUrl: string): Promise<void>;

  /**
   * Disconnect from the browser without terminating it.
   * The browser process survives; another engine can reconnect.
   */
  disconnect(): Promise<void>;

  /** Whether the engine is currently connected to a browser */
  isConnected(): boolean;

  // ─── Navigation ───

  /** Navigate to a URL and wait for the page to load */
  navigate(url: string): Promise<void>;

  /** Get the current page URL */
  getCurrentUrl(): Promise<string>;

  // ─── Actions ───

  /**
   * Perform a browser action described in natural language.
   * Maps to Stagehand's act() or Magnitude's act().
   * @param instruction - e.g. "Click the Submit button"
   * @param variables - sensitive values substituted at runtime, never sent to LLM
   */
  act(
    instruction: string,
    variables?: Record<string, string>,
  ): Promise<EngineActionResult>;

  /**
   * Extract structured data from the current page.
   * @param instruction - what to extract
   * @param schema - JSON Schema or Zod-compatible schema descriptor
   */
  extract<T = Record<string, unknown>>(
    instruction: string,
    schema: Record<string, unknown>,
  ): Promise<EngineExtractResult<T>>;

  /**
   * Discover interactive elements on the page.
   * @param instruction - what elements to look for
   */
  observe(instruction: string): Promise<ObservedElement[]>;

  // ─── State Capture ───

  /** Capture the current page state (URL, title, scroll, optional screenshot) */
  getPageState(): Promise<PageState>;

  /** Take a full-page or viewport screenshot */
  screenshot(): Promise<Buffer>;
}
```

---

## 3. ISandboxController

Manages the browser lifecycle and guarantees that exactly one engine is connected
at a time via a CDP mutex. One controller is created per workflow run.

```typescript
// packages/shared/src/types/sandbox.ts

import type { BrowserSession } from "./automation.js";

/**
 * Engine configuration thresholds for a specific engine type.
 */
export interface EngineConfig {
  /** Max consecutive failures before triggering a switch */
  maxFailures: number;
  /** Timeout for a single operation (ms) */
  operationTimeoutMs: number;
  /** Minimum confidence score to accept an action result */
  confidenceThreshold: number;
  /** Max retries within the same engine before escalating */
  retryCount: number;
}

/**
 * Configuration for the sandbox controller.
 * JSON-serializable for storage in workflow context.
 */
export interface SandboxControllerConfig {
  /** Sandbox provider type */
  providerType: SandboxProviderType;
  /** Engine-specific configuration */
  engines: {
    stagehand: EngineConfig;
    magnitude: EngineConfig;
  };
  /** LLM model for Stagehand agent */
  stagehandModel: string;
  /** LLM model for Magnitude agent (optional, uses Magnitude default) */
  magnitudeModel?: string;
  /** Enable VNC/LiveView for human intervention */
  enableHumanIntervention: boolean;
}

/**
 * Handle to the currently active engine within the controller.
 * NOT serializable — contains live object references.
 */
export interface EngineHandle {
  /** Which engine is connected */
  type: EngineType;
  /** The live engine instance */
  engine: IBrowserEngine | null;
  /** When this engine was connected */
  connectedAt: string;
  /** Running count of consecutive failures */
  failureCount: number;
}

/**
 * Record of an engine switch event.
 * JSON-serializable for logging and analytics.
 */
export interface EngineSwitchEvent {
  from: EngineType;
  to: EngineType;
  reason: string;
  pageState: PageState;
  durationMs: number;
  success: boolean;
  timestamp: string;
}

/**
 * ISandboxController — manages engine lifecycle, CDP mutex, engine switching.
 *
 * Invariant: at most one engine is connected to the CDP endpoint at any time.
 * The mutex serializes connect/disconnect/switch operations.
 *
 * Implementation: apps/worker/src/services/sandbox-controller.ts
 *
 * NOT serializable. Created once per workflow run and shared via closure
 * across Hatchet tasks (see core-docs/integration/04-engine-switching.md §9).
 */
export interface ISandboxController {
  // ─── Session Lifecycle ───

  /** Start the browser via the sandbox provider, obtain CDP URL */
  startSession(): Promise<BrowserSession>;

  /** Stop the browser and release all resources */
  stopSession(): Promise<void>;

  // ─── Engine Management ───

  /**
   * Connect an engine to the running browser.
   * Acquires the CDP mutex; disconnects any existing engine first.
   */
  connectEngine(engineType: EngineType): Promise<IBrowserEngine>;

  /**
   * Disconnect the current engine without stopping the browser.
   * Releases the CDP mutex.
   */
  disconnectEngine(): Promise<void>;

  /**
   * Switch from the current engine to a different one.
   * Captures page state, disconnects, verifies browser, connects new engine,
   * restores page state.
   */
  switchEngine(
    targetEngine: EngineType,
    reason: string,
  ): Promise<EngineHandle>;

  // ─── State Accessors ───

  getCurrentEngine(): EngineType;
  getEngineHandle(): EngineHandle | null;
  getCdpUrl(): string | null;
  getSession(): BrowserSession | null;
  getSwitchHistory(): EngineSwitchEvent[];

  // ─── Failure Tracking ───

  /** Record a failure against the current engine. Returns new failure count. */
  recordFailure(): number;

  /** Check if the current engine has exceeded its failure threshold. */
  shouldSwitch(): boolean;

  // ─── VNC / Human Intervention ───

  /** Get the VNC/LiveView URL for human takeover, or null if unavailable */
  getInterventionUrl(): string | null;

  // ─── Teardown ───

  /** Stop everything: engine, browser, VNC. Safe to call multiple times. */
  destroy(): Promise<void>;
}
```

---

## 4. IEngineOrchestrator

Decides which engine to use based on platform, failure history, and tier.
Implements the fallback cascade: Stagehand DOM -> Stagehand CUA -> Magnitude -> Human.

```typescript
// packages/shared/src/types/sandbox.ts

/**
 * A single level in the fallback cascade.
 */
export interface FallbackLevel {
  engine: EngineType;
  /** Only applicable for Stagehand */
  mode?: StagehandMode;
  retryCount: number;
  timeoutPerAttemptMs: number;
  /** Skip this level for certain platforms */
  skipForPlatforms?: Platform[];
}

/**
 * Complete fallback cascade configuration.
 */
export interface FallbackCascadeConfig {
  /** Total timeout across all levels (ms) */
  totalTimeoutMs: number;
  levels: FallbackLevel[];
}

/**
 * Decision output from the engine selector.
 */
export interface EngineSelection {
  /** Initial engine to use */
  primary: EngineType;
  /** Stagehand mode if primary is stagehand */
  primaryMode?: StagehandMode;
  /** Full fallback cascade for this platform */
  cascade: FallbackCascadeConfig;
}

/**
 * Decision about whether to switch engines.
 */
export interface SwitchDecision {
  shouldSwitch: boolean;
  reason: string;
  targetEngine: EngineType;
}

/**
 * IEngineOrchestrator — decides which engine to use and handles fallback.
 *
 * Implementation: apps/worker/src/services/engine-orchestrator.ts
 *
 * NOT serializable. Wraps ISandboxController and adds decision logic.
 */
export interface IEngineOrchestrator {
  /**
   * Select the optimal engine and cascade for a given platform.
   * Called once at the start of a workflow.
   */
  selectEngine(platform: Platform): EngineSelection;

  /**
   * Evaluate whether the current engine should be switched.
   * @param error - the error that occurred, or null for timeout/confidence checks
   * @param operationDurationMs - how long the operation took
   * @param confidenceScore - optional confidence score from the engine
   */
  evaluateSwitch(
    error: Error | null,
    operationDurationMs: number,
    confidenceScore?: number,
  ): SwitchDecision;

  /**
   * Execute an operation with the full fallback cascade.
   * Automatically retries, switches engines, and escalates to human.
   * @param operation - function that takes the current engine and returns a result
   * @param context - metadata for logging
   */
  executeWithFallback<T>(
    operation: (engine: IBrowserEngine) => Promise<T>,
    context: { taskId: string; step: string },
  ): Promise<T>;

  /**
   * Request human takeover when all engines are exhausted.
   * Pauses the workflow until human completes or times out.
   */
  requestHumanTakeover(
    reason: InterventionReason,
    screenshotUrl?: string,
  ): Promise<void>;

  /** Get the currently active engine type */
  getCurrentEngine(): EngineType;
}
```

---

## 5. ISandboxProvider

Abstract factory for browser instances. Each tier has a concrete implementation.

```typescript
// packages/shared/src/types/sandbox.ts

import type { ProxyConfig, BrowserSession } from "./automation.js";

/**
 * Options for provisioning a browser sandbox.
 */
export interface ProvisionOptions {
  /** User ID for profile/session association */
  userId: string;
  /** Target platform (affects fingerprint and proxy selection) */
  platform: Platform;
  /** Proxy configuration, or undefined for provider default */
  proxy?: ProxyConfig;
  /** Task ID for tracing */
  taskId: string;
  /** Whether human intervention (VNC/LiveView) is needed */
  enableIntervention: boolean;
}

/**
 * Result of provisioning a sandbox.
 * JSON-serializable for passing between Hatchet tasks.
 */
export interface ProvisionResult {
  /** CDP WebSocket URL for engine connection */
  cdpUrl: string;
  /** Session metadata from the provider */
  session: BrowserSession;
  /** URL for human intervention (VNC or LiveView), if enabled */
  interventionUrl?: string;
  /** Provider-specific context ID for session persistence */
  contextId?: string;
  /** Which tier was provisioned */
  tier: SandboxTier;
  /** Provider type */
  providerType: SandboxProviderType;
}

/**
 * ISandboxProvider — abstract provider for browser instances.
 *
 * Implementations:
 *   - AdsPowerEC2Provider   (Tier 1: apps/worker/src/providers/adspower-ec2.ts)
 *   - BrowserbaseProvider   (Tier 2: apps/worker/src/providers/browserbase.ts)
 *   - FlyMachineProvider    (Tier 3: apps/worker/src/providers/fly-machine.ts)
 *   - ApiDirectProvider     (Tier 4: apps/worker/src/providers/api-direct.ts)
 *
 * Provider instances are singletons in the DI container.
 * ProvisionResult IS serializable for Hatchet task boundaries.
 */
export interface ISandboxProvider {
  /** Provider type identifier */
  readonly providerType: SandboxProviderType;
  /** Sandbox tier */
  readonly tier: SandboxTier;

  /**
   * Provision a browser sandbox for a task.
   * For Tier 1: Acquires an AdsPower profile and starts the browser.
   * For Tier 2: Creates a Browserbase session with a persistent context.
   * For Tier 3: Starts a Fly Machine with Camoufox/Chromium.
   * For Tier 4: Returns a no-op result (no browser needed).
   */
  provision(options: ProvisionOptions): Promise<ProvisionResult>;

  /**
   * Release the sandbox after task completion.
   * Stops the browser, saves session state, returns resources to the pool.
   */
  release(result: ProvisionResult): Promise<void>;

  /**
   * Check whether the provider has capacity for a new session.
   * Used by the tier router to decide where to schedule.
   */
  hasCapacity(): Promise<boolean>;

  /**
   * Health check for the provider.
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}
```

---

## 6. ISessionManager

Handles session state capture, persistence, and restoration across ephemeral tiers.

```typescript
// packages/shared/src/types/sandbox.ts

/**
 * Serializable session state for persistence across ephemeral sandboxes.
 * Stored in Supabase Storage S3 or via Browserbase Contexts API.
 */
export interface SessionSnapshot {
  /** User ID owning this session */
  userId: string;
  /** Platform this session was used for */
  platform: Platform;
  /** Cookies */
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  /** localStorage entries, keyed by origin */
  localStorage: Record<string, Record<string, string>>;
  /** sessionStorage entries, keyed by origin (best-effort, lost on browser close) */
  sessionStorage?: Record<string, Record<string, string>>;
  /** Browserbase context ID, if using Tier 2 */
  browserbaseContextId?: string;
  /** AdsPower profile ID, if using Tier 1 */
  adspowerProfileId?: string;
  /** ISO-8601 timestamp of when this snapshot was taken */
  capturedAt: string;
}

/**
 * ISessionManager — session creation, persistence, cleanup, state capture/restore.
 *
 * Implementations:
 *   - S3SessionManager         (Tier 3: saves storageState to Supabase S3)
 *   - BrowserbaseSessionManager (Tier 2: delegates to Contexts API)
 *   - AdsPowerSessionManager   (Tier 1: profiles persist on disk, minimal work)
 *
 * Provider-level service. Injected into ISandboxProvider implementations.
 */
export interface ISessionManager {
  /**
   * Capture the current browser session state.
   * Called before releasing a sandbox to preserve login state.
   */
  capture(
    engine: IBrowserEngine,
    userId: string,
    platform: Platform,
  ): Promise<SessionSnapshot>;

  /**
   * Restore session state into a newly provisioned sandbox.
   * Called after provisioning to resume from previous state.
   * @returns true if state was successfully restored, false if no prior state
   */
  restore(
    engine: IBrowserEngine,
    userId: string,
    platform: Platform,
  ): Promise<boolean>;

  /**
   * Delete all stored session state for a user/platform combination.
   * Called when a user explicitly logs out or resets.
   */
  clear(userId: string, platform?: Platform): Promise<void>;

  /**
   * Check if there is stored session state for a user/platform.
   */
  hasSnapshot(userId: string, platform: Platform): Promise<boolean>;
}
```

---

## 7. IProxyManager

Extended from the existing `IProxyManager` in `automation.ts` with tier-aware
proxy selection and session stickiness.

```typescript
// packages/shared/src/types/sandbox.ts

import type { ProxyConfig, ProxyOptions } from "./automation.js";

/**
 * Extended proxy options for multi-tier use.
 */
export interface TierProxyOptions extends ProxyOptions {
  /** Which tier is requesting the proxy */
  tier: SandboxTier;
  /** Platform for geo-targeting heuristics */
  platform?: Platform;
  /** Task ID for session stickiness */
  taskId?: string;
}

/**
 * Proxy health status.
 */
export interface ProxyHealthResult {
  healthy: boolean;
  latencyMs: number;
  exitIp?: string;
  country?: string;
}

/**
 * IProxyManager — proxy binding, rotation, and health checking.
 *
 * Extends the existing interface from automation.ts with tier awareness.
 *
 * Implementations:
 *   - IPRoyalProxyManager (primary: residential proxies)
 *   - BrowserbaseProxy    (Tier 2: built-in to Browserbase, no-op manager)
 *   - MockProxyManager    (testing)
 *
 * Service-level singleton in the DI container.
 */
export interface IProxyManager {
  /**
   * Get a proxy configuration for a task.
   * @param options - tier-aware proxy selection options
   */
  getProxy(options?: TierProxyOptions): Promise<ProxyConfig>;

  /**
   * Rotate to a new IP (new sticky session).
   * @param currentProxy - the proxy to rotate from
   */
  rotateIp(currentProxy: ProxyConfig): Promise<ProxyConfig>;

  /**
   * Check proxy health (latency, IP resolution).
   */
  healthCheck(proxy: ProxyConfig): Promise<ProxyHealthResult>;

  /**
   * Bind a proxy to an AdsPower profile (Tier 1 only).
   * No-op for Tiers 2-4.
   */
  bindToProfile(profileId: string, proxy: ProxyConfig): Promise<void>;

  /**
   * Mark a proxy as blocked for a cooldown period.
   * Called when a target site blocks the exit IP.
   */
  markBlocked(proxy: ProxyConfig, cooldownMinutes: number): Promise<void>;
}
```

---

## 8. IHumanInterventionHandler

CAPTCHA detection, VNC/LiveView URL generation, and waiting for human resolution.

```typescript
// packages/shared/src/types/sandbox.ts

/**
 * Details of a detected intervention trigger.
 */
export interface InterventionTrigger {
  reason: InterventionReason;
  /** Human-readable description */
  description: string;
  /** Screenshot URL showing the issue */
  screenshotUrl?: string;
  /** Current page URL */
  pageUrl: string;
  /** ISO-8601 timestamp */
  detectedAt: string;
}

/**
 * An active intervention request that is waiting for human resolution.
 * JSON-serializable for transmission via WebSocket to the frontend.
 */
export interface InterventionRequest {
  /** Unique request ID */
  requestId: string;
  /** Task ID this intervention is for */
  taskId: string;
  /** User ID who must respond */
  userId: string;
  /** What triggered the intervention */
  trigger: InterventionTrigger;
  /** URL for human to access the browser (VNC WebSocket or Browserbase LiveView) */
  interventionUrl: string;
  /** Timeout in ms; after expiry, workflow resumes with a failure */
  timeoutMs: number;
  /** ISO-8601 deadline */
  expiresAt: string;
}

/**
 * Result of a human intervention.
 */
export interface InterventionResult {
  /** Whether the human resolved the issue */
  resolved: boolean;
  /** How the intervention was completed */
  resolvedBy: "user" | "timeout" | "cancelled";
  /** Duration from request to resolution in ms */
  durationMs: number;
  /** Optional notes from the human */
  notes?: string;
}

/**
 * IHumanInterventionHandler — CAPTCHA detection, VNC/LiveView, waitFor human.
 *
 * Implementations:
 *   - VncInterventionHandler        (Tiers 1, 3: noVNC over WebSocket)
 *   - BrowserbaseLiveViewHandler    (Tier 2: embedded iframe)
 *   - ExtensionInterventionHandler  (Free tier: in-page overlay)
 *
 * Injected into IEngineOrchestrator. Uses Redis pub/sub + Hatchet durable
 * wait to pause the workflow until the human completes.
 */
export interface IHumanInterventionHandler {
  /**
   * Detect if the current page requires human intervention.
   * Checks for CAPTCHAs, login walls, security challenges.
   */
  detect(engine: IBrowserEngine): Promise<InterventionTrigger | null>;

  /**
   * Request human intervention and pause the workflow.
   * Publishes the request via Redis pub/sub (WebSocket to frontend),
   * then blocks until the human resolves or the timeout expires.
   *
   * @returns the resolution result
   */
  requestAndWait(
    trigger: InterventionTrigger,
    interventionUrl: string,
    taskId: string,
    userId: string,
    timeoutMs?: number,
  ): Promise<InterventionResult>;

  /**
   * Signal that the human has completed the intervention.
   * Called by the API when it receives the resolution webhook/event.
   */
  resolve(requestId: string, notes?: string): Promise<void>;

  /**
   * Cancel a pending intervention request.
   */
  cancel(requestId: string): Promise<void>;
}
```

---

## 9. IFormAnalyzer

Field detection and platform detection. Shared interface between the Chrome
extension content script (free tier) and the server-side Stagehand/Magnitude
engines (paid tiers).

```typescript
// packages/shared/src/types/sandbox.ts

import type {
  FormField,
  FormAnalysis,
  FieldMapping,
  UserData,
  Platform,
  PlatformDetection,
  GeneratedAnswer,
  AnswerContext,
} from "./automation.js";

/**
 * IFormAnalyzer — LLM-powered form analysis and field mapping.
 *
 * This interface is shared between:
 *   - Server-side: StagehandFormAnalyzer, MagnitudeFormAnalyzer
 *   - Extension:   ContentScriptFormAnalyzer (runs in the browser, uses DOM APIs)
 *
 * The extension implementation uses DOM queries instead of LLM calls for
 * basic field detection, falling back to the API for complex analysis.
 *
 * Implementations:
 *   - LLMFormAnalyzer        (server: uses Stagehand extract or LLMRouter)
 *   - DOMFormAnalyzer        (extension: DOM queries, heuristic-based)
 *   - MockFormAnalyzer       (testing)
 */
export interface IFormAnalyzer {
  /**
   * Detect the ATS platform from a URL or page content.
   */
  detectPlatform(url: string, pageContent?: string): Promise<PlatformDetection>;

  /**
   * Analyze a form page: discover all fields, their types, and structure.
   *
   * Server-side: uses Stagehand extract() or Magnitude extract() with a Zod schema.
   * Extension: uses DOM querySelectorAll('input, select, textarea') + heuristics.
   *
   * @param source - HTML string (extension), or undefined (server uses current page)
   */
  analyzeForm(source?: string): Promise<FormAnalysis>;

  /**
   * Map discovered form fields to user data values.
   * Uses LLM for fuzzy matching on the server, heuristic matching in the extension.
   */
  mapFields(
    analysis: FormAnalysis,
    userData: UserData,
    qaAnswers?: Record<string, string>,
  ): Promise<FieldMapping[]>;

  /**
   * Generate an answer for a screening question.
   * Server-side only (requires LLM). The extension defers to the API.
   */
  generateAnswer(
    question: string,
    context: AnswerContext,
  ): Promise<GeneratedAnswer>;

  /**
   * Score the confidence of a field mapping.
   * @returns confidence score 0.0-1.0
   */
  scoreConfidence(mapping: FieldMapping): Promise<number>;
}
```

---

## 10. IQABank

Q&A storage and retrieval, used by both the Chrome extension and the server.

```typescript
// packages/shared/src/types/sandbox.ts

/**
 * A single Q&A entry.
 * JSON-serializable for storage in the database and sync to the extension.
 */
export interface QAEntry {
  id: string;
  /** The question (or keyword pattern) */
  question: string;
  /** The stored answer */
  answer: string;
  /** Tags for categorization (e.g., "salary", "authorization", "eeo") */
  tags: string[];
  /** Number of times this answer has been used */
  useCount: number;
  /** When this entry was last used */
  lastUsedAt?: string;
  /** When this entry was created */
  createdAt: string;
  /** When this entry was last updated */
  updatedAt: string;
}

/**
 * IQABank — Q&A storage and retrieval for screening questions.
 *
 * Implementations:
 *   - DatabaseQABank      (server: queries Supabase via Drizzle)
 *   - ExtensionQABank     (extension: chrome.storage.local, synced from API)
 *   - InMemoryQABank      (testing)
 *
 * The extension periodically syncs from the API via:
 *   GET /api/v1/qa-bank -> chrome.storage.local.set()
 *
 * The server uses this for Stagehand agent's lookupQABank custom tool.
 */
export interface IQABank {
  /**
   * Look up an answer by question text.
   * Uses fuzzy matching (server: embedding similarity or keyword overlap;
   * extension: simple string includes).
   *
   * @returns the best matching entry, or null if no match above threshold
   */
  lookup(question: string): Promise<QAEntry | null>;

  /**
   * Get all Q&A entries for a user.
   */
  getAll(userId: string): Promise<QAEntry[]>;

  /**
   * Add or update a Q&A entry.
   */
  upsert(userId: string, entry: Omit<QAEntry, "id" | "useCount" | "createdAt" | "updatedAt">): Promise<QAEntry>;

  /**
   * Delete a Q&A entry.
   */
  delete(userId: string, entryId: string): Promise<void>;

  /**
   * Record that an answer was used (increments useCount, updates lastUsedAt).
   */
  recordUsage(entryId: string): Promise<void>;
}
```

---

## 11. IUsageMetering

Rate limiting, tier-based feature gating, and usage tracking.

```typescript
// packages/shared/src/types/sandbox.ts

import type { SubscriptionTier } from "../schemas/user.schema.js";

/**
 * Plan limits for a subscription tier.
 */
export interface PlanLimits {
  /** Max applications per calendar month */
  maxApplicationsPerMonth: number;
  /** Max concurrent running tasks */
  maxConcurrent: number;
  /** Allowed sandbox tiers */
  allowedTiers: SandboxTier[];
  /** Max stored resumes */
  maxResumes: number;
  /** Max Q&A bank entries */
  maxQAEntries: number;
  /** Whether autopilot mode is available */
  autopilotEnabled: boolean;
  /** Whether API access is available */
  apiAccessEnabled: boolean;
}

/**
 * Current usage snapshot for a user.
 * JSON-serializable for API response.
 */
export interface UsageSnapshot {
  userId: string;
  /** Current billing period (ISO-8601 date range) */
  periodStart: string;
  periodEnd: string;
  /** Applications used this period */
  applicationsUsed: number;
  /** Applications remaining before overage */
  applicationsRemaining: number;
  /** Currently running tasks */
  activeTasks: number;
  /** Plan limits for reference */
  limits: PlanLimits;
}

/**
 * Result of a rate-limit check.
 */
export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  /** Retry-After value in seconds, if rate limited */
  retryAfterSeconds?: number;
}

/**
 * IUsageMetering — rate limiting, feature gating, usage tracking.
 *
 * Implementation: apps/api/src/services/usage-metering.ts
 *
 * Uses Redis for real-time counters (concurrent tasks, rate limits)
 * and the database for period-based usage (monthly applications).
 */
export interface IUsageMetering {
  /**
   * Get the plan limits for a subscription tier.
   */
  getLimits(tier: SubscriptionTier): PlanLimits;

  /**
   * Check if a user can start a new application.
   * Checks: monthly quota, concurrent limit, tier access.
   */
  checkRateLimit(userId: string): Promise<RateLimitResult>;

  /**
   * Record that a user started an application.
   * Increments the period counter and active task count.
   * Call this AFTER checkRateLimit returns allowed=true.
   */
  recordApplicationStart(userId: string, taskId: string): Promise<void>;

  /**
   * Record that an application completed (success or failure).
   * Decrements the active task counter.
   */
  recordApplicationEnd(userId: string, taskId: string): Promise<void>;

  /**
   * Get the current usage snapshot for a user.
   */
  getUsage(userId: string): Promise<UsageSnapshot>;

  /**
   * Check if a feature is available for a user's plan.
   * @param feature - feature key, e.g. "autopilot", "api_access", "tier_1"
   */
  hasFeature(userId: string, feature: string): Promise<boolean>;
}
```

---

## 12. IApplicationTracker

Tracks application status through the state machine and emits progress events.

```typescript
// packages/shared/src/types/sandbox.ts

/**
 * A state transition in the application lifecycle.
 * JSON-serializable for WebSocket broadcast and database storage.
 */
export interface StateTransition {
  taskId: string;
  from: ApplicationPhase;
  to: ApplicationPhase;
  /** What triggered this transition */
  trigger: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Progress update event sent to the frontend via WebSocket.
 * JSON-serializable.
 */
export interface ProgressUpdate {
  taskId: string;
  userId: string;
  /** Current phase in the application lifecycle */
  phase: ApplicationPhase;
  /** 0-100 percentage */
  progressPct: number;
  /** Human-readable step description */
  stepDescription: string;
  /** Current step name for display */
  currentStep: string;
  /** Screenshot URL, if one was taken at this step */
  screenshotUrl?: string;
  /** ISO-8601 timestamp */
  timestamp: string;
}

/**
 * IApplicationTracker — tracks application status and emits progress events.
 *
 * Implementation: apps/worker/src/services/application-tracker.ts
 *
 * Uses Redis pub/sub to broadcast ProgressUpdate events to the API,
 * which forwards them to frontend WebSocket connections.
 * State transitions are persisted to the task_events table.
 */
export interface IApplicationTracker {
  /**
   * Transition the application to a new phase.
   * Validates the transition is legal, persists to DB, broadcasts via Redis.
   */
  transition(
    taskId: string,
    userId: string,
    toPhase: ApplicationPhase,
    trigger: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Emit a progress update to the frontend.
   * Does NOT change state; used for intermediate progress within a phase.
   */
  emitProgress(update: ProgressUpdate): Promise<void>;

  /**
   * Get the current phase for a task.
   */
  getCurrentPhase(taskId: string): Promise<ApplicationPhase | null>;

  /**
   * Get the full state transition history for a task.
   */
  getHistory(taskId: string): Promise<StateTransition[]>;
}
```

---

## 13. Engine Switching Types

Detailed types for the failure detection and engine switching protocol.

```typescript
// packages/shared/src/types/sandbox.ts

/**
 * A structured failure signal from an engine operation.
 * Produced by the failure classifier and consumed by IEngineOrchestrator.
 */
export interface FailureSignal {
  /** Classification of the failure */
  type: FailureSignalType;
  /** The original error, if available */
  error?: Error;
  /** Which engine produced this failure */
  engine: EngineType;
  /** How long the operation ran before failing (ms) */
  durationMs: number;
  /** Whether this failure type is typically recoverable by the same engine */
  retriableWithSameEngine: boolean;
  /** Whether this failure suggests switching to a vision-based engine */
  suggestsVisionEngine: boolean;
  /** ISO-8601 timestamp */
  timestamp: string;
}

/**
 * Classify a raw error into a structured FailureSignal.
 * Pure function, no side effects.
 */
export type FailureClassifier = (
  error: Error,
  engine: EngineType,
  durationMs: number,
) => FailureSignal;

/**
 * Result of an operation executed through the fallback cascade.
 * Includes metadata about which engine succeeded and how many attempts were made.
 */
export interface CascadeResult<T> {
  /** The operation result */
  data: T;
  /** Which engine produced the successful result */
  engine: EngineType;
  /** Total attempts across all engines */
  totalAttempts: number;
  /** Which cascade level succeeded (0-indexed) */
  levelIndex: number;
  /** Total time across all attempts (ms) */
  totalDurationMs: number;
}
```

---

## 14. Implementation Mapping

Which concrete class implements each interface, organized by tier.

### Per-Tier Implementation Matrix

| Interface | Tier 1 (EC2+AdsPower) | Tier 2 (Browserbase) | Tier 2.5 (Local Desktop) | Tier 3 (Fly Machine) | Tier 4 (API-Direct) | Extension (Free) |
|---|---|---|---|---|---|---|
| `IBrowserEngine` | `SeleniumEngine` | `StagehandEngine` | `StagehandEngine` | `PlaywrightEngine` | `ApiDirectEngine` (no-op for most methods) | N/A (content script) |
| `ISandboxController` | `SandboxController` | `SandboxController` | `SandboxController` | `SandboxController` | `ApiDirectController` (thin wrapper) | N/A |
| `IEngineOrchestrator` | `EngineOrchestrator` | `EngineOrchestrator` | `EngineOrchestrator` | `EngineOrchestrator` | N/A (no engine switching) | N/A |
| `ISandboxProvider` | `AdsPowerEC2Provider` | `BrowserbaseProvider` | `LocalDesktopProvider` | `FlyMachineProvider` | `ApiDirectProvider` | N/A |
| `ISessionManager` | `AdsPowerSessionManager` | `BrowserbaseSessionManager` | `LocalChromeSessionManager` | `S3SessionManager` | N/A | N/A |
| `IProxyManager` | `IPRoyalProxyManager` | `BrowserbaseProxy` (no-op) | N/A (user's own IP) | `IPRoyalProxyManager` | N/A | N/A |
| `IHumanInterventionHandler` | `VncInterventionHandler` | `LiveViewInterventionHandler` | `ExtensionOverlayHandler` | `VncInterventionHandler` | N/A | `ExtensionInterventionHandler` |
| `IFormAnalyzer` | `LLMFormAnalyzer` | `LLMFormAnalyzer` | `LLMFormAnalyzer` | `LLMFormAnalyzer` | `ApiFormAnalyzer` | `DOMFormAnalyzer` |
| `IQABank` | `DatabaseQABank` | `DatabaseQABank` | `DatabaseQABank` | `DatabaseQABank` | `DatabaseQABank` | `ExtensionQABank` |
| `IUsageMetering` | `UsageMeteringService` | `UsageMeteringService` | `UsageMeteringService` | `UsageMeteringService` | `UsageMeteringService` | `ExtensionUsageService` |
| `IApplicationTracker` | `ApplicationTracker` | `ApplicationTracker` | `ApplicationTracker` | `ApplicationTracker` | `ApplicationTracker` | N/A |

### File Locations

| Implementation | File Path |
|---|---|
| `StagehandEngine` | `apps/worker/src/engines/stagehand-engine.ts` |
| `MagnitudeEngine` | `apps/worker/src/engines/magnitude-engine.ts` |
| `SeleniumEngine` | `apps/worker/src/engines/selenium-engine.ts` |
| `PlaywrightEngine` | `apps/worker/src/engines/playwright-engine.ts` |
| `MockEngine` | `apps/worker/src/engines/mock-engine.ts` |
| `SandboxController` | `apps/worker/src/services/sandbox-controller.ts` |
| `EngineOrchestrator` | `apps/worker/src/services/engine-orchestrator.ts` |
| `AdsPowerEC2Provider` | `apps/worker/src/providers/adspower-ec2.ts` |
| `BrowserbaseProvider` | `apps/worker/src/providers/browserbase.ts` |
| `LocalDesktopProvider` | `apps/agent/src/providers/local-desktop.ts` |
| `FlyMachineProvider` | `apps/worker/src/providers/fly-machine.ts` |
| `ApiDirectProvider` | `apps/worker/src/providers/api-direct.ts` |
| `S3SessionManager` | `apps/worker/src/services/s3-session-manager.ts` |
| `BrowserbaseSessionManager` | `apps/worker/src/services/browserbase-session-manager.ts` |
| `AdsPowerSessionManager` | `apps/worker/src/services/adspower-session-manager.ts` |
| `IPRoyalProxyManager` | `apps/worker/src/services/iproyal-proxy-manager.ts` |
| `VncInterventionHandler` | `apps/worker/src/services/vnc-intervention-handler.ts` |
| `LiveViewInterventionHandler` | `apps/worker/src/services/liveview-intervention-handler.ts` |
| `LLMFormAnalyzer` | `apps/worker/src/services/llm-form-analyzer.ts` |
| `DOMFormAnalyzer` | `apps/extension/src/services/dom-form-analyzer.ts` |
| `DatabaseQABank` | `apps/api/src/services/qa-bank.ts` |
| `ExtensionQABank` | `apps/extension/src/services/extension-qa-bank.ts` |
| `UsageMeteringService` | `apps/api/src/services/usage-metering.ts` |
| `ApplicationTracker` | `apps/worker/src/services/application-tracker.ts` |

---

## 15. Dependency Graph

```
IUsageMetering (API layer, checked before task creation)
    |
    v
ISandboxProvider -----> ISessionManager (capture/restore state)
    |                   IProxyManager (proxy binding)
    |
    v
ISandboxController ---> IBrowserEngine (one at a time, via CDP mutex)
    |
    v
IEngineOrchestrator --> IBrowserEngine (fallback cascade)
    |                   IHumanInterventionHandler (escalation)
    |
    v
IFormAnalyzer ---------> IQABank (answer lookup)
    |
    v
IApplicationTracker (progress events throughout)
```

### Initialization Order in Hatchet Workflow

1. `IUsageMetering.checkRateLimit()` -- API layer, before dispatching to worker
2. `ISandboxProvider.provision()` -- get CDP URL and session
3. `ISandboxController` created with `ProvisionResult`
4. `ISandboxController.startSession()` -- browser running
5. `ISandboxController.connectEngine()` -- engine connected
6. `IEngineOrchestrator` wraps the controller for fallback cascade
7. `IFormAnalyzer` uses the active engine for page analysis
8. `IApplicationTracker` emits events throughout
9. `IHumanInterventionHandler` pauses workflow if needed
10. `ISandboxController.destroy()` -- cleanup
11. `ISandboxProvider.release()` -- return resources
12. `IUsageMetering.recordApplicationEnd()` -- decrement counters

### DI Container Registration (awilix)

```typescript
// apps/worker/src/container.ts (conceptual)

export interface WorkerCradle {
  // Providers (singletons)
  adsPowerProvider: ISandboxProvider;
  browserbaseProvider: ISandboxProvider;
  flyMachineProvider: ISandboxProvider;
  apiDirectProvider: ISandboxProvider;

  // Services (singletons)
  proxyManager: IProxyManager;
  s3SessionManager: ISessionManager;
  browserbaseSessionManager: ISessionManager;
  interventionHandler: IHumanInterventionHandler;
  formAnalyzer: IFormAnalyzer;
  qaBank: IQABank;
  applicationTracker: IApplicationTracker;

  // Per-workflow (scoped, created per task)
  // sandboxController: ISandboxController;
  // engineOrchestrator: IEngineOrchestrator;
}
```

---

## 16. Serialization Constraints

Hatchet tasks communicate via JSON return values through `ctx.parentOutput()`.
Only JSON-serializable data can cross task boundaries.

### What CAN Cross Hatchet Task Boundaries

| Type | Serializable | Notes |
|---|---|---|
| `ProvisionResult` | Yes | CDP URL, session metadata, intervention URL |
| `PageState` | Yes | URL, title, scroll, optional base64 screenshot |
| `SessionSnapshot` | Yes | Cookies, localStorage, context IDs |
| `EngineSelection` | Yes | Engine type, mode, cascade config |
| `EngineSwitchEvent` | Yes | From/to/reason/duration/success |
| `FailureSignal` | Partially | Error object is not serializable; serialize `.message` and `.stack` |
| `ProgressUpdate` | Yes | Phase, percentage, step description |
| `StateTransition` | Yes | From/to phase, trigger, metadata |
| `InterventionRequest` | Yes | Request ID, trigger, intervention URL |
| `InterventionResult` | Yes | Resolved, resolved by, duration |
| `QAEntry` | Yes | All fields are primitive types |
| `UsageSnapshot` | Yes | All fields are primitive types |
| `PlanLimits` | Yes | All fields are primitive types |
| `CascadeResult<T>` | Yes (if T is) | Data, engine, attempts, duration |

### What CANNOT Cross Hatchet Task Boundaries

| Type | Why | Workaround |
|---|---|---|
| `IBrowserEngine` | Live WebSocket connection | Pass `cdpUrl` string; reconnect in next task |
| `ISandboxController` | Contains Mutex, live engine refs | Share via closure (same Node.js process) |
| `IEngineOrchestrator` | Wraps ISandboxController | Share via closure |
| `Stagehand` instance | Playwright internal state | Reconnect via `createStagehandAgent({ cdpUrl })` |
| `BrowserAgent` instance | Playwright internal state | Reconnect via `startBrowserAgent({ browser: { cdp } })` |
| `Error` objects | `Error` is not JSON-serializable | Serialize as `{ message, stack, name }` |
| `Buffer` (screenshots) | Binary data | Base64-encode or upload to S3, pass URL |

### Cross-Task Pattern

```typescript
// Task 1: Provision and analyze
const provisionTask = workflow.task({
  name: "provision",
  fn: async (input) => {
    const result = await provider.provision({ ... });
    // Return ONLY serializable data
    return {
      cdpUrl: result.cdpUrl,
      tier: result.tier,
      interventionUrl: result.interventionUrl,
    };
  },
});

// Task 2: Uses cdpUrl to reconnect
const fillTask = workflow.task({
  name: "fill",
  parents: [provisionTask],
  fn: async (input, ctx) => {
    const prev = await ctx.parentOutput(provisionTask);
    // Reconnect using the serialized cdpUrl
    const engine = new StagehandEngine();
    await engine.connect(prev.cdpUrl);
    // ... use engine ...
  },
});
```

### Closure-Based Sharing (Preferred for Same-Process Tasks)

When all tasks run in the same Hatchet worker process, share live objects via closure:

```typescript
let controller: ISandboxController | null = null;

const startTask = workflow.task({
  name: "start",
  fn: async () => {
    controller = new SandboxController(config);
    await controller.startSession();
    await controller.connectEngine("stagehand");
    return { ready: true };
  },
});

const fillTask = workflow.task({
  name: "fill",
  parents: [startTask],
  fn: async () => {
    // Access live controller via closure -- no serialization needed
    const engine = controller!.getEngineHandle()!.engine!;
    await engine.act("Fill the form");
    return { filled: true };
  },
});
```

---

*Last updated: 2026-02-13*
*Depends on: [automation.ts](../../packages/shared/src/types/automation.ts), [task.schema.ts](../../packages/shared/src/schemas/task.schema.ts), [user.schema.ts](../../packages/shared/src/schemas/user.schema.ts)*
*Consumed by: [04-engine-switching.md](../integration/04-engine-switching.md), [04-multi-tier-sandbox-architecture.md](../sandbox/04-multi-tier-sandbox-architecture.md)*
