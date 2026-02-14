# GHOST-HANDS: Migration Plan

**From:** Current embedded structure (`magnitude-source/packages/ghosthands/`)
**To:** Clean separation with npm dependencies (see `docs/15-proposed-directory-structure.md`)

**Dependency approach:** npm packages (not git submodule)
- `magnitude-core` pinned at `^0.3.1` via package.json
- `magnitude-extract` pinned at `^0.0.2` via package.json
- Updates via `bun update magnitude-core` or Renovate/Dependabot

---

## Phase 0: Preparation (Before Any Code Changes)

### 0.1 Snapshot current state
```bash
cd magnitude-source
git log --oneline -5                    # Record current commit
bun run build                           # Verify clean build
bun run test                            # Record test baseline
```

### 0.2 Inventory all magnitude-core imports

Current imports from `magnitude-core` in ghosthands (complete list):

| File | Imports |
|------|---------|
| `workers/JobExecutor.ts` | `startBrowserAgent`, `ManualConnector`, `BrowserAgent`, `ModelUsage` (type), `LLMClient` (type) |
| `workers/jobHandlers/applyJob.ts` | `BrowserAgent` |

Total: **3 value imports** (`startBrowserAgent`, `ManualConnector`, `BrowserAgent`) + **2 type imports** (`ModelUsage`, `LLMClient`).

### 0.3 Inventory all magnitude-extract imports

The `magnitude-extract` package is listed as a dependency in ghosthands `package.json` but no direct imports exist in the ghosthands source. It is an indirect dependency through `magnitude-core`. No adapter needed for this package.

### 0.4 Verify upstream packages are published on npm

```bash
# Confirm magnitude-core and magnitude-extract are available on npm
bun info magnitude-core
bun info magnitude-extract
```

If the packages are not yet published, or the published version does not match what we need, we can use one of these fallbacks:
- **GitHub URL dependency:** `"magnitude-core": "github:magnitudedev/magnitude#packages/magnitude-core"`
- **patch-package:** For applying hotfixes on top of the published version
- **npm aliasing:** `"magnitude-core": "npm:magnitude-core@0.3.1"`

---

## Phase 1: Create the New Repo Structure

**Branch:** `migration/clean-separation`
**Estimated effort:** 20 minutes
**Risk:** Low (additive only, no deletions)

### Step 1.1: Initialize new repo root

```bash
# Start from the GHOST-HANDS parent directory
cd /Users/adam/Desktop/WeKruit/Hiring/GHOST-HANDS

# Create the new repo structure
mkdir ghost-hands-new
cd ghost-hands-new
git init
```

### Step 1.2: Create workspace root files

Create `package.json`:
```jsonc
{
  "name": "ghost-hands",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "turbo run build",
    "dev:api": "bun --watch packages/ghosthands/src/api/server.ts",
    "dev:worker": "bun --watch packages/ghosthands/src/workers/main.ts",
    "test": "vitest run",
    "test:unit": "vitest run packages/ghosthands/__tests__/unit",
    "test:integration": "vitest run packages/ghosthands/__tests__/integration",
    "test:e2e": "vitest run packages/ghosthands/__tests__/e2e",
    "magnitude:update": "bun update magnitude-core magnitude-extract"
  },
  "packageManager": "bun@1.2.8^",
  "devDependencies": {
    "turbo": "^2.4.4",
    "typescript": "5.8.2",
    "vitest": "^4.0.18"
  },
  "dependencies": {
    "patchright": "^1.52.5"
  }
}
```

Create `turbo.json`:
```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

Create `tsconfig.base.json`:
```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

Copy infrastructure files from current repo:
```bash
cp ../magnitude-source/.env.example .
cp ../magnitude-source/.gitignore .
cp ../magnitude-source/Dockerfile .         # Will modify in Phase 3
cp ../magnitude-source/docker-compose.yml .  # Will modify in Phase 3
cp ../magnitude-source/fly.toml .
cp ../magnitude-source/fly.worker.toml .
cp ../magnitude-source/vitest.config.ts .
```

### Step 1.3: Copy ghosthands package

```bash
cp -r ../magnitude-source/packages/ghosthands packages/ghosthands
```

### Step 1.4: Update ghosthands package.json to use npm dependencies

Edit `packages/ghosthands/package.json`:

**Before:**
```jsonc
{
  "dependencies": {
    "magnitude-core": "workspace:*",
    "magnitude-extract": "workspace:*",
    // ...
  }
}
```

**After:**
```jsonc
{
  "dependencies": {
    "magnitude-core": "^0.3.1",
    "magnitude-extract": "^0.0.2",
    "@supabase/supabase-js": "^2.95.3",
    "hono": "^4.0.0",
    "pg": "^8.13.0",
    "zod": "^3.24.4"
  }
}
```

### Step 1.5: Install dependencies and verify

```bash
bun install
bun run build
```

**Checkpoint:** Build should succeed. `magnitude-core` and `magnitude-extract` should resolve from the npm registry. If the published npm version differs from what we had locally, check for API changes.

### Step 1.6: Run tests

```bash
bun run test
```

**Checkpoint:** All existing tests should pass unchanged.

---

## Phase 2: Create the Adapter Layer

**Estimated effort:** 1-2 hours
**Risk:** Medium (refactoring core execution path)

The adapter interface incorporates findings from `docs/adapter-validation.md`:
- `act()` returns `ActionResult` (not void) for Stagehand compatibility
- Optional `observe()` method for Stagehand/Actionbook element discovery
- `navigate()` and `getCurrentUrl()` for explicit page navigation
- `isActive()` for lifecycle state checking
- `type` property to identify the active engine
- `off()` for event unsubscription (standard EventEmitter pattern)

### Step 2.1: Create adapter interface

Create `packages/ghosthands/src/adapters/types.ts`:

```typescript
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

  // ── Lifecycle ──

  /** Initialize the adapter with browser and LLM configuration */
  start(options: AdapterStartOptions): Promise<void>;

  /** Stop the adapter, close browser connections, release resources */
  stop(): Promise<void>;

  /** Whether the adapter is currently active */
  isActive(): boolean;

  // ── Core Actions ──

  /** Execute a natural-language action on the current page */
  act(instruction: string, context?: ActionContext): Promise<ActionResult>;

  /** Extract structured data from the current page using a Zod schema */
  extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T>;

  // ── Observation (optional) ──

  /**
   * Discover interactive elements on the page without executing actions.
   * Native to Stagehand; simulated via screenshot analysis for Magnitude;
   * uses searchActions for Actionbook.
   */
  observe?(instruction: string): Promise<ObservedElement[] | undefined>;

  // ── Navigation ──

  /** Navigate to a URL */
  navigate(url: string): Promise<void>;

  /** Get the current page URL */
  getCurrentUrl(): Promise<string>;

  // ── State ──

  /** Take a screenshot of the current page */
  screenshot(): Promise<Buffer>;

  /** Access the underlying browser page for escape-hatch operations */
  get page(): Page;

  // ── Credentials ──

  /** Register sensitive values that should not be sent to LLMs */
  registerCredentials(creds: Record<string, string>): void;

  // ── Events ──

  /** Subscribe to adapter lifecycle events */
  on(event: AdapterEvent, handler: (...args: any[]) => void): void;
  off(event: AdapterEvent, handler: (...args: any[]) => void): void;
}

// ── Types ──

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
  /** Supabase client for ManualConnector (Magnitude-specific) */
  supabaseClient?: any;
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
  };
  /** LLM roles for multi-model setups (Magnitude) */
  roles?: ('act' | 'extract' | 'query')[];
}

export interface BrowserLaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  args?: string[];
}
```

### Step 2.2: Create Magnitude adapter

Create `packages/ghosthands/src/adapters/magnitude.ts`:

```typescript
import {
  BrowserAgent,
  startBrowserAgent,
  ManualConnector,
} from 'magnitude-core';
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
    const connectors = [];
    if (options.supabaseClient) {
      connectors.push(new ManualConnector({ supabaseClient: options.supabaseClient }));
    }

    this.agent = await startBrowserAgent({
      url: options.url,
      llm: {
        provider: options.llm.provider,
        options: options.llm.options,
      },
      connectors,
      prompt: options.systemPrompt,
      browser: options.cdpUrl
        ? { cdp: options.cdpUrl }
        : { launchOptions: options.browserOptions },
    });

    // Wire Magnitude events to adapter events
    this.agent.events.on('actionStarted', (action) => {
      this.emitter.emit('actionStarted', { variant: action.variant });
    });
    this.agent.events.on('actionDone', (action) => {
      this.emitter.emit('actionDone', { variant: action.variant });
    });
    this.agent.events.on('tokensUsed', (usage) => {
      this.emitter.emit('tokensUsed', usage as TokenUsage);
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
    this._credentials = creds;
    this.requireAgent().registerCredentials(creds);
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
```

### Step 2.3: Create adapter factory

Create `packages/ghosthands/src/adapters/index.ts`:

```typescript
export type {
  BrowserAutomationAdapter,
  AdapterStartOptions,
  ActionContext,
  ActionResult,
  TokenUsage,
  AdapterType,
  AdapterEvent,
  ObservedElement,
  LLMConfig,
  BrowserLaunchOptions,
} from './types';
export { MagnitudeAdapter } from './magnitude';

import type { BrowserAutomationAdapter, AdapterType } from './types';
import { MagnitudeAdapter } from './magnitude';

export function createAdapter(type: AdapterType = 'magnitude'): BrowserAutomationAdapter {
  switch (type) {
    case 'magnitude':
      return new MagnitudeAdapter();
    case 'stagehand':
      throw new Error('Stagehand adapter not yet implemented. Install @browserbasehq/stagehand and create StagehandAdapter.');
    case 'actionbook':
      throw new Error('Actionbook adapter not yet implemented. Install @actionbookdev/js-sdk and create ActionbookAdapter.');
    case 'hybrid':
      throw new Error('Hybrid adapter not yet implemented. Requires a primary adapter + Actionbook.');
    case 'mock':
      throw new Error('Mock adapter not yet implemented. Use MockAdapter from adapters/mock.');
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
```

### Step 2.4: Refactor JobExecutor to use adapter

Changes to `packages/ghosthands/src/workers/JobExecutor.ts`:

**Remove:**
```typescript
import { startBrowserAgent, ManualConnector, BrowserAgent } from 'magnitude-core';
import type { ModelUsage, LLMClient } from 'magnitude-core';
```

**Replace with:**
```typescript
import { createAdapter, type BrowserAutomationAdapter, type TokenUsage, type AdapterType } from '../adapters';
```

**Key changes in `execute()` method:**

Replace:
```typescript
agent = await startBrowserAgent({
  llm: llmClient,
  connectors: [
    new ManualConnector({ supabaseClient: this.supabase }),
  ],
  url: job.target_url,
});
```

With:
```typescript
const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
adapter = createAdapter(adapterType);
await adapter.start({
  url: job.target_url,
  llm: llmClient,
  supabaseClient: this.supabase,
});
```

Replace all `agent.` calls with `adapter.` calls:
- `agent.act(...)` -> `adapter.act(...)` (now returns `ActionResult`)
- `agent.extract(...)` -> `adapter.extract(...)`
- `agent.page.screenshot()` -> `adapter.screenshot()`
- `agent.events.on(...)` -> `adapter.on(...)`
- `agent.registerCredentials(...)` -> `adapter.registerCredentials(...)`
- `agent.stop()` -> `adapter.stop()`

Change variable type:
```typescript
// Before:
let agent: BrowserAgent | null = null;
// After:
let adapter: BrowserAutomationAdapter | null = null;
```

Update `tokensUsed` event handler to use `TokenUsage` type instead of `ModelUsage`.

Update `act()` call to handle `ActionResult`:
```typescript
// Before:
await agent.act(job.task_description, { ... });

// After:
const actResult = await adapter.act(job.task_description, { ... });
if (!actResult.success) {
  throw new Error(`Action failed: ${actResult.message}`);
}
```

### Step 2.5: Refactor applyJob to use adapter

Changes to `packages/ghosthands/src/workers/jobHandlers/applyJob.ts`:

**Remove:**
```typescript
import { BrowserAgent } from 'magnitude-core';
```

**Replace with:**
```typescript
import type { BrowserAutomationAdapter } from '../../adapters';
```

**Change function signature:**
```typescript
// Before:
export async function handleApplyJob(
  agent: BrowserAgent,
  taskDescription: string,
  dataPrompt: string,
  inputData: Record<string, any>,
): Promise<{ result: any; screenshotBuffer: Buffer | null }>

// After:
export async function handleApplyJob(
  adapter: BrowserAutomationAdapter,
  taskDescription: string,
  dataPrompt: string,
  inputData: Record<string, any>,
): Promise<{ result: any; screenshotBuffer: Buffer | null }>
```

Replace body:
- `agent.act(...)` -> `adapter.act(...)` (check `ActionResult.success`)
- `agent.extract(...)` -> `adapter.extract(...)`
- `agent.page.screenshot()` -> `adapter.screenshot()`

### Step 2.6: Update barrel export

Update `packages/ghosthands/src/index.ts`:
```typescript
export * from './config';
export * from './adapters';   // NEW
export * from './security';
export * from './workers';
export * from './db';
export * from './monitoring';
```

Remove the empty `connectors` export.

### Step 2.7: Build and test

```bash
bun run build
bun run test
```

**Checkpoint:** All tests should pass. The adapter is a thin wrapper, so behavior should be identical.

---

## Phase 3: Update Infrastructure

**Estimated effort:** 20 minutes
**Risk:** Low

### Step 3.1: Update Dockerfile

The Dockerfile simplifies significantly with npm dependencies. No submodule paths, no vendor directory copying.

```dockerfile
# ──────────────────────────────────────────────────
# GhostHands Production Dockerfile
# Multi-stage build: deps -> build -> runtime
#
# Targets: API server and Worker (same image, different CMD)
#   API:    docker run ghosthands  (default)
#   Worker: docker run ghosthands bun packages/ghosthands/src/workers/main.ts
# ──────────────────────────────────────────────────

# Stage 1: Install dependencies
FROM oven/bun:1.2-debian AS deps

WORKDIR /app

# Copy workspace root files for dependency resolution
COPY package.json bun.lock turbo.json ./

# Copy package.json for workspace resolution
COPY packages/ghosthands/package.json packages/ghosthands/

# Install dependencies (magnitude-core and magnitude-extract come from npm)
RUN bun install --frozen-lockfile

# Stage 2: Build TypeScript
FROM deps AS build

# Copy source
COPY packages/ packages/
COPY tsconfig.base.json ./

# Build
RUN bun run build

# Stage 3: Production runtime
FROM oven/bun:1.2-debian AS runtime

# Install system dependencies for Patchright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules (includes magnitude-core from npm)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Copy ghosthands package (dist + source for bun direct execution)
COPY --from=build /app/packages/ghosthands/dist ./packages/ghosthands/dist
COPY --from=build /app/packages/ghosthands/src ./packages/ghosthands/src
COPY --from=build /app/packages/ghosthands/package.json ./packages/ghosthands/
COPY --from=build /app/packages/ghosthands/node_modules ./packages/ghosthands/node_modules 2>/dev/null || true

# Install Patchright browser binaries (Chromium only)
RUN cd /app && npx patchright install chromium

# Create non-root user
RUN groupadd -r ghosthands && useradd -r -g ghosthands -m ghosthands
USER ghosthands

# Default: start API server
EXPOSE 3100
CMD ["bun", "packages/ghosthands/src/api/server.ts"]
```

### Step 3.2: Update docker-compose.yml

No changes needed to docker-compose.yml -- volume mounts and commands remain the same since ghosthands path is unchanged.

### Step 3.3: Docker build test

```bash
docker build -t ghosthands-test .
docker run --rm ghosthands-test bun --version  # Smoke test
```

---

## Phase 4: Clean Up and Documentation

**Estimated effort:** 20 minutes
**Risk:** None

### Step 4.1: Remove old repo artifacts

These files from the current `magnitude-source` root are NOT copied to the new repo:
- `.changeset/` (upstream's changeset config)
- `packages/create-magnitude-app/` (upstream's CLI scaffolder)
- `packages/magnitude-mcp/` (upstream's MCP server)
- `packages/magnitude-test/` (upstream's test runner -- not used by us)
- `packages/magnitude-core/` (now an npm dependency, not a local package)
- `packages/magnitude-extract/` (now an npm dependency, not a local package)
- `model-config.ts` (root-level, replaced by ghosthands config)
- `models.config.json` (root-level, replaced by ghosthands config)
- `test-*.ts` (root-level test scripts -- replaced by __tests__)
- `run-test.sh` (replaced by npm scripts)
- `.npmrc` (upstream config)

### Step 4.2: Verify no direct magnitude-core imports outside adapters

```bash
# This should return ZERO results
grep -r "from 'magnitude-core'" packages/ghosthands/src/ \
  --include='*.ts' \
  | grep -v 'adapters/'
```

### Step 4.3: Update README

Add to the project README:
- Setup instructions (`git clone && bun install`)
- Upstream update workflow (`bun update magnitude-core`)
- Adapter layer explanation
- How to switch browser engines via `GH_BROWSER_ENGINE` env var

---

## Phase 5: Mock Adapter (Enables Better Testing)

**Estimated effort:** 1 hour
**Risk:** None (additive)

### Step 5.1: Create MockAdapter

Create `packages/ghosthands/src/adapters/mock.ts`:

```typescript
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

  isActive(): boolean {
    return this.active;
  }

  async stop(): Promise<void> {
    this.active = false;
  }
}
```

### Step 5.2: Register MockAdapter in factory

Update `packages/ghosthands/src/adapters/index.ts` to add:
```typescript
import { MockAdapter, type MockAdapterConfig } from './mock';
export { MockAdapter, type MockAdapterConfig };

// In createAdapter():
case 'mock':
  return new MockAdapter();
```

### Step 5.3: Update test helpers

The existing `createMockAgent()` in `__tests__/e2e/helpers.ts` can be replaced with:
```typescript
import { MockAdapter, type MockAdapterConfig } from '../../src/adapters/mock';

export function createMockAdapter(config: MockAdapterConfig = {}): MockAdapter {
  return new MockAdapter(config);
}
```

---

## Execution Order Summary

| Phase | What | Depends On | Risk | Time |
|-------|------|-----------|------|------|
| 0 | Snapshot + inventory + verify npm availability | Nothing | None | 15 min |
| 1 | New repo + npm deps + copy ghosthands | Phase 0 | Low | 20 min |
| 2 | Adapter layer + refactor | Phase 1 | Medium | 1-2 hr |
| 3 | Update Dockerfile | Phase 2 | Low | 20 min |
| 4 | Cleanup + docs | Phase 3 | None | 20 min |
| 5 | Mock adapter | Phase 2 | None | 1 hr |

**Total estimated time: 3-4 hours**

---

## Upstream Update Workflow

With npm dependencies, upstream updates are standard package management:

```bash
# Check for new versions
bun outdated magnitude-core

# Update to latest compatible version
bun update magnitude-core magnitude-extract

# If a specific version is needed
bun add magnitude-core@0.4.0

# Build and test after update
bun run build
bun run test
```

### Handling Breaking Changes

If a new `magnitude-core` version changes an API we depend on:

1. The adapter layer (`src/adapters/magnitude.ts`) absorbs the change.
2. All other GHOST-HANDS code continues using our stable `BrowserAutomationAdapter` interface.
3. Pin the old version in package.json until the adapter is updated.
4. Write a migration note in `docs/upstream-changes.md`.

### Emergency Hotfixes

If upstream has a bug that blocks us:

```bash
# Option 1: patch-package (preferred for small fixes)
bun add -D patch-package
# Make edits in node_modules/magnitude-core/...
npx patch-package magnitude-core

# Option 2: Pin to a known-good version
bun add magnitude-core@0.3.0  # Roll back

# Option 3: Fork temporarily (last resort)
bun add magnitude-core@github:our-org/magnitude-core-fork#fix-branch
```

---

## Testing Strategy

### After Each Phase:

1. **Phase 1:** `bun install && bun run build && bun run test` -- all existing tests pass
2. **Phase 2:** Same + verify adapter is transparent (no behavior change)
3. **Phase 3:** `docker build` succeeds; container starts API + worker
4. **Phase 4:** Grep confirms no stray magnitude-core imports
5. **Phase 5:** New mock adapter tests pass

### Specific Tests to Add:

- `__tests__/unit/adapters/magnitude.test.ts` -- MagnitudeAdapter unit tests
- `__tests__/unit/adapters/mock.test.ts` -- MockAdapter unit tests
- `__tests__/integration/adapters/factory.test.ts` -- Factory returns correct adapter type

### Regression Checks:

- Job lifecycle E2E test still passes (pending -> running -> completed)
- Cost control still enforces budgets
- Rate limiting still works
- Encryption round-trips still pass
- Domain lockdown blocks disallowed URLs

---

## Rollback Plan

Each phase is a separate git commit. Rollback is simple:

```bash
# If Phase N breaks, revert to Phase N-1
git log --oneline
git revert <phase-N-commit>
```

If the entire migration fails, the old `magnitude-source/` directory is untouched. We can resume using it immediately.

**Critical safety nets:**
- The old repo is never deleted until the new one is proven stable
- Each phase has a build + test checkpoint
- Docker build is tested before any deployment
- npm versions are pinned with `^` semver ranges (no surprise major version bumps)

---

## Git Strategy

```
main
  |
  +-- migration/clean-separation (branch)
        |
        +-- commit: "chore: initialize ghost-hands repo with workspace root"
        +-- commit: "chore: copy ghosthands package, switch to npm deps"
        +-- commit: "feat: add adapter layer for browser automation"
        +-- commit: "refactor: JobExecutor uses BrowserAutomationAdapter"
        +-- commit: "refactor: applyJob uses BrowserAutomationAdapter"
        +-- commit: "chore: update Dockerfile for npm-based deps"
        +-- commit: "chore: remove empty connectors barrel, update exports"
        +-- commit: "feat: add MockAdapter for testing"
        +-- commit: "test: add adapter unit tests"
        |
        +-- PR -> main (squash or merge)
```

---

## Appendix: Files Changed Summary

### New Files (11):
```
package.json                                      # Workspace root
turbo.json                                        # Our Turborepo config
tsconfig.base.json                                # Shared TS config
packages/ghosthands/src/adapters/index.ts         # Adapter factory
packages/ghosthands/src/adapters/types.ts         # BrowserAutomationAdapter interface
packages/ghosthands/src/adapters/magnitude.ts     # Magnitude implementation
packages/ghosthands/src/adapters/mock.ts          # Test mock
packages/ghosthands/src/adapters/stagehand.ts     # Stub (future)
__tests__/unit/adapters/magnitude.test.ts         # Adapter unit tests
__tests__/unit/adapters/mock.test.ts              # Mock adapter tests
__tests__/integration/adapters/factory.test.ts    # Factory integration test
```

### Modified Files (5):
```
packages/ghosthands/package.json                       # workspace:* -> npm versions
packages/ghosthands/src/index.ts                       # Add adapters export, remove connectors
packages/ghosthands/src/workers/JobExecutor.ts         # Use adapter instead of direct imports
packages/ghosthands/src/workers/jobHandlers/applyJob.ts # Use adapter instead of BrowserAgent
Dockerfile                                              # Simplified (no vendor/ paths)
```

### Removed Files (1):
```
packages/ghosthands/src/connectors/index.ts            # Empty barrel, replaced by adapters
```

### Not Migrated (upstream-only, now consumed via npm):
```
packages/magnitude-core/          # Now: bun add magnitude-core
packages/magnitude-extract/       # Now: bun add magnitude-extract
packages/create-magnitude-app/    # Upstream only
packages/magnitude-mcp/           # Upstream only
packages/magnitude-test/          # Upstream only
.changeset/                       # Upstream only
model-config.ts                   # Replaced by ghosthands config
models.config.json                # Replaced by ghosthands config
test-*.ts (root level)            # Replaced by __tests__
run-test.sh                       # Replaced by npm scripts
```

---

## Appendix: Comparison with Previous (Submodule) Plan

| Aspect | Submodule (v1) | npm (v2, current) |
|--------|---------------|-------------------|
| Magnitude location | `vendor/magnitude/` submodule | `node_modules/magnitude-core/` |
| Version pinning | Git commit SHA | Semver in package.json |
| Update command | `git submodule update --remote` | `bun update magnitude-core` |
| Clone command | `git clone --recurse-submodules` | `git clone && bun install` |
| CI/CD setup | Needs submodule init step | Standard `bun install` |
| Source access | Full source in vendor/ | Source in node_modules/ (readable) |
| Hotfix workflow | Edit vendor/, complex merge | patch-package or npm alias |
| New dev onboarding | Must know git submodules | Standard npm workflow |
| Workspace config | Includes vendor/ paths | Only `packages/*` |
| `.gitmodules` needed | Yes | No |
| Dockerfile complexity | Copy vendor/ paths | Standard npm install |
| Files changed | 12 new, 5 modified | 11 new, 5 modified |
| Estimated time | 3-5 hours | 3-4 hours |
