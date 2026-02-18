# GhostHands Dependency Map

## Overview

Total source files analyzed: 50 TypeScript files across 10 modules.

**External dependencies:**
- `magnitude-core` (workspace) -- Browser automation engine
- `magnitude-extract` (workspace) -- listed in package.json but NOT imported by any source file
- `@supabase/supabase-js` -- Database/auth/realtime/storage
- `hono` -- HTTP framework (API layer)
- `pg` -- Direct Postgres connection for LISTEN/NOTIFY
- `zod` -- Schema validation
- `playwright` -- Referenced via types only (Page, Route) in domainLockdown.ts

---

## File-by-File Dependency Analysis

### Legend
- **Core** = Our standalone business logic, zero Magnitude deps
- **Magnitude-dependent** = Imports/uses Magnitude APIs (magnitude-core, magnitude-extract)
- **Integration glue** = Connects Magnitude to our systems (DB, API, monitoring)

---

### 1. config/ (4 files)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `env.ts` | **Core** | None | `zod` | Env var validation. Standalone. |
| `models.ts` | **Core** | None | `fs`, `path` (Node stdlib) | LLM model config loader. Mentions `BrowserAgent` in comments only. Produces `llmClient` objects but defines its own types. |
| `rateLimits.ts` | **Core** | None | None | Pure data config: tier/platform rate limits. Zero imports. |
| `index.ts` | **Core** | None | None | Barrel export. |

**Summary: config/ is 100% Core.** No Magnitude dependencies at all.

---

### 2. db/ (3 files + SQL migration)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `client.ts` | **Core** | None | `@supabase/supabase-js` | Supabase client factory. Standalone. |
| `encryption.ts` | **Core** | None | `node:crypto` | AES-256-GCM credential encryption. Completely standalone. |
| `index.ts` | **Core** | None | None | Barrel export. |

**Summary: db/ is 100% Core.** Supabase is our own infrastructure, not Magnitude.

---

### 3. monitoring/ (5 files)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `metrics.ts` | **Core** | None | None | In-memory counters + Prometheus export. Zero external deps. |
| `logger.ts` | **Core** | None | None | Structured JSON logger with secret redaction. Imports only `../config/env.js`. |
| `health.ts` | **Core** | None | `@supabase/supabase-js` (type) | Health checker. Uses Supabase for DB/storage checks. Checks env vars for LLM providers but doesn't import Magnitude. |
| `alerts.ts` | **Core** | None | `@supabase/supabase-js` (type) | Alert manager. Uses metrics + Supabase. No Magnitude deps. |
| `index.ts` | **Core** | None | None | Barrel export. |

**Summary: monitoring/ is 100% Core.** References LLM concepts (cost, tokens) but via our own MetricsCollector, not Magnitude APIs.

---

### 4. security/ (4 files)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `sanitize.ts` | **Core** | None | None | XSS/SQL injection prevention. Pure functions. Zero imports. |
| `rateLimit.ts` | **Integration Glue** | None | `hono` (Context, Next) | Rate limiting middleware. Imports `../config/rateLimits.js` and `../api/middleware/auth.js`. Bridges security config to Hono API layer. |
| `domainLockdown.ts` | **Magnitude-dependent** | `playwright` (Page, Route types) | None | Domain lockdown for browser agent navigation. Imports Playwright types (which magnitude-core depends on). This is the security boundary around Magnitude's browser. |
| `index.ts` | **Core** | None | None | Barrel export. |

**Summary: security/ is mostly Core with one Magnitude-adjacent file.**
- `sanitize.ts` = 100% Core
- `rateLimit.ts` = Integration glue (Hono middleware)
- `domainLockdown.ts` = Magnitude-dependent (Playwright types for browser safety)

---

### 5. workers/ (8 files)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `JobExecutor.ts` | **Magnitude-dependent** | `startBrowserAgent`, `ManualConnector`, `BrowserAgent`, `ModelUsage`, `LLMClient` | `@supabase/supabase-js`, `zod` | **THE core integration point.** Creates BrowserAgent, wires events, calls `agent.act()` and `agent.extract()`. This is the main Magnitude-to-GhostHands bridge. |
| `JobPoller.ts` | **Core** | None | `@supabase/supabase-js`, `pg` | Job queue polling via Supabase RPC + Postgres LISTEN/NOTIFY. No Magnitude deps. Calls `executor.execute(job)` but doesn't know about Magnitude. |
| `costControl.ts` | **Core** | None | `@supabase/supabase-js` | Per-task budget tracking + per-user monthly limits. Pure business logic. No Magnitude types used. |
| `progressTracker.ts` | **Core** | None | `@supabase/supabase-js` | Job progress lifecycle tracking. Step inference from action variants. No Magnitude deps. |
| `main.ts` | **Core** | None | `@supabase/supabase-js`, `pg` | Worker entry point. Sets up executor + poller. No direct Magnitude imports. |
| `jobHandlers/applyJob.ts` | **Magnitude-dependent** | `BrowserAgent` | `zod` | Apply job handler: calls `agent.act()` + `agent.extract()`. |
| `jobHandlers/extractData.ts` | **Magnitude-dependent** | `BrowserAgent` | `zod` | Scrape handler: calls `agent.act()` + `agent.extract()`. |
| `jobHandlers/healthCheck.ts` | **Magnitude-dependent** | `startBrowserAgent`, `BrowserAgent` | None | Verifies browser can launch. |
| `index.ts` | **Core** | None | None | Barrel export. |

**Summary: workers/ is the primary Magnitude integration point.**
- Core (no Magnitude): `JobPoller.ts`, `costControl.ts`, `progressTracker.ts`, `main.ts`
- Magnitude-dependent: `JobExecutor.ts`, `applyJob.ts`, `extractData.ts`, `healthCheck.ts`

---

### 6. client/ (4 files)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `types.ts` | **Core** | None | `zod` | All GhostHands domain types, schemas, error classes. Zero Magnitude deps. |
| `GhostHandsClient.ts` | **Core** | None | `@supabase/supabase-js` | Client SDK for consuming the GhostHands API. Dual-mode (API/DB). No Magnitude deps. |
| `realtimeSubscriber.ts` | **Core** | None | `@supabase/supabase-js` | Supabase Realtime subscriptions. Imports `ProgressEventData` from workers/progressTracker (our own type). |
| `index.ts` | **Core** | None | None | Barrel export. |

**Summary: client/ is 100% Core.** The entire client SDK has zero Magnitude dependencies.

---

### 7. api/ (13 files)

| File | Category | Imports From Magnitude | External Deps | Notes |
|------|----------|----------------------|---------------|-------|
| `server.ts` | **Core** | None | `hono` | App factory + server entry. No Magnitude. |
| `controllers/jobs.ts` | **Core** | None | `@supabase/supabase-js` | CRUD operations on gh_automation_jobs. Pure DB. |
| `middleware/auth.ts` | **Core** | None | `hono`, `@supabase/supabase-js` | Auth middleware (JWT + service key). |
| `middleware/csp.ts` | **Core** | None | `hono` | Content Security Policy headers. |
| `middleware/error-handler.ts` | **Core** | None | `hono` | Global error handler. |
| `middleware/metrics.ts` | **Core** | None | None | Metrics recording middleware. Imports our own `getMetrics()`. |
| `middleware/validation.ts` | **Core** | None | `hono`, `zod` | Request body/query validation. |
| `routes/health.ts` | **Core** | None | `hono` | Health check endpoint. |
| `routes/jobs.ts` | **Core** | None | `hono` | Job CRUD routes. |
| `routes/monitoring.ts` | **Core** | None | `hono`, `@supabase/supabase-js` | Monitoring dashboard routes. |
| `routes/usage.ts` | **Core** | None | `hono` | User usage/billing routes. |
| `schemas/job.ts` | **Core** | None | `zod` | API request validation schemas. |
| All index/barrel files | **Core** | None | None | Re-exports. |

**Summary: api/ is 100% Core.** The entire REST API layer has zero Magnitude dependencies.

---

### 8. connectors/ (1 file)

| File | Category | Notes |
|------|----------|-------|
| `index.ts` | **Core** | Empty barrel with comment "ManualConnector will be moved here from magnitude-core in Phase 3". |

---

### 9. scripts/ (2 files)

| File | Category | Notes |
|------|----------|-------|
| `run-migration.ts` | **Core** | Database migration runner. |
| `verify-setup.ts` | **Core** | Setup verification script. |

---

## Magnitude-Core Import Summary

Only **5 files** import from `magnitude-core`:

```
1. workers/JobExecutor.ts
   imports: startBrowserAgent, ManualConnector, BrowserAgent, ModelUsage, LLMClient

2. workers/jobHandlers/applyJob.ts
   imports: BrowserAgent

3. workers/jobHandlers/extractData.ts
   imports: BrowserAgent

4. workers/jobHandlers/healthCheck.ts
   imports: startBrowserAgent, BrowserAgent

5. security/domainLockdown.ts
   imports: Page, Route (from playwright, used with browser agent)
```

**`magnitude-extract` is listed in package.json but NEVER imported anywhere.**

---

## Dependency Graph (ASCII)

```
                    ┌──────────────────────────┐
                    │     magnitude-core        │
                    │  (Browser automation)     │
                    └─────────┬────────────────┘
                              │
                    ┌─────────▼────────────────┐
                    │  MAGNITUDE BOUNDARY       │
                    │                          │
                    │  workers/JobExecutor.ts   │◄── THE bridge
                    │  workers/jobHandlers/*    │
                    │  security/domainLockdown  │
                    └─────────┬────────────────┘
                              │ calls
                    ┌─────────▼────────────────┐
                    │  OUR BUSINESS LOGIC       │
                    │  (100% standalone)        │
                    │                          │
                    │  ┌─────────────────────┐ │
                    │  │ config/             │ │  env, models, rateLimits
                    │  │ db/                 │ │  supabase client, encryption
                    │  │ monitoring/         │ │  metrics, health, alerts, logging
                    │  │ security/           │ │  sanitize, rateLimit
                    │  │ workers/costControl │ │  budget tracking
                    │  │ workers/progress    │ │  progress tracking
                    │  │ workers/JobPoller   │ │  job queue management
                    │  │ client/             │ │  SDK (API + DB modes)
                    │  │ api/                │ │  REST API (Hono)
                    │  └─────────────────────┘ │
                    └──────────────────────────┘
                              │ uses
                    ┌─────────▼────────────────┐
                    │  INFRASTRUCTURE           │
                    │  Supabase (DB/Auth/RT)    │
                    │  Hono (HTTP)             │
                    │  PostgreSQL (LISTEN/NOTIFY)│
                    └──────────────────────────┘
```

---

## Categorized File Count

| Category | File Count | Percentage |
|----------|-----------|------------|
| **Core** (standalone business logic) | 44 | 88% |
| **Magnitude-dependent** | 5 | 10% |
| **Integration glue** | 1 | 2% |

---

## Recommendations for Separation of Concerns

### 1. The Magnitude surface is already small
Only 5 of 50 files (10%) touch Magnitude. The codebase is already well-separated.

### 2. Create an explicit adapter/bridge layer
Move all Magnitude-touching code behind an interface:

```
src/adapters/magnitude/
  ├── browserAdapter.ts     # Wraps startBrowserAgent + BrowserAgent
  ├── types.ts              # Our own types mirroring what we need from magnitude-core
  └── index.ts
```

This would let us:
- Swap Magnitude for another browser automation engine without touching business logic
- Test business logic without Magnitude installed
- Track breaking changes from upstream in one place

### 3. The JobExecutor is the critical seam
`JobExecutor.ts` is the single file that orchestrates everything: it creates the BrowserAgent, wires up event callbacks (cost tracking, progress), executes the task, and extracts results. This is the natural place to introduce an adapter interface.

### 4. domainLockdown.ts imports Playwright types directly
This should import from our adapter layer instead, so security code doesn't depend on Playwright's type signatures directly.

### 5. magnitude-extract is a phantom dependency
It's in package.json but never imported. It can likely be removed or is planned for future use.

### 6. The client/ module is already perfectly isolated
It talks only to our API or Supabase directly. It has zero knowledge of Magnitude. This is the right boundary for external consumers (like VALET).

### 7. Internal cross-module dependencies worth noting
- `security/rateLimit.ts` imports from `api/middleware/auth.ts` (circular-ish: security -> api)
- `api/routes/usage.ts` imports from `workers/costControl.ts` (api -> workers)
- `client/realtimeSubscriber.ts` imports type from `workers/progressTracker.ts` (client -> workers)

These cross-module deps should be refactored to use shared types in a `types/` or `shared/` module.
