# Hatchet v1 Workflow Reference for Valet

> Comprehensive SDK reference, workflow patterns, and integration guide for the Valet browser automation orchestration layer. Based on `@hatchet-dev/typescript-sdk ^1.11.0` and the self-hosted hatchet-lite instance.

---

## Table of Contents

1. [SDK Architecture Overview](#1-sdk-architecture-overview)
2. [Workflow & Task Declaration API](#2-workflow--task-declaration-api)
3. [Context API](#3-context-api)
4. [DurableContext API](#4-durablecontext-api)
5. [Worker Configuration](#5-worker-configuration)
6. [DAG Workflows (Declarative)](#6-dag-workflows-declarative)
7. [Child Task Spawning (Procedural)](#7-child-task-spawning-procedural)
8. [Conditional Workflows](#8-conditional-workflows)
9. [Event System](#9-event-system)
10. [Concurrency Control](#10-concurrency-control)
11. [Rate Limiting](#11-rate-limiting)
12. [Retry Policies & Error Handling](#12-retry-policies--error-handling)
13. [Timeout Configuration](#13-timeout-configuration)
14. [Sticky Worker Assignment](#14-sticky-worker-assignment)
15. [Existing Valet Workflows](#15-existing-valet-workflows)
16. [Integration with Valet Architecture](#16-integration-with-valet-architecture)
17. [Best Practices for Browser Automation](#17-best-practices-for-browser-automation)
18. [Workflow Patterns for Job Application](#18-workflow-patterns-for-job-application)

---

## 1. SDK Architecture Overview

The Hatchet v1 TypeScript SDK uses a **factory pattern** (not the v0 object-based pattern) for creating workflows and tasks. This provides:

- Full TypeScript type inference across workflow invocations
- Type-safe input/output handling between tasks
- Logical client organization for environment control
- Eliminated magic string references for workflow names

### Client Initialization

```typescript
import { Hatchet } from "@hatchet-dev/typescript-sdk";

// SDK reads config from environment variables:
//   HATCHET_CLIENT_TOKEN
//   HATCHET_CLIENT_TLS_STRATEGY
//   HATCHET_CLIENT_TLS_SERVER_NAME
//   HATCHET_CLIENT_HOST_PORT
const hatchet = new Hatchet();
```

### Feature Clients

The Hatchet client exposes organized sub-clients:

| Client | Purpose |
|--------|---------|
| `hatchet.runs` | List, replay, cancel workflow runs |
| `hatchet.workflows` | Workflow metadata |
| `hatchet.schedules` | Scheduled runs |
| `hatchet.crons` | Recurring tasks |
| `hatchet.metrics` | Queue depth, etc. |
| `hatchet.events` | Push events |
| `hatchet.workers` | Worker management |
| `hatchet.ratelimits` | Rate limit configuration |
| `hatchet.admin` | Admin operations (runWorkflow) |

### Key Imports

```typescript
import { Hatchet } from "@hatchet-dev/typescript-sdk";
import type { Context, DurableContext } from "@hatchet-dev/typescript-sdk/v1/client/worker/context";
import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types";
import { ConcurrencyLimitStrategy, StickyStrategy, RateLimitDuration } from "@hatchet-dev/typescript-sdk";
```

---

## 2. Workflow & Task Declaration API

### Simple Standalone Task

For single tasks that don't need DAG dependencies:

```typescript
export const simple = hatchet.task({
  name: "simple",
  retries: 3,
  fn: async (input: SimpleInput) => {
    return { TransformedMessage: input.Message.toLowerCase() };
  },
});
```

### Workflow (DAG of Tasks)

For multi-step workflows with task dependencies:

```typescript
type DagInput = { Message: string };
type DagOutput = {
  toLower: { TransformedMessage: string };
  reverse: { Original: string; Transformed: string };
};

export const dag = hatchet.workflow<DagInput, DagOutput>({
  name: "my-workflow",
  // Optional: trigger on events
  onEvents: ["my-event:create"],
  // Optional: concurrency control
  concurrency: { maxRuns: 5, limitStrategy: ConcurrencyLimitStrategy.QUEUE },
});
```

### Registering Tasks on a Workflow

```typescript
const step1 = dag.task({
  name: "step1",
  executionTimeout: "60s",
  scheduleTimeout: "5m",
  retries: 3,
  fn: async (input: DagInput, ctx: Context<DagInput>) => {
    return { result: input.Message.toLowerCase() };
  },
});

const step2 = dag.task({
  name: "step2",
  parents: [step1],         // <-- DAG dependency
  executionTimeout: "30s",
  fn: async (input: DagInput, ctx: Context<DagInput>) => {
    const prev = await ctx.parentOutput(step1) as { result: string };
    return { reversed: prev.result.split("").reverse().join("") };
  },
});
```

### Durable Task Registration

```typescript
const durableStep = dag.durableTask({
  name: "durable-step",
  executionTimeout: "300s",
  parents: [step2],
  fn: async (input: DagInput, ctx: DurableContext<DagInput>) => {
    // Can use waitFor, sleepFor — see DurableContext section
    await ctx.waitFor({ eventKey: "approval_received" });
    return { approved: true };
  },
});
```

### Task Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Task identifier |
| `fn` | `(input, ctx) => Promise<T>` | required | Task function |
| `parents` | `TaskRef[]` | `[]` | DAG parent dependencies |
| `executionTimeout` | `string` | `"60s"` | Max execution time (e.g., `"30s"`, `"5m"`, `"1h"`) |
| `scheduleTimeout` | `string` | `"5m"` | Max queue wait time |
| `retries` | `number` | `0` | Max retry attempts |
| `backoff` | `{ maxSeconds, factor }` | none | Exponential backoff config |
| `rateLimits` | `RateLimitConfig[]` | none | Rate limit consumption |
| `skipIf` | `Condition[]` | none | Skip conditions |
| `waitFor` | `Condition[]` | none | Pre-execution wait conditions |
| `cancelIf` | `Condition[]` | none | Cancellation conditions |

### Execution Methods

Tasks and workflows support direct execution:

```typescript
// Run and wait for result (typed)
const result = await dag.run({ Message: "hello" });

// Run without waiting (fire-and-forget)
const runRef = await dag.runNoWait({ Message: "hello" });
const runId = await runRef.getWorkflowRunId();

// Get result later
const result = await runRef.result();

// Schedule for future execution
await dag.schedule(new Date("2025-06-01"), { Message: "hello" });

// Recurring execution
await dag.cron("daily-run", "0 9 * * *", { Message: "hello" });
```

### On-Failure Handler

One per workflow. Executes when any task fails:

```typescript
dag.onFailure({
  name: "on-failure",
  fn: async (input, ctx) => {
    console.log("Workflow failed, run:", ctx.workflowRunId());
    // Send alert, cleanup resources, etc.
    return { handled: true };
  },
});
```

---

## 3. Context API

`Context<T>` is provided to every regular task function. `T` is the workflow input type.

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `ctx.input()` | `T` | Workflow input data (same as `input` param) |
| `ctx.parentOutput(taskRef)` | `Promise<unknown>` | Output of a parent task |
| `ctx.workflowRunId()` | `string` | Current workflow run ID |
| `ctx.retryCount()` | `number` | Current retry attempt (0-based) |
| `ctx.log(message)` | `void` | Log message visible in Hatchet dashboard |
| `ctx.refreshTimeout(duration)` | `void` | Extend execution timeout (e.g., `"15s"`) |
| `ctx.runChild(taskRef, input, opts?)` | `Promise<T>` | Spawn a child task and wait for result |
| `ctx.filterPayload()` | `object` | Event filter payload (if event-triggered) |
| `ctx.wasSkipped(taskRef)` | `boolean` | Check if a parent task was skipped |

### parentOutput Usage

```typescript
const fillFields = workflow.task({
  name: "fill-fields",
  parents: [analyzeForm],
  fn: async (input, ctx) => {
    // Cast to expected shape — Hatchet serializes/deserializes via JSON
    const prev = await ctx.parentOutput(analyzeForm) as {
      formFlow: FormFlow;
      platform: string;
    };
    // Use prev.formFlow...
  },
});
```

**Important**: Parent outputs are JSON-serialized. Only plain objects, arrays, strings, numbers, booleans, and null survive. No class instances, functions, Buffers, or Dates (use ISO strings).

---

## 4. DurableContext API

`DurableContext<T>` extends `Context<T>` with durable execution primitives. Only available in tasks registered with `workflow.durableTask()`.

When you register a durable task, Hatchet spawns a **separate durable worker** in the background. Both the regular and durable workers appear in the Hatchet dashboard.

### Additional Methods (beyond Context)

| Method | Description |
|--------|-------------|
| `ctx.waitFor({ eventKey, expression?, timeout? })` | Durably wait for an external event |
| `ctx.sleepFor(duration)` | Durably sleep (survives restarts) |

### waitFor

Pauses execution until an external event matching the key is received. If the task is interrupted and restarted, the event will still be processed on resumption.

```typescript
// Simple wait
await ctx.waitFor({ eventKey: "captcha_solved" });

// Wait with CEL expression filter
await ctx.waitFor({
  eventKey: "review_approved",
  expression: "input.taskId == '123'",
});
```

### sleepFor

Durably sleeps for the specified duration. Unlike `setTimeout`, if the task is interrupted after sleeping 23 of 24 hours, on restart it sleeps only the remaining 1 hour.

```typescript
await ctx.sleepFor("5s");   // 5 seconds
await ctx.sleepFor("10m");  // 10 minutes
await ctx.sleepFor("1h");   // 1 hour
```

### Or Groups (Conditional Waits)

Wait for whichever condition completes first:

```typescript
// TypeScript: wait for event OR timeout
const waitForSleep = workflow.task({
  name: "wait-for-event-or-timeout",
  parents: [start],
  waitFor: [
    or_(
      new SleepCondition("60s"),
      new UserEventCondition("my_event:start")
    ),
  ],
  fn: async (input, ctx) => {
    return { completed: true };
  },
});
```

### Determinism Requirement

Durable tasks store intermediate results in an event log. On replay, the same sequence of operations must occur. Rules:

1. **Avoid side effects in the durable task body** — Database writes, HTTP calls, etc. should be in **child tasks** spawned via `ctx.runChild()`.
2. **Preserve operation order during updates** — Changing the sequence of `sleepFor`/`waitFor` calls breaks replay.
3. **Prefer DAGs over durable tasks** when possible — DAGs are inherently deterministic.

### When to Use Durable Tasks

| Use Case | Use Durable? |
|----------|-------------|
| Wait for external event (CAPTCHA solved, user approval) | Yes |
| Long-duration pause (rate limit cooldown, scheduled retry) | Yes |
| Sequential I/O tasks (fetch data, call API) | No — use DAG |
| Parallel independent tasks | No — use child spawning |
| State that must survive worker crash mid-step | Yes |

---

## 5. Worker Configuration

### Creating a Worker

```typescript
const worker = await hatchet.worker("valet-worker", {
  workflows: [jobApplicationWorkflow, resumeParseWorkflow],
  slots: 5,       // Max concurrent task executions
});

await worker.start();
```

### Slots

`slots` controls how many task runs execute concurrently on this worker. Setting `slots: 5` means 5 concurrent tasks; additional tasks queue.

- Increase slots or add workers for higher throughput
- Effectiveness plateaus when bottlenecked by CPU, memory, or network
- For browser automation: each slot may hold a browser session, so slot count = max concurrent browsers

### Graceful Shutdown

```typescript
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down worker...`);
  await worker.stop();          // Drains current tasks
  await redis.quit();
  await sql.end();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

### Worker Best Practices

1. **Reliability** — Deploy in stable environments with adequate resources
2. **Monitoring** — Track worker health and task execution status
3. **Error handling** — Graceful failure reporting and retry management
4. **Secure communication** — Encrypted worker-engine connections
5. **Lifecycle management** — Automatic restarts and graceful shutdowns
6. **Scalability** — Design system to easily add/remove workers
7. **Version consistency** — Keep SDK version compatible with engine

---

## 6. DAG Workflows (Declarative)

DAGs define task sequences where dependencies are known in advance. Each task is a node; dependencies are edges.

### Linear Chain

```
start-browser → analyze-form → fill-fields → upload-resume → submit → verify
```

```typescript
const start = wf.task({ name: "start", fn: ... });
const analyze = wf.task({ name: "analyze", parents: [start], fn: ... });
const fill = wf.task({ name: "fill", parents: [analyze], fn: ... });
```

### Diamond Pattern (Parallel → Merge)

```
         ┌─ fill-personal ─┐
analyze ─┤                  ├─ review
         └─ fill-work ─────┘
```

```typescript
const analyze = wf.task({ name: "analyze", fn: ... });
const personal = wf.task({ name: "fill-personal", parents: [analyze], fn: ... });
const work = wf.task({ name: "fill-work", parents: [analyze], fn: ... });
const review = wf.task({ name: "review", parents: [personal, work], fn: ... });
```

Tasks with the same parent execute in parallel automatically. Tasks with multiple parents wait for all parents to complete.

### Data Passing

Data flows between tasks via `ctx.parentOutput()`. All data is JSON-serialized.

```typescript
const fill = wf.task({
  name: "fill",
  parents: [analyze],
  fn: async (input, ctx) => {
    const analysisResult = await ctx.parentOutput(analyze) as AnalysisOutput;
    // Use analysisResult...
  },
});
```

**Serialization constraints**: Only JSON-safe values survive between tasks. No class instances, Buffers, functions, circular references, or `undefined`.

---

## 7. Child Task Spawning (Procedural)

For dynamic task orchestration where the number or type of child tasks isn't known until runtime.

### Fan-Out Pattern

```typescript
const child = hatchet.task({
  name: "fill-field",
  fn: async (input: { fieldName: string; value: string }) => {
    // Fill single field
    return { filled: true, fieldName: input.fieldName };
  },
});

const parent = hatchet.task({
  name: "fill-all-fields",
  fn: async (input: { fields: FieldMapping[] }, ctx) => {
    const promises = input.fields.map((field) =>
      ctx.runChild(child, { fieldName: field.field.name, value: field.value })
    );

    const results = await Promise.all(promises);
    const allFilled = results.every((r) => r.filled);
    return { allFilled, count: results.length };
  },
});
```

### Error Handling in Child Tasks

```typescript
const parent = hatchet.task({
  name: "parent",
  fn: async (input, ctx) => {
    try {
      const result = await ctx.runChild(child, { N: 1 });
      return { success: true, result };
    } catch (err) {
      // Child task failed — decide what to do
      return { success: false, error: String(err) };
    }
  },
});
```

### Use Cases for Browser Automation

- Spawn one child per form page (dynamic page count)
- Spawn one child per field section (personal info, work history, education)
- Retry individual field fills without restarting entire form
- Conditional child spawning (only run CAPTCHA solver if CAPTCHA detected)

---

## 8. Conditional Workflows

Three condition types control task execution:

### Condition Types

| Type | Description |
|------|-------------|
| `SleepCondition` | Pause for duration before executing |
| `UserEventCondition` | Wait for external event |
| `ParentCondition` | Evaluate parent output with CEL expression |

### wait_for — Delay Execution

```typescript
const delayed = wf.task({
  name: "delayed",
  parents: [start],
  waitFor: [new SleepCondition("10s")],
  fn: async (input, ctx) => {
    // Executes 10s after parent completes
  },
});
```

### skip_if — Conditional Skip

```typescript
const leftBranch = wf.task({
  name: "left-branch",
  parents: [waitForSleep],
  skipIf: [new ParentCondition(waitForSleep, "output.randomNumber > 50")],
  fn: (input) => {
    return { branch: "left" };
  },
});

const rightBranch = wf.task({
  name: "right-branch",
  parents: [waitForSleep],
  skipIf: [new ParentCondition(waitForSleep, "output.randomNumber <= 50")],
  fn: (input) => {
    return { branch: "right" };
  },
});
```

### cancel_if — Cancel Task and Downstream

```typescript
const cancellable = wf.task({
  name: "cancellable",
  parents: [check],
  cancelIf: [new ParentCondition(check, "output.shouldCancel == true")],
  fn: async (input, ctx) => { ... },
});
```

A cancelled task also cancels all downstream dependent tasks.

### Handling Skipped Parents

```typescript
const merge = wf.task({
  name: "merge",
  parents: [leftBranch, rightBranch],
  fn: async (input, ctx) => {
    const leftResult = ctx.wasSkipped(leftBranch)
      ? null
      : await ctx.parentOutput(leftBranch);
    const rightResult = ctx.wasSkipped(rightBranch)
      ? null
      : await ctx.parentOutput(rightBranch);
    return { leftResult, rightResult };
  },
});
```

### CEL Expressions

Conditions use [Common Expression Language](https://github.com/google/cel-spec) for evaluation:

- `output.field == "value"` — String equality
- `output.score > 0.8` — Numeric comparison
- `output.status == "success" && output.count > 0` — Logical AND
- `input.userId == "1234"` — Filter on workflow input

---

## 9. Event System

### Workflow Event Triggers (onEvents)

Workflows can be triggered by named events:

```typescript
const workflow = hatchet.workflow<WorkflowInput>({
  name: "job-application",
  onEvents: ["task:created"],   // Trigger on this event
});
```

Wildcard patterns are supported: `"subscription:*"` matches `subscription:create`, `subscription:renew`, etc.

### Pushing Events from API

```typescript
// From Fastify API routes:
await hatchet.events.push<Input>("task:created", {
  taskId: "uuid",
  jobUrl: "https://...",
  userId: "uuid",
  resumeId: "uuid",
  mode: "copilot",
});

// With additional metadata
await hatchet.events.push("simple-event:create",
  { Message: "hello" },
  { additionalMetadata: { source: "api", priority: "high" } }
);
```

### Durable Event Waits (within durable tasks)

```typescript
// Simple event wait
await ctx.waitFor({ eventKey: "captcha_solved" });

// With CEL filter expression
await ctx.waitFor({
  eventKey: "review_approved",
  expression: "input.taskId == '123'",
});
```

### Pushing Events to Resume Durable Waits

From the API, push the event that a durable task is waiting for:

```typescript
// In task.service.ts — user approves a review
await this.hatchet.event.push("review_approved", {
  taskId: id,
  fieldOverrides: fieldOverrides ?? {},
});

// In task.service.ts — user solves CAPTCHA
await this.hatchet.event.push("captcha_solved", {
  taskId: id,
});
```

### Event Filters

For more precise event routing:

```typescript
// Declarative filter on workflow
const workflow = hatchet.workflow({
  name: "filtered",
  onEvents: ["user:action"],
});

// Dynamic filter creation
hatchet.filters.create({
  workflowId: workflow.id,
  expression: "input.ShouldSkip == false",
  scope: "my-scope",
  payload: { customData: "value" },
});

// Push with scope
hatchet.events.push("user:action",
  { ShouldSkip: false },
  { scope: "my-scope" }
);
```

### Valet Event Flow

```
Frontend                  API (Fastify)                 Hatchet                  Worker
   │                         │                             │                       │
   │ POST /tasks             │                             │                       │
   ├────────────────────────►│                             │                       │
   │                         │ hatchet.admin.runWorkflow() │                       │
   │                         ├────────────────────────────►│                       │
   │                         │                             │  dispatch to worker   │
   │                         │                             ├──────────────────────►│
   │                         │                             │                       │
   │              ... worker executes DAG tasks ...        │                       │
   │                         │                             │                       │
   │                         │                             │  durable waitFor      │
   │                         │                             │◄─── "review_approved" │
   │ POST /tasks/:id/approve │                             │                       │
   ├────────────────────────►│                             │                       │
   │                         │ hatchet.event.push()        │                       │
   │                         ├────────────────────────────►│  resume durable task  │
   │                         │                             ├──────────────────────►│
```

---

## 10. Concurrency Control

### Configuration

```typescript
const workflow = hatchet.workflow<Input, Output>({
  name: "controlled",
  concurrency: {
    maxRuns: 5,                                       // Max concurrent runs
    limitStrategy: ConcurrencyLimitStrategy.QUEUE,     // Queue excess
    expression: "input.userId",                        // Group by user
  },
});
```

### Strategies

| Strategy | Behavior |
|----------|----------|
| `QUEUE` | Excess runs wait in queue (default-like behavior) |
| `GROUP_ROUND_ROBIN` | Fair round-robin across groups sharing concurrency |
| `CANCEL_IN_PROGRESS` | Cancel running tasks when new ones arrive for same key |
| `CANCEL_NEWEST` | Cancel new arrivals, let existing work complete |

### Multiple Concurrency Strategies

```typescript
concurrency: [
  {
    maxRuns: 3,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    expression: "input.userId",     // Per-user limit
  },
  {
    maxRuns: 10,
    limitStrategy: ConcurrencyLimitStrategy.QUEUE,
    expression: "input.platform",   // Per-platform limit
  },
],
```

### Valet Application

- Limit concurrent browser sessions per user (e.g., `maxRuns: 3` grouped by `userId`)
- Prevent overloading a single job platform (group by `platform`)
- Use `CANCEL_IN_PROGRESS` for duplicate submissions to same job URL

---

## 11. Rate Limiting

### Static Rate Limits (pre-declared)

```typescript
// At worker startup
await hatchet.ratelimits.upsert({
  key: "linkedin-api",
  limit: 10,
  duration: RateLimitDuration.MINUTE,
});

// In task definition
const navigate = wf.task({
  name: "navigate",
  rateLimits: [{ staticKey: "linkedin-api", units: 1 }],
  fn: async (input, ctx) => { ... },
});
```

### Dynamic Rate Limits (per-user/tenant)

```typescript
const task = wf.task({
  name: "fill-field",
  rateLimits: [{
    dynamicKey: "input.userId",
    units: 1,
    limit: 5,      // 5 per duration per userId
  }],
  fn: async (input, ctx) => { ... },
});
```

When limits are exceeded, Hatchet re-queues step runs until capacity becomes available.

---

## 12. Retry Policies & Error Handling

### Simple Retries

```typescript
const task = hatchet.task({
  name: "fragile-task",
  retries: 3,
  fn: async (input, ctx) => {
    const attempt = ctx.retryCount();  // 0, 1, 2, 3
    // ...
  },
});
```

### Exponential Backoff

```typescript
const task = hatchet.task({
  name: "with-backoff",
  retries: 10,
  backoff: {
    maxSeconds: 60,   // Cap wait time
    factor: 2,        // Exponential: 2s, 4s, 8s, 16s, 32s, 60s, 60s...
  },
  fn: async () => {
    throw new Error("will retry with backoff");
  },
});
```

### NonRetryable Errors

Skip the retry queue for permanent failures:

```typescript
import { NonRetryableException } from "@hatchet-dev/typescript-sdk";

const task = wf.task({
  name: "validate",
  retries: 5,
  fn: async (input) => {
    if (!input.jobUrl) {
      throw new NonRetryableException("Missing job URL — will not retry");
    }
    // ... transient failures will retry normally
  },
});
```

Use for: 4XX errors, validation failures, non-idempotent operations that have already executed.

### On-Failure Handler

One per workflow. Runs after all retries are exhausted:

```typescript
workflow.onFailure({
  name: "cleanup-on-failure",
  fn: async (input, ctx) => {
    const runId = ctx.workflowRunId();
    // Close browser session, update task status to "failed",
    // send notification, capture screenshot
    return { handled: true };
  },
});
```

---

## 13. Timeout Configuration

### Time Format

Pattern: `<number><unit>` — `s` (seconds), `m` (minutes), `h` (hours)

Examples: `"10s"`, `"4m"`, `"1h"`

### Execution Timeout

Max time a task can run before being marked failed. Default: `60s`.

```typescript
const longTask = wf.task({
  name: "browser-session",
  executionTimeout: "15m",    // Browser automation can be slow
  fn: async (input, ctx) => { ... },
});
```

### Schedule Timeout

Max time a task can wait in queue before being cancelled. Default: `5m`.

```typescript
const task = wf.task({
  name: "time-sensitive",
  scheduleTimeout: "2m",     // Cancel if not picked up within 2 minutes
  executionTimeout: "60s",
  fn: async (input, ctx) => { ... },
});
```

### Refreshing Timeout During Execution

For tasks where duration is unpredictable:

```typescript
const dynamicTask = wf.task({
  name: "fill-large-form",
  executionTimeout: "60s",
  fn: async (input, ctx) => {
    for (const field of fields) {
      await fillField(field);
      ctx.refreshTimeout("30s");  // Add 30s more for each field
    }
  },
});
```

### Recommended Timeouts for Valet

| Task | Execution | Schedule | Rationale |
|------|-----------|----------|-----------|
| start-browser | 120s | 5m | Browser provisioning can be slow |
| analyze-form | 60s | 5m | Page load + LLM analysis |
| fill-fields | 300s | 5m | Multi-page forms with LLM per field |
| upload-resume | 60s | 5m | File upload |
| check-captcha | 600s | 5m | Human solve time (durable) |
| submit | 60s | 5m | Click + wait for confirmation |
| verify | 30s | 5m | Screenshot + page check |

---

## 14. Sticky Worker Assignment

Ensures all tasks in a workflow run on the same worker. Critical for browser automation where a browser session lives in worker memory.

### Strategies

| Strategy | Behavior |
|----------|----------|
| `SOFT` | Attempt same worker; fall back to another if unavailable |
| `HARD` | Only assign to original worker; pending until available or timeout |

### Configuration

```typescript
// On a standalone task
const sticky = hatchet.task({
  name: "browser-task",
  sticky: StickyStrategy.SOFT,
  fn: async (input, ctx) => { ... },
});

// Child tasks inherit stickiness
const result = await ctx.runChild(childTask, input, { sticky: true });
```

### Requirements for Child Sticky Tasks

1. Child task must define a sticky strategy
2. Child task must be registered with the same worker as parent
3. Failing these conditions throws an error

### Valet Application

Browser automation workflows **should use `SOFT` sticky** to keep all DAG steps on the same worker where the browser session lives. This avoids passing CDP URLs between workers and maintains the live Stagehand/Playwright instance in memory.

```typescript
const workflow = hatchet.workflow<WorkflowInput>({
  name: "job-application",
  onEvents: ["task:created"],
  // All tasks in this workflow should run on same worker
  sticky: StickyStrategy.SOFT,
});
```

---

## 15. Existing Valet Workflows

### job-application (apps/worker/src/workflows/job-application.ts)

**DAG Structure:**

```
start-browser → analyze-form → fill-fields → upload-resume → check-captcha* → submit* → verify
                                                                   (* = durable task)
```

**Input type:**

```typescript
interface WorkflowInput {
  [key: string]: JsonValue;  // Required by Hatchet for serialization
  taskId: string;
  jobUrl: string;
  userId: string;
  resumeId: string;
  mode: "copilot" | "autopilot";
}
```

**Key patterns used:**
- `workflow.task()` for regular tasks with `parents` DAG edges
- `workflow.durableTask()` for `check-captcha` (waitFor CAPTCHA solved) and `submit` (waitFor review approval in copilot mode)
- `ctx.parentOutput(taskRef)` for data passing between tasks
- Redis pub/sub for real-time progress updates to frontend
- `EventLogger` for persistent event storage in DB

### resume-parse (apps/worker/src/workflows/resume-parse.ts)

**DAG Structure:**

```
extract-text → llm-parse → save-results
```

**Triggered by:** `resume:uploaded` event

**Key patterns:**
- S3 download in `extract-text`
- LLM call in `llm-parse` with JSON parsing
- Database write in `save-results`
- Error handling updates resume status to `parse_failed`

---

## 16. Integration with Valet Architecture

### API → Worker (Triggering Workflows)

**Current pattern** (task.service.ts):

```typescript
// Method 1: Direct workflow run (used for task creation)
const runRef = await this.hatchet.admin.runWorkflow("job-application", {
  taskId: task.id,
  jobUrl: task.jobUrl,
  userId,
  resumeId: body.resumeId,
  mode: body.mode,
});
const workflowRunId = await runRef.getWorkflowRunId();

// Method 2: Event push (used for resume upload trigger)
await hatchet.events.push("resume:uploaded", {
  resumeId,
  storageKey,
  userId,
});
```

### API → Worker (Resuming Durable Waits)

```typescript
// User approves field review
await this.hatchet.event.push("review_approved", {
  taskId: id,
  fieldOverrides: fieldOverrides ?? {},
});

// User solves CAPTCHA
await this.hatchet.event.push("captcha_solved", { taskId: id });
```

### Worker → Frontend (Real-time Progress)

Via Redis pub/sub:

```typescript
// Worker publishes to Redis
await redis.publish(`tasks:${userId}`, JSON.stringify({
  type: "progress",
  taskId: input.taskId,
  step: "fill-fields",
  pct: 60,
  message: "Filled 12 fields",
}));

// API subscribes and forwards via WebSocket
// (in apps/api WebSocket route handler)
```

**Message types:**
- `state_change` — Task status transition (e.g., `created` → `provisioning`)
- `progress` — Step progress with percentage and message
- `field_review` — Field values for user review (copilot mode)
- `human_needed` — CAPTCHA or intervention required (includes VNC URL)
- `completed` — Workflow finished with confirmation

### Querying Workflow Status

```typescript
// List runs with filters
const runs = await hatchet.runs.list({
  statuses: [V1TaskStatus.RUNNING, V1TaskStatus.FAILED],
});

// Cancel runs
await hatchet.runs.cancel({ ids: [workflowRunId] });

// Replay failed runs
await hatchet.runs.replay({ ids: failedRunIds });
```

### Worker Health & Reconnection

- Hatchet SDK handles gRPC reconnection internally
- Worker `stop()` drains current tasks gracefully
- Fly.io health checks configured via `fly.toml`
- gRPC uses `h2_backend=true` on Fly.io for HTTP/2

---

## 17. Best Practices for Browser Automation

### Task Granularity

| Too Small | Just Right | Too Large |
|-----------|-----------|-----------|
| One task per keystroke | One task per form page | Entire application in one task |
| No meaningful checkpoint | Checkpoints at natural boundaries | No retry granularity |
| High overhead | Moderate overhead | Single failure = restart everything |

**Recommended granularity for Valet:**
- `provision-browser` — One task
- `analyze-form` — One task (page load + LLM analysis)
- `fill-page-N` — One task per form page (enables page-level retry)
- `upload-resume` — One task
- `check-captcha` — One durable task (may wait indefinitely)
- `submit` — One task (with optional durable wait for copilot approval)
- `verify` — One task (screenshot + confirmation check)

### Durable vs Regular Tasks

| Criteria | Regular Task | Durable Task |
|----------|-------------|-------------|
| Runs to completion quickly | Yes | Overkill |
| May wait for external event | No | Yes |
| Needs long sleep (hours/days) | No | Yes |
| All operations are deterministic | N/A | Required |
| Side effects in task body | OK | Avoid — use child tasks |

### Data Passing Between Tasks

**Do:**
- Pass serializable state (IDs, URLs, JSON objects)
- Use parent outputs for small-to-medium data
- Store large data (screenshots, HTML) in S3/DB; pass references

**Don't:**
- Pass live objects (browser instance, WebSocket, DB connection)
- Pass Buffer/Uint8Array between tasks (use base64 or S3 key)
- Exceed reasonable output size (keep under ~1MB per task output)

### Sharing Browser Sessions

The browser (Stagehand/Playwright) instance cannot be passed between tasks via Hatchet's data channel. Two approaches:

1. **Sticky workers** (recommended): Use `StickyStrategy.SOFT` so all tasks run on the same worker. Store the browser instance in a worker-level Map keyed by `workflowRunId`. Each task looks up the session.

2. **CDP URL passing**: Start browser in task 1, return the CDP URL. Subsequent tasks reconnect via `browser.connectOverCDP(cdpUrl)`. Works across workers but has connection overhead.

### Error Propagation

```typescript
workflow.onFailure({
  name: "handle-failure",
  fn: async (input, ctx) => {
    // 1. Close any open browser session
    // 2. Update task status to "failed" in DB
    // 3. Publish failure event via Redis for frontend
    // 4. Capture final screenshot if browser still alive
    // 5. Log structured error for debugging
  },
});
```

### gRPC Connection Management

- SDK handles reconnection internally
- DO NOT override `tls_config` in constructor — blocks env var reading
- Env vars: `HATCHET_CLIENT_TLS_STRATEGY=tls`, `HATCHET_CLIENT_TLS_SERVER_NAME=*.fly.dev`, `HATCHET_CLIENT_HOST_PORT=*.fly.dev:443`
- Set `SERVER_GRPC_INSECURE=t` on hatchet-lite so it serves h2c internally (Fly.io terminates TLS)

---

## 18. Workflow Patterns for Job Application

### Pattern 1: Sequential with Copilot Pause

```
provision → navigate → analyze → fill → [PAUSE: user review] → submit → verify
```

The `fill` task returns field mappings. In copilot mode, a durable task waits for `review_approved` before proceeding to `submit`.

### Pattern 2: Multi-Page Form with Fan-Out

```
                    ┌── fill-page-1 ──┐
provision → analyze ┤                  ├── upload-resume → submit → verify
                    └── fill-page-2 ──┘
```

Each page is a child task spawned dynamically based on `analyze`'s output.

### Pattern 3: Engine Fallback

```
provision → analyze → fill-with-stagehand
                          │ (on failure)
                          └── fill-with-magnitude
                                  │ (on failure)
                                  └── request-human-takeover
```

Use `retries: 0` on each engine task. On failure, spawn the next engine as a child task.

### Pattern 4: CAPTCHA Handling

```
... → check-captcha ──────────────────────── submit
         │                                      ▲
         │ (captcha detected)                   │
         ├── notify-user (VNC URL)              │
         └── waitFor("captcha_solved") ─────────┘
```

Durable task waits for either `captcha_solved` event or a timeout (e.g., 10 minutes), whichever comes first.

### Pattern 5: Batch Application (Multiple Jobs)

```
Parent workflow spawns N child workflows:

batch-apply
  ├── runChild(job-application, { jobUrl: url1 })
  ├── runChild(job-application, { jobUrl: url2 })
  └── runChild(job-application, { jobUrl: url3 })
```

With concurrency limits to avoid overwhelming platforms:

```typescript
const batchWorkflow = hatchet.workflow({
  name: "batch-apply",
  concurrency: {
    maxRuns: 3,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    expression: "input.userId",
  },
});
```

---

## Appendix: Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HATCHET_CLIENT_TOKEN` | Yes | Auth token for gRPC connection |
| `HATCHET_CLIENT_TLS_STRATEGY` | Fly.io | `tls` for Fly.io, omit for local |
| `HATCHET_CLIENT_TLS_SERVER_NAME` | Fly.io | e.g., `valet-hatchet-stg.fly.dev` |
| `HATCHET_CLIENT_HOST_PORT` | Fly.io | e.g., `valet-hatchet-stg.fly.dev:443` |
| `DATABASE_URL` | Yes | Postgres connection for event logging |
| `REDIS_URL` | Yes | Redis for pub/sub progress updates |
| `S3_ENDPOINT` | Yes | Supabase S3 endpoint |
| `S3_ACCESS_KEY` | Yes | S3 access key |
| `S3_SECRET_KEY` | Yes | S3 secret key |
| `ANTHROPIC_API_KEY` | Yes | For LLM-powered form analysis |

## Appendix: Bulk Operations

```typescript
// List failed runs
const allFailed = await hatchet.runs.list({
  statuses: [V1TaskStatus.FAILED],
});

// Replay all failed
await hatchet.runs.replay({
  ids: allFailed.rows?.map((r) => r.metadata.id),
});

// Cancel runs since a date
await hatchet.runs.cancel({
  filters: { since: new Date("2025-03-27") },
});
```
