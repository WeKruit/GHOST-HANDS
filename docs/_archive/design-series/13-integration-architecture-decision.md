# 13 - VALET-GhostHands Integration Architecture Decision

> Architecture decision record (ADR) evaluating Hatchet, REST API, and Hybrid
> integration approaches between VALET (Next.js web app) and GhostHands
> (Magnitude-based browser automation workers). Includes the recommended
> approach, API contracts, worker implementation, authentication strategy,
> and integration code structure.

---

## Table of Contents

1. [Architecture Decision](#1-architecture-decision)
2. [System Context](#2-system-context)
3. [Options Evaluated](#3-options-evaluated)
4. [Decision: Hybrid with DB-First Queue](#4-decision-hybrid-with-db-first-queue)
5. [API Contract](#5-api-contract)
6. [Job Payload Schema](#6-job-payload-schema)
7. [Worker Implementation](#7-worker-implementation)
8. [Authentication Strategy](#8-authentication-strategy)
9. [Job Status Updates](#9-job-status-updates)
10. [Integration Code Structure](#10-integration-code-structure)
11. [Hatchet Future Upgrade Path](#11-hatchet-future-upgrade-path)
12. [Implementation Plan](#12-implementation-plan)

---

## 1. Architecture Decision

**Decision:** Hybrid architecture with a **database-first job queue** as the
primary orchestration mechanism, a **thin REST API** as the convenience layer
for VALET, and **no Hatchet dependency for MVP**. Hatchet is deferred to Phase 2
as an optional upgrade when concurrency control and DAG workflows become
necessary.

**Status:** Accepted

**Date:** 2026-02-14

---

## 2. System Context

### What Exists Today

- **VALET**: Next.js web app (frontend + API routes). Manages users, resumes,
  subscription tiers. Has no workflow orchestration layer yet.
- **GhostHands**: Magnitude-based browser automation agent. Uses `BrowserAgent`
  from `magnitude-core` with `ManualConnector` for self-learning action
  manuals. Stores manuals in `gh_action_manuals` table in Supabase.
- **Shared Supabase**: Postgres database + S3 storage + Auth. Both systems
  already connected.

### What We Need

VALET needs to:
1. Trigger automation jobs (apply to job, scrape posting, fill form)
2. Pass structured data (resume path, user info, tier, platform, target URL)
3. Authenticate requests securely
4. Receive real-time job status updates
5. Scale workers horizontally without job duplication

### Key Constraints

- **Supabase 60-connection limit** (Pro plan) -- pooler required for app
  connections; direct connection reserved for LISTEN/NOTIFY
- **magnitude-core is vision-based** -- single `agent.act()` call runs an
  autonomous LLM loop (5-15 calls per task). This is NOT a DAG of discrete
  Hatchet-style tasks. The agent loop is self-contained.
- **ManualConnector is built into the agent** -- manual lookup/execute/save
  happen inside the LLM planning loop, not as separate orchestration steps
- **MVP timeline** -- need working integration in days, not weeks

---

## 3. Options Evaluated

### Option A: Hatchet Workflow Orchestration

**How it works:** VALET calls `hatchet.admin.runWorkflow()` to trigger a
`job-application` workflow. The workflow is a DAG of tasks:
`start-browser -> analyze-form -> fill-fields -> check-captcha -> submit -> verify`.
Each task is a Hatchet step with retries, timeouts, and data passing via
`ctx.parentOutput()`. Workers register with Hatchet via gRPC.

**Advantages:**
- Built-in DAG orchestration, retry policies, concurrency control
- Durable task execution (survives worker crashes)
- `StickyStrategy.SOFT` keeps browser session on same worker
- Built-in dashboard for workflow monitoring
- Per-user and per-platform rate limiting via `ConcurrencyLimitStrategy`
- Event system for CAPTCHA/review pauses (`ctx.waitFor()`)

**Disadvantages:**
- **Architectural mismatch**: Magnitude's `BrowserAgent.act()` is a single
  autonomous LLM loop, not a DAG of discrete steps. Breaking it into Hatchet
  tasks means artificially decomposing an agent loop into task boundaries that
  don't naturally exist. The agent decides what to do at each step based on
  screenshots -- this isn't a deterministic workflow.
- **Infrastructure overhead**: Requires a self-hosted hatchet-lite instance
  ($7/mo Fly.io + maintenance). Adds gRPC complexity.
- **Complexity for MVP**: 15+ new files, gRPC config, worker registration,
  token management. Estimated 2-3 weeks to integrate.
- **Durable task determinism constraint**: Durable tasks require deterministic
  replay ordering of `waitFor`/`sleepFor` calls. The LLM agent loop is
  inherently non-deterministic.
- **Connection overhead**: Hatchet uses gRPC for worker communication, adding
  another connection to manage alongside Supabase.

**Verdict:** Excellent orchestration system, but overkill for the current
architecture where the automation is a single autonomous agent call, not a
DAG of discrete steps. The existing doc-08 Hatchet design assumed a different
engine model (Stagehand with discrete DOM actions) that doesn't match how
Magnitude actually works.

### Option B: REST API Only

**How it works:** VALET calls a GhostHands HTTP endpoint
(`POST /api/v1/gh/jobs`) to create a job. A separate GhostHands worker process
polls the database for pending jobs. Job status updates are read by VALET
via polling or Supabase Realtime.

**Advantages:**
- Simple to implement and understand
- No external infrastructure dependencies beyond Supabase
- Matches Magnitude's execution model perfectly (one job = one `agent.act()` call)
- Easy to debug (just HTTP + SQL)

**Disadvantages:**
- No built-in retry/timeout orchestration (must implement in worker)
- No concurrency control (must implement with DB locks)
- No DAG support (not needed for MVP, but limits future flexibility)
- Polling latency (mitigated by Postgres NOTIFY)

**Verdict:** Too bare-bones. Loses the queue semantics (priority, idempotency,
`FOR UPDATE SKIP LOCKED`) that are already designed in doc-12.

### Option C: Hybrid (REST API + DB Queue) -- RECOMMENDED

**How it works:** VALET calls a REST API (or inserts directly into DB) to
create a job row in `gh_automation_jobs`. GhostHands workers poll the database
using `FOR UPDATE SKIP LOCKED` and listen via Postgres `NOTIFY`. The worker
picks up a job, creates a `BrowserAgent` with `ManualConnector`, runs
`agent.act()`, and updates the job row with results. Status updates flow back
to VALET via Supabase Realtime subscriptions.

This is exactly the Dual-Channel Design already specified in doc-12, with the
key insight that the worker executes the entire job as a single
`BrowserAgent.act()` call rather than a Hatchet DAG.

**Advantages:**
- **Matches Magnitude's execution model**: One job = one agent session =
  one `BrowserAgent.act()` call. No artificial task decomposition.
- **Zero external dependencies**: No Hatchet, no Redis, no gRPC. Just
  Supabase (which we already have).
- **Proven patterns**: `FOR UPDATE SKIP LOCKED` is the standard Postgres
  job queue pattern. Battle-tested in production at scale.
- **Real-time updates**: Supabase Realtime on `gh_automation_jobs` gives
  instant status updates to VALET frontend with zero additional infrastructure.
- **Horizontally scalable**: Multiple workers poll the same queue with
  `SKIP LOCKED` -- no contention, no coordination.
- **Already designed**: Doc-12 has the complete schema, API spec, state
  machine, indexes, triggers, and migration SQL ready to deploy.
- **Preserves Hatchet upgrade path**: Can wrap the DB queue in Hatchet
  workflows later without changing the job table structure.
- **Fast to implement**: ~3-5 days for core integration.

**Disadvantages:**
- Must implement retry logic, heartbeat, and stuck job detection ourselves
  (but doc-12 already has the SQL and patterns)
- No built-in DAG orchestration (not needed -- agent loop is autonomous)
- No durable pauses for CAPTCHA (use Supabase Realtime + status polling
  instead of Hatchet `ctx.waitFor()`)

**Verdict:** Best fit for the actual Magnitude architecture. Leverages
existing Supabase infrastructure. Fast to ship.

---

## 4. Decision: Hybrid with DB-First Queue

### Why Not Hatchet (For Now)

The critical insight is that **Magnitude's BrowserAgent is not a DAG**. The
existing Hatchet workflow design in doc-08 was built around a different
assumption: that form filling is decomposable into discrete, predictable
steps (navigate, analyze, fill field 1, fill field 2, ..., submit). In
reality, Magnitude's agent works like this:

```
agent.act("Apply to this job with the following user data: ...")
  -> LLM observes screenshot
  -> LLM decides action (click, type, scroll, etc.)
  -> Agent executes action via Patchright
  -> LLM observes new screenshot
  -> ... repeat 5-15 times until task complete
```

This is a single, autonomous, non-deterministic loop. There are no natural
"task boundaries" for Hatchet to orchestrate. The `ManualConnector` adds
optimization (if a manual exists, the agent replays it with zero LLM calls),
but this happens inside the agent's action space -- it's transparent to the
orchestration layer.

Wrapping this in Hatchet would mean:
1. A single Hatchet task that calls `agent.act()` -- negating the purpose of
   Hatchet's DAG orchestration
2. OR artificially breaking the agent loop into discrete steps -- fighting
   against Magnitude's architecture

Neither is a good use of Hatchet's capabilities.

### When Hatchet Becomes Valuable

Hatchet becomes the right choice when:
- **Batch operations**: Orchestrating 50+ concurrent applications across
  multiple workers with per-user and per-platform concurrency limits
- **Multi-step workflows**: When we add pre/post-processing steps that ARE
  naturally discrete (resume parsing -> job matching -> application ->
  follow-up email)
- **Human-in-the-loop at scale**: When CAPTCHA/review pauses need to survive
  worker restarts via durable execution
- **Analytics pipeline**: When we need workflow-level metrics across tasks

At that point, the DB queue becomes a Hatchet workflow where `agent.act()` is
one task in a larger DAG. The job table structure is compatible with both.

---

## 5. API Contract

### 5.1 Base URL and Versioning

```
Base URL: /api/v1/gh
Content-Type: application/json
```

All endpoints require authentication (see Section 8).

### 5.2 Endpoints

#### Create Job

```
POST /api/v1/gh/jobs
```

**Request:**
```json
{
  "job_type": "apply",
  "target_url": "https://boards.greenhouse.io/company/jobs/12345",
  "task_description": "Apply to Software Engineer position at Company",
  "input_data": {
    "resume_path": "resumes/user-uuid/resume-uuid.pdf",
    "user_data": {
      "first_name": "Jane",
      "last_name": "Doe",
      "email": "jane@example.com",
      "phone": "+1-555-0100",
      "linkedin_url": "https://linkedin.com/in/janedoe"
    },
    "tier": "premium",
    "platform": "greenhouse",
    "qa_overrides": {
      "Are you authorized to work in the US?": "Yes",
      "Desired salary": "150000"
    }
  },
  "priority": 3,
  "max_retries": 3,
  "timeout_seconds": 300,
  "tags": ["greenhouse", "swe"],
  "idempotency_key": "valet-apply-550e8400-greenhouse-12345",
  "metadata": {
    "valet_task_id": "550e8400-e29b-41d4-a716-446655440000",
    "subscription_tier": "premium"
  }
}
```

**Response (201 Created):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pending",
  "created_at": "2026-02-14T10:30:00Z"
}
```

**Response (409 Conflict):**
```json
{
  "error": "duplicate_idempotency_key",
  "existing_job_id": "a1b2c3d4-...",
  "existing_status": "running"
}
```

**Response (422 Validation Error):**
```json
{
  "error": "validation_error",
  "details": [
    { "field": "target_url", "message": "Must be a valid URL" }
  ]
}
```

#### Get Job

```
GET /api/v1/gh/jobs/:id
```

Returns full job record including results, screenshots, and event summary.
See doc-12 Section 4.2 for complete response schema.

#### Get Job Status (Lightweight)

```
GET /api/v1/gh/jobs/:id/status
```

Returns only status fields for efficient polling.
See doc-12 Section 4.3 for response schema.

#### Cancel Job

```
POST /api/v1/gh/jobs/:id/cancel
```

Transitions job to `cancelled` status. Only valid for `pending`, `queued`,
`running`, or `paused` jobs. See doc-12 Section 4.4.

#### List Jobs

```
GET /api/v1/gh/jobs?user_id=<uuid>&status=running,pending&limit=20&offset=0
```

Paginated job list with filters. See doc-12 Section 4.5.

#### Get Job Events

```
GET /api/v1/gh/jobs/:id/events?limit=50
```

Returns event timeline for debugging. See doc-12 Section 4.6.

#### Retry Job

```
POST /api/v1/gh/jobs/:id/retry
```

Re-queues a `failed` or `cancelled` job. See doc-12 Section 4.7.

#### Batch Create Jobs

```
POST /api/v1/gh/jobs/batch
```

Creates multiple jobs in one request. See doc-12 Section 4.8.

### 5.3 Error Response Format

All errors use consistent format:

```json
{
  "error": "error_code_string",
  "message": "Human-readable description",
  "details": {}
}
```

HTTP status codes:
- `400` -- Bad request (malformed JSON)
- `401` -- Unauthorized (missing or invalid token)
- `403` -- Forbidden (user cannot access this resource)
- `404` -- Job not found
- `409` -- Conflict (duplicate idempotency key, invalid state transition)
- `422` -- Validation error (Zod schema failure)
- `429` -- Rate limited
- `500` -- Internal server error

---

## 6. Job Payload Schema

### 6.1 Zod Validation Schema

```typescript
import { z } from 'zod';

// Validated on API ingress before DB insertion
export const CreateJobSchema = z.object({
  job_type: z.enum(['apply', 'scrape', 'fill_form', 'custom']),
  target_url: z.string().url().max(2048),
  task_description: z.string().min(1).max(1000),
  input_data: z.object({
    // Resume reference (S3 path or UUID)
    resume_path: z.string().max(500).optional(),
    resume_id: z.string().uuid().optional(),

    // Customer/user info passed to the agent
    user_data: z.object({
      first_name: z.string().max(100),
      last_name: z.string().max(100),
      email: z.string().email().max(200),
      phone: z.string().max(30).optional(),
      linkedin_url: z.string().url().max(500).optional(),
      // Additional fields as needed
    }).passthrough().optional(),

    // Subscription tier determines engine capabilities
    tier: z.enum(['free', 'starter', 'pro', 'premium']).optional(),

    // Target platform (auto-detected if not provided)
    platform: z.enum([
      'linkedin', 'greenhouse', 'lever', 'workday',
      'icims', 'taleo', 'smartrecruiters', 'other'
    ]).optional(),

    // Pre-answered screening questions
    qa_overrides: z.record(z.string(), z.string()).optional(),
  }).default({}),

  priority: z.number().int().min(1).max(10).default(5),
  scheduled_at: z.string().datetime().nullable().optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
  timeout_seconds: z.number().int().min(30).max(1800).default(300),
  tags: z.array(z.string().max(50)).max(20).default([]),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;
```

### 6.2 How input_data Maps to BrowserAgent

The worker translates `input_data` into a Magnitude `BrowserAgent` call:

```typescript
// Worker: translate job row into agent execution
async function executeJob(job: AutomationJob): Promise<void> {
  const { input_data, target_url, task_description } = job;
  const userData = input_data.user_data;
  const qaOverrides = input_data.qa_overrides;

  // Build the prompt that tells the agent what data to use
  const dataPrompt = buildDataPrompt(userData, qaOverrides);

  // Create agent with ManualConnector for self-learning
  const agent = await startBrowserAgent({
    llm: { provider: 'anthropic', options: { model: 'claude-sonnet-4-5-20250929' } },
    connectors: [new ManualConnector({ supabaseClient: supabase })],
    browser: { cdp: cdpUrl },  // Or launch options
    url: target_url,
  });

  try {
    // Single autonomous call -- agent handles everything
    await agent.act(task_description, {
      prompt: dataPrompt,
      data: { userData, qaOverrides },
    });

    // Extract confirmation if possible
    const result = await agent.extract(
      "Extract any confirmation number, success message, or application ID",
      z.object({
        confirmation_id: z.string().optional(),
        success_message: z.string().optional(),
        submitted: z.boolean(),
      })
    );

    return result;
  } finally {
    await agent.stop();
  }
}
```

### 6.3 Data Prompt Construction

```typescript
function buildDataPrompt(
  userData?: Record<string, any>,
  qaOverrides?: Record<string, string>
): string {
  const parts: string[] = [];

  if (userData) {
    parts.push("Use the following personal information when filling form fields:");
    for (const [key, value] of Object.entries(userData)) {
      if (value) parts.push(`  ${key}: ${value}`);
    }
  }

  if (qaOverrides && Object.keys(qaOverrides).length > 0) {
    parts.push("\nFor screening questions, use these specific answers:");
    for (const [question, answer] of Object.entries(qaOverrides)) {
      parts.push(`  Q: "${question}" -> A: "${answer}"`);
    }
  }

  return parts.join("\n");
}
```

---

## 7. Worker Implementation

### 7.1 Worker Architecture

The GhostHands worker is a long-running Node.js process that:
1. Connects to Supabase (direct connection for LISTEN/NOTIFY)
2. Listens for `gh_job_created` notifications
3. Polls for pending jobs using `FOR UPDATE SKIP LOCKED`
4. Executes jobs using `BrowserAgent.act()`
5. Updates job status and results in the database
6. Sends heartbeats every 30 seconds during execution

```
┌─────────────────────────────────────────────┐
│             GhostHands Worker               │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Job      │  │ Agent    │  │ Heartbeat│  │
│  │ Poller   │  │ Executor │  │ Timer    │  │
│  │          │  │          │  │          │  │
│  │ LISTEN/  │  │ Browser  │  │ UPDATE   │  │
│  │ NOTIFY + │  │ Agent +  │  │ last_    │  │
│  │ poll     │  │ Manual   │  │ heartbeat│  │
│  │ loop     │  │ Connector│  │ every 30s│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │        │
│       └──────────────┼──────────────┘        │
│                      │                       │
│              ┌───────┴───────┐               │
│              │  Supabase     │               │
│              │  (Direct Conn)│               │
│              └───────────────┘               │
└─────────────────────────────────────────────┘
```

### 7.2 Worker Entry Point

```typescript
// src/worker/main.ts
import { createClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';
import { JobPoller } from './jobPoller';
import { JobExecutor } from './jobExecutor';

const WORKER_ID = `worker-${process.env.FLY_REGION || 'local'}-${Date.now()}`;

async function main() {
  // Pooled connection for normal queries
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  // Direct connection for LISTEN/NOTIFY (not through pgbouncer)
  const pgDirect = new PgClient({
    connectionString: process.env.SUPABASE_DIRECT_URL,
  });
  await pgDirect.connect();

  const executor = new JobExecutor({ supabase, workerId: WORKER_ID });
  const poller = new JobPoller({
    supabase,
    pgDirect,
    workerId: WORKER_ID,
    executor,
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_JOBS || '2'),
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, draining...`);
    await poller.stop();
    await pgDirect.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await poller.start();
  console.log(`Worker ${WORKER_ID} started`);
}

main().catch(console.error);
```

### 7.3 Job Poller

```typescript
// src/worker/jobPoller.ts
import { SupabaseClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';
import { JobExecutor } from './jobExecutor';

const POLL_INTERVAL_MS = 5000;  // Fallback polling every 5s

export class JobPoller {
  private supabase: SupabaseClient;
  private pgDirect: PgClient;
  private workerId: string;
  private executor: JobExecutor;
  private maxConcurrent: number;
  private activeJobs: number = 0;
  private running: boolean = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(opts: {
    supabase: SupabaseClient;
    pgDirect: PgClient;
    workerId: string;
    executor: JobExecutor;
    maxConcurrent: number;
  }) {
    this.supabase = opts.supabase;
    this.pgDirect = opts.pgDirect;
    this.workerId = opts.workerId;
    this.executor = opts.executor;
    this.maxConcurrent = opts.maxConcurrent;
  }

  async start(): Promise<void> {
    this.running = true;

    // Listen for new job notifications
    await this.pgDirect.query('LISTEN gh_job_created');
    this.pgDirect.on('notification', () => {
      // Notification received -- try to pick up a job
      if (this.activeJobs < this.maxConcurrent) {
        this.tryPickup();
      }
    });

    // Fallback polling in case NOTIFY is missed
    this.pollTimer = setInterval(() => {
      if (this.activeJobs < this.maxConcurrent) {
        this.tryPickup();
      }
    }, POLL_INTERVAL_MS);

    // Initial pickup attempt
    await this.tryPickup();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.pgDirect.query('UNLISTEN gh_job_created');
    // Wait for active jobs to complete (with timeout)
    const deadline = Date.now() + 30000;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private async tryPickup(): Promise<void> {
    if (!this.running || this.activeJobs >= this.maxConcurrent) return;

    // Atomic pickup with FOR UPDATE SKIP LOCKED
    const { data: job, error } = await this.supabase.rpc(
      'gh_pickup_next_job',
      { p_worker_id: this.workerId }
    );

    if (error || !job) return;  // No jobs available

    this.activeJobs++;
    // Execute in background, don't await
    this.executor.execute(job)
      .catch(err => console.error(`Job ${job.id} failed:`, err))
      .finally(() => {
        this.activeJobs--;
        // Try to pick up another job
        if (this.running) this.tryPickup();
      });
  }
}
```

### 7.4 Job Executor

```typescript
// src/worker/jobExecutor.ts
import { SupabaseClient } from '@supabase/supabase-js';
import { startBrowserAgent, ManualConnector } from 'magnitude-core';
import { z } from 'zod';

interface AutomationJob {
  id: string;
  job_type: string;
  target_url: string;
  task_description: string;
  input_data: Record<string, any>;
  user_id: string;
  timeout_seconds: number;
  max_retries: number;
  retry_count: number;
  metadata: Record<string, any>;
}

export class JobExecutor {
  private supabase: SupabaseClient;
  private workerId: string;

  constructor(opts: { supabase: SupabaseClient; workerId: string }) {
    this.supabase = opts.supabase;
    this.workerId = opts.workerId;
  }

  async execute(job: AutomationJob): Promise<void> {
    const heartbeat = this.startHeartbeat(job.id);

    try {
      // 1. Transition to 'running'
      await this.updateJobStatus(job.id, 'running', 'Starting browser agent');

      // 2. Load user credentials if available
      const credentials = await this.loadCredentials(
        job.user_id,
        this.detectPlatform(job.target_url)
      );

      // 3. Build data prompt from input_data
      const dataPrompt = this.buildDataPrompt(job.input_data);

      // 4. Create and start BrowserAgent
      const agent = await startBrowserAgent({
        llm: {
          provider: 'anthropic',
          options: {
            model: 'claude-sonnet-4-5-20250929',
            apiKey: process.env.ANTHROPIC_API_KEY,
          },
        },
        connectors: [
          new ManualConnector({ supabaseClient: this.supabase }),
        ],
        url: job.target_url,
        // browser: { cdp: cdpUrl }, // When using remote browsers
      });

      // 5. Wire up progress events
      agent.events.on('actionStarted', (action) => {
        this.logJobEvent(job.id, 'step_started', {
          action: action.variant,
        });
      });

      agent.events.on('actionDone', (action) => {
        this.logJobEvent(job.id, 'step_completed', {
          action: action.variant,
        });
      });

      // 6. Execute the task with timeout
      const timeoutMs = job.timeout_seconds * 1000;
      await Promise.race([
        agent.act(job.task_description, {
          prompt: dataPrompt,
          data: job.input_data.user_data,
        }),
        this.timeoutPromise(timeoutMs),
      ]);

      // 7. Extract results
      const result = await agent.extract(
        "Extract confirmation number, success message, or application ID from the page",
        z.object({
          confirmation_id: z.string().optional(),
          success_message: z.string().optional(),
          submitted: z.boolean(),
        })
      );

      // 8. Take final screenshot
      const screenshot = await agent.page.screenshot();
      const screenshotUrl = await this.uploadScreenshot(
        job.id, 'final', Buffer.from(screenshot)
      );

      // 9. Mark completed
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          result_data: result,
          result_summary: result.success_message
            || (result.submitted ? 'Application submitted' : 'Task completed'),
          screenshot_urls: [screenshotUrl],
        })
        .eq('id', job.id);

      await agent.stop();

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = this.classifyError(errorMessage);

      // Check if retryable
      if (this.isRetryable(errorCode) && job.retry_count < job.max_retries) {
        await this.supabase
          .from('gh_automation_jobs')
          .update({
            status: 'pending',  // Re-queue for retry
            retry_count: job.retry_count + 1,
            error_code: errorCode,
            error_details: { message: errorMessage, retry: job.retry_count + 1 },
            worker_id: null,  // Release worker claim
          })
          .eq('id', job.id);
      } else {
        await this.supabase
          .from('gh_automation_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_code: errorCode,
            error_details: { message: errorMessage },
          })
          .eq('id', job.id);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private startHeartbeat(jobId: string): NodeJS.Timeout {
    return setInterval(async () => {
      await this.supabase
        .from('gh_automation_jobs')
        .update({ last_heartbeat: new Date().toISOString() })
        .eq('id', jobId);
    }, 30_000);
  }

  private async updateJobStatus(
    jobId: string, status: string, message?: string
  ): Promise<void> {
    const update: Record<string, any> = {
      status,
      status_message: message,
    };
    if (status === 'running') {
      update.started_at = new Date().toISOString();
      update.last_heartbeat = new Date().toISOString();
    }
    await this.supabase
      .from('gh_automation_jobs')
      .update(update)
      .eq('id', jobId);
  }

  private async logJobEvent(
    jobId: string, eventType: string, metadata?: Record<string, any>
  ): Promise<void> {
    await this.supabase
      .from('gh_job_events')
      .insert({
        job_id: jobId,
        event_type: eventType,
        metadata: metadata || {},
        actor: this.workerId,
      });
  }

  private async loadCredentials(
    userId: string, platform: string
  ): Promise<any | null> {
    const { data } = await this.supabase
      .from('gh_user_credentials')
      .select()
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('is_valid', true)
      .single();
    return data || null;
  }

  private detectPlatform(url: string): string {
    if (url.includes('greenhouse.io')) return 'greenhouse';
    if (url.includes('linkedin.com')) return 'linkedin';
    if (url.includes('lever.co')) return 'lever';
    if (url.includes('myworkdayjobs.com')) return 'workday';
    return 'other';
  }

  private buildDataPrompt(inputData: Record<string, any>): string {
    const parts: string[] = [];
    const userData = inputData.user_data;
    const qaOverrides = inputData.qa_overrides;

    if (userData) {
      parts.push("Use this personal information when filling form fields:");
      for (const [key, value] of Object.entries(userData)) {
        if (value) parts.push(`  ${key}: ${value}`);
      }
    }

    if (qaOverrides && Object.keys(qaOverrides).length > 0) {
      parts.push("\nFor screening questions, use these answers:");
      for (const [question, answer] of Object.entries(qaOverrides)) {
        parts.push(`  Q: "${question}" -> A: "${answer}"`);
      }
    }

    return parts.join("\n");
  }

  private async uploadScreenshot(
    jobId: string, name: string, buffer: Buffer
  ): Promise<string> {
    const path = `gh/jobs/${jobId}/${name}.png`;
    await this.supabase.storage
      .from('screenshots')
      .upload(path, buffer, { contentType: 'image/png', upsert: true });
    const { data } = this.supabase.storage
      .from('screenshots')
      .getPublicUrl(path);
    return data.publicUrl;
  }

  private classifyError(message: string): string {
    if (message.includes('CAPTCHA') || message.includes('captcha'))
      return 'captcha_blocked';
    if (message.includes('login') || message.includes('sign in'))
      return 'login_required';
    if (message.includes('timeout') || message.includes('Timeout'))
      return 'timeout';
    if (message.includes('rate limit'))
      return 'rate_limited';
    if (message.includes('not found') || message.includes('selector'))
      return 'element_not_found';
    if (message.includes('disconnect') || message.includes('connection'))
      return 'network_error';
    return 'internal_error';
  }

  private isRetryable(errorCode: string): boolean {
    const retryable = new Set([
      'captcha_blocked', 'element_not_found', 'timeout',
      'rate_limited', 'network_error', 'internal_error',
    ]);
    return retryable.has(errorCode);
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Job execution timeout')), ms)
    );
  }
}
```

### 7.5 Database Function for Atomic Job Pickup

The worker calls this via `supabase.rpc()`. This replaces the raw SQL from
doc-12 Section 3.5 with a proper Postgres function:

```sql
-- Create a function for atomic job pickup
CREATE OR REPLACE FUNCTION gh_pickup_next_job(p_worker_id TEXT)
RETURNS SETOF gh_automation_jobs AS $$
  WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE gh_automation_jobs
  SET status = 'queued',
      worker_id = p_worker_id,
      updated_at = NOW()
  FROM next_job
  WHERE gh_automation_jobs.id = next_job.id
  RETURNING gh_automation_jobs.*;
$$ LANGUAGE sql;
```

---

## 8. Authentication Strategy

### 8.1 Three Authentication Layers

```
┌───────────────────────────────────────────────────────────────┐
│                    Authentication Layers                       │
├───────────────┬───────────────────────┬───────────────────────┤
│  Frontend     │  VALET Backend        │  GhostHands Worker    │
│  (Browser)    │  (Next.js API Routes) │  (Node.js Process)    │
├───────────────┼───────────────────────┼───────────────────────┤
│  Supabase JWT │  Service-to-Service   │  Supabase Service     │
│  (user auth)  │  HMAC Token           │  Role Key             │
│               │                       │                       │
│  RLS enforces │  GH_SERVICE_SECRET    │  Bypasses RLS         │
│  user_id      │  env var              │  Full DB access       │
│  scoping      │                       │                       │
└───────────────┴───────────────────────┴───────────────────────┘
```

### 8.2 Frontend-to-API Authentication

Users authenticate to VALET via Supabase Auth (email/password, OAuth, etc.).
The Supabase JWT is sent as a Bearer token to GhostHands API endpoints.

RLS policies on `gh_automation_jobs` ensure users can only see their own jobs:
```sql
CREATE POLICY "Users can view own jobs"
  ON gh_automation_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
```

### 8.3 VALET Backend-to-GhostHands API Authentication

For server-to-server calls (Next.js API routes calling GhostHands endpoints),
use an HMAC-signed service token:

```typescript
// VALET backend: create signed request
import crypto from 'crypto';

function createServiceToken(payload: object): string {
  const secret = process.env.GH_SERVICE_SECRET; // Shared secret
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ ...payload, timestamp });
  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return Buffer.from(JSON.stringify({ body, signature })).toString('base64');
}

// GhostHands API: validate service token
function validateServiceToken(token: string): object | null {
  const secret = process.env.GH_SERVICE_SECRET;
  const { body, signature } = JSON.parse(
    Buffer.from(token, 'base64').toString()
  );
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  if (!crypto.timingSafeEqual(
    Buffer.from(signature), Buffer.from(expected)
  )) {
    return null; // Invalid signature
  }
  const parsed = JSON.parse(body);
  // Check timestamp freshness (5 minute window)
  if (Math.abs(Date.now() / 1000 - parsed.timestamp) > 300) {
    return null; // Expired
  }
  return parsed;
}
```

**Alternative (simpler for MVP):** Use a shared API key in the
`X-GH-Service-Key` header. The GhostHands API middleware validates it:

```typescript
// Simpler MVP approach
function authMiddleware(req, res, next) {
  const serviceKey = req.headers['x-gh-service-key'];
  const userJwt = req.headers['authorization']?.replace('Bearer ', '');

  if (serviceKey === process.env.GH_SERVICE_SECRET) {
    // Service-to-service call (VALET backend)
    req.auth = { type: 'service', userId: req.body.user_id };
    return next();
  }

  if (userJwt) {
    // Frontend call -- validate Supabase JWT
    const { data: { user }, error } = await supabase.auth.getUser(userJwt);
    if (error || !user) return res.status(401).json({ error: 'unauthorized' });
    req.auth = { type: 'user', userId: user.id };
    return next();
  }

  return res.status(401).json({ error: 'unauthorized' });
}
```

### 8.4 Worker-to-Database Authentication

Workers use the Supabase `service_role` key, which bypasses RLS and has full
read/write access to all tables. This is necessary because workers need to:
- Read jobs for any user
- Update job status
- Read encrypted credentials
- Write to job events

The `service_role` key is set via `SUPABASE_SERVICE_KEY` environment variable,
never exposed to the frontend.

### 8.5 Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | All | Supabase project URL |
| `SUPABASE_ANON_KEY` | Frontend | Public anon key (RLS enforced) |
| `SUPABASE_SERVICE_KEY` | Worker, API | Service role key (bypasses RLS) |
| `SUPABASE_DIRECT_URL` | Worker | Direct Postgres connection (for LISTEN/NOTIFY) |
| `GH_SERVICE_SECRET` | VALET, API | Shared secret for service-to-service auth |
| `GH_ENCRYPTION_KEY` | Worker | AES-256-GCM key for credential encryption |
| `ANTHROPIC_API_KEY` | Worker | For Magnitude LLM calls |

---

## 9. Job Status Updates

### 9.1 Supabase Realtime (Primary Channel)

VALET frontend subscribes to job updates via Supabase Realtime. This is
already supported by the `gh_automation_jobs` table being added to the
`supabase_realtime` publication (see doc-12 Section 8 migration SQL).

```typescript
// VALET frontend: subscribe to job updates for current user
const channel = supabase
  .channel('my-job-updates')
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'gh_automation_jobs',
      filter: `user_id=eq.${currentUser.id}`,
    },
    (payload) => {
      const job = payload.new;
      // Update UI with job.status, job.status_message, etc.
      onJobUpdate(job);
    }
  )
  .subscribe();
```

### 9.2 Polling Fallback

For environments where Realtime websockets are not available (server-side
rendering, background processes), poll the status endpoint:

```typescript
// VALET backend: poll for job completion
async function waitForJobCompletion(
  jobId: string, timeoutMs: number = 600_000
): Promise<AutomationJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data: job } = await supabase
      .from('gh_automation_jobs')
      .select()
      .eq('id', jobId)
      .single();

    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }

    await new Promise(r => setTimeout(r, 2000)); // Poll every 2s
  }
  throw new Error(`Job ${jobId} did not complete within timeout`);
}
```

### 9.3 Webhook Callbacks (Optional)

For fire-and-forget workflows where VALET needs asynchronous notification:

```json
{
  "metadata": {
    "webhook_url": "https://valet.wekruit.com/api/webhooks/gh-job",
    "webhook_events": ["completed", "failed"],
    "webhook_secret": "whsec_..."
  }
}
```

The worker checks for `metadata.webhook_url` after status transitions and
sends a signed POST. See doc-12 Section 7.2 for webhook payload format.

---

## 10. Integration Code Structure

### 10.1 File Layout

```
magnitude-source/
  packages/
    magnitude-core/
      src/
        connectors/
          manualConnector.ts      # Existing -- no changes needed
        agent/
          browserAgent.ts         # Existing -- no changes needed
        ...

  src/                            # NEW: GhostHands worker + API
    worker/
      main.ts                     # Worker entry point
      jobPoller.ts                # LISTEN/NOTIFY + poll loop
      jobExecutor.ts              # BrowserAgent integration
      heartbeat.ts                # Heartbeat timer
      stuckJobDetector.ts         # Background process for stuck jobs
    api/
      server.ts                   # Express/Fastify server
      routes/
        jobs.ts                   # CRUD routes for gh_automation_jobs
        health.ts                 # Health check endpoint
      middleware/
        auth.ts                   # Authentication middleware
        validation.ts             # Zod validation middleware
      schemas/
        job.ts                    # Zod schemas (CreateJobSchema, etc.)
    shared/
      types.ts                    # Shared TypeScript types
      errors.ts                   # Error codes and classification
      platform.ts                 # Platform detection utilities
```

### 10.2 VALET Integration Code

VALET (Next.js app) integrates via a thin client:

```typescript
// valet/lib/ghosthands-client.ts
import { createClient } from '@supabase/supabase-js';

interface CreateJobOptions {
  jobType: 'apply' | 'scrape' | 'fill_form' | 'custom';
  targetUrl: string;
  taskDescription: string;
  resumePath?: string;
  userData?: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    linkedin_url?: string;
  };
  tier?: 'free' | 'starter' | 'pro' | 'premium';
  platform?: string;
  qaOverrides?: Record<string, string>;
  priority?: number;
  idempotencyKey?: string;
}

export class GhostHandsClient {
  private supabase;

  constructor(supabaseUrl: string, serviceKey: string) {
    // Use service key for backend-to-backend communication
    this.supabase = createClient(supabaseUrl, serviceKey);
  }

  async createJob(userId: string, options: CreateJobOptions) {
    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .insert({
        user_id: userId,
        created_by: 'valet',
        job_type: options.jobType,
        target_url: options.targetUrl,
        task_description: options.taskDescription,
        input_data: {
          resume_path: options.resumePath,
          user_data: options.userData,
          tier: options.tier,
          platform: options.platform,
          qa_overrides: options.qaOverrides,
        },
        priority: options.priority || 5,
        idempotency_key: options.idempotencyKey,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getJob(jobId: string) {
    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .select()
      .eq('id', jobId)
      .single();

    if (error) throw error;
    return data;
  }

  async cancelJob(jobId: string) {
    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .update({ status: 'cancelled' })
      .eq('id', jobId)
      .in('status', ['pending', 'queued', 'running', 'paused'])
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async listJobs(userId: string, filters?: {
    status?: string[];
    limit?: number;
    offset?: number;
  }) {
    let query = this.supabase
      .from('gh_automation_jobs')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (filters?.status?.length) {
      query = query.in('status', filters.status);
    }
    if (filters?.limit) query = query.limit(filters.limit);
    if (filters?.offset) query = query.range(
      filters.offset,
      filters.offset + (filters.limit || 20) - 1
    );

    const { data, error, count } = await query;
    if (error) throw error;
    return { jobs: data, total: count };
  }
}
```

### 10.3 VALET Usage Example (Next.js API Route)

```typescript
// valet/app/api/apply/route.ts
import { GhostHandsClient } from '@/lib/ghosthands-client';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';

const gh = new GhostHandsClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(request: Request) {
  // Authenticate user
  const supabase = createRouteHandlerClient({ cookies });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json();

  // Create GhostHands job
  const job = await gh.createJob(user.id, {
    jobType: 'apply',
    targetUrl: body.jobUrl,
    taskDescription: `Apply to ${body.jobTitle} at ${body.company}`,
    resumePath: body.resumePath,
    userData: {
      first_name: body.firstName,
      last_name: body.lastName,
      email: body.email,
      phone: body.phone,
    },
    tier: body.subscriptionTier,
    platform: body.platform,
    qaOverrides: body.qaOverrides,
    idempotencyKey: `valet-apply-${user.id}-${body.jobUrl}`,
  });

  return Response.json({ jobId: job.id, status: job.status }, { status: 201 });
}
```

---

## 11. Hatchet Future Upgrade Path

When the system needs multi-step orchestration (batch applications,
pre/post-processing pipelines), Hatchet can be layered on top:

### Upgrade Strategy

1. **Keep the DB queue** -- `gh_automation_jobs` remains the source of truth
2. **Hatchet wraps the queue** -- A Hatchet workflow reads from the DB queue
   and dispatches to workers
3. **Agent execution stays the same** -- `BrowserAgent.act()` is still the
   core execution unit, now called from a Hatchet task instead of the poller

```typescript
// Future: Hatchet workflow wrapping the existing job executor
const applyWorkflow = hatchet.workflow<WorkflowInput>({
  name: 'apply-job',
  onEvents: ['gh:job_created'],
  sticky: StickyStrategy.SOFT,
  concurrency: {
    maxRuns: 3,
    expression: 'input.userId',
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
});

// Pre-processing: validate resume, check rate limits
const precheck = applyWorkflow.task({
  name: 'precheck',
  fn: async (input, ctx) => {
    // ... validation logic
    return { approved: true };
  },
});

// Core execution: exactly what the current worker does
const execute = applyWorkflow.task({
  name: 'execute',
  parents: [precheck],
  executionTimeout: '300s',
  fn: async (input, ctx) => {
    const executor = new JobExecutor({ supabase, workerId });
    await executor.execute(input.job);
    return { completed: true };
  },
});

// Post-processing: send notification, update analytics
const postProcess = applyWorkflow.task({
  name: 'post-process',
  parents: [execute],
  fn: async (input, ctx) => {
    // ... notification and analytics logic
    return { notified: true };
  },
});
```

### Migration Path

1. Deploy Hatchet (self-hosted hatchet-lite on Fly.io)
2. Create Hatchet workflows that call existing `JobExecutor.execute()`
3. Switch VALET from direct DB insert to Hatchet event push
4. Decommission the polling-based `JobPoller`
5. The DB queue tables remain unchanged -- Hatchet tasks update them

No breaking changes to the API, no schema migrations, no client-side changes.

---

## 12. Implementation Plan

### Phase 0: Database Setup (Day 1)

- [x] Review and finalize doc-12 migration SQL
- [ ] Deploy migration to Supabase (gh_automation_jobs, gh_job_events,
  gh_user_credentials tables)
- [ ] Create `gh_pickup_next_job` function
- [ ] Verify NOTIFY trigger works
- [ ] Verify RLS policies
- [ ] Verify Supabase Realtime subscription works

### Phase 1: Worker Core (Days 2-3)

- [ ] Implement `src/worker/main.ts` entry point
- [ ] Implement `src/worker/jobPoller.ts` (LISTEN/NOTIFY + polling)
- [ ] Implement `src/worker/jobExecutor.ts` (BrowserAgent integration)
- [ ] Implement heartbeat mechanism
- [ ] Implement stuck job detection
- [ ] Test: insert job row -> worker picks up -> agent executes -> status updated
- [ ] Test: multiple workers compete for jobs (SKIP LOCKED)

### Phase 2: REST API (Days 3-4)

- [ ] Implement API server with authentication middleware
- [ ] Implement CRUD routes (create, get, list, cancel, retry, batch)
- [ ] Implement Zod validation
- [ ] Write API integration tests
- [ ] Test: VALET creates job via API -> worker executes -> Realtime update

### Phase 3: VALET Client Library (Day 5)

- [ ] Implement `GhostHandsClient` class
- [ ] Implement example Next.js API route
- [ ] Implement frontend Realtime subscription for job updates
- [ ] End-to-end test: user submits application -> job created -> executed ->
  result displayed

### Phase 4: Production Hardening (Days 6-7)

- [ ] Add structured logging (pino)
- [ ] Add error alerting
- [ ] Add monitoring for queue depth, execution time, failure rate
- [ ] Load test with 20 concurrent jobs
- [ ] Document deployment procedure

---

*Last updated: 2026-02-14*

*Depends on:*
- [12-valet-ghosthands-integration.md](./12-valet-ghosthands-integration.md) -- DB schema, API spec, migration SQL
- [08-comprehensive-integration-plan.md](./08-comprehensive-integration-plan.md) -- VALET architecture context
- [06-hatchet-workflow-reference.md](./06-hatchet-workflow-reference.md) -- Hatchet SDK reference (for future upgrade)

*Consumed by: Worker implementation, VALET integration, deployment pipeline*
