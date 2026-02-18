# GhostHands Architecture

Production-ready directory structure and migration plan for the GhostHands project,
built on top of the Magnitude browser-automation monorepo.

---

## 1. Current State Analysis

### What exists today (magnitude-source/)

```
magnitude-source/
  .env                          # credentials at root, not gitignored properly
  model-config.ts               # GH-specific config loader at monorepo root
  models.config.json            # GH model registry at monorepo root
  run-test.sh                   # ad-hoc shell runner
  test-simple.ts                # scattered test scripts at root
  test-workday.ts
  test-qwen.ts / test-kimi.ts / test-minimax.ts
  test-e2e.ts
  vitest.config.ts              # root vitest aliases into magnitude-core/src
  test/                         # newer structured tests (model-config, connectors, errors)
  packages/
    magnitude-core/             # upstream Magnitude agent framework (Apache-2.0)
    magnitude-extract/          # HTML partitioning / markdown serializer
    magnitude-test/             # Magnitude test runner CLI
    magnitude-mcp/              # MCP server bridge
    create-magnitude-app/       # scaffolding CLI
  evals/                        # eval suites (basic, webvoyager)
  docs/                         # Magnitude's Mintlify docs
```

### Problems

| Problem | Impact |
|---------|--------|
| Test scripts (`test-*.ts`) at monorepo root | Hard to find, no test runner integration, import paths break on refactor |
| `.env` at root with real credentials | Security risk; no dev/staging/prod separation |
| `model-config.ts` + `models.config.json` at root | GhostHands-specific code mixed into Magnitude monorepo root |
| `vitest.config.ts` aliases directly into `magnitude-core/src` | Tests coupled to internal package structure |
| No `packages/ghosthands` package | GH-specific code (ManualConnector, model config, job application logic) lives in magnitude-core or root |
| No worker architecture | No clear place for Hatchet/BullMQ job handlers |
| No API layer | No REST/tRPC structure for the VALET integration |
| ManualConnector lives inside magnitude-core | GH-specific Supabase integration mixed into upstream package |

---

## 2. Proposed Directory Structure

```
magnitude-source/
  package.json                  # workspace root (unchanged)
  turbo.json                    # turborepo config (unchanged)
  .env.example                  # template with placeholders only (committed)
  .env                          # local overrides (gitignored, never committed)

  packages/
    magnitude-core/             # UPSTREAM - do not modify unless contributing back
    magnitude-extract/          # UPSTREAM
    magnitude-test/             # UPSTREAM
    magnitude-mcp/              # UPSTREAM
    create-magnitude-app/       # UPSTREAM

    ghosthands/                 # <-- NEW: all GhostHands-specific code
      package.json
      tsconfig.json
      src/
        index.ts                # public API barrel export

        config/
          index.ts              # re-exports
          env.ts                # typed env loading (zod-validated, dev/staging/prod)
          models.ts             # model-config loader (moved from root model-config.ts)
          models.config.json    # model registry (moved from root)

        connectors/
          index.ts              # re-exports
          manualConnector.ts    # moved from magnitude-core (GH-specific, Supabase-backed)
          # future: greenhouseConnector.ts, leverConnector.ts, etc.

        security/
          index.ts
          browserIsolation.ts   # S1: browser profile isolation
          cdpAuth.ts            # S2: CDP authentication
          credentialSub.ts      # S3: credential substitution
          browserCleanup.ts     # S12: browser cleanup on exit

        workers/
          index.ts
          registry.ts           # job type -> handler mapping
          applyJob.ts           # "apply to job" job handler
          extractJob.ts         # "extract page data" job handler
          healthCheck.ts        # manual health score recalculation

        api/                    # REST API layer (Hono)
          index.ts              # app entrypoint, mounts routers
          routes/
            jobs.ts             # POST /jobs/apply, GET /jobs/:id/status
            manuals.ts          # CRUD for action manuals
            health.ts           # GET /health, GET /readiness
          middleware/
            auth.ts             # API key / JWT validation
            logging.ts          # request logging
            errors.ts           # error serialization

        db/
          index.ts
          client.ts             # Supabase client singleton (respects env)
          migrations/           # SQL migration files
          queries/
            manuals.ts          # typed queries for gh_action_manuals
            jobs.ts             # typed queries for gh_job_runs
            credentials.ts      # typed queries for gh_credentials

        scripts/
          apply-workday.ts      # moved from root test-workday.ts (cleaned up)
          apply-simple.ts       # moved from root test-simple.ts

      __tests__/
        unit/
          config/
            env.test.ts
            models.test.ts      # moved from test/model-config.test.ts
          connectors/
            manual.test.ts      # moved from test/connectors/manual.test.ts
          security/
            browserIsolation.test.ts
            credentialSub.test.ts
          workers/
            applyJob.test.ts
        integration/
          connectors/
            manual.integration.test.ts
            stagehand.integration.test.ts
          db/
            queries.integration.test.ts
        e2e/
          workday.e2e.test.ts   # moved from root test-e2e.ts
          greenhouse.e2e.test.ts

  evals/                        # keep as-is (Magnitude upstream)
  docs/                         # Magnitude upstream docs
```

---

## 3. Reasoning for Each Decision

### 3.1 New `packages/ghosthands` package

**Why:** GhostHands is a distinct product built on top of Magnitude. Mixing GH-specific
code into `magnitude-core` or the monorepo root creates coupling that makes upstream
syncs painful and the codebase hard to navigate.

**What goes here:** Everything that would not make sense to contribute back to
open-source Magnitude: the ManualConnector (Supabase-backed self-learning), model
config system, security hardening, worker architecture, REST API, and application
scripts.

**What stays in magnitude-core:** The Agent/BrowserAgent/BrowserConnector framework,
action system, memory, AI harness -- these are generic and GH builds on top of them.

### 3.2 `config/` -- centralized configuration

**Why:** Today `model-config.ts`, `models.config.json`, and `.env` all sit at the
monorepo root with no validation or environment awareness. A `config/` module with
zod-validated env loading supports:

- **Type safety:** `env.ts` exports typed, validated config objects.
- **Env separation:** A single `NODE_ENV` switch selects dev/staging/prod defaults.
- **No scattered files:** `models.config.json` moves here; root `.env` stays at root
  (standard monorepo convention) but is loaded through this module.

### 3.3 `connectors/` -- GhostHands-specific connectors

**Why:** `ManualConnector` depends on Supabase and the `gh_action_manuals` table.
It is a GhostHands feature, not a generic Magnitude feature. Moving it here:

- Keeps `magnitude-core` clean for upstream sync.
- Groups future ATS-specific connectors (Greenhouse, Lever, iCIMS) together.
- The connector implements the same `AgentConnector` interface from magnitude-core,
  so it plugs in with zero changes to the agent.

### 3.4 `security/` -- browser isolation and credential management

**Why:** These modules (being built by the security-engineer) enforce tenant isolation,
secure CDP connections, credential substitution, and cleanup. They are GhostHands
operational concerns, not generic Magnitude features.

### 3.5 `workers/` -- job handler architecture

**Why:** GhostHands needs to process async job-application tasks dispatched by VALET.
Whether integration happens via Hatchet workflows or a REST queue, the actual job
handlers need a home. The `workers/` module provides:

- **registry.ts:** Maps job types to handler functions. Framework-agnostic -- works
  with Hatchet `step()`, BullMQ processors, or plain function calls in tests.
- **One file per job type:** Easy to find, test, and monitor independently.
- **No framework lock-in:** Handlers are plain async functions that receive typed
  input and return typed output. The integration layer (Hatchet SDK, REST polling)
  wraps these handlers.

### 3.6 `api/` -- REST API layer (Hono)

**Why:** Even if VALET dispatches via Hatchet, GhostHands needs HTTP endpoints for:

- Health checks and readiness probes (Kubernetes/Railway/Fly)
- Manual CRUD (admin UI)
- Direct job submission (webhook fallback)
- Status polling

**Why Hono:** Lightweight, TypeScript-native, runs on Bun/Node/Cloudflare Workers.
Magnitude already uses Bun as its package manager, so Hono is a natural fit. No heavy
Express/Fastify dependency needed.

### 3.7 `db/` -- database layer

**Why:** Supabase queries are currently inline in `ManualConnector`. Extracting them
into a `db/` module:

- Enables typed query functions reusable across connectors, workers, and API routes.
- Centralizes the Supabase client singleton (connection pooling, env-aware).
- Puts migration SQL files in a discoverable location.

### 3.8 `scripts/` -- runnable application scripts

**Why:** `test-workday.ts` and `test-simple.ts` at the root are actually demo/runner
scripts, not tests. Moving them into `scripts/` clarifies their purpose and keeps the
monorepo root clean.

### 3.9 `__tests__/` -- structured test organization

**Why:** Tests are currently split between:
- `packages/magnitude-core/src/**/*.test.ts` (co-located unit tests, upstream)
- `test/` at monorepo root (GH-specific tests with vitest alias hacks)
- `test-*.ts` at monorepo root (not real tests, just runnable scripts)

The proposed structure:

| Layer | Location | Runner | Speed |
|-------|----------|--------|-------|
| Unit | `__tests__/unit/` | vitest | <1s each, no network |
| Integration | `__tests__/integration/` | vitest | Needs Supabase/browser, 5-30s |
| E2E | `__tests__/e2e/` | vitest or custom | Full browser + LLM, 30s-5min |

- Unit tests mock all external deps (Supabase, browser, LLM).
- Integration tests hit real Supabase (dev instance) and optionally a real browser.
- E2E tests run full application flows against real ATS portals.

The root `vitest.config.ts` can define workspace-level test configurations, but
`packages/ghosthands` gets its own vitest config that resolves imports correctly
without aliasing into another package's internals.

---

## 4. Package Dependency Graph

```
packages/ghosthands
  depends on:
    magnitude-core       (Agent, BrowserAgent, BrowserConnector, actions, memory)
    magnitude-extract    (HTML parsing, used by BrowserAgent.extract())
    @supabase/supabase-js
    hono                 (REST API)
    zod                  (config validation, API schemas)

packages/magnitude-core  (upstream, no GH deps)
  depends on:
    magnitude-extract
    @boundaryml/baml
    playwright (patchright)
    zod, sharp, pino, etc.
```

GhostHands depends on magnitude-core. Magnitude-core never depends on ghosthands.
This ensures clean upstream syncs.

---

## 5. Configuration Management

### Environment variables

```
# .env.example (committed)
NODE_ENV=development

# Database
DATABASE_URL=
SUPABASE_URL=
SUPABASE_KEY=

# LLM Providers
SILICONFLOW_API_KEY=
DEEPSEEK_API_KEY=
GOOGLE_API_KEY=

# Storage
S3_ENDPOINT=
S3_ACCESS_KEY=
S3_SECRET_KEY=
```

### Config module (packages/ghosthands/src/config/env.ts)

```typescript
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_KEY: z.string().min(1),
  GHOSTHANDS_TABLE_PREFIX: z.string().default('gh_'),
  // ... LLM keys validated per-provider as needed
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
```

### Per-environment behavior

| Setting | development | staging | production |
|---------|-------------|---------|------------|
| Supabase instance | local / shared dev | staging project | production project |
| LLM provider | cheapest (qwen-7b) | same as prod | SiliconFlow Qwen-72B |
| Browser headless | false | true | true |
| DRY_RUN default | true | true | false |
| Log level | debug | info | warn |

---

## 6. Migration Plan

### Phase 1: Create the package skeleton (no code moves yet)

1. `mkdir -p packages/ghosthands/src/{config,connectors,security,workers,api/routes,api/middleware,db/queries,db/migrations,scripts}`
2. `mkdir -p packages/ghosthands/__tests__/{unit,integration,e2e}`
3. Create `packages/ghosthands/package.json` with workspace deps on `magnitude-core` and `magnitude-extract`.
4. Create `packages/ghosthands/tsconfig.json` extending the root tsconfig.

**Risk:** None. Additive only.

### Phase 2: Move GhostHands-specific code out of root

| Source | Destination | Notes |
|--------|-------------|-------|
| `model-config.ts` | `packages/ghosthands/src/config/models.ts` | Remove CLI entrypoint, keep `loadModelConfig()` |
| `models.config.json` | `packages/ghosthands/src/config/models.config.json` | JSON import |
| `test-workday.ts` | `packages/ghosthands/src/scripts/apply-workday.ts` | Update imports to use package names |
| `test-simple.ts` | `packages/ghosthands/src/scripts/apply-simple.ts` | Update imports |
| `test-qwen.ts`, `test-kimi.ts`, `test-minimax.ts` | `packages/ghosthands/src/scripts/` | Consolidate into parameterized script or keep as-is |
| `run-test.sh` | `packages/ghosthands/scripts/run.sh` | Update paths |

**Risk:** Low. Old files can be deleted once new locations are verified.

### Phase 3: Extract ManualConnector from magnitude-core

1. Copy `packages/magnitude-core/src/connectors/manualConnector.ts` to `packages/ghosthands/src/connectors/manualConnector.ts`.
2. Update imports to use `magnitude-core` package name instead of `@/` aliases.
3. Update `test-workday.ts` (now in scripts/) to import from `ghosthands`.
4. Remove `manualConnector.ts` from magnitude-core (it is not exported from core's index.ts barrel, so no breaking change to core's public API).

**Risk:** Low. ManualConnector is already unexported from `magnitude-core/src/connectors/index.ts` barrel -- it is imported directly in test files.

### Phase 4: Create config/env.ts and db/ layer

1. Write `config/env.ts` with zod validation.
2. Extract Supabase client creation from ManualConnector into `db/client.ts`.
3. Extract query functions into `db/queries/manuals.ts`.
4. Update ManualConnector to use the shared db client.

**Risk:** Low. Internal refactor within ghosthands package.

### Phase 5: Move and restructure tests

1. Move `test/model-config.test.ts` to `packages/ghosthands/__tests__/unit/config/models.test.ts`.
2. Move `test/connectors/manual.test.ts` to `packages/ghosthands/__tests__/unit/connectors/manual.test.ts`.
3. Move `test/connectors/stagehand.test.ts` and `test/connectors/gmail.test.ts` to `__tests__/integration/connectors/`.
4. Move `test-e2e.ts` to `packages/ghosthands/__tests__/e2e/`.
5. Add `packages/ghosthands/vitest.config.ts` and remove the root-level vitest alias hack.
6. Keep `packages/magnitude-core/src/**/*.test.ts` co-located (upstream convention).

**Risk:** Medium. Test imports need updating. Run all tests after migration to verify.

### Phase 6: Scaffold workers and API (future, post-integration-architect)

1. Create worker handler stubs based on integration-architect's Hatchet vs REST decision.
2. Create Hono API routes.
3. Wire workers to db layer and agent.

**Risk:** Low. Greenfield code.

---

## 7. Package.json for packages/ghosthands

```json
{
  "name": "ghosthands",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:unit": "vitest run __tests__/unit",
    "test:integration": "vitest run __tests__/integration",
    "test:e2e": "vitest run __tests__/e2e",
    "apply:simple": "bun src/scripts/apply-simple.ts",
    "apply:workday": "bun src/scripts/apply-workday.ts"
  },
  "dependencies": {
    "magnitude-core": "workspace:*",
    "magnitude-extract": "workspace:*",
    "@supabase/supabase-js": "^2.95.3",
    "hono": "^4.0.0",
    "zod": "^3.24.4"
  },
  "devDependencies": {
    "typescript": "~5.7.2",
    "vitest": "^4.0.18",
    "@types/node": "^22.13.4"
  }
}
```

---

## 8. Import Convention

Inside `packages/ghosthands/src/`, imports follow these rules:

```typescript
// Magnitude core -- use package name, never relative paths into another package
import { BrowserAgent, startBrowserAgent } from 'magnitude-core';
import { partitionHtml } from 'magnitude-extract';

// GhostHands internal -- use relative paths or tsconfig paths
import { getEnv } from '../config/env';
import { getSupabaseClient } from '../db/client';
import { ManualConnector } from '../connectors/manualConnector';
```

Never import from `magnitude-core/src/...` directly. Always go through the package's
public API (its barrel `index.ts`). If something is not exported from magnitude-core,
either:
1. Contribute the export upstream, or
2. Re-implement it in ghosthands.

---

## 9. Files to Delete After Migration

Once all phases are complete and tests pass:

```
# Root-level GH-specific files (moved into packages/ghosthands)
rm model-config.ts
rm models.config.json
rm test-simple.ts
rm test-workday.ts
rm test-qwen.ts
rm test-kimi.ts
rm test-minimax.ts
rm test-e2e.ts
rm run-test.sh

# Root-level test directory (moved into packages/ghosthands/__tests__)
rm -rf test/

# Root vitest.config.ts can be simplified or removed if each package owns its own
```

The root `vitest.config.ts` should either be deleted (each package runs its own tests)
or kept as a workspace-level config that delegates to each package.

---

## 10. Summary

The core principle is **separation of concerns**: Magnitude is the generic
browser-automation framework; GhostHands is the job-application product built on it.
By creating `packages/ghosthands` as a proper workspace package, we get:

- Clean upstream syncs with Magnitude releases
- A discoverable home for all GH-specific code (connectors, config, security, workers, API)
- Proper test organization (unit/integration/e2e) with no alias hacks
- Environment-aware configuration (dev/staging/prod)
- A clear dependency graph where ghosthands depends on magnitude-core, never the reverse
