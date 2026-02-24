# GhostHands -- Current State Technical Reference

**Last Updated:** 2026-02-18

This document describes the actual implemented state of GhostHands by reading the source code. It covers architecture, database schema, API endpoints, worker system, adapters, security, monitoring, sessions, deployment, and CI/CD.

---

## 1. Architecture Overview

GhostHands is a browser automation system for job applications. It wraps the Magnitude LLM agent behind an adapter interface and runs jobs through a REST API + Postgres-backed worker queue.

```
                VALET (Next.js)
                     |
                     | POST /api/v1/gh/valet/apply
                     v
         ┌───────────────────────┐
         │   Hono REST API       │  Port 3100
         │   (auth, rate limit,  │
         │    CSP, validation)   │
         └─────────┬─────────────┘
                   │ INSERT INTO gh_automation_jobs
                   v
         ┌─────────────────────┐
         │   Postgres (Supabase)│
         │   NOTIFY gh_job_created
         └─────────┬───────────┘
                   │ LISTEN
                   v
         ┌───────────────────────┐
         │   Worker Process      │  Port 3101
         │   JobPoller           │
         │     → JobExecutor     │
         │       → ExecutionEngine (cookbook first)
         │       → MagnitudeAdapter (LLM fallback)
         │       → TraceRecorder (save manuals)
         └───────────┬───────────┘
                     │ callback POST
                     v
                  VALET (webhook handler)
```

### Key Design Decisions

- **Adapter pattern**: All browser automation goes through `BrowserAutomationAdapter`. Only the adapter layer imports from `magnitude-core`.
- **Single-task-per-worker**: Each worker handles one job at a time. Scale by adding workers.
- **Cookbook-first execution**: The `ExecutionEngine` tries replaying a saved manual before falling back to the LLM agent. Successful LLM runs are recorded as manuals for future replay (~95% cost reduction).
- **Shared database**: GhostHands and VALET share the same Supabase database. All GhostHands tables use the `gh_` prefix.

### Source Layout

```
packages/ghosthands/src/
  adapters/       BrowserAutomationAdapter interface + Magnitude, Mock implementations
  api/            Hono REST API (server, routes, middleware, controllers, schemas)
  client/         VALET integration SDK (GhostHandsClient)
  config/         Environment, model catalog (models.config.json), rate limit config
  connectors/     Magnitude AgentConnector extensions
  db/             Supabase client singleton, AES-256-GCM CredentialEncryption
  detection/      BlockerDetector (captcha/login wall detection)
  engine/         ExecutionEngine, CookbookExecutor, ManualStore, TraceRecorder
  events/         Job event type constants (JOB_EVENT_TYPES)
  lib/            Shared utilities (Redis Streams helpers)
  monitoring/     Structured JSON logger, Prometheus metrics, health checks, alerts
  scripts/        Operational scripts (run-migration, verify-setup, job management)
  security/       Rate limiting, domain lockdown, input sanitization
  sessions/       SessionManager (encrypted browser session persistence)
  workers/        JobPoller, JobExecutor, CostControl, ProgressTracker, task handlers
```

---

## 2. Database Schema

All tables live in the `public` schema of a shared Supabase Postgres database. VALET tables have no prefix; GhostHands tables use `gh_`.

### 2.1 gh_automation_jobs

The central job queue. Created in `supabase-migration-integration.sql`.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | `gen_random_uuid()` |
| idempotency_key | VARCHAR(255) UNIQUE | Prevents duplicate submissions |
| user_id | UUID NOT NULL | References VALET user |
| created_by | VARCHAR(100) | `'valet'` or `'api'` |
| job_type | VARCHAR(50) | `'apply'`, `'scrape'`, `'fill_form'`, `'custom'` |
| target_url | TEXT NOT NULL | URL to automate |
| task_description | TEXT NOT NULL | Natural language instruction |
| input_data | JSONB | User profile, QA overrides, resume ref |
| priority | INTEGER 1-10 | Lower = higher priority (default 5) |
| scheduled_at | TIMESTAMPTZ | Deferred execution |
| max_retries | INTEGER | Default 3 |
| retry_count | INTEGER | Current retry count |
| timeout_seconds | INTEGER | Default 300 (5 min) |
| status | VARCHAR(20) | See status enum below |
| status_message | TEXT | Human-readable status |
| started_at | TIMESTAMPTZ | When worker picked up |
| completed_at | TIMESTAMPTZ | When finished |
| last_heartbeat | TIMESTAMPTZ | Worker liveness (30s interval) |
| worker_id | VARCHAR(100) | Which worker is executing |
| manual_id | UUID FK | References gh_action_manuals if cookbook used |
| engine_type | VARCHAR(20) | `'cookbook'` or `'magnitude'` |
| result_data | JSONB | Structured result payload |
| result_summary | TEXT | Human-readable result |
| error_code | VARCHAR(50) | Classified error code |
| error_details | JSONB | Error context |
| screenshot_urls | JSONB | Array of screenshot URLs |
| artifact_urls | JSONB | Array of artifact URLs |
| metadata | JSONB | Arbitrary metadata |
| tags | JSONB | Array of string tags |
| callback_url | TEXT | VALET callback URL (migration 005) |
| valet_task_id | UUID | VALET task reference (migration 005) |
| resume_ref | TEXT | Resume file reference (migration 006) |
| target_worker_id | TEXT | Worker affinity for sandbox routing (migration 007) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | Auto-updated via trigger |

**Status values:** `pending` -> `queued` -> `running` -> `paused` -> `completed` | `failed` | `cancelled` | `expired`

**Indexes:**
- `idx_gh_jobs_status_priority` -- Job pickup query (status IN pending/queued, ordered by priority+created_at)
- `idx_gh_jobs_user_status` -- User job history
- `idx_gh_jobs_heartbeat` -- Stuck job detection (running jobs by heartbeat)
- `idx_gh_jobs_scheduled` -- Deferred job pickup
- `idx_gh_jobs_manual` -- Manual lookup

**Triggers:**
- `gh_automation_jobs_notify` -- `pg_notify('gh_job_created', ...)` on INSERT
- `gh_automation_jobs_log_status` -- Auto-logs status changes to gh_job_events
- `update_gh_automation_jobs_updated_at` -- Sets updated_at on UPDATE

**RLS:** Users see own jobs. Service role has full access.

**Realtime:** Added to `supabase_realtime` publication for live frontend updates.

### 2.2 gh_job_events

Audit log for every job state transition and significant event.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| job_id | UUID FK | References gh_automation_jobs (CASCADE delete) |
| event_type | VARCHAR(50) | e.g. `status_change`, `cost_recorded`, `thought`, `action`, `error` |
| from_status | VARCHAR(20) | Previous status (for status_change) |
| to_status | VARCHAR(20) | New status |
| message | TEXT | Event description |
| metadata | JSONB | Event-specific data |
| actor | VARCHAR(100) | `'system'`, worker_id, or `'cost_control'` |
| created_at | TIMESTAMPTZ | |

**Indexes:** `idx_gh_job_events_job` (job_id, created_at), `idx_gh_job_events_type` (job_id, event_type)

**RLS:** Users see events for their own jobs. Service role has full access.

### 2.3 gh_user_credentials

Encrypted per-user platform credentials. Service-role access only.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID NOT NULL | |
| platform | VARCHAR(50) | e.g. `'linkedin'`, `'greenhouse'` |
| credential_type | VARCHAR(30) | e.g. `'password'`, `'oauth_token'` |
| encrypted_data | BYTEA | AES-256-GCM encrypted blob |
| encryption_key_id | VARCHAR(100) | Key version used for encryption |
| expires_at | TIMESTAMPTZ | Optional TTL |
| last_used_at | TIMESTAMPTZ | |
| last_verified_at | TIMESTAMPTZ | |
| is_valid | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `(user_id, platform, credential_type)`

**RLS:** Service role only. Never exposed to client.

### 2.4 gh_action_manuals

Self-learning manuals created from successful Magnitude runs. Used by CookbookExecutor for replay.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| url_pattern | TEXT NOT NULL | URL pattern (e.g. `*.greenhouse.io`) |
| task_pattern | TEXT NOT NULL | Task description pattern (e.g. `apply`) |
| steps | JSONB NOT NULL | Array of recorded step objects |
| success_count | INTEGER | Incremented on successful cookbook replay |
| failure_count | INTEGER | Incremented on failed replay |
| health_score | REAL | 0-100, decreases on failure, increases on success |
| created_by | UUID | Optional VALET user reference |
| last_verified | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** url_pattern, task_pattern, health_score DESC, compound (url_pattern, task_pattern), created_at DESC

**RLS:** Authenticated users + service role have full access.

### 2.5 gh_user_usage

Per-user monthly cost tracking for budget enforcement. Created in migration 001.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID NOT NULL | |
| tier | TEXT | `'free'`, `'starter'`, `'pro'`, `'premium'`, `'enterprise'` |
| period_start | TIMESTAMPTZ | Calendar month start (UTC) |
| period_end | TIMESTAMPTZ | Calendar month end (UTC) |
| total_cost_usd | DOUBLE PRECISION | Accumulated cost this period |
| total_input_tokens | BIGINT | |
| total_output_tokens | BIGINT | |
| job_count | INTEGER | Jobs executed this period |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `(user_id, period_start)`

**RLS:** Users can read own usage. Service role has full access.

### 2.6 gh_browser_sessions

Encrypted browser session persistence. Created in migration 008.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID NOT NULL | |
| domain | TEXT NOT NULL | Extracted from target URL |
| session_data | TEXT NOT NULL | AES-256-GCM encrypted Playwright storageState JSON |
| encryption_key_id | TEXT NOT NULL | Key version |
| expires_at | TIMESTAMPTZ | Optional TTL |
| last_used_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `(user_id, domain)` -- one session per user per domain

**RLS:** Service role has full access. Users can read and delete own sessions.

### 2.7 gh_worker_registry

Fleet monitoring table. Created in migration 013. Workers UPSERT on startup and heartbeat every 30s.

| Column | Type | Notes |
|--------|------|-------|
| worker_id | TEXT PK | e.g. `worker-local-1708300000` or custom ID |
| status | TEXT | `'active'`, `'draining'`, `'offline'` |
| target_worker_id | TEXT | Sandbox UUID from VALET (for affinity routing) |
| ec2_instance_id | TEXT | From EC2 metadata or env |
| ec2_ip | TEXT | From EC2 metadata or env |
| current_job_id | UUID FK | References gh_automation_jobs |
| registered_at | TIMESTAMPTZ | |
| last_heartbeat | TIMESTAMPTZ | Updated every 30s |
| jobs_completed | INTEGER | Lifetime counter |
| jobs_failed | INTEGER | Lifetime counter |
| metadata | JSONB | |

**Indexes:** status, target_worker_id

### 2.8 Postgres Functions

**`gh_pickup_next_job(p_worker_id TEXT)`** (migration 002):
Atomic job pickup using `FOR UPDATE SKIP LOCKED`. Selects the highest-priority pending job, sets status to `queued`, assigns the worker_id, and returns the full row. Multiple workers calling concurrently never pick the same job.

**`gh_notify_new_job()`**: Trigger function that fires `pg_notify('gh_job_created', ...)` on INSERT into gh_automation_jobs.

**`gh_log_status_change()`**: Trigger function that inserts a `status_change` event into gh_job_events whenever status changes.

---

## 3. API Endpoints

The API is a Hono application running on port 3100 (configurable via `GH_API_PORT`). All authenticated routes are mounted under `/api/v1/gh/`.

### 3.1 Authentication

Middleware in `api/middleware/auth.ts`. Two modes:

| Method | Header | Notes |
|--------|--------|-------|
| Service key | `X-GH-Service-Key` | Matches `GH_SERVICE_SECRET` env var. Used by VALET. |
| Bearer token | `Authorization: Bearer <jwt>` | Supabase JWT. User ID extracted from token. |

Service-to-service calls bypass rate limits.

### 3.2 Public Routes (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health check (200 OK) |
| GET | `/api/v1/gh/models` | Available LLM model catalog |
| GET | `/monitoring/health` | Detailed health report (DB, worker connectivity) |
| GET | `/monitoring/metrics` | Prometheus text format metrics |
| GET | `/monitoring/metrics/json` | JSON metrics snapshot |
| GET | `/monitoring/alerts` | Active alerts + stuck job detection |
| GET | `/monitoring/workers` | Fleet-wide worker list from gh_worker_registry |
| GET | `/monitoring/dashboard` | Aggregated health + metrics + alerts for UI |

### 3.3 Job Routes (auth required)

All under `/api/v1/gh/jobs`. Rate limited per user tier.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Create a new automation job |
| POST | `/jobs/batch` | Batch create multiple jobs |
| GET | `/jobs` | List jobs (filtered by user, status, type; paginated) |
| GET | `/jobs/:id` | Get job details |
| GET | `/jobs/:id/status` | Get job status (lightweight) |
| POST | `/jobs/:id/cancel` | Cancel a pending/running job |
| GET | `/jobs/:id/events` | Get job event log |
| POST | `/jobs/:id/retry` | Retry a failed job |

**Create job request body** (Zod validated):
```json
{
  "job_type": "apply",
  "target_url": "https://boards.greenhouse.io/...",
  "task_description": "Apply to the job posting",
  "input_data": { "user_data": { "first_name": "...", ... }, "qa_overrides": {} },
  "priority": 5,
  "timeout_seconds": 300,
  "max_retries": 3,
  "idempotency_key": "unique-key",
  "metadata": {},
  "tags": []
}
```

### 3.4 VALET Routes (auth required)

All under `/api/v1/gh/valet`. Designed for VALET-specific workflows.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/valet/apply` | Rich application request (profile, resume, QA answers) |
| POST | `/valet/task` | Generic task request |
| POST | `/valet/resume/:jobId` | Resume a paused HITL job (supports credential injection) |
| GET | `/valet/status/:jobId` | VALET-compatible status (cost breakdown, manual info, interactions) |
| GET | `/valet/sessions/:userId` | List user's browser sessions |
| DELETE | `/valet/sessions/:userId` | Clear user's browser sessions |
| POST | `/valet/workers/deregister` | Deregister a worker and cancel its active jobs |

**POST /valet/resume/:jobId** accepts:
```json
{
  "resolved_by": "human",              // "human" (default) | "system"
  "resolution_notes": "Solved captcha", // optional, max 500 chars
  "resolution_type": "code_entry",      // optional: "manual" | "code_entry" | "credentials" | "skip"
  "resolution_data": { "code": "123456" } // optional: arbitrary JSON (credentials, 2FA codes)
}
```
When `resolution_type` or `resolution_data` is present, the route stores them in `interaction_data` JSONB before firing NOTIFY. The JobExecutor reads and clears this data on wake-up.

**POST /valet/apply** is the primary entry point from VALET. It accepts a full user profile (name, email, phone, LinkedIn, work history, education, skills), resume reference, QA overrides, quality preset, and callback URL. It transforms this into the internal job format and inserts into gh_automation_jobs.

### 3.5 Usage Routes (auth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/gh/users/:id/usage` | Monthly cost, budget, job count for a user |

### 3.6 Middleware Stack

Applied in order (see `api/server.ts`):
1. `logger()` -- Hono built-in request logger
2. `requestLoggingMiddleware()` -- Structured JSON logging with X-Request-Id
3. `metricsMiddleware()` -- Prometheus counter/histogram updates
4. `strictCSP()` -- Content Security Policy headers
5. `cors()` -- CORS (configurable origin via `CORS_ORIGIN`)
6. `errorHandler` -- Global error handler (classifies errors, returns JSON)
7. `authMiddleware` -- Applied only to `/api/v1/gh/*` routes
8. `rateLimitMiddleware()` -- Per-route rate limiting (applied per handler)

---

## 4. Worker System

### 4.1 Worker Entry Point

`workers/main.ts` -- Long-running Bun process that:
1. Connects to Supabase (pooled) and Postgres (direct for LISTEN/NOTIFY)
2. Registers in `gh_worker_registry` with UPSERT
3. Starts `JobPoller` which LISTENs on `gh_job_created` and polls every 5s as fallback
4. Runs a lightweight HTTP status server on port 3101 (configurable via `GH_WORKER_PORT`)
5. Heartbeats every 30s (updates last_heartbeat and current_job_id in registry)
6. Handles graceful shutdown (SIGTERM/SIGINT) with two-phase: drain active jobs, then force-exit

**Worker status endpoints** (port 3101):
- `GET /worker/status` -- Worker state (active jobs, uptime, draining)
- `GET /worker/health` -- 200 if idle, 503 if busy or draining. Used by deploy.sh.
- `POST /worker/drain` -- Stop accepting new jobs, let active ones finish

### 4.2 JobPoller

`workers/JobPoller.ts` -- Manages job discovery and pickup.

- Subscribes to Postgres `LISTEN gh_job_created` for instant pickup on new jobs
- Falls back to polling every 5s in case NOTIFY is missed (network blip, transaction pooler)
- Calls `gh_pickup_next_job(worker_id)` which uses `FOR UPDATE SKIP LOCKED` for atomic, contention-free pickup
- On startup, runs `recoverStuckJobs()` to reclaim jobs from dead workers (heartbeat > 2 min old)
- Graceful shutdown: stops polling, waits up to 30s for active jobs to drain, releases claimed jobs

Properties exposed: `activeJobCount`, `isRunning`, `currentJobId`

### 4.3 JobExecutor

`workers/JobExecutor.ts` -- The largest component (~1260 lines). Handles the full job lifecycle:

**Execution flow:**
1. **Preflight**: CostControlService checks user monthly budget
2. **Adapter creation**: `createAdapter('magnitude')` -- creates MagnitudeAdapter
3. **Session loading**: SessionManager loads encrypted browser session for user+domain
4. **ExecutionEngine attempt**: Tries cookbook replay if a matching manual exists (health_score > 0.3)
5. **Magnitude fallback**: If no manual or cookbook fails, runs full Magnitude LLM agent
6. **TraceRecorder**: On successful Magnitude run, records steps as a new manual for future replay
7. **Session saving**: Saves updated browser session state after completion
8. **Cost recording**: CostControlService records job cost against user's monthly usage
9. **Callback**: CallbackNotifier POSTs status to VALET callback URL

**Error handling:**
- Error classification via regex patterns: `budget_exceeded`, `action_limit_exceeded`, `captcha_blocked`, `login_required`, `timeout`, `rate_limited`, `element_not_found`, `network_error`, `browser_crashed`
- Retryable errors: captcha, element_not_found, timeout, rate_limited, network_error, browser_crashed, internal_error
- Browser crash recovery: up to 2 attempts (`MAX_CRASH_RECOVERIES`)

**HITL (Human-in-the-Loop):**
- Triggered by `captcha_blocked` or `login_required` errors
- Sets job status to `paused`, sends `needs_human` callback to VALET
- Waits for NOTIFY on `gh_job_resume` channel (or polls every 3s via Supabase)
- Default timeout: 300s (5 minutes, configurable via `hitlTimeoutSeconds`)
- VALET resumes via `POST /valet/resume/:jobId`

**Credential injection (HITL resume):**
- When VALET sends `POST /valet/resume/:jobId` with `resolution_type` and `resolution_data`, the route stores these in `interaction_data` JSONB before firing `pg_notify('gh_job_resume', jobId)`
- On wake, `waitForResume()` returns a `ResumeResult` with `{ resumed, resolutionType, resolutionData }`
- `readAndClearResolutionData()` reads resolution fields from DB and immediately clears them (SECURITY: credentials/codes must not persist)
- Based on `resolutionType`:
  - `code_entry`: `injectCode()` fills the first visible 2FA/OTP input using Playwright selectors (autocomplete, name, inputmode patterns) and clicks submit
  - `credentials`: `injectCredentials()` fills username/email + password fields via Playwright selectors and clicks submit
  - `manual` / `skip`: No injection, adapter resumes directly
- After injection, `adapter.resume(context)` is called with a `ResolutionContext` so adapters can track the resolution type
- Post-resume verification re-checks for blockers up to 3 times (`MAX_POST_RESUME_CHECKS`)

**Progress tracking:**
- `ProgressTracker` tracks 11 lifecycle steps: queued, initializing, navigating, analyzing, filling, uploading, answering, reviewing, submitting, extracting, completed
- Heuristic step inference from action text and LLM thoughts
- Throttled DB writes (2s minimum interval)

### 4.4 Cost Control

`workers/costControl.ts`

**CostTracker** (per-task):
- Tracks input/output tokens, cost in USD, action count
- Throws `BudgetExceededError` when task cost exceeds budget
- Throws `ActionLimitExceededError` when action count exceeds limit
- Tracks cookbook vs. magnitude steps and image vs. reasoning cost separately

Per-task budgets by quality preset:

| Preset | Budget | Use Case |
|--------|--------|----------|
| speed | $0.02 | Simple forms, quick scrapes |
| balanced | $0.10 | Standard applications |
| quality | $0.30 | Complex multi-page applications |

Per-job-type action limits: apply=50, scrape=30, fill_form=40, custom=50

**CostControlService** (per-user monthly):
- Reads/writes `gh_user_usage` table
- Preflight budget check before starting a job
- Records job cost after completion
- Resolves user tier from VALET `profiles` table

Monthly budgets by tier:

| Tier | Monthly Budget |
|------|---------------|
| free | $0.50 |
| starter | $2.00 |
| pro | $10.00 |
| premium | $25.00 |
| enterprise | $100.00 |

### 4.5 Callback Notifier

`workers/callbackNotifier.ts` -- Singleton that POSTs job status changes to VALET callback URLs.

- Status types: `completed`, `failed`, `needs_human`, `resumed`, `running`
- 3 retries with backoff: 1s, 3s, 10s
- 10s request timeout
- Non-blocking: failures are logged but don't affect job execution

### 4.6 Task Handlers

`workers/taskHandlers/` -- Pluggable task handler registry.

- `registry.ts`: `taskHandlerRegistry` maps job_type to handler functions
- `registerBuiltinHandlers()`: Registers built-in handlers on worker startup
- Handler interface: `(context: TaskContext) => Promise<TaskResult>`
- `TaskContext` includes: job, adapter, supabase, costTracker, progress, logEvent

---

## 5. Adapter Layer

### 5.1 BrowserAutomationAdapter Interface

`adapters/types.ts` -- The core abstraction. All browser interaction goes through this.

**Lifecycle:** `start(options)` / `stop()` / `isActive()` / `isConnected()`

**Core actions:**
- `act(instruction, context?)` -- Execute a natural-language action. Returns `ActionResult` with success, message, durationMs, tokensUsed.
- `extract<T>(instruction, schema)` -- Extract structured data using a Zod schema.

**Optional methods:**
- `observe(instruction)` -- Discover interactive elements without acting
- `navigate(url)` / `getCurrentUrl()`
- `screenshot()` -- Returns Buffer
- `getBrowserSession()` -- Export Playwright storageState as JSON
- `registerCredentials(creds)` -- Register sensitive values to exclude from LLM
- `pause()` / `resume(context?: ResolutionContext)` / `isPaused()` -- HITL support. `ResolutionContext` carries `resolutionType` and `resolutionData` from the human resolver.

**Events:** `actionStarted`, `actionDone`, `tokensUsed`, `thought`, `error`, `progress`

**Adapter types:** `'magnitude'` | `'stagehand'` | `'actionbook'` | `'hybrid'` | `'mock'`

### 5.2 HitlCapableAdapter Interface

`adapters/types.ts` -- Extends `BrowserAutomationAdapter` for adapters that support human-in-the-loop workflows. Makes HITL methods required (not optional) and adds blocker detection.

**Required HITL methods:**
- `observe(instruction)` -- Discover interactive elements (required, not optional)
- `pause()` / `resume()` / `isPaused()` -- Promise-based pause gate for HITL takeover
- `screenshot()` -- Capture current page state (required for HITL evidence)
- `getCurrentUrl()` -- Report current URL (required for HITL context)
- `observeWithBlockerDetection(instruction)` -- Run observation and classify any blockers found

**Key types:**
- `BlockerCategory`: `'captcha'` | `'login'` | `'2fa'` | `'bot_check'` | `'rate_limit'` | `'visual_verification'`
- `ObservationBlocker`: `{ type: BlockerCategory, confidence: number, description: string, source: DetectionSource }`
- `DetectionSource`: `'dom'` | `'observe'` | `'combined'`
- `ObservationResult`: `{ elements: ObservedElement[], blockers: ObservationBlocker[] }`

Both MagnitudeAdapter and MockAdapter implement `HitlCapableAdapter`.

### 5.3 MagnitudeAdapter

`adapters/magnitude.ts` -- Wraps `magnitude-core`'s `BrowserAgent`.

- Dual-model support: `imageLlm` for 'act' role (vision), `llm` for 'extract'/'query' roles (reasoning)
- Cost calculation from model pricing registry
- StagehandObserver integration for `observe()` support
- Browser connection health checking via `isConnected()`
- Event emission: `tokensUsed` (with calculated cost), `thought` (LLM reasoning), `actionDone`
- **Promise-based pause gate**: `pause()` creates a pending Promise; `resume()` resolves it. Adapter methods await the gate before proceeding, enabling safe HITL takeover.
- **`observeWithBlockerDetection()`**: Runs `observe()`, then classifies returned elements against regex heuristics to identify blockers (captcha, login walls, 2FA, bot checks, rate limits, visual verification).

### 5.4 MockAdapter

`adapters/mock.ts` -- For unit tests. Implements `HitlCapableAdapter`.

- Configurable: action count, tokens per action, failure simulation
- `simulateCrash()` method for testing crash recovery
- `simulatedBlockers` config for HITL/blocker detection testing
- Promise-based pause/resume gate (same pattern as MagnitudeAdapter)
- No browser required

### 5.5 Factory

`adapters/index.ts` -- `createAdapter(type: AdapterType)` factory.

- `'magnitude'` -> MagnitudeAdapter
- `'mock'` -> MockAdapter
- `'stagehand'`, `'actionbook'`, `'hybrid'` -> throw "not yet implemented"

---

## 6. Execution Engine

### 6.1 ExecutionEngine

`engine/ExecutionEngine.ts` -- Orchestrates mode selection.

Decision logic:
1. Look up matching manual via ManualStore (by URL pattern + task type + platform)
2. If manual exists with `health_score > 0.3`: try CookbookExecutor
3. On cookbook success: record success in ManualStore, return result
4. On cookbook failure: record failure, signal fallback to Magnitude
5. If no manual or health too low: signal Magnitude mode immediately

### 6.2 ManualStore

`engine/ManualStore.ts` -- CRUD operations on `gh_action_manuals` table.

- `lookup(url, taskType, platform)` -- Find best matching manual
- `recordSuccess(manualId)` / `recordFailure(manualId)` -- Update health score
- Creates manuals from TraceRecorder output

### 6.3 CookbookExecutor

`engine/CookbookExecutor.ts` -- Replays manual steps using the adapter.

- Executes each step via `adapter.act(step.instruction)`
- Tracks step progress through ProgressTracker
- Aborts on step failure, signals fallback to Magnitude

### 6.4 TraceRecorder

`engine/TraceRecorder.ts` -- Captures successful Magnitude runs.

- Listens to adapter events (`actionDone`, `thought`)
- Builds a step-by-step trace of the successful run
- On job completion, saves trace as a new manual in ManualStore

---

## 7. Security

### 7.1 Credential Encryption

`db/encryption.ts` -- `CredentialEncryption` class.

- Algorithm: AES-256-GCM
- Envelope format: version byte + keyId (length-prefixed) + 12-byte IV + 16-byte authTag + ciphertext
- Key rotation support via `GH_CREDENTIAL_PREV_KEYS` (comma-separated hex key list)
- Environment: `GH_CREDENTIAL_KEY` (64 hex chars = 32 bytes), `GH_CREDENTIAL_KEY_ID`, `GH_CREDENTIAL_PREV_KEYS`
- Used for: user credentials (gh_user_credentials) and browser sessions (gh_browser_sessions)

### 7.2 Rate Limiting

`security/rateLimit.ts` -- Sliding window, in-memory rate limiter.

Per-user-tier limits:

| Tier | Hourly | Daily |
|------|--------|-------|
| free | 10 | 50 |
| starter | 30 | 200 |
| pro | 100 | 1000 |
| premium | 100 | 1000 |
| enterprise | 500 | 5000 |

Per-platform limits: 200/hour, 2000/day (shared across all users for a given ATS platform).

- Hono middleware adds `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers
- Returns 429 with `Retry-After` header when exceeded
- Service-to-service calls (via `X-GH-Service-Key`) bypass rate limits

### 7.3 Blocker Detection (HITL)

`detection/BlockerDetector.ts` -- Detects CAPTCHAs, login walls, 2FA prompts, and other blockers that require human intervention.

**Dual-mode detection:**

1. **DOM detection** (`detectBlocker(page)`): Fast first pass using `page.evaluate()`. Checks CSS selectors and text patterns for known blocker indicators (reCAPTCHA iframes, hCaptcha divs, Cloudflare challenge wrappers, login form markers, 2FA prompts, rate limit messages).

2. **Adapter-assisted detection** (`detectWithAdapter(adapter)`): Uses `HitlCapableAdapter` for deeper analysis. Runs DOM detection first; if confidence < 0.8, also runs `adapter.observe()` and classifies the observed elements via regex heuristics. Combines both sources for higher confidence.

**Blocker types:** `captcha`, `login`, `2fa`, `bot_check`, `rate_limit`, `visual_verification`

**Detection sources:** `dom` (selector/text match), `observe` (LLM-based observation), `combined` (both sources agree)

**Integration with JobExecutor:**
- `checkForBlockers()` runs after initial navigation and on HITL-eligible errors
- Uses `BLOCKER_CONFIDENCE_THRESHOLD = 0.6` to trigger HITL flow
- On detection: emits `blocker_detected` event, pauses adapter, updates job status to `waiting_for_human`, sends callback to VALET
- Post-resume verification loop (`MAX_POST_RESUME_CHECKS = 3`) confirms blocker is resolved before continuing

### 7.4 Domain Lockdown

`security/domainLockdown.ts` -- `DomainLockdown` class.

- Restricts Playwright navigation to the job's target URL domain plus ATS platform allowlists
- Platform allowlists include: Workday, LinkedIn, Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters
- Enforced via Playwright `page.route()` interception
- Prevents LLM agent from navigating to attacker-controlled URLs

### 7.5 Input Sanitization

`security/sanitize.ts`

- `sanitizeString()` pipeline: trim -> normalize Unicode -> truncate (10K chars) -> strip HTML tags -> HTML entity encoding -> SQL injection detection
- XSS detection and stripping (script tags, event handlers, javascript: URLs)
- SQL injection detection (DROP, UNION SELECT, etc.) -- logs warning, does not block
- URL validation (must be http/https, no javascript:/data: schemes)

---

## 8. Monitoring

### 8.1 Structured Logger

`monitoring/logger.ts`

- JSON-formatted output with timestamp, level, message, metadata
- Automatic secret redaction for sensitive keys: `password`, `secret`, `token`, `api_key`, `apikey`, `authorization`, `credential`, `ssn`, `credit_card`
- Pattern-based redaction: JWTs (`eyJ...`), email addresses, SSNs, credit card numbers
- Hono middleware: `requestLoggingMiddleware()` -- logs request/response with `X-Request-Id` correlation

### 8.2 Metrics

Prometheus-compatible metrics exposed at `/monitoring/metrics`:
- Request count, latency histogram, error rate
- Job count by status, type
- Worker heartbeat age

### 8.3 Health Checks

`/monitoring/health` endpoint:
- Database connectivity check (Supabase query)
- Worker connectivity (heartbeat freshness from gh_worker_registry)
- Returns `healthy`, `degraded`, or `unhealthy` status

### 8.4 Alerts

`monitoring/alerts.ts` -- `AlertManager` class.
- Evaluates alert rules on a periodic interval
- Stuck job detection: jobs in `running` status with heartbeat > 2 minutes old
- Active alerts exposed at `/monitoring/alerts`

---

## 9. Session Management

`sessions/SessionManager.ts`

- Saves/loads encrypted Playwright `context.storageState()` per user+domain
- Storage: `gh_browser_sessions` table (encrypted with CredentialEncryption)
- Auto-cleanup of expired sessions
- VALET can manage sessions via:
  - `GET /valet/sessions/:userId` -- List sessions
  - `DELETE /valet/sessions/:userId` -- Clear all sessions for a user
- Enables session reuse across job runs to avoid repeated logins and CAPTCHAs

---

## 10. Docker and Deployment

### 10.1 Dockerfile

Multi-stage build:
1. **deps** (`oven/bun:1.2-debian`): Install dependencies with `bun install --frozen-lockfile`
2. **build**: Copy source, run `bun run build` (tsc)
3. **runtime** (`oven/bun:1.2-debian`): Install Chromium system deps, copy node_modules + dist + src, install Patchright Chromium, create non-root `ghosthands` user

Same image for API and Worker (different CMD):
- API: `bun packages/ghosthands/src/api/server.ts` (default, port 3100)
- Worker: `bun packages/ghosthands/src/workers/main.ts` (port 3101)

### 10.2 docker-compose.yml

Development compose with hot-reload:
- `api` service: port 3100, `bun --watch src/api/server.ts`
- `worker` service: port 3101, `bun --watch src/workers/main.ts`, 2GB memory / 2 CPU limit
- Volume mounts for source files

### 10.3 Deploy Script

`scripts/deploy-manual.sh` (formerly `deploy.sh`) -- Manual escape hatch for EC2 deployments. Primary deploys use Kamal (`config/deploy.yml`).

Commands:
- `deploy <image-tag>` -- Pull from ECR, gracefully drain worker, docker compose up, health check
- `rollback` -- Rollback to previous image
- `status` -- Show running containers
- `drain` -- Stop worker (keep API running)
- `health` -- Exit 0 if healthy, 1 if not
- `worker-status` -- Check if worker is busy or idle (queries port 3101)
- `start-worker <id>` -- Start a targeted worker container (for sandbox routing)
- `stop-worker <id>` -- Stop a targeted worker container
- `list-workers` -- List all targeted worker containers

Graceful deploy flow:
1. ECR login
2. Pull new image
3. Request worker drain via `POST /worker/drain`
4. Wait for active jobs to finish (up to 60s)
5. `docker compose up -d` with new image
6. Health check (up to 30 attempts, 2s interval)

---

## 11. CI/CD

`.github/workflows/ci.yml`

### Pipeline

```
push/PR to main
  ├── typecheck (bun run build)
  ├── test-unit (bun run test:unit)
  └── test-integration (needs typecheck, requires Supabase secrets)

push to main only:
  └── docker (build + push to ECR, needs typecheck + test-unit)
       └── deploy-staging (notify VALET webhook)
            └── deploy-production (notify VALET webhook, requires staging success)
```

### Deploy Notification

Staging and production deploys notify VALET via webhook:
- POST to `VALET_DEPLOY_WEBHOOK_URL` with HMAC-SHA256 signature
- Payload includes: image tag, commit SHA, commit message, environment, run URL
- Headers: `X-GH-Webhook-Signature`, `X-GH-Event: deploy_ready`, `X-GH-Environment`
- Non-blocking: webhook failure is a warning, not a pipeline failure

---

## 12. Known Issues and Gaps

### Recently Resolved

- **HITL credential injection**: Resume endpoint (`POST /valet/resume/:jobId`) now accepts `resolution_type` (`code_entry`, `credentials`, `manual`, `skip`) and `resolution_data` (arbitrary JSON). JobExecutor reads resolution data on wake-up, injects 2FA codes or credentials via Playwright selectors, passes `ResolutionContext` to adapter.resume(), and clears sensitive data from DB immediately. See Section 4.3.
- **HITL blocker detection**: BlockerDetector now supports dual-mode detection (DOM + LLM observe). JobExecutor calls `checkForBlockers()` after navigation and on HITL-eligible errors, pausing the adapter and notifying VALET when blockers are found. See Section 7.3.
- **Cost on failure**: All JobExecutor exit paths (preflight failure, validation failure, error catch) now capture cost snapshots and include them in callbacks. Preflight/validation failures report zero cost. See Section 5.3 (MagnitudeAdapter) and `workers/callbackNotifier.ts`.
- **HitlCapableAdapter interface**: Unified adapter interface for HITL-capable adapters. Both MagnitudeAdapter and MockAdapter implement it. See Section 5.2.

### Implemented but Incomplete

1. **Stagehand/Actionbook/Hybrid adapters**: Factory throws "not yet implemented". Only Magnitude and Mock are functional.
2. **Worker registry counters**: `jobs_completed` and `jobs_failed` columns exist in gh_worker_registry but are not incremented by the current worker code (heartbeat only updates status and current_job_id).
3. **Rate limit persistence**: Rate limiting is in-memory only. Limits reset on API server restart. No Redis or shared store.
4. **Scheduled jobs**: The `scheduled_at` column and index exist, but JobPoller's `gh_pickup_next_job()` function already handles `scheduled_at <= NOW()`. The API does not validate or expose scheduling in a first-class way.
5. **HITL takeover UI**: Backend detection and pause/resume are implemented, but VALET frontend for viewing the blocked page and resolving blockers is not yet built.

### Known Limitations

6. **Single database connection for LISTEN/NOTIFY**: The worker uses a direct Postgres connection (`pg.Client`). Transaction-mode poolers (pgbouncer port 6543) do not support LISTEN/NOTIFY; the 5s fallback poll handles this, but with added latency.
7. **Cost tracking race condition**: `CostControlService.recordJobCost()` reads then updates `gh_user_usage` without a database-level atomic increment. Concurrent jobs for the same user could result in slightly inaccurate monthly totals.
8. **No E2E test automation in CI**: The CI pipeline runs unit and integration tests, but E2E tests (`bun run test:e2e`) are not wired into the GitHub Actions workflow.
9. **Alert rules are hardcoded**: `AlertManager` has fixed thresholds. No configuration file or database-driven alert rules.

### Not Yet Implemented

10. **Supabase Storage for screenshots**: `screenshot_urls` column exists but screenshot upload to Supabase Storage is referenced in JobExecutor but may not be fully wired.
11. **Key rotation automation**: CredentialEncryption supports key rotation via `GH_CREDENTIAL_PREV_KEYS`, but there is no automated rotation script or re-encryption migration tool.
12. **Worker auto-scaling**: Workers must be manually started. No auto-scaling based on queue depth.
13. **Observability dashboard**: `/monitoring/dashboard` aggregates data but there is no dedicated UI consuming it.

---

## Migration Inventory

Run in order:

| File | Creates |
|------|---------|
| `supabase-migration.sql` | gh_action_manuals |
| `supabase-migration-integration.sql` | gh_automation_jobs, gh_job_events, gh_user_credentials, triggers, RLS, Realtime |
| `migrations/001_gh_user_usage.sql` | gh_user_usage |
| `migrations/002_gh_pickup_function.sql` | gh_pickup_next_job() function |
| `migrations/003_expand_job_types.sql` | Expand job_type constraint |
| `migrations/005_add_callback_fields.sql` | callback_url, valet_task_id columns |
| `migrations/006_add_resume_ref.sql` | resume_ref column |
| `migrations/007_add_target_worker_id.sql` | target_worker_id column |
| `migrations/008_gh_browser_sessions.sql` | gh_browser_sessions |
| `migrations/009_hitl_columns.sql` | HITL-related columns |
| `migrations/010_gh_action_manuals.sql` | Additional manual columns |
| `migrations/011_execution_mode_tracking.sql` | engine_type, execution mode columns |
| `migrations/012_gh_job_events_realtime.sql` | Realtime on gh_job_events |
| `migrations/013_gh_worker_registry.sql` | gh_worker_registry |
| `migrations/014_worker_affinity.sql` | Worker affinity routing |

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key (`sb_secret_...`). Legacy name `SUPABASE_SERVICE_KEY` accepted as fallback. |
| `DATABASE_URL` | Postgres connection string (prefer transaction pooler for API) |
| `GH_SERVICE_SECRET` | API authentication key (shared with VALET) |
| `GH_CREDENTIAL_KEY` | 64 hex chars for AES-256-GCM encryption |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GH_API_PORT` | 3100 | API server port |
| `GH_WORKER_PORT` | 3101 | Worker status server port |
| `GH_WORKER_ID` | auto-generated | Worker identity string |
| `GH_MODEL` | -- | Default LLM model alias |
| `GH_IMAGE_MODEL` | -- | Default vision/image LLM model alias |
| `GH_CREDENTIAL_KEY_ID` | -- | Encryption key version identifier |
| `GH_CREDENTIAL_PREV_KEYS` | -- | Previous encryption keys for rotation |
| `SUPABASE_DIRECT_URL` | -- | Direct Postgres URL (session mode, for LISTEN/NOTIFY) |
| `DATABASE_DIRECT_URL` | -- | Alias for direct Postgres URL |
| `EC2_INSTANCE_ID` | -- | EC2 metadata for worker registry |
| `EC2_IP` | -- | EC2 IP for worker registry |
| `REDIS_URL` | -- | Redis connection URL (optional, enables real-time streaming via Redis Streams for SSE) |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
