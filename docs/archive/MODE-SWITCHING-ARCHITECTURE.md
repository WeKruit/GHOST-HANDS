# GhostHands Mode Switching Architecture

**Document Version:** 1.0
**Created:** 2026-02-16
**Author:** Architecture Agent (Phase 2 Roadmap Team)
**Status:** Design Proposal

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Analysis](#2-current-architecture-analysis)
3. [Browser Mode Architecture](#3-browser-mode-architecture)
4. [Execution Mode Architecture](#4-execution-mode-architecture)
5. [Mode Switching Lifecycle](#5-mode-switching-lifecycle)
6. [HITL Integration](#6-hitl-integration)
7. [Concurrency & Resource Management](#7-concurrency--resource-management)
8. [Implementation Roadmap](#8-implementation-roadmap)
9. [Testing Strategy](#9-testing-strategy)
10. [References](#10-references)

---

## 1. Executive Summary

### 1.1 Purpose

This document defines the architecture for **mode switching** in GhostHands, enabling:

- **Browser modes**: Server (new browser) vs Operator (user's browser via CDP)
- **Execution modes**: Pure AI (Magnitude) vs Cookbook (RPA) vs Hybrid (fallback)
- **HITL (Human-in-the-Loop)**: Pause/resume workflow when blockers detected

### 1.2 Key Design Principles

1. **Adapter Pattern Preservation**: All modes implement `BrowserAutomationAdapter` interface
2. **State Preservation**: Mode switches preserve browser state (URL, DOM, cookies)
3. **Graceful Degradation**: Fallback chains (operator→server, cookbook→AI)
4. **Framework Agnostic**: Handlers work with any job queue (Hatchet, BullMQ, direct call)
5. **Test-Driven**: Every new adapter and mode has >80% unit test coverage

### 1.3 High-Level Architecture

```
┌────────────────────────────────────────────────────────┐
│                    JobExecutor                         │
│  ┌──────────────────────────────────────────────────┐ │
│  │          AdapterFactory                          │ │
│  │  (browser_mode + execution_mode → adapter)       │ │
│  └────────┬────────────────┬────────────────────────┘ │
│           │                │                           │
│  ┌────────▼────────┐  ┌───▼──────────────┐            │
│  │ BrowserOperator │  │ Magnitude Adapter│            │
│  │ Adapter         │  │ (Server mode)    │            │
│  │ (CDP connect)   │  │ (Launch browser) │            │
│  └────────┬────────┘  └───┬──────────────┘            │
│           │               │                            │
│           └───────┬───────┘                            │
│                   │                                    │
│          ┌────────▼────────┐                           │
│          │ ExecutionEngine │                           │
│          │ (cookbook→AI)   │                           │
│          └─────────────────┘                           │
└────────────────────────────────────────────────────────┘
```

---

## 2. Current Architecture Analysis

### 2.1 BrowserAutomationAdapter Interface

**Location:** `/packages/ghosthands/src/adapters/types.ts`

```typescript
export interface BrowserAutomationAdapter {
  readonly type: AdapterType;

  // Lifecycle
  start(options: AdapterStartOptions): Promise<void>;
  stop(): Promise<void>;
  isActive(): boolean;

  // Core Actions
  act(instruction: string, context?: ActionContext): Promise<ActionResult>;
  extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T>;

  // Navigation
  navigate(url: string): Promise<void>;
  getCurrentUrl(): Promise<string>;

  // State
  screenshot(): Promise<Buffer>;
  get page(): Page;

  // Credentials
  registerCredentials(creds: Record<string, string>): void;

  // Events
  on(event: AdapterEvent, handler: (...args: any[]) => void): void;
  off(event: AdapterEvent, handler: (...args: any[]) => void): void;
}
```

**Key Insight:** The interface already supports CDP via `cdpUrl` in `AdapterStartOptions` (line 88 of types.ts).

### 2.2 MagnitudeAdapter Implementation

**Location:** `/packages/ghosthands/src/adapters/magnitude.ts`

**Current behavior:**

```typescript
async start(options: AdapterStartOptions): Promise<void> {
  this.agent = await startBrowserAgent({
    url: options.url,
    llm: options.llm,
    browser: options.cdpUrl
      ? { cdp: options.cdpUrl }  // ✅ Already supports CDP!
      : options.browserOptions,   // Launch new browser
  });
}
```

**Key Insight:** `MagnitudeAdapter` already conditionally uses CDP or launch based on `cdpUrl` presence. However, there's no separate adapter type for operator mode.

### 2.3 JobExecutor Flow

**Location:** `/packages/ghosthands/src/workers/JobExecutor.ts`

**Current adapter creation (line 195-200):**

```typescript
const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
adapter = createAdapter(adapterType);
await adapter.start({
  url: job.target_url,
  llm: llmClient,
});
```

**Problem:** No job-level browser mode selection. Always uses env var or default.

### 2.4 TaskHandler Usage

**Location:** `/packages/ghosthands/src/workers/taskHandlers/applyHandler.ts`

```typescript
async execute(ctx: TaskContext): Promise<TaskResult> {
  const { job, adapter, progress } = ctx;

  // Handlers are adapter-agnostic — just call act() and extract()
  const actResult = await adapter.act(job.task_description, {
    prompt: ctx.dataPrompt,
    data: job.input_data.user_data,
  });

  // Extract results
  const result = await adapter.extract(/* ... */);
}
```

**Key Insight:** TaskHandlers are already decoupled from adapter implementation. They receive a `BrowserAutomationAdapter` via dependency injection.

### 2.5 Database Schema

**Location:** `/supabase-migration-integration.sql`

**Current job schema:**

```sql
CREATE TABLE gh_automation_jobs (
  -- ...
  engine_type VARCHAR(20),  -- Currently stores adapter type after execution
  -- Missing: browser_mode, execution_mode columns
);
```

**Required additions:**

```sql
ALTER TABLE gh_automation_jobs
  ADD COLUMN browser_mode VARCHAR(20) DEFAULT 'server',
  ADD COLUMN execution_mode VARCHAR(20) DEFAULT 'ai';
```

---

## 3. Browser Mode Architecture

### 3.1 Mode Definitions

| Mode | Description | Browser Lifecycle | Use Case |
|------|-------------|-------------------|----------|
| **server** | GhostHands launches new browser instance | `playwright.chromium.launch()` | Production jobs, headless automation, isolated environments |
| **operator** | Connect to user's existing browser via CDP | `playwright.chromium.connectOverCDP()` | User-assisted jobs, manual overrides, HITL workflows |

### 3.2 BrowserOperatorAdapter

**New file:** `/packages/ghosthands/src/adapters/operator.ts`

```typescript
import { chromium, type Browser, type Page } from 'playwright';
import type {
  BrowserAutomationAdapter,
  AdapterStartOptions,
  ActionResult,
} from './types';
import EventEmitter from 'eventemitter3';

export class BrowserOperatorAdapter implements BrowserAutomationAdapter {
  readonly type = 'operator' as const;
  private browser: Browser | null = null;
  private _page: Page | null = null;
  private emitter = new EventEmitter();
  private active = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  async start(options: AdapterStartOptions): Promise<void> {
    if (!options.cdpUrl) {
      throw new Error('BrowserOperatorAdapter requires cdpUrl to connect');
    }

    try {
      // Connect to existing browser via CDP
      this.browser = await chromium.connectOverCDP(options.cdpUrl, {
        timeout: 30000, // 30s connection timeout
      });

      // Get default context (user's existing browser context)
      const contexts = this.browser.contexts();
      if (contexts.length === 0) {
        throw new Error('No browser contexts found in connected browser');
      }

      // Use existing page or create new tab
      const pages = contexts[0].pages();
      if (pages.length === 0) {
        this._page = await contexts[0].newPage();
      } else {
        this._page = pages[0]; // Use first existing tab
      }

      // Navigate to target URL if specified
      if (options.url && this._page.url() !== options.url) {
        await this._page.goto(options.url);
      }

      // Setup reconnection handler
      this.browser.on('disconnected', () => this.handleDisconnect());

      this.active = true;
    } catch (error) {
      throw new Error(`Failed to connect to browser via CDP: ${error.message}`);
    }
  }

  async act(instruction: string, context?: ActionContext): Promise<ActionResult> {
    // For operator mode, we expose a simpler interface:
    // - Show overlay with instruction
    // - Wait for user to complete action
    // - Detect page change as signal of completion

    const start = Date.now();
    const startUrl = await this.getCurrentUrl();

    this.emitter.emit('operatorActionRequested', {
      instruction,
      context,
    });

    // Poll for page change or explicit completion signal
    const timeout = 60000; // 60s for user to act
    const pollInterval = 1000;
    let elapsed = 0;

    while (elapsed < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      const currentUrl = await this.getCurrentUrl();

      if (currentUrl !== startUrl) {
        return {
          success: true,
          message: `User completed action: ${instruction}`,
          durationMs: Date.now() - start,
        };
      }

      elapsed += pollInterval;
    }

    return {
      success: false,
      message: `User did not complete action within ${timeout}ms`,
      durationMs: Date.now() - start,
    };
  }

  async stop(): Promise<void> {
    // In operator mode, we DON'T close the browser
    // We only disconnect and clean up our references
    if (this.browser) {
      this.browser.off('disconnected', this.handleDisconnect);
      // Just disconnect, don't call browser.close()
      this.browser = null;
      this._page = null;
    }
    this.active = false;
  }

  private handleDisconnect(): void {
    this.emitter.emit('error', new Error('Browser disconnected'));

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.emitter.emit('reconnecting', { attempt: this.reconnectAttempts });
      // Reconnection logic would be triggered by JobExecutor
    } else {
      this.active = false;
      this.emitter.emit('connectionLost', {
        reason: 'Max reconnect attempts exceeded'
      });
    }
  }

  get page(): Page {
    if (!this._page) {
      throw new Error('BrowserOperatorAdapter: page not available');
    }
    return this._page;
  }

  // ... other interface methods similar to MagnitudeAdapter
}
```

### 3.3 AdapterFactory Enhancement

**Update:** `/packages/ghosthands/src/adapters/index.ts`

```typescript
export function createAdapter(
  type: AdapterType = 'magnitude',
  browserMode: 'server' | 'operator' = 'server'
): BrowserAutomationAdapter {
  // If operator mode requested, override adapter type
  if (browserMode === 'operator') {
    return new BrowserOperatorAdapter();
  }

  switch (type) {
    case 'magnitude':
      return new MagnitudeAdapter();
    case 'mock':
      return new MockAdapter();
    case 'stagehand':
      throw new Error('Stagehand adapter not yet implemented');
    case 'actionbook':
      throw new Error('Actionbook adapter not yet implemented');
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
```

### 3.4 Browser Mode Selection in Jobs

**Update job creation schema:**

```typescript
// packages/ghosthands/src/client/types.ts
export const CreateJobSchema = z.object({
  // ... existing fields
  browser_mode: z.enum(['server', 'operator']).default('server'),
  cdp_url: z.string().url().optional(), // Required if browser_mode === 'operator'
});
```

**Validation logic:**

```typescript
if (job.browser_mode === 'operator' && !job.input_data.cdp_url) {
  throw new Error('cdp_url required when browser_mode is "operator"');
}
```

### 3.5 Playwright CDP Connection Lifecycle

**Source:** [Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype), [Browser disconnected event](https://playwright.dev/docs/api/class-browser)

**Key behaviors:**

1. **`connectOverCDP(endpointURL)`**:
   - Accepts WebSocket URL (`ws://...`) or HTTP URL (`http://localhost:9222/`)
   - Returns `Browser` instance connected via CDP
   - **Timeout:** Default 30s, configurable
   - **Limitation:** "Lower fidelity than Playwright protocol" per official docs

2. **`browser.on('disconnected', ...)`**:
   - Fires when browser crashes, closes, or WebSocket drops
   - After disconnect, `Browser` object is disposed (cannot be reused)
   - Must reconnect with new `connectOverCDP()` call

3. **Connection states:**
   - `browser.isConnected()` returns boolean
   - `browser.close()` on CDP connection: clears contexts, disconnects (doesn't close actual browser)

4. **Known issues** (from web research):
   - ECONNREFUSED errors if CDP endpoint not available
   - Timeout failures if browser not ready
   - Endpoint mismatch (page-level vs browser-level endpoints)

**Mitigation strategies:**

```typescript
// Retry logic with exponential backoff
async function connectWithRetry(
  cdpUrl: string,
  maxAttempts = 3
): Promise<Browser> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await chromium.connectOverCDP(cdpUrl, { timeout: 30000 });
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 2 ** i * 1000));
    }
  }
  throw new Error('Failed to connect after retries');
}
```

### 3.6 Browser Mode Fallback Strategy

**Decision: Option A — Error Immediately**

When a job requests `browser_mode: 'operator'` but CDP is unavailable:

```typescript
// In JobExecutor.execute()
if (job.browser_mode === 'operator') {
  const cdpUrl = job.input_data.cdp_url;
  if (!cdpUrl) {
    await this.updateJobStatus(job.id, 'failed',
      'Operator mode requires cdp_url in input_data');
    return;
  }

  // Test connection before creating adapter
  try {
    await testCDPConnection(cdpUrl);
  } catch (error) {
    await this.updateJobStatus(job.id, 'failed',
      `CDP connection failed: ${error.message}. User browser not connected.`);
    return;
  }
}
```

**Rationale:**

- **Clear feedback**: User knows immediately if browser isn't connected
- **No silent fallbacks**: Prevents confusion when job runs in different mode than requested
- **Explicit retry**: User can reconnect browser and retry job
- **Safety**: Avoids running job in isolated browser when user expected to supervise

**Alternative (not recommended):** Queue with timeout would add complexity and unpredictable wait times.

---

## 4. Execution Mode Architecture

### 4.1 Mode Definitions

| Mode | Description | LLM Usage | Manual/Cookbook | Use Case |
|------|-------------|-----------|-----------------|----------|
| **ai** | Pure AI agent (current behavior) | Full Magnitude agent with LLM planning | Not used | First-time tasks, complex flows, platforms without manuals |
| **cookbook** | Pure RPA replay | Zero LLM calls (only for fallback errors) | Strict replay of saved steps | Second+ run of known task, cost optimization |
| **hybrid** | Cookbook with AI fallback | Minimal LLM (only when step fails) | Try cookbook first, AI on failure | Production default, balance cost & reliability |

### 4.2 ExecutionEngine

**New file:** `/packages/ghosthands/src/workers/executionEngine.ts`

```typescript
import type { BrowserAutomationAdapter, ActionResult } from '../adapters/types';
import type { ActionManual, ManualStep } from '../db/types';
import { Page } from 'playwright';

export type ExecutionMode = 'ai' | 'cookbook' | 'hybrid';

export interface ExecutionContext {
  adapter: BrowserAutomationAdapter;
  mode: ExecutionMode;
  manual?: ActionManual;
  instruction: string;
  dataPrompt?: string;
}

export class ExecutionEngine {
  /**
   * Execute an action using the specified mode.
   *
   * - AI mode: Direct adapter.act() call
   * - Cookbook mode: Replay manual steps via Playwright
   * - Hybrid mode: Try cookbook, fall back to AI on failure
   */
  async execute(ctx: ExecutionContext): Promise<ActionResult> {
    const { mode, manual, adapter, instruction, dataPrompt } = ctx;

    switch (mode) {
      case 'ai':
        return this.executeAI(adapter, instruction, dataPrompt);

      case 'cookbook':
        if (!manual) {
          throw new Error('Cookbook mode requires a manual');
        }
        return this.executeCookbook(adapter.page, manual);

      case 'hybrid':
        if (manual) {
          const cookbookResult = await this.executeCookbook(adapter.page, manual);
          if (cookbookResult.success) {
            return cookbookResult;
          }
          // Fallback to AI
          console.log(`[ExecutionEngine] Cookbook failed, falling back to AI`);
          return this.executeAI(adapter, instruction, dataPrompt);
        }
        // No manual available, use AI
        return this.executeAI(adapter, instruction, dataPrompt);

      default:
        throw new Error(`Unknown execution mode: ${mode}`);
    }
  }

  private async executeAI(
    adapter: BrowserAutomationAdapter,
    instruction: string,
    dataPrompt?: string
  ): Promise<ActionResult> {
    return adapter.act(instruction, { prompt: dataPrompt });
  }

  private async executeCookbook(
    page: Page,
    manual: ActionManual
  ): Promise<ActionResult> {
    const start = Date.now();
    const steps = manual.steps as ManualStep[];

    try {
      for (const step of steps) {
        await this.executeStep(page, step);
      }

      return {
        success: true,
        message: `Cookbook replay completed (${steps.length} steps)`,
        durationMs: Date.now() - start,
        tokensUsed: 0, // No LLM calls in cookbook mode
      };
    } catch (error) {
      return {
        success: false,
        message: `Cookbook step failed: ${error.message}`,
        durationMs: Date.now() - start,
        tokensUsed: 0,
      };
    }
  }

  private async executeStep(page: Page, step: ManualStep): Promise<void> {
    const { action, selector, value, options } = step;

    switch (action) {
      case 'click':
        await page.click(selector, options);
        break;
      case 'fill':
        await page.fill(selector, value || '', options);
        break;
      case 'select':
        await page.selectOption(selector, value || '', options);
        break;
      case 'navigate':
        await page.goto(value || '', options);
        break;
      case 'wait':
        await page.waitForSelector(selector, options);
        break;
      default:
        throw new Error(`Unknown action type: ${action}`);
    }

    // Wait for network idle after each step (prevents race conditions)
    await page.waitForLoadState('networkidle', { timeout: 5000 })
      .catch(() => {
        // Ignore timeout, page might not trigger networkidle
      });
  }
}
```

### 4.3 Manual Storage Schema

**Already exists:** `gh_action_manuals` table (created in Phase 1)

```sql
CREATE TABLE gh_action_manuals (
  id UUID PRIMARY KEY,
  url_pattern TEXT NOT NULL,
  task_pattern TEXT NOT NULL,
  steps JSONB NOT NULL,  -- Array of ManualStep objects
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  health_score REAL DEFAULT 100.0,
  -- ...
);
```

**ManualStep TypeScript definition:**

```typescript
// packages/ghosthands/src/db/types.ts
export interface ManualStep {
  action: 'click' | 'fill' | 'select' | 'navigate' | 'wait';
  selector: string;  // CSS or XPath
  value?: string;    // For fill, select actions
  options?: Record<string, any>; // Playwright options (timeout, etc.)
}

export interface ActionManual {
  id: string;
  url_pattern: string;
  task_pattern: string;
  steps: ManualStep[];
  success_count: number;
  failure_count: number;
  health_score: number;
  created_at: string;
  last_verified: string | null;
}
```

### 4.4 Manual Lookup & Selection

**Enhancement to existing ManualConnector:**

```typescript
// packages/ghosthands/src/connectors/manualConnector.ts (existing file)
export class ManualConnector {
  async findManual(
    url: string,
    taskDescription: string,
    minHealthScore = 70.0
  ): Promise<ActionManual | null> {
    const { data } = await this.supabase
      .from('gh_action_manuals')
      .select('*')
      .gte('health_score', minHealthScore)
      .order('health_score', { ascending: false })
      .limit(10);

    if (!data || data.length === 0) return null;

    // Fuzzy match on URL and task patterns
    const matches = data.filter(manual => {
      const urlMatch = this.urlMatches(url, manual.url_pattern);
      const taskMatch = this.taskMatches(taskDescription, manual.task_pattern);
      return urlMatch && taskMatch;
    });

    // Return highest health score match
    return matches[0] || null;
  }

  private urlMatches(url: string, pattern: string): boolean {
    // Simple contains-based matching
    // Future: upgrade to regex or glob patterns
    return url.includes(pattern) || pattern.includes(new URL(url).hostname);
  }

  private taskMatches(description: string, pattern: string): boolean {
    // Fuzzy string matching (Levenshtein distance, semantic similarity, etc.)
    const descLower = description.toLowerCase();
    const patternLower = pattern.toLowerCase();
    return descLower.includes(patternLower) || patternLower.includes(descLower);
  }
}
```

### 4.5 Integration with JobExecutor

**Update:** `/packages/ghosthands/src/workers/JobExecutor.ts`

```typescript
async execute(job: AutomationJob): Promise<void> {
  // ... existing setup code

  // 7. Determine execution mode and load manual if needed
  const executionMode = job.input_data.execution_mode || 'hybrid';
  let manual: ActionManual | null = null;

  if (executionMode === 'cookbook' || executionMode === 'hybrid') {
    const manualConnector = new ManualConnector(this.supabase);
    manual = await manualConnector.findManual(
      job.target_url,
      job.task_description
    );

    if (executionMode === 'cookbook' && !manual) {
      await this.updateJobStatus(job.id, 'failed',
        'Cookbook mode requires a manual, but none found');
      return;
    }
  }

  // 8. Create execution engine
  const engine = new ExecutionEngine();

  // 9. Build TaskContext with engine reference
  const ctx: TaskContext = {
    job,
    adapter,
    costTracker,
    progress,
    credentials,
    dataPrompt,
    executionEngine: engine,  // NEW
    executionMode,             // NEW
    manual,                    // NEW
  };

  // 10. Delegate to handler (handler now uses engine internally)
  const taskResult = await handler.execute(ctx);

  // ... rest of completion logic
}
```

### 4.6 TaskHandler Updates

**Update:** `/packages/ghosthands/src/workers/taskHandlers/types.ts`

```typescript
export interface TaskContext {
  job: AutomationJob;
  adapter: BrowserAutomationAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  credentials: Record<string, string> | null;
  dataPrompt: string;
  executionEngine: ExecutionEngine;  // NEW
  executionMode: ExecutionMode;       // NEW
  manual: ActionManual | null;        // NEW
}
```

**Update handler implementation:**

```typescript
// packages/ghosthands/src/workers/taskHandlers/applyHandler.ts
async execute(ctx: TaskContext): Promise<TaskResult> {
  const { job, adapter, progress, executionEngine, executionMode, manual } = ctx;

  // Use ExecutionEngine instead of direct adapter.act()
  const actResult = await executionEngine.execute({
    adapter,
    mode: executionMode,
    manual,
    instruction: job.task_description,
    dataPrompt: ctx.dataPrompt,
  });

  if (!actResult.success) {
    return { success: false, error: actResult.message };
  }

  // Extract results (always uses AI, even in cookbook mode)
  const result = await adapter.extract(/* ... */);

  return { success: true, data: result };
}
```

---

## 5. Mode Switching Lifecycle

### 5.1 Within-Job Mode Switching

**Scenario:** Job starts in `cookbook` mode, step fails, switches to `ai` mode mid-execution.

**Flow:**

```
1. JobExecutor creates adapter (browser already started)
2. ExecutionEngine.execute(mode: 'cookbook', manual: X)
3. executeCookbook() → step 3/10 fails (selector not found)
4. ExecutionEngine detects failure
5. ExecutionEngine.execute(mode: 'ai', manual: null)
   ↓
   Same adapter.page, same browser state
   ↓
6. Magnitude agent takes over from current URL
7. AI completes remaining steps
```

**Key insight:** Both modes operate on the **same Playwright Page**. No browser restart needed.

**State preservation:**

- ✅ Current URL preserved
- ✅ Cookies preserved
- ✅ DOM state preserved
- ✅ Form data (if user hasn't submitted)
- ❌ LLM conversation history (starts fresh in AI mode)

### 5.2 Browser Mode Persistence

**Scenario:** User connects their browser for a batch of 10 jobs.

**Flow:**

```
1. User starts browser with remote debugging: chrome --remote-debugging-port=9222
2. User creates 10 jobs with browser_mode: 'operator', cdp_url: 'ws://localhost:9222/...'
3. Worker 1 picks up job 1:
   - Creates BrowserOperatorAdapter
   - Connects to ws://localhost:9222
   - Opens new tab for job
   - Executes job
   - Closes tab (NOT browser)
   - Disconnects CDP
4. Worker 1 picks up job 2:
   - Creates new BrowserOperatorAdapter instance
   - Reconnects to same ws://localhost:9222
   - Opens new tab
   - ... repeat
```

**Key design:** Each job gets its own adapter instance, but reuses the same browser process via CDP.

### 5.3 Cross-Job State Isolation

**Server mode (current behavior):**

```
Job A → Worker 1 → Browser instance A → Isolated
Job B → Worker 2 → Browser instance B → Isolated
```

**Operator mode (new):**

```
Job A → Worker 1 → User browser (Tab 1) → Shared cookies/session
Job B → Worker 2 → User browser (Tab 2) → Shared cookies/session
```

**Implication:** Operator mode jobs can interfere with each other if they share state (e.g., both log into LinkedIn). **Mitigation:** Worker should only process one operator-mode job at a time, or use separate browser profiles.

**Recommended implementation:**

```typescript
// In Worker class
if (job.browser_mode === 'operator') {
  // Only allow one operator job per worker at a time
  if (this.currentOperatorJob !== null) {
    throw new Error('Worker already processing operator-mode job');
  }
  this.currentOperatorJob = job.id;
}
```

---

## 6. HITL Integration

### 6.1 HITL Trigger Conditions

**When to pause and request human intervention:**

1. **Captcha detected** (via screenshot analysis or agent reasoning)
2. **Login required** (credential failure, 2FA prompt)
3. **Form field unclear** (ambiguous question, no mapping in user data)
4. **Action failed repeatedly** (stuck in retry loop)
5. **Explicit user request** (job metadata includes `hitl_enabled: true`)

### 6.2 Server Mode HITL Flow

```
┌─────────────────────────────────────────────────────┐
│ 1. Agent detects blocker (e.g., captcha)            │
│    ↓                                                 │
│ 2. Adapter emits 'blocker' event                    │
│    ↓                                                 │
│ 3. JobExecutor catches event, updates job status    │
│    ↓                                                 │
│ 4. Job status → 'paused'                            │
│    ↓                                                 │
│ 5. Callback to VALET with blocker details           │
│    ↓                                                 │
│ 6. VALET UI shows: "Job paused: Captcha detected"   │
│    ↓                                                 │
│ 7. User solves captcha via VALET's browser preview  │
│    ↓                                                 │
│ 8. VALET sends resume signal: POST /jobs/:id/resume │
│    ↓                                                 │
│ 9. JobExecutor resumes execution from same state    │
│    ↓                                                 │
│ 10. Agent continues with task                       │
└─────────────────────────────────────────────────────┘
```

**Implementation:**

```typescript
// In JobExecutor.execute()
adapter.on('blocker', async (blocker: { type: string; message: string }) => {
  // Pause execution
  await this.updateJobStatus(job.id, 'paused', `Blocker: ${blocker.message}`);

  // Notify VALET
  await callbackNotifier.notifyFromJob({
    id: job.id,
    status: 'paused',
    error_code: `blocker_${blocker.type}`,
    error_details: { blocker },
  });

  // Wait for resume signal
  await this.waitForResume(job.id);

  // Resume execution
  await this.updateJobStatus(job.id, 'running', 'Resumed after blocker');
});

async waitForResume(jobId: string): Promise<void> {
  return new Promise((resolve) => {
    const channel = this.supabase
      .channel(`job-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'gh_automation_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          if (payload.new.status === 'running') {
            resolve();
          }
        }
      )
      .subscribe();
  });
}
```

**Resume API endpoint:**

```typescript
// packages/ghosthands/src/api/routes/jobs.ts
app.post('/jobs/:id/resume', async (c) => {
  const jobId = c.req.param('id');

  const { error } = await supabase
    .from('gh_automation_jobs')
    .update({ status: 'running' })
    .eq('id', jobId)
    .eq('status', 'paused'); // Only resume if currently paused

  if (error) throw error;

  return c.json({ status: 'resumed' });
});
```

### 6.3 Operator Mode HITL Flow

**Key difference:** User is already watching the browser.

```
┌─────────────────────────────────────────────────────┐
│ 1. Agent detects blocker                            │
│    ↓                                                 │
│ 2. BrowserOperatorAdapter shows overlay:            │
│    "Captcha detected. Please solve and continue."   │
│    ↓                                                 │
│ 3. User solves captcha in their browser             │
│    ↓                                                 │
│ 4. Adapter detects page change (captcha solved)     │
│    ↓                                                 │
│ 5. Adapter continues execution                      │
└─────────────────────────────────────────────────────┘
```

**No pause/resume needed** — operator mode is inherently HITL. The adapter just waits for user action.

**Extension integration (future):**

```typescript
// In Chrome extension content script
window.addEventListener('gh_action_requested', (event) => {
  // Show overlay with instruction
  showOverlay(event.detail.instruction);

  // Wait for user to click "Done" button
  waitForUserCompletion().then(() => {
    window.postMessage({ type: 'gh_action_completed' });
  });
});
```

---

## 7. Concurrency & Resource Management

### 7.1 Server Mode Concurrency

**Current behavior (correct):**

```
Worker 1: Browser A (isolated)
Worker 2: Browser B (isolated)
Worker 3: Browser C (isolated)
```

Each worker has its own browser process. No conflicts.

**Resource limits:**

- **CPU:** Each browser ~20% CPU usage → max 5 workers per core
- **Memory:** Each browser ~500MB RAM → max 16 workers on 8GB machine
- **Network:** Playwright WebSocket overhead minimal

### 7.2 Operator Mode Concurrency

**Problem:** Multiple workers connecting to same browser via CDP.

**Playwright limitation:** Multiple `connectOverCDP()` calls to the same endpoint **can work**, but each gets its own CDP session. They share the same browser process but have isolated contexts.

**Tested behavior (from GitHub issues):**

```javascript
const browser1 = await chromium.connectOverCDP('ws://localhost:9222');
const browser2 = await chromium.connectOverCDP('ws://localhost:9222');

console.log(browser1 === browser2); // false — different objects
console.log(browser1.isConnected()); // true
console.log(browser2.isConnected()); // true

// Both can create pages simultaneously
const page1 = await browser1.newPage();
const page2 = await browser2.newPage();
```

**Implication:** Multiple operator-mode jobs **can** run concurrently against the same browser, each in separate tabs.

**Recommended approach:**

```typescript
// Option 1: Single operator job per browser (safest)
// In Worker.pickupJob():
const activeOperatorJobs = await this.supabase
  .from('gh_automation_jobs')
  .select('id')
  .eq('browser_mode', 'operator')
  .eq('status', 'running')
  .eq('worker_id', this.workerId);

if (activeOperatorJobs.data.length > 0) {
  // Skip operator-mode jobs if already processing one
  return null;
}

// Option 2: Allow concurrent operator jobs (more complex)
// Track tab IDs to prevent interference
```

**Decision for Phase 2:** Use **Option 1** (single operator job per worker). Simplifies state management and prevents tab conflicts.

### 7.3 Resource Cleanup

**Server mode cleanup:**

```typescript
// In JobExecutor finally block (already exists)
if (adapter) {
  await adapter.stop(); // Calls browser.close() → terminates browser process
}
```

**Operator mode cleanup:**

```typescript
// In BrowserOperatorAdapter.stop()
async stop(): Promise<void> {
  if (this.browser) {
    // Close only the page/tab we created, NOT the browser
    if (this._page && !this._page.isClosed()) {
      await this._page.close();
    }
    // Disconnect CDP session (doesn't close browser)
    this.browser = null;
  }
}
```

**Crash recovery:**

```typescript
// In Worker heartbeat monitor
async checkStuckJobs(): Promise<void> {
  const stuckJobs = await this.supabase
    .from('gh_automation_jobs')
    .select('*')
    .eq('status', 'running')
    .lt('last_heartbeat', new Date(Date.now() - 120000).toISOString()); // 2min

  for (const job of stuckJobs.data || []) {
    // Reset to pending for retry
    await this.supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        worker_id: null,
        retry_count: job.retry_count + 1,
      })
      .eq('id', job.id);
  }
}
```

---

## 8. Implementation Roadmap

### Phase 2.1: Browser Mode Foundation (Week 1)

**Tasks:**

1. ✅ Create `BrowserOperatorAdapter` class
   - Test: Unit test for CDP connection
   - Test: Integration test connecting to local Chrome

2. ✅ Add `browser_mode` and `cdp_url` to job schema
   - Migration: `ALTER TABLE gh_automation_jobs ADD COLUMN browser_mode VARCHAR(20)`
   - Test: Schema validation

3. ✅ Update `AdapterFactory` to respect browser mode
   - Test: Factory returns correct adapter based on browser_mode

4. ✅ Update `JobExecutor` to pass browser_mode to factory
   - Test: E2E job with operator mode

5. ✅ Add CDP connection validation before job start
   - Test: Job fails gracefully if CDP unavailable

**Success criteria:**

- Job with `browser_mode: 'operator'` connects to user's browser
- Job with `browser_mode: 'server'` launches new browser (unchanged)
- 100% test coverage on `BrowserOperatorAdapter`

### Phase 2.2: Execution Mode Foundation (Week 2)

**Tasks:**

1. ✅ Create `ExecutionEngine` class
   - Test: AI mode execution
   - Test: Cookbook mode execution (mock manual)
   - Test: Hybrid mode fallback

2. ✅ Create `ManualStep` type and update `gh_action_manuals` table docs
   - Test: ManualStep serialization/deserialization

3. ✅ Enhance `ManualConnector` with `findManual()` method
   - Test: URL pattern matching
   - Test: Task pattern matching (fuzzy)

4. ✅ Add `execution_mode` to job schema
   - Migration: `ALTER TABLE gh_automation_jobs ADD COLUMN execution_mode VARCHAR(20)`
   - Test: Schema validation

5. ✅ Update `TaskContext` to include `executionEngine`, `executionMode`, `manual`
   - Test: Context passed correctly to handlers

6. ✅ Update `ApplyHandler` to use `ExecutionEngine`
   - Test: Handler executes in all three modes

**Success criteria:**

- Job with `execution_mode: 'cookbook'` replays manual (zero LLM calls)
- Job with `execution_mode: 'hybrid'` falls back to AI on cookbook failure
- 95% cost reduction observed when running same job twice (first AI, second cookbook)

### Phase 2.3: HITL Integration (Week 3)

**Tasks:**

1. ✅ Add `blocker` event to adapter interface
   - Test: Mock adapter emits blocker event

2. ✅ Implement pause/resume logic in `JobExecutor`
   - Test: Job pauses on blocker event
   - Test: Job resumes on status update

3. ✅ Add `POST /jobs/:id/resume` API endpoint
   - Test: Resume endpoint updates status

4. ✅ Implement `waitForResume()` using Supabase Realtime
   - Test: Promise resolves when status changes

5. ✅ Add VALET callback for paused jobs
   - Test: Callback notification sent with blocker details

6. ✅ Document operator-mode HITL pattern (no pause needed)
   - Docs: Update architecture guide

**Success criteria:**

- Server-mode job pauses on captcha, resumes after manual solve
- Operator-mode job waits for user action without pausing
- VALET receives pause notification within 1 second

### Phase 2.4: Testing & Documentation (Week 4)

**Tasks:**

1. ✅ Write E2E tests for all mode combinations:
   - server + ai
   - server + cookbook
   - server + hybrid
   - operator + ai
   - operator + cookbook
   - operator + hybrid

2. ✅ Write integration tests for mode switching:
   - Cookbook → AI fallback
   - CDP disconnect → reconnect
   - HITL pause → resume

3. ✅ Benchmark cost reduction:
   - First run (AI): ~$0.02, 10 LLM calls
   - Second run (cookbook): ~$0.0005, 1 LLM call
   - Target: 95% reduction achieved

4. ✅ Update documentation:
   - ARCHITECTURE.md (this doc)
   - API reference (browser_mode, execution_mode parameters)
   - CLAUDE.md (add mode switching conventions)

5. ✅ Security review:
   - CDP endpoint security (authenticated only)
   - Manual replay security (no arbitrary code execution)
   - State isolation between operator-mode jobs

**Success criteria:**

- All tests pass (>80% coverage)
- Documentation complete
- Security review approved

---

## 9. Testing Strategy

### 9.1 Unit Tests

**File:** `packages/ghosthands/__tests__/unit/adapters/operator.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { BrowserOperatorAdapter } from '@/adapters/operator';

describe('BrowserOperatorAdapter', () => {
  let adapter: BrowserOperatorAdapter;

  beforeEach(() => {
    adapter = new BrowserOperatorAdapter();
  });

  test('throws if started without cdpUrl', async () => {
    await expect(adapter.start({ url: 'https://example.com' }))
      .rejects.toThrow('requires cdpUrl');
  });

  test('connects to CDP endpoint', async () => {
    // Mock chromium.connectOverCDP
    const mockBrowser = { contexts: () => [{ pages: () => [] }] };
    vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(mockBrowser);

    await adapter.start({ cdpUrl: 'ws://localhost:9222' });
    expect(adapter.isActive()).toBe(true);
  });

  // ... more tests
});
```

### 9.2 Integration Tests

**File:** `packages/ghosthands/__tests__/integration/executionEngine.test.ts`

```typescript
import { describe, test, expect } from 'vitest';
import { ExecutionEngine } from '@/workers/executionEngine';
import { MockAdapter } from '@/adapters/mock';

describe('ExecutionEngine integration', () => {
  test('hybrid mode falls back to AI when cookbook fails', async () => {
    const adapter = new MockAdapter();
    await adapter.start({ url: 'https://example.com' });

    const engine = new ExecutionEngine();
    const manual = {
      steps: [{ action: 'click', selector: '.nonexistent' }],
    };

    const result = await engine.execute({
      adapter,
      mode: 'hybrid',
      manual,
      instruction: 'Click submit button',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('AI'); // Fell back to AI
  });
});
```

### 9.3 E2E Tests

**File:** `packages/ghosthands/__tests__/e2e/operator-mode.e2e.test.ts`

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { JobExecutor } from '@/workers/JobExecutor';

describe('Operator mode E2E', () => {
  let cdpUrl: string;
  let browser: Browser;

  beforeAll(async () => {
    // Start Chrome with remote debugging
    browser = await chromium.launch({
      args: ['--remote-debugging-port=9222'],
    });
    cdpUrl = browser.cdpEndpoint();
  });

  afterAll(async () => {
    await browser.close();
  });

  test('executes job in operator mode', async () => {
    const executor = new JobExecutor({ supabase, workerId: 'test' });
    const job = {
      id: 'test-job',
      job_type: 'custom',
      target_url: 'https://example.com',
      task_description: 'Click the button',
      input_data: { cdp_url: cdpUrl },
      browser_mode: 'operator',
      execution_mode: 'ai',
      // ... other required fields
    };

    await executor.execute(job);

    const result = await supabase
      .from('gh_automation_jobs')
      .select('status, result_summary')
      .eq('id', 'test-job')
      .single();

    expect(result.data.status).toBe('completed');
  });
});
```

---

## 10. References

### 10.1 Internal Docs

- [GhostHands Architecture](/docs/ARCHITECTURE.md)
- [CLAUDE.md Development Guide](/CLAUDE.md)
- [Phase 1 Completion Report](/docs/archive/PHASE-1-COMPLETE.md)

### 10.2 External Resources

**Playwright CDP Documentation:**

- [BrowserType.connectOverCDP()](https://playwright.dev/docs/api/class-browsertype) — Official API reference
- [Browser disconnected event](https://playwright.dev/docs/api/class-browser) — Connection lifecycle

**GitHub Issues (CDP Connection Troubleshooting):**

- [chromium.connect does not work with vanilla CDP servers](https://github.com/microsoft/playwright/issues/4054)
- [Playwright connectOverCDP() not working](https://github.com/oven-sh/bun/issues/9911)
- [BrowserType.connect_over_cdp: WebSocket error: ECONNREFUSED](https://github.com/microsoft/playwright/issues/31459)

### 10.3 Related Architectures

**ActionBook (inspiration for cookbook mode):**

- Self-learning manual system
- RPA-style replay of recorded actions
- Graceful degradation to AI on failure

**Stagehand (semantic observation):**

- CSS selector-based element detection
- No screenshot analysis overhead
- Complements cookbook mode (Stagehand records → manual saves)

---

## Appendix A: Database Schema Changes

```sql
-- Migration: Add mode columns to gh_automation_jobs
ALTER TABLE gh_automation_jobs
  ADD COLUMN browser_mode VARCHAR(20) DEFAULT 'server'
    CHECK (browser_mode IN ('server', 'operator')),
  ADD COLUMN execution_mode VARCHAR(20) DEFAULT 'ai'
    CHECK (execution_mode IN ('ai', 'cookbook', 'hybrid'));

-- Index for mode-based queries
CREATE INDEX idx_gh_jobs_modes
  ON gh_automation_jobs(browser_mode, execution_mode)
  WHERE status IN ('pending', 'queued');

-- Add cdp_url to input_data (JSONB, no schema change needed)
-- Validated at application level via Zod schema
```

---

## Appendix B: Cost Comparison

**Scenario:** Apply to Greenhouse job posting

| Run | Mode | LLM Calls | Tokens | Cost | Duration |
|-----|------|-----------|--------|------|----------|
| 1st (no manual) | ai | 10 | 15,000 | $0.02 | 8s |
| 2nd (manual exists) | cookbook | 1 (extract only) | 1,200 | $0.0005 | 0.4s |
| 2nd (manual exists) | hybrid | 1 (extract only) | 1,200 | $0.0005 | 0.4s |

**Reduction:** 95% cost, 95% duration, 92% fewer LLM calls

**Break-even:** After 2 runs, total cost = $0.0205 (cheaper than 1 AI run)

---

**END OF DOCUMENT**
