# GhostHands Development Guide

**For:** Claude AI, Developers, Contributors
**Last Updated:** 2026-02-18

> **BEFORE YOU START:** Read the following docs to understand the project architecture, current state, and integration points. Do not make changes until you have reviewed them.
>
> **Required reading:**
> 1. `docs/CURRENT-STATE.md` — Full technical reference (architecture, DB, API, workers, deployment)
> 2. `docs/VALET-INTEGRATION-CONTRACT.md` — Complete API contract with VALET (30 models, all endpoints)
> 3. `docs/REGRESSION-TESTING.md` — Regression test plans and rollback procedures
> 4. `docs/ONBOARDING-AND-GETTING-STARTED.md` — Getting started guide
>
> **Cross-project references:**
> - `../INTEGRATION.md` — Unified VALET + GHOST-HANDS integration doc (cross-team sync)
> - `../PRODUCT-STATUS-AND-ROADMAP.md` — Product status, roadmap, known issues
> - Sibling project: `../VALET/CLAUDE.md` — VALET development guide
>
> This file covers development conventions and standards only.

---

## Project Overview

GhostHands is a browser automation system for job applications. It wraps Magnitude (via npm) behind a clean adapter interface, runs jobs through a Hono REST API + Postgres LISTEN/NOTIFY worker system, and deploys as Docker containers on EC2.

Key traits:
- Adapter pattern: Magnitude today, Stagehand/Actionbook ready
- Self-learning: successful runs create manuals for future cookbook replay (~95% cost reduction)
- VALET integration: callback-driven, shared Supabase database
- Cost control: per-task budgets, per-user monthly limits, tiered rate limiting

---

## Architecture Principles

### 1. Extend via Adapters, Never Modify Magnitude Core

All browser automation goes through `BrowserAutomationAdapter`. Magnitude is consumed as an npm dependency. Never import from `magnitude-core` outside the adapter layer.

### 2. Adapter Factory Pattern

```typescript
import { createAdapter } from './adapters';
const adapter = createAdapter('magnitude'); // or 'mock' for tests
```

### 3. Single-Task-Per-Worker

Each worker process handles one job at a time. Scale horizontally by adding workers. This keeps browser sessions isolated and cost tracking deterministic.

---

## Database Naming Conventions

GhostHands shares the same Supabase database as VALET. **All GhostHands tables use the `gh_` prefix.**

| System | Prefix | Examples |
|--------|--------|---------|
| VALET | None | `users`, `tasks`, `resumes` |
| GhostHands | `gh_` | `gh_automation_jobs`, `gh_job_events`, `gh_user_credentials` |

See `docs/CURRENT-STATE.md` for the full table inventory.

---

## Code Style

- TypeScript strict mode, `async/await` over raw promises
- Zod for schema validation at API boundaries
- Hono for HTTP routing
- `eventemitter3` for adapter events
- File naming: `PascalCase.ts` for classes, `camelCase.ts` for modules
- Connectors: `*Connector.ts`; Tests: `*.test.ts`

### File Organization

```
packages/ghosthands/src/
  adapters/       # BrowserAutomationAdapter interface + implementations
  api/            # Hono REST API (routes, middleware, schemas, controllers)
  client/         # VALET integration SDK (GhostHandsClient)
  config/         # Environment, model catalog, rate limit config
  connectors/     # Magnitude AgentConnector extensions
  db/             # Supabase client, AES-256-GCM encryption
  detection/      # BlockerDetector (captcha/login detection)
  engine/         # ExecutionEngine, CookbookExecutor, ManualStore, TraceRecorder
  events/         # Job event type constants
  lib/            # Shared utilities (Redis Streams helpers)
  monitoring/     # Logger (JSON structured, secret redaction), metrics, health, alerts
  scripts/        # Operational scripts (migration, job management, setup verification)
  security/       # Rate limiting, domain lockdown, input sanitization
  sessions/       # SessionManager (encrypted browser session persistence)
  workers/        # JobPoller, JobExecutor, CostControl, ProgressTracker, task handlers
```

---

## Testing Standards

- Test runner: `bun test` (vitest config available)
- Test tiers: `__tests__/unit/`, `__tests__/integration/`, `__tests__/e2e/`
- Use `MockAdapter` for unit tests (no browser required)
- Mock external services (Supabase, LLM providers)
- Never make live API calls in unit tests

```bash
bun run test:unit          # Fast, no external deps
bun run test:integration   # Requires Supabase credentials
bun run test:e2e           # Full system tests, sequential
```

---

## Security Rules

- Never commit API keys, database passwords, or credentials
- Use `.env` files (gitignored) for all secrets
- AES-256-GCM encryption for stored credentials (`GH_CREDENTIAL_KEY`)
- RLS enabled on all `gh_` tables
- Domain lockdown prevents LLM agent from navigating to attacker-controlled URLs
- Input sanitization at API boundary (XSS stripping, SQL injection detection, URL validation)
- Structured logger auto-redacts sensitive keys (passwords, tokens, JWTs, SSNs)

---

## Environment Variables

Required:
- `SUPABASE_URL` -- Supabase project URL
- `SUPABASE_SECRET_KEY` -- Supabase secret key (`sb_secret_...`). Replaces legacy `service_role` JWT.
- `DATABASE_URL` or `SUPABASE_DIRECT_URL` -- Postgres connection string
- `GH_SERVICE_SECRET` -- API authentication key
- `GH_CREDENTIAL_KEY` -- 64 hex chars for AES-256-GCM encryption

Optional:
- `SUPABASE_PUBLISHABLE_KEY` -- Supabase publishable key (`sb_publishable_...`). Replaces legacy `anon` JWT.
- `GH_MODEL` / `GH_IMAGE_MODEL` -- Default LLM model aliases
- `REDIS_URL` -- Redis connection URL (enables real-time streaming via Redis Streams for SSE)
- `GH_API_PORT` (default 3100), `GH_WORKER_PORT` (default 3101)
- `GH_WORKER_ID` -- Worker identity for registry
- `EC2_INSTANCE_ID`, `EC2_IP` -- EC2 metadata for monitoring

> **Note:** Legacy env var names (`SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`) are still accepted as fallbacks but deprecated. Use the new names.

---

## Cross-Team Communication (VALET)

When changes touch the VALET integration surface:
- New/changed API endpoints: update `docs/VALET-INTEGRATION-CONTRACT.md`
- New callback payload fields: document for VALET webhook handler
- New `gh_` tables or columns: note in migration file and contract doc
- New environment variables VALET needs: document in `.env.example`

---

## Pre-commit Checklist

- [ ] All tests pass (`bun run test:unit`)
- [ ] TypeScript compiles (`bun run build`)
- [ ] No `console.log` statements (use structured logger)
- [ ] New tables use `gh_` prefix
- [ ] Secrets in `.env`, not hardcoded
- [ ] Documentation updated if API surface changed
