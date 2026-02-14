# GHOST-HANDS: Proposed Directory Structure & Architecture

## Status: APPROVED (npm dependency approach selected)

---

## 1. Executive Summary

The current codebase embeds `ghosthands` as a package inside the Magnitude monorepo (`packages/ghosthands`). This works but creates problems:

- **Merge conflicts**: Our package.json/turbo.json changes collide with upstream.
- **Unclear ownership boundary**: Which code is ours vs upstream?
- **Coupled build pipeline**: We inherit Magnitude's changesets, CI, and Turborepo config.
- **Stagehand integration lives in magnitude-core**: The `StagehandConnector` is upstream code we may want to extend.

This document proposes a clean separation that keeps upstream Magnitude as an isolated dependency while giving GHOST-HANDS its own identity.

---

## 2. Decision: npm Dependencies

### Why not other approaches?

| Approach | Pros | Cons |
|----------|------|------|
| **npm package** (selected) | Clean separation; standard tooling; simple CI/CD; easy onboarding | Must wait for upstream releases; hotfixes via patch-package |
| **Copy-paste vendor** | Full control | Manual sync nightmare; no git history |
| **Fork + remote** | Full git history | Complex merge workflow; divergence risk |
| **Git submodule** | Pinned version; source access | Poor DX; CI complexity; workspace fragility; onboarding friction |

**Recommendation: npm dependencies** for `magnitude-core` and `magnitude-extract`.

Rationale:
- Standard `bun install` workflow -- no submodule knowledge required.
- `bun update magnitude-core` for upstream updates, or Renovate/Dependabot for automation.
- Our code never touches upstream files -- zero merge conflicts.
- Semver pinning (`^0.3.1`) in package.json gives controlled updates.
- Source readable in `node_modules/` for debugging; `patch-package` for hotfixes.
- CI/CD is standard -- no submodule init/update steps needed.
- New developer onboarding is `git clone && bun install` -- nothing else.

---

## 3. Proposed Directory Structure

```
ghost-hands/                          # NEW repo root (replaces magnitude-source)
|
+-- .git/
+-- package.json                      # Workspace root (bun workspaces)
+-- turbo.json                        # Turborepo config (our own, not upstream's)
+-- tsconfig.base.json                # Shared compiler options
+-- bun.lock
+-- .env.example
+-- .gitignore
+-- Dockerfile
+-- docker-compose.yml
+-- fly.toml
+-- fly.worker.toml
+-- vitest.config.ts
|
+-- node_modules/
|   +-- magnitude-core/               # npm dependency: BrowserAgent, connectors, AI, etc.
|   +-- magnitude-extract/            # npm dependency: DOM extraction
|   +-- ...                           # Other npm dependencies
|
+-- packages/
|   +-- ghosthands/                   # OUR code -- the GHOST-HANDS application
|       +-- package.json
|       +-- tsconfig.json
|       +-- src/
|           +-- index.ts              # Public barrel export
|           |
|           +-- api/                  # REST API layer (Hono)
|           |   +-- server.ts         # App factory + server startup
|           |   +-- controllers/      # Request handlers
|           |   |   +-- jobs.ts
|           |   +-- middleware/       # Auth, CSP, rate-limit, validation, metrics
|           |   |   +-- auth.ts
|           |   |   +-- csp.ts
|           |   |   +-- error-handler.ts
|           |   |   +-- metrics.ts
|           |   |   +-- validation.ts
|           |   +-- routes/           # Route declarations
|           |   |   +-- health.ts
|           |   |   +-- jobs.ts
|           |   |   +-- monitoring.ts
|           |   |   +-- usage.ts
|           |   +-- schemas/          # Zod request/response schemas
|           |       +-- job.ts
|           |
|           +-- adapters/            # ** NEW ** Magnitude/Stagehand abstraction layer
|           |   +-- index.ts          # Adapter interface + factory
|           |   +-- types.ts          # BrowserAutomationAdapter interface
|           |   +-- magnitude.ts      # MagnitudeAdapter: wraps BrowserAgent
|           |   +-- stagehand.ts      # StagehandAdapter: wraps StagehandConnector
|           |   +-- mock.ts           # MockAdapter: for testing without browser
|           |
|           +-- client/              # VALET-facing client SDK
|           |   +-- GhostHandsClient.ts
|           |   +-- realtimeSubscriber.ts
|           |   +-- types.ts
|           |
|           +-- config/              # Configuration + environment
|           |   +-- env.ts            # Zod-validated env vars
|           |   +-- models.ts         # LLM model configuration
|           |   +-- rateLimits.ts     # Rate limit tiers
|           |   +-- models.config.json
|           |
|           +-- db/                   # Database layer
|           |   +-- client.ts         # Supabase client factory
|           |   +-- encryption.ts     # AES-256-GCM credential encryption
|           |   +-- migrations/       # SQL migration files
|           |       +-- 001_gh_user_usage.sql
|           |
|           +-- monitoring/          # Observability
|           |   +-- alerts.ts
|           |   +-- health.ts
|           |   +-- logger.ts
|           |   +-- metrics.ts        # MetricsCollector + Prometheus output
|           |
|           +-- security/            # Security controls
|           |   +-- domainLockdown.ts  # ATS domain allowlisting
|           |   +-- rateLimit.ts       # Sliding window rate limiter
|           |   +-- sanitize.ts        # Input sanitization
|           |
|           +-- workers/             # Background job processing
|           |   +-- main.ts            # Worker entry point
|           |   +-- JobExecutor.ts     # Job execution orchestrator
|           |   +-- JobPoller.ts       # Postgres LISTEN/NOTIFY poller
|           |   +-- costControl.ts     # Per-task + per-user budget tracking
|           |   +-- progressTracker.ts
|           |   +-- jobHandlers/       # Per-job-type handlers
|           |       +-- applyJob.ts
|           |       +-- extractData.ts
|           |       +-- healthCheck.ts
|           |
|           +-- scripts/             # CLI utilities
|               +-- run-migration.ts
|               +-- verify-setup.ts
|
+-- docs/                            # Project documentation
+-- test/                            # Integration / E2E test fixtures
+-- examples/                        # Usage examples
```

---

## 4. The Adapter Layer (Key Architectural Decision)

The current code imports directly from `magnitude-core`:

```typescript
// Current: tight coupling
import { BrowserAgent, startBrowserAgent, ManualConnector } from 'magnitude-core';
```

We introduce an **adapter layer** that wraps upstream APIs behind our own interface:

```typescript
// packages/ghosthands/src/adapters/types.ts

export interface BrowserAutomationAdapter {
  /** Start a browser session at the given URL */
  start(options: AdapterStartOptions): Promise<void>;

  /** Execute a natural-language action */
  act(instruction: string, context?: ActionContext): Promise<void>;

  /** Extract structured data from the current page */
  extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T>;

  /** Take a screenshot of the current page */
  screenshot(): Promise<Buffer>;

  /** Register credentials for auto-fill */
  registerCredentials(creds: Record<string, string>): void;

  /** Subscribe to events (actions, tokens, thoughts) */
  on(event: string, handler: (...args: any[]) => void): void;

  /** Get the underlying Playwright page (for domain lockdown, etc.) */
  get page(): Page;

  /** Stop the browser session */
  stop(): Promise<void>;
}

export interface AdapterStartOptions {
  url: string;
  llm: LLMClient;
  connectors?: any[];
}

export interface ActionContext {
  prompt?: string;
  data?: Record<string, any>;
}
```

### Why this matters:

1. **Swap Magnitude for Stagehand**: Change one line in configuration to switch browser engines.
2. **Test without browsers**: `MockAdapter` returns canned responses for unit tests.
3. **Upgrade isolation**: When Magnitude's API changes, we update one file (`magnitude.ts`), not every consumer.
4. **Type safety**: Our interface is stable even if upstream types shift.

### Magnitude Adapter implementation:

```typescript
// packages/ghosthands/src/adapters/magnitude.ts

import { BrowserAgent, startBrowserAgent, ManualConnector } from 'magnitude-core';
import type { BrowserAutomationAdapter, AdapterStartOptions } from './types';

export class MagnitudeAdapter implements BrowserAutomationAdapter {
  private agent: BrowserAgent | null = null;

  async start(options: AdapterStartOptions): Promise<void> {
    this.agent = await startBrowserAgent({
      llm: options.llm,
      connectors: options.connectors ?? [
        new ManualConnector({ supabaseClient: /* injected */ }),
      ],
      url: options.url,
    });
  }

  async act(instruction: string, context?: ActionContext): Promise<void> {
    this.requireAgent().act(instruction, context);
  }

  // ... etc
}
```

---

## 5. Import/Export Strategy

### 5.1 Workspace Configuration

```jsonc
// ghost-hands/package.json (root)
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
    "magnitude:update": "bun update magnitude-core magnitude-extract"
  },
  "packageManager": "bun@1.2.8^"
}
```

### 5.2 GhostHands package.json

```jsonc
// packages/ghosthands/package.json
{
  "name": "ghosthands",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    // Upstream via npm (pinned with semver)
    "magnitude-core": "^0.3.1",
    "magnitude-extract": "^0.0.2",

    // Our direct dependencies
    "@supabase/supabase-js": "^2.95.3",
    "hono": "^4.0.0",
    "pg": "^8.13.0",
    "zod": "^3.24.4"
  }
}
```

### 5.3 Import Rules

| From | To | Import Style |
|------|----|-------------|
| `ghosthands/*` | `magnitude-core` | Through adapter layer only (except types) |
| `ghosthands/*` | `magnitude-extract` | Direct import OK (stable API, leaf dependency) |
| `ghosthands/adapters/*` | `magnitude-core` | Direct import (adapter is the bridge) |
| `ghosthands/workers/*` | `ghosthands/adapters/*` | Through adapter factory |
| External (VALET) | `ghosthands/client/*` | Via `GhostHandsClient` class |

**Lint rule**: An ESLint rule (or simple grep check) should flag any import of `magnitude-core` outside of `src/adapters/`.

---

## 6. Build Configuration

### 6.1 Turborepo Pipeline

```jsonc
// ghost-hands/turbo.json
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
      "dependsOn": ["build"],
      "inputs": ["src/**", "__tests__/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {}
  }
}
```

Build order enforced by Turborepo:
1. `magnitude-extract` (no internal deps)
2. `magnitude-core` (depends on magnitude-extract)
3. `ghosthands` (depends on both)

### 6.2 TypeScript Configuration

```jsonc
// ghost-hands/tsconfig.base.json
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

```jsonc
// packages/ghosthands/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@adapters/*": ["src/adapters/*"]
    }
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 7. Upstream Update Workflow

```bash
# 1. Check for new versions
bun outdated magnitude-core

# 2. Update to latest compatible version
bun update magnitude-core magnitude-extract

# 3. Rebuild and test
bun run build
bun run test

# 4. If tests pass, commit the lockfile update
git add bun.lock package.json
git commit -m "chore: update magnitude-core to $(bun info magnitude-core --json | jq -r '.version')"
```

### Handling Breaking Changes

If Magnitude changes an API we depend on:

1. The adapter layer (`src/adapters/magnitude.ts`) absorbs the change.
2. All other GHOST-HANDS code continues using our stable interface.
3. Pin the old version until the adapter is updated: `bun add magnitude-core@0.3.1`
4. Write a migration note in `docs/upstream-changes.md`.

### Emergency Hotfixes

If upstream has a bug that blocks us before they release a fix:

```bash
# Option 1: patch-package (preferred for small fixes)
bun add -D patch-package
# Edit node_modules/magnitude-core/... then:
npx patch-package magnitude-core

# Option 2: Pin to known-good version
bun add magnitude-core@0.3.0

# Option 3: Temporary fork (last resort)
bun add magnitude-core@github:our-org/magnitude-core-fork#fix-branch
```

---

## 8. Development Workflow

### 8.1 Initial Setup

```bash
git clone <ghost-hands-repo>
cd ghost-hands
cp .env.example .env    # Fill in real values
bun install
bun run build
```

### 8.2 Daily Development

```bash
# Terminal 1: API with hot reload
bun run dev:api

# Terminal 2: Worker with hot reload
bun run dev:worker

# Terminal 3: Run tests
bun run test
```

### 8.3 Adding a New Job Handler

1. Create `src/workers/jobHandlers/newJobType.ts`
2. Use `BrowserAutomationAdapter` (not `BrowserAgent` directly)
3. Register in `src/workers/jobHandlers/index.ts`
4. Add route in `src/api/routes/jobs.ts`
5. Add schema in `src/api/schemas/job.ts`
6. Write tests in `__tests__/unit/workers/newJobType.test.ts`

### 8.4 Switching Browser Engine (Stagehand)

```typescript
// In JobExecutor.ts or config:
import { createAdapter } from '../adapters';

// Config-driven:
const adapter = createAdapter(
  process.env.GH_BROWSER_ENGINE === 'stagehand' ? 'stagehand' : 'magnitude',
  { /* options */ }
);
```

---

## 9. Docker Changes

The Dockerfile changes minimally. The key difference is the submodule copy:

```dockerfile
# Stage 1: deps
FROM oven/bun:1.2-debian AS deps
WORKDIR /app

COPY package.json bun.lock turbo.json ./

# Copy submodule package.jsons for workspace resolution
COPY vendor/magnitude/packages/magnitude-core/package.json vendor/magnitude/packages/magnitude-core/
COPY vendor/magnitude/packages/magnitude-extract/package.json vendor/magnitude/packages/magnitude-extract/

# Copy our package.json
COPY packages/ghosthands/package.json packages/ghosthands/

RUN bun install --frozen-lockfile

# Stage 2: build
FROM deps AS build
COPY vendor/magnitude/packages/ vendor/magnitude/packages/
COPY packages/ packages/
RUN bun run build

# Stage 3: runtime (same as before, paths updated)
```

---

## 10. What Stays, What Moves, What's New

### Stays the same (just relocates):
- All `src/api/` code
- All `src/client/` code
- All `src/config/` code
- All `src/db/` code
- All `src/monitoring/` code
- All `src/security/` code
- All `src/workers/` code (with adapter refactor)
- All `src/scripts/` code

### New:
- `src/adapters/` -- adapter layer wrapping magnitude-core
- `src/adapters/types.ts` -- `BrowserAutomationAdapter` interface
- `src/adapters/magnitude.ts` -- Magnitude implementation
- `src/adapters/stagehand.ts` -- Stagehand implementation (stub)
- `src/adapters/mock.ts` -- Test mock
- `vendor/magnitude/` -- git submodule (replaces inline dependency)

### Removed:
- `src/connectors/` -- empty barrel; connector concept moves to adapter layer
- Root-level Magnitude workspace files (turbo.json, .changeset, etc.)

### Modified:
- `JobExecutor.ts` -- uses adapter instead of direct magnitude-core imports
- `applyJob.ts` -- uses adapter instead of direct BrowserAgent
- `package.json` -- workspace paths point to vendor/magnitude/*

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Git submodule confusion for new devs | Medium | Low | Clear README; `--recurse-submodules` in clone instructions |
| Magnitude API breaking change | Low (stable project) | Medium | Adapter layer absorbs changes |
| Workspace resolution issues with submodule | Low | Medium | Pin exact commit; test in CI |
| Stagehand integration doesn't fit adapter interface | Low | Medium | Adapter interface designed from both APIs |
| Build time increase from building upstream | Low | Low | Turborepo caching handles this |

---

## 12. Migration Checklist

See `docs/16-migration-plan.md` (task #5) for the step-by-step migration from the current structure.

High-level:
1. Create new `ghost-hands` repo
2. Add Magnitude as git submodule at `vendor/magnitude/`
3. Set up workspace root (package.json, turbo.json, tsconfig.base.json)
4. Move `packages/ghosthands/` to new repo's `packages/ghosthands/`
5. Create adapter layer files
6. Update imports in `JobExecutor.ts` and `applyJob.ts`
7. Update Dockerfile paths
8. Verify build + tests pass
9. Update CI/CD

---

## Appendix A: Dependency Graph

```
ghost-hands (workspace root)
  |
  +-- packages/ghosthands
  |     depends on:
  |       magnitude-core (workspace:*) --> vendor/magnitude/packages/magnitude-core
  |       magnitude-extract (workspace:*) --> vendor/magnitude/packages/magnitude-extract
  |       @supabase/supabase-js
  |       hono
  |       pg
  |       zod
  |
  +-- vendor/magnitude/packages/magnitude-core
  |     depends on:
  |       magnitude-extract (workspace:*)
  |       @browserbasehq/stagehand
  |       @boundaryml/baml
  |       playwright (patchright)
  |       sharp
  |       zod
  |       ... (see upstream package.json)
  |
  +-- vendor/magnitude/packages/magnitude-extract
        depends on:
          cheerio
          uuid
```

## Appendix B: Import from magnitude-core -- What We Actually Use

Based on analysis of the current ghosthands source code:

| Import | Used In | Adapter Candidate? |
|--------|---------|-------------------|
| `BrowserAgent` | JobExecutor.ts, applyJob.ts | Yes -- wrap in adapter |
| `startBrowserAgent` | JobExecutor.ts | Yes -- adapter.start() |
| `ManualConnector` | JobExecutor.ts | Yes -- adapter config |
| `ModelUsage` (type) | JobExecutor.ts | Type only -- re-export from adapter |
| `LLMClient` (type) | JobExecutor.ts | Type only -- re-export from adapter |
| `agent.act()` | JobExecutor.ts, applyJob.ts | Yes -- adapter.act() |
| `agent.extract()` | JobExecutor.ts, applyJob.ts | Yes -- adapter.extract() |
| `agent.page` | JobExecutor.ts, applyJob.ts | Yes -- adapter.page |
| `agent.events` | JobExecutor.ts | Yes -- adapter.on() |
| `agent.stop()` | JobExecutor.ts | Yes -- adapter.stop() |
| `agent.registerCredentials()` | JobExecutor.ts | Yes -- adapter.registerCredentials() |

Surface area: 6 functions/methods + 2 types. Very manageable adapter.
