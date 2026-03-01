# PRD: Mastra Orchestration for GHOST-HANDS (V5.2)

**Author:** Codex + Claude (final)
**Date:** 2026-03-01
**Status:** Final Draft
**Supersedes:** V2, V3, V4, V5, V5.1

---

## 1. Why V5.2 Exists

V5.1 resolved most structural issues but still left implementation blockers:

1. `mastra_run_id` lifecycle was referenced but not defined.
2. Migration checklist did not guarantee DB acceptance of `execution_mode='mastra'`.
3. Blocker detection snippet used incorrect `observeWithBlockerDetection()` shape.
4. Handler outcome mapping still risked regressions for `awaitingUserReview` flows.
5. Finalization extraction was underspecified for parity-critical branches.

This V5.2 closes those gaps and makes Phase 1 directly implementable.

---

## 2. Current-State Baseline (Verified)

1. Active runtime path is in `JobExecutor` using `ExecutionEngine` then handler fallback.
2. `V3ExecutionEngine` exists but is not wired by `JobExecutor`.
3. Current `execution_mode` enum in VALET schemas:
   - `auto`, `ai_only`, `cookbook_only`, `hybrid`, `smart_apply`, `agent_apply`
4. Existing HITL resume route stores resolution data, emits `pg_notify('gh_job_resume')`, sets status.
5. Dispatch modes:
   - `legacy` (`JobPoller`, pending/queued DB pickup)
   - `queue` (`PgBossConsumer`, queue-delivered payloads)

---

## 3. Scope and Phase Boundaries

## 3.1 Phase 1 (Shippable)

1. Add `execution_mode='mastra'` (backward compatible).
2. Mastra workflow wraps active cookbook + handler execution path.
3. Durable suspend/resume for checkpoint-safe blocker points that occur before handler deep execution.
4. Worker-owned resume (API stores intent; worker performs workflow resume).

## 3.2 Explicit Phase-1 Limits

1. No claim of exact mid-page browser continuation after crash.
2. No per-page decomposition of SmartApply loop in Phase 1.
3. No queue-mode resume support in Phase 1 unless a queue enqueue path is implemented in API process.

## 3.3 Phase 2+

1. SmartApply checkpoint callback/decomposition.
2. Broader suspend coverage inside handler loop.
3. Queue-mode resume support (if not delivered in Phase 1).

---

## 4. Binding Decisions

### AD-1: Backward-Compatible Mode Contract

Append `mastra`, do not remove any existing values:

```ts
z.enum(['auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'])
```

### AD-2: Worker-Owned Resume

`/valet/resume/:jobId` for mastra jobs:

1. store resolution payload in DB
2. mark resume intent in metadata
3. set resumable status
4. wake dispatcher using mode-specific mechanism

API does not call `workflow.resume()` directly.

### AD-3: Secret-Safe Resume

Workflow resume schema contains only non-sensitive metadata (e.g. `resolutionType`, `resumeNonce`).

Sensitive `resolution_data` stays DB-only:

1. worker reads it
2. injects into browser if needed
3. clears immediately

### AD-4: Honest Recovery Scope

Crash during suspension resumes from workflow checkpoint, then runtime is rehydrated:

1. create adapter/browser
2. navigate to target URL
3. restore session
4. continue from checkpoint

If context mismatch is detected, emit `context_lost` HITL event and pause again.

### AD-5: Idempotency by Persistence

Introduce callback dedupe persistence:

- new table `gh_callback_dedupe(job_id, event_type, nonce, created_at, PRIMARY KEY(job_id, event_type, nonce))`

Callbacks emit only when dedupe insert succeeds.

### AD-6: Canonical Mastra Run-ID Lifecycle

Each mastra job has exactly one active run identity in `metadata.mastra_run_id`.

1. On first mastra execution in `JobExecutor`, create `mastra_run_id` and persist it before execute/suspend paths.
2. API resume requires `metadata.mastra_run_id` to exist; otherwise reject with `409 invalid_state`.
3. Worker resume path must use the persisted `mastra_run_id` from job metadata and never synthesize a new one.
4. If run recreation is required (rare corruption path), worker sets `metadata.mastra_run_recreated=true` and emits `context_lost`.

### AD-7: Deterministic Queue-Mode Rule (Phase 1)

Phase 1 behavior is explicit:

1. `JOB_DISPATCH_MODE=legacy`: resume is supported.
2. `JOB_DISPATCH_MODE=queue` without API enqueue support: resume request is rejected with explicit `409 unsupported_mode`.
3. Reject path performs no state mutation (`status` remains `paused`, `resume_requested` unchanged).

---

## 5. Corrected Workflow Contract

V5 had step shape mismatch. V5.2 keeps a single composable state object and fixes outcome semantics.

## 5.1 Serializable Workflow State

```ts
const workflowState = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
  targetUrl: z.string().url(),
  platform: z.string().default('other'),
  qualityPreset: z.enum(['speed', 'balanced', 'quality']),
  budgetUsd: z.number(),

  cookbook: z.object({
    attempted: z.boolean().default(false),
    success: z.boolean().default(false),
    manualId: z.string().nullable().default(null),
    steps: z.number().default(0),
    error: z.string().nullable().default(null),
  }),

  handler: z.object({
    attempted: z.boolean().default(false),
    success: z.boolean().default(false),
    taskResult: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).optional(),
      error: z.string().optional(),
      screenshotUrl: z.string().optional(),
      keepBrowserOpen: z.boolean().optional(),
      awaitingUserReview: z.boolean().optional(),
    }).nullable().default(null),
  }),

  hitl: z.object({
    blocked: z.boolean().default(false),
    blockerType: z.string().nullable().default(null),
    resumeNonce: z.string().nullable().default(null),
    checkpoint: z.string().nullable().default(null),
  }),

  metrics: z.object({
    costUsd: z.number().default(0),
    pagesProcessed: z.number().default(0),
  }),

  status: z.enum(['running', 'suspended', 'awaiting_user_review', 'completed', 'failed']).default('running'),
});
```

Each step input and output is `workflowState` to guarantee `.then()` compatibility.

## 5.2 Runtime Context (Not Persisted)

```ts
interface RuntimeContext {
  job: AutomationJob;
  handler: TaskHandler;
  adapter: HitlCapableAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  credentials: Record<string, string> | null;
  dataPrompt: string;
  resumeFilePath: string | null;
  supabase: SupabaseClient;
  logEvent: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
}
```

Runtime context is closure-injected; never part of schemas.

## 5.3 Workflow Steps (Phase 1)

1. `check_blockers_checkpoint`
   - if blocked: pause side effects + `suspend()` + set `status='suspended'`
2. `cookbook_attempt`
   - wraps current `ExecutionEngine.execute(...)`
3. `execute_handler`
   - executes resolved handler path and writes `handler.taskResult` plus parity-safe status hints

Branching:

- if cookbook success: skip `execute_handler`
- else run `execute_handler`

Output of workflow is `workflowState`; `handler.taskResult` is the source for existing finalization.

Note: `finalize_state` from earlier drafts is removed. Finalization (screenshot, session save, callbacks, cost recording) stays in `JobExecutor` after the workflow returns, not inside the workflow. The workflow is responsible for execution only; the caller is responsible for side effects. This avoids duplicating the ~150 lines of finalization logic.

## 5.4 Runtime Context Injection

Mastra's `createStep()` returns a static step definition. Runtime context (adapter, page, costTracker) cannot be passed through step schemas. We use a factory pattern: step definitions are created at workflow start with runtime context bound via closure.

```ts
// workflows/mastra/steps/factory.ts

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { workflowState } from '../types.js';
import type { RuntimeContext } from '../types.js';
import type { BlockerType } from '../../../detection/BlockerDetector.js';

function mapBlockerCategory(category: string): BlockerType {
  if (category === 'unknown') return 'verification';
  return category as BlockerType;
}

/**
 * Build all workflow steps with runtime context captured via closure.
 * Called once per job execution in JobExecutor.runMastraWorkflow().
 */
export function buildSteps(rt: RuntimeContext) {
  const checkBlockers = createStep({
    id: 'check_blockers_checkpoint',
    inputSchema: workflowState,
    outputSchema: workflowState,
    resumeSchema: z.object({
      resolutionType: z.enum(['manual', 'code_entry', 'credentials', 'skip']),
      resumeNonce: z.string().uuid(),
    }),
    execute: async ({ inputData, resumeData, suspend }) => {
      const state = { ...inputData };

      if (resumeData) {
        // ── Resumed from HITL ──
        // Read sensitive resolution_data from DB (NOT from resumeData)
        const resolution = await readAndClearResolutionData(rt.supabase, state.jobId);
        if (resolution) {
          await injectResolution(rt.adapter, resolution);
        }
        await rt.adapter.resume?.({ resolutionType: resumeData.resolutionType });

        // Verify blocker resolved (up to 3 attempts)
        for (let i = 0; i < 3; i++) {
          const stillBlocked = await detectBlockers(rt.adapter);
          if (!stillBlocked) break;
          if (i === 2) {
            // Blocker persists — re-suspend with context_lost
            await emitContextLost(rt, state);
            return await suspend({ blockerType: 'context_lost' });
          }
          await rt.adapter.page.waitForTimeout(2000);
        }

        state.hitl.blocked = false;
        state.hitl.blockerType = null;
        return state;
      }

      // ── Fresh blocker check ──
      const observation = await rt.adapter.observeWithBlockerDetection('Check for blockers');
      const blocker = observation.blockers
        .filter((b) => b.confidence > 0.6)
        .sort((a, b) => b.confidence - a.confidence)[0];

      if (blocker) {
        const blockerType = mapBlockerCategory(blocker.category);

        // Side effects before suspend
        await pauseJob(rt.supabase, state.jobId);
        await rt.logEvent('blocker_detected', {
          type: blockerType,
          confidence: blocker.confidence,
          description: blocker.description,
        });
        await sendNeedsHumanCallback(rt, state, {
          type: blockerType,
          confidence: blocker.confidence,
          details: blocker.description,
          source: 'observe',
        });

        state.hitl.blocked = true;
        state.hitl.blockerType = blockerType;
        state.status = 'suspended';

        // Suspend — workflow state serialized to Postgres, worker freed
        return await suspend({
          blockerType,
          pageUrl: await rt.adapter.getCurrentUrl(),
        });
      }

      return state;
    },
  });

  const cookbookAttempt = createStep({
    id: 'cookbook_attempt',
    inputSchema: workflowState,
    outputSchema: workflowState,
    execute: async ({ inputData }) => {
      const state = { ...inputData };
      const engine = new ExecutionEngine({
        manualStore: new ManualStore(rt.supabase),
        cookbookExecutor: new CookbookExecutor({ logEvent: rt.logEvent }),
      });

      const result = await engine.execute({
        job: rt.job,
        adapter: rt.adapter,
        costTracker: rt.costTracker,
        progress: rt.progress,
        logEvent: rt.logEvent,
        resumeFilePath: rt.resumeFilePath,
      });

      state.cookbook.attempted = true;
      state.cookbook.success = result.success;
      state.cookbook.manualId = result.manualId ?? null;
      state.cookbook.steps = result.cookbookSteps ?? 0;
      state.cookbook.error = result.success ? null : (result.error ?? 'cookbook_miss');
      state.metrics.costUsd = rt.costTracker.getSnapshot().totalCost;
      return state;
    },
  });

  const executeHandler = createStep({
    id: 'execute_handler',
    inputSchema: workflowState,
    outputSchema: workflowState,
    execute: async ({ inputData }) => {
      const state = { ...inputData };

      const ctx: TaskContext = {
        job: rt.job,
        adapter: rt.adapter,
        costTracker: rt.costTracker,
        progress: rt.progress,
        credentials: rt.credentials,
        dataPrompt: rt.dataPrompt,
        resumeFilePath: rt.resumeFilePath,
      };

      const result = await rt.handler.execute(ctx);
      const cost = rt.costTracker.getSnapshot();
      const awaitingReview = result.awaitingUserReview === true || result.keepBrowserOpen === true;

      state.handler.attempted = true;
      state.handler.success = result.success || awaitingReview;
      state.handler.taskResult = {
        success: result.success,
        data: result.data,
        error: result.error,
        keepBrowserOpen: result.keepBrowserOpen,
        awaitingUserReview: result.awaitingUserReview,
      };
      state.metrics.costUsd = cost.totalCost;
      state.metrics.pagesProcessed = result.data?.pages_processed ?? 0;
      if (awaitingReview) {
        state.status = 'awaiting_user_review';
      } else {
        state.status = result.success ? 'completed' : 'failed';
      }
      return state;
    },
  });

  return { checkBlockers, cookbookAttempt, executeHandler };
}
```

## 5.5 Workflow Assembly

```ts
// workflows/mastra/applyWorkflow.ts

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { workflowState } from './types.js';
import { buildSteps } from './steps/factory.js';
import type { RuntimeContext } from './types.js';

/**
 * Build and return a configured workflow instance.
 * Called per-job because steps capture runtime context via closure.
 */
export function buildApplyWorkflow(rt: RuntimeContext) {
  const { checkBlockers, cookbookAttempt, executeHandler } = buildSteps(rt);

  return createWorkflow({
    id: 'gh_apply',
    inputSchema: workflowState,
    outputSchema: workflowState,
  })
    .then(checkBlockers)
    .then(cookbookAttempt)
    .branch([
      [async ({ inputData }) => inputData.cookbook.success === true, /* skip handler */
        createStep({
          id: 'cookbook_done',
          inputSchema: workflowState,
          outputSchema: workflowState,
          execute: async ({ inputData }) => ({
            ...inputData,
            status: 'completed' as const,
          }),
        }),
      ],
      [async () => true, executeHandler],
    ])
    .commit();
}
```

**Note on per-job workflow creation:** Mastra workflows are lightweight definitions (no server/process overhead). Creating one per job adds negligible cost vs. the seconds-long handler execution. This pattern is the only clean way to inject non-serializable runtime context without global mutable state.

## 5.6 New File Structure

```
packages/ghosthands/src/workflows/
└── mastra/
    ├── init.ts              # Mastra singleton (PostgresStore)
    ├── applyWorkflow.ts     # buildApplyWorkflow() factory
    ├── types.ts             # workflowState schema, RuntimeContext interface
    ├── resumeCoordinator.ts # Worker-side resume: read resolution, inject, resume
    └── steps/
        └── factory.ts       # buildSteps() with closure-injected runtime
```

---

## 6. JobExecutor Integration (Corrected)

For `execution_mode='mastra'`:

1. Build runtime context using existing objects in `execute()`.
2. Derive `qualityPreset` via existing `resolveQualityPreset(input_data, metadata)`.
3. Use `costTracker.getRemainingBudget()` (existing API).
4. Create and persist `metadata.mastra_run_id` before first execute/suspend path.
5. Run workflow with composable `workflowState`.
6. If workflow returns `status='suspended'`: return without completion finalization.
7. If workflow returns `status='completed'`: require success result path and run cookbook/handler success finalization.
8. If workflow returns `status='awaiting_user_review'`: run existing awaiting-review finalization branch.
9. If workflow returns `status='failed'`: run existing failure path.

Important: avoid ambiguous "single helper for everything". Extract parity-preserving helpers that map to existing branches.

```ts
// workers/finalization.ts (extracted from JobExecutor)

interface CommonFinalizationInput {
  job: AutomationJob;
  adapter: HitlCapableAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  traceRecorder: TraceRecorder | null;
  sessionManager: SessionManager | null;
  workerId: string;
  supabase: SupabaseClient;
  logEvent: (...) => Promise<void>;
}

export async function finalizeCookbookSuccess(input: CommonFinalizationInput & {
  engineResult: ExecutionResult;
}): Promise<void>;

export async function finalizeHandlerResult(input: CommonFinalizationInput & {
  taskResult: TaskResult;
  finalMode: string;
}): Promise<void>;
```

Parity requirement: `finalizeHandlerResult()` must preserve existing `awaiting_user_review` semantics and callback behavior.

---

## 7. VALET Contract Changes

### 7.1 New Execution Mode Value

Add `mastra` to the accepted `execution_mode` enum. Backward compatible.

### 7.2 New HITL Interaction Type: `context_lost`

When crash recovery or resume fails to restore a usable browser state:

```json
{
  "job_id": "abc-123",
  "valet_task_id": "task-456",
  "status": "needs_human",
  "interaction": {
    "type": "context_lost",
    "message": "Browser context could not be restored after interruption. The application may need to be restarted or the page state verified.",
    "screenshot_url": "https://storage.example.com/screenshots/abc-123/context_lost.png",
    "page_url": "https://jobs.example.com/apply/step3",
    "original_blocker_type": "captcha",
    "timeout_seconds": 300
  }
}
```

VALET should treat `context_lost` like other HITL blockers: show the screenshot, provide a "I've verified the page" button, and call `POST /valet/resume/:jobId` with `resolution_type: 'manual'`. The worker will re-check page state and either continue or fail.

### 7.3 No Other Contract Changes

All existing callback payloads (`running`, `completed`, `failed`, `needs_human`, `resumed`) are unchanged. Status API responses are unchanged.

---

## 8. Resume Flow (Corrected)

## 8.1 API Route Behavior (`/valet/resume/:jobId`)

For mastra jobs:

1. Validate paused state.
2. Store resolution payload in `interaction_data`.
3. Require `metadata.mastra_run_id` to exist; if missing, return `409 invalid_state` with no writes.
4. Set metadata flags:
   - `resume_requested = true`
   - `resume_nonce = <uuid>`
5. Dispatch-mode behavior:
   - `legacy`: set `status='pending'`
   - `queue` without API enqueue support: return `409 unsupported_mode` with no writes
6. Return status consistent with DB state (`pending`, never `running`).

## 8.2 Dispatch-Mode Handling

Phase-1 safe default:

- Support `JOB_DISPATCH_MODE=legacy` for mastra resume.
- If `queue` mode is active and no API-side enqueue capability exists, reject mastra resume with explicit error and no state mutation.

Do not silently assume `pg_notify('gh_job_created')` wakes queue consumers.

## 8.3 Worker Resume Discriminator

Resume if and only if:

1. `execution_mode === 'mastra'`
2. `metadata.mastra_run_id` exists
3. `metadata.resume_requested === true`

Worker clears `resume_requested` atomically before applying resume to guarantee single-consumer semantics.

Atomic resume-claim (required):

```sql
UPDATE gh_automation_jobs
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{resume_requested}', 'false'::jsonb, true)
WHERE id = $1::uuid
  AND execution_mode = 'mastra'
  AND status IN ('pending', 'queued')
  AND metadata->>'mastra_run_id' = $2
  AND COALESCE((metadata->>'resume_requested')::boolean, false) = true
RETURNING metadata;
```

Only the worker receiving a row from this statement may call `workflow.resume()`.

---

## 9. Idempotency and Side Effects

## 9.1 Status Transitions

Pause update:

```sql
UPDATE gh_automation_jobs
SET status = 'paused', ...
WHERE id = $1
  AND status <> 'paused';
```

Resume request update:

```sql
UPDATE gh_automation_jobs
SET status = $next_status, metadata = ..., ...
WHERE id = $1
  AND status = 'paused';
```

## 9.2 Callback Dedupe

Before sending callback:

```sql
INSERT INTO gh_callback_dedupe(job_id, event_type, nonce)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING
RETURNING 1;
```

Send only if row inserted.

---

## 10. Security, Dependencies, and Migrations

## 10.1 Sensitive Data

Forbidden in workflow schemas:

- `password`
- `resolution_data`
- `otp`
- `credential`
- `secret`
- `token`

CI guard enforces this.

## 10.2 Dependencies

| Package | Pinned Version | Purpose |
|---------|---------------|---------|
| `@mastra/core` | `1.7.0` | Workflow engine, step/workflow primitives |
| `@mastra/pg` | `1.7.0` | PostgresStore for workflow snapshots |

Pin exact versions in `package.json` (not `^` ranges). Mastra is post-1.0 but iterating rapidly. Test before upgrading.

**Bun compatibility:** Must be validated in Phase 0. `@mastra/core` targets Node.js. If incompatible, the integration is blocked until resolved (switch to Node or wait for Mastra Bun support).

## 10.3 Migration Numbering

Use next available migration number (currently after 017), not `015`.

Proposed files:

1. `018_execution_mode_add_mastra.sql` (required)
   - updates `gh_automation_jobs_execution_mode_check` to include `'mastra'`
2. `019_callback_dedupe.sql` (required)
3. `020_mastra_rls_and_retention.sql` (required, or combined with 019 by policy)

## 10.4 RLS and Retention

Apply service-role-only access policies to Mastra-managed tables and 7-day retention cleanup.

---

## 11. Cost and Progress (Corrected)

1. `CostTracker` remains authoritative for enforcement.
2. Workflow stores read-only cost metadata copied from `CostTracker`.
3. Progress literals remain existing values (`analyzing_page`, `filling_form`, etc.).
4. Optional metadata extension:
   - `orchestrator: 'legacy' | 'mastra'`

---

## 12. Rollout Plan

### Phase 0: Hard Gate

All items must pass. Failure on any item blocks Phase 1.

| # | Validation | Pass Criteria | Abort If |
|---|-----------|---------------|----------|
| 0a | Bun compat | Trivial workflow (create → execute → suspend → resume) runs under Bun without errors | Runtime crash or unsupported API |
| 0b | Cross-process resume | Process A calls `workflow.execute()`, suspends. Process B calls `workflow.resume()` on same run ID. Resumes correctly. | Resume fails or loses state |
| 0c | Secret audit | After suspend/resume with credentials, `SELECT * FROM mastra_workflow_snapshot WHERE ...` contains zero password/code values | Any sensitive value found |
| 0d | Dispatch compat | Resumed job (status `pending`, `resume_requested=true`) picked up by JobPoller within 10s | JobPoller ignores it or PgBossConsumer required but unsupported |
| 0e | Overhead benchmark | 3-step workflow execute + snapshot persist adds < 500ms vs direct function calls | Overhead > 500ms |
| 0f | Snapshot size | Workflow state for a typical job serializes to < 10KB | Snapshot > 100KB |

### Phase 1: Controlled Launch

1. Add `mastra` to execution mode enum.
2. Implement `workflows/mastra/` module (types, factory, workflow, resume coordinator).
3. Add `JobExecutor` branch for `execution_mode === 'mastra'` with `mastra_run_id` persistence.
4. Implement worker-owned resume for `JOB_DISPATCH_MODE=legacy`.
5. Extract parity-preserving finalization helpers from JobExecutor.
6. Add `gh_callback_dedupe` table + idempotency guards.
7. Add `context_lost` HITL interaction type.
8. Add migration files (018-020).
9. Run full test suite (Section 14).
10. Opt-in rollout only. No automatic routing.

### Phase 1.1: Queue Mode (If Needed)

1. Add API-side pg-boss enqueue path for mastra resume requests.
2. Remove queue-mode rejection gate.
3. Test resume flow end-to-end under `JOB_DISPATCH_MODE=queue`.

### Phase 2: SmartApply Decomposition (Optional)

**Prerequisite:** Phase 1 incident-free for 2+ weeks, 100+ mastra jobs completed.

1. Modify SmartApplyHandler to accept a `checkpoint` callback.
2. Handler calls `checkpoint()` at top of each page loop iteration.
3. Mastra workflow models page loop as `doUntil`, each page as a step.
4. HITL suspend at per-page boundaries (not just initial navigation).
5. Per-page cost attribution via step output.

### Phase 3: V3ExecutionEngine (Future, Uncommitted)

Only after V3ExecutionEngine is wired into JobExecutor by a separate effort. Requires rebuilding the Mastra workflow against V3's SectionOrchestrator architecture. Not incremental from Phase 2.

Rollback at any phase: stop assigning `execution_mode='mastra'`.

---

## 13. Acceptance Criteria

1. No contract regressions for legacy modes (all existing tests pass unchanged).
2. Mastra mode success rate >= legacy - 1% absolute (measured over 500+ jobs).
3. Median cost/job: mastra <= legacy + 5%.
4. Median duration/job: mastra <= legacy + 15%.
5. Zero credential leaks in workflow snapshots (CI + periodic audit).
6. Zero duplicate callbacks for same `(job_id, event_type, nonce)`.
7. Resume route returns status consistent with actual DB state.
8. Queue-mode behavior is either supported or rejected explicitly (never silently broken).
9. Worker freed during HITL pause (can process other jobs while suspended).
10. Crash during HITL pause: job recoverable by another worker (>= 90% success rate).
11. 100% of suspended/resumed mastra jobs have stable `metadata.mastra_run_id`.

---

## 14. Test Plan

### 14.1 Unit Tests

| Test | Validates |
|------|-----------|
| `workflowState` schema round-trips through `JSON.parse(JSON.stringify(...))` | Serializable state contract |
| No step schema contains forbidden keys (`password`, `resolution_data`, `otp`, `credential`, `secret`, `token`) | Secret safety (CI guard) |
| `mastra` accepted in execution mode enum; all existing values still accepted | AD-1 backward compat |
| `observeWithBlockerDetection()` parsing uses `ObservationResult.blockers[]` and category mapping | Adapter contract correctness |
| Resume discriminator: `mastra_run_id` + `resume_requested` = resume; absent = fresh | Section 8.3 logic |
| First mastra execution persists `metadata.mastra_run_id` once and never rotates it in normal flow | AD-6 lifecycle |
| Pause SQL: `WHERE status <> 'paused'` prevents double-pause | Idempotency |
| Resume SQL: `WHERE status = 'paused'` prevents double-resume | Idempotency |
| Callback dedupe: second insert with same `(job_id, event_type, nonce)` returns no rows | AD-5 |

### 14.2 Integration Tests

| Test | Validates |
|------|-----------|
| Mastra mode, cookbook succeeds → same result_data and callback as legacy | Parity (happy path) |
| Mastra mode, cookbook fails → handler runs → same result as legacy | Parity (handler path) |
| Blocker detected → workflow suspends → job status `paused` → callback `needs_human` sent | HITL suspend |
| Resume API called → job `pending` with `resume_requested` → worker picks up → credentials injected → workflow completes | HITL resume |
| Resume API called in `JOB_DISPATCH_MODE=queue` without enqueue support → `409 unsupported_mode`, job remains `paused`, metadata unchanged | Deterministic queue gating |
| Handler returns `awaitingUserReview=true` → workflow state is `awaiting_user_review` and finalization matches legacy behavior | Outcome parity |
| Worker killed during suspend → new worker starts → picks up resumed job → completes | Crash recovery |
| Suspend → 300s timeout → job fails with `hitl_timeout` | Timeout handling |
| Resume but page state changed → `context_lost` callback → new HITL request | AD-4 honest recovery |
| After HITL flow, `SELECT * FROM mastra_workflow_snapshot` contains no passwords/codes | Secret safety (integration) |
| `execution_mode=smart_apply` → zero Mastra involvement, runs exactly as before | Legacy isolation |
| `execution_mode=agent_apply` → zero Mastra involvement | Legacy isolation |

### 14.3 Contract Tests

| Test | Validates |
|------|-----------|
| Callback payloads for `running`, `completed`, `failed`, `needs_human` match existing schemas | VALET compat |
| `context_lost` interaction type has required fields (`type`, `message`, `screenshot_url`, `page_url`, `timeout_seconds`) | New contract |
| Status API response for mastra-mode job matches existing format | VALET compat |

---

## 15. Implementation Checklist

### Phase 0
- [ ] Install `@mastra/core@1.7.0` + `@mastra/pg@1.7.0` (pinned)
- [ ] Run Bun compat test (0a)
- [ ] Run cross-process resume test (0b)
- [ ] Run secret persistence audit (0c)
- [ ] Run dispatch compat test (0d)
- [ ] Run overhead benchmark (0e)
- [ ] Run snapshot size measurement (0f)
- [ ] Go/no-go decision

### Phase 1
- [ ] Add `mastra` to execution mode enum in `api/schemas/valet.ts`
- [ ] Add migration `018_execution_mode_add_mastra.sql` for DB CHECK constraint parity
- [ ] Create `workflows/mastra/types.ts` (`workflowState`, `RuntimeContext`)
- [ ] Create `workflows/mastra/init.ts` (Mastra singleton + PostgresStore)
- [ ] Create `workflows/mastra/steps/factory.ts` (`buildSteps()`)
- [ ] Create `workflows/mastra/applyWorkflow.ts` (`buildApplyWorkflow()`)
- [ ] Create `workflows/mastra/resumeCoordinator.ts`
- [ ] Extract parity-preserving helpers in `workers/finalization.ts` from JobExecutor
- [ ] Add mastra branch in `JobExecutor.execute()` (run-id persistence, resume discriminator, workflow execution)
- [ ] Modify `/valet/resume/:jobId` route for mastra-mode resume intent
- [ ] Add dispatch-mode gate (reject queue-mode resume with explicit error if unsupported)
- [ ] Add migration `019_callback_dedupe.sql`
- [ ] Add migration `020_mastra_rls_and_retention.sql`
- [ ] Add unit tests (Section 14.1)
- [ ] Add integration tests (Section 14.2)
- [ ] Add contract tests (Section 14.3)
- [ ] Deploy as opt-in
