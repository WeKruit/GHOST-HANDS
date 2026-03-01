# PRD: Mastra Orchestration for GHOST-HANDS (V5)

**Author:** Claude (synthesis of V2-V4 critique)
**Date:** 2026-03-01
**Status:** Draft
**Supersedes:** V2, V3, V4

---

## 0. Why V5 Exists

V2-V4 each got closer to a workable design but each had structural flaws. This section documents the error chain so we don't repeat it.

| Version | Key Error | Root Cause |
|---------|-----------|------------|
| V2 | Built on wrong runtime (described V1 ExecutionEngine as if V3 was active) | Didn't verify imports in JobExecutor |
| V3 | Built on wrong runtime in the opposite direction (assumed V3ExecutionEngine was wired in) | Read V3 source files but didn't check that JobExecutor imports V1 |
| V4 | Correct runtime baseline but never answered "what does Mastra execute?" | Focused on safety constraints without specifying the execution target |
| V4 | Phase-1 coarse wrapper (3 sequential steps) adds overhead for no value | Prioritized "low risk" over "has a reason to exist" |
| V4 | Phase-2 HITL checkpoint boundaries reference V3 code that isn't wired in | Treated SectionOrchestrator as available but said it wasn't |
| V4 | Resume re-queue via `pending` status conflates fresh jobs with resumed jobs | Didn't trace the dispatcher logic for how a worker distinguishes job types |

### What This Version Does Differently

1. **Specifies the execution target.** Answers "when `execution_mode === 'mastra'`, what handler runs?" with concrete code paths.
2. **Phase 1 has a real value proposition** — not a wrapper, but HITL durable suspend/resume, which is the one thing Mastra does better than the current implementation.
3. **Checkpoint boundaries are identified in SmartApplyHandler's actual page loop**, not in unwired V3 code.
4. **Resume dispatch uses a metadata flag**, not status overloading.
5. **Includes concrete Mastra code** for every proposed component.

---

## 1. Current-State Facts (Verified Against Source)

These are verified by reading actual imports and call sites, not docs.

### 1.1 Runtime Path

`JobExecutor.execute()` ([JobExecutor.ts:325-867](packages/ghosthands/src/workers/JobExecutor.ts#L325)):

```
Step 2:  Resolve handler by execution_mode:
           'agent_apply'  → AgentApplyHandler (Stagehand autonomous agent)
           'smart_apply'  → SmartApplyHandler (multi-page form filler)
           default        → taskHandlerRegistry.getOrThrow(job.job_type)

Step 9:  V1 ExecutionEngine (cookbook-first, ManualStore + CookbookExecutor)
           If cookbook succeeds → complete job, return
           If cookbook fails   → fall through to handler

Step 10: handler.execute(ctx) with crash recovery loop (max 2 recoveries)
```

**V3ExecutionEngine is NOT imported or called by JobExecutor.** It exists at `engine/v3/V3ExecutionEngine.ts` and is exported from `engine/v3/index.ts` but has zero import sites in the workers directory.

### 1.2 Execution Modes (Actual Enum)

From [valet.ts:75](packages/ghosthands/src/api/schemas/valet.ts#L75):

```typescript
z.enum(['auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply'])
```

### 1.3 Handler Architecture

**SmartApplyHandler** ([smartApplyHandler.ts:52-388](packages/ghosthands/src/workers/taskHandlers/smartApplyHandler.ts#L52)):
- Multi-page `while` loop (max 15 pages)
- Per-page: detect page type → switch on type (job_listing, login, verification_code, phone_2fa, account_creation, review, confirmation, error, default/form)
- Form pages: `fillPage()` → platform-specific `clickNextButton()` → stuck detection
- Exits on: review page reached, confirmation page, error page, max pages, stuck detection
- Uses MagnitudeAdapter via `adapter.act()` for LLM-driven actions

**AgentApplyHandler** ([agentApplyHandler.ts:89-279](packages/ghosthands/src/workers/taskHandlers/agentApplyHandler.ts#L89)):
- Single `agent.execute()` call (Stagehand agent mode)
- Agent autonomously decides actions via LLM tool calls
- `onStepFinish` callback for logging/progress
- No explicit page loop — agent manages its own control flow

### 1.4 HITL (Actual Implementation)

HITL lives in `JobExecutor`, NOT in handlers:
- `checkForBlockers()` at step 8.6 (initial navigation) and periodically via `setInterval`
- On blocker: `requestHumanIntervention()` → status `paused` → callback `needs_human`
- `waitForResume()` → LISTEN/NOTIFY + 3s poll fallback → 300s timeout
- On resume: read resolution data from DB → inject credentials/code → clear DB → `adapter.resume()`
- Worker is **blocked** during entire HITL wait (cannot pick up other jobs)

### 1.5 Dispatch Mechanisms

Two coexist:
- `JobPoller` — LISTEN/NOTIFY on `gh_job_created` + 5s poll fallback
- `PgBossConsumer` — pg-boss queue consumer ([PgBossConsumer.ts](packages/ghosthands/src/workers/PgBossConsumer.ts))

Both call into `JobExecutor.execute()`.

---

## 2. Problem Statement

Two problems justify Mastra. One is urgent, one is strategic.

### 2.1 HITL Blocks the Worker (Urgent)

When a job hits a CAPTCHA/login wall, the worker sits idle for up to 300 seconds waiting for a human. During this time:
- The worker cannot pick up other jobs (single-task-per-worker + blocked promise)
- If the worker crashes, the job is lost (no durable state snapshot)
- If the deployment rotates workers, the HITL job fails

Mastra's `suspend()` serializes workflow state to Postgres and **frees the worker**. Resume re-creates runtime context on any available worker.

### 2.2 Handler Observability Is Coarse (Strategic)

SmartApplyHandler's 15-page loop produces no step-level events. From outside, you see "running" until it finishes or fails. You don't know:
- Which page it's on
- Whether it's filling fields, handling login, or waiting for a page transition
- Per-page cost attribution
- Whether a specific page consistently fails

This is a Phase-2+ concern. Phase 1 focuses on HITL.

---

## 3. Goals and Non-Goals

### 3.1 Goals

1. Free the worker during HITL pause via Mastra `suspend()`/`resume()`.
2. Enable crash-safe HITL: if worker dies during pause, another worker resumes from snapshot.
3. Preserve all existing behavior for non-mastra execution modes.
4. Preserve VALET callback contracts, DB status semantics, and cost tracking.
5. Use `@mastra/pg` backed by existing Supabase Postgres.
6. Opt-in via `execution_mode: 'mastra'` with rollback by mode toggle.

### 3.2 Non-Goals

1. **NOT replacing Hand selection with Mastra Agents.** Hand escalation is deterministic heuristics, not LLM reasoning.
2. **NOT decomposing SmartApplyHandler's page loop in Phase 1.** Phase 1 wraps the handler as one step; decomposition is Phase 2.
3. **NOT wiring V3ExecutionEngine.** That's a separate effort. Mastra integration targets the current V1 path.
4. **NOT replacing the job queue.** JobPoller/PgBossConsumer stay as-is.
5. **NOT claiming exact mid-page browser continuation after crash.** Recovery re-navigates to `target_url` and re-runs from scratch with session cookies. This is the same as current crash recovery, not worse.

---

## 4. Architectural Decisions (Binding)

### AD-1: Execution Target

When `execution_mode === 'mastra'`:
- `JobExecutor` runs the Mastra `applyWorkflow` instead of V1 ExecutionEngine + handler
- The workflow's primary step calls **SmartApplyHandler.execute()** (the production form filler)
- Cookbook attempt runs as a preceding step (same as today's Step 9)
- If cookbook succeeds, handler step is skipped

This means `mastra` mode runs the same code as `smart_apply` mode, but wrapped in a Mastra workflow that enables suspend/resume.

### AD-2: Worker-Owned Resume

API `/valet/resume/:jobId` does NOT call `workflow.resume()`.

Flow:
1. API stores resolution data in `interaction_data` JSONB (same as today)
2. API sets `metadata.resume_requested = true` and `status = 'pending'`
3. API fires `pg_notify('gh_job_created', jobId)` (wake signal)
4. Worker picks up the job via normal dispatch (JobPoller/PgBossConsumer)
5. Worker detects `metadata.mastra_run_id` + `metadata.resume_requested` → this is a resume
6. Worker re-creates runtime context (adapter, browser, session)
7. Worker calls `workflow.resume()` with non-sensitive metadata
8. Worker reads sensitive `resolution_data` from DB, injects credentials, clears DB
9. Workflow continues from suspend point

### AD-3: Secret-Safe Resume

`resolution_data` (passwords, 2FA codes) NEVER enters Mastra schemas.

```
Mastra resumeData: { resolutionType: 'code_entry' }     ← enum only, no secrets
DB interaction_data: { code: '123456' }                   ← read and cleared by worker
```

### AD-4: Honest Recovery Scope

On crash during HITL:
1. Mastra snapshot has workflow state (page index, cost so far, blocker type)
2. Worker re-creates adapter + browser + navigates to `target_url`
3. Session cookies are restored from `gh_browser_sessions`
4. Workflow resumes at `check_blockers` step
5. If the page state doesn't match expectations (e.g., session expired, different page):
   - Emit `resume_context_mismatch` error
   - Set job status to `paused` with a new HITL request ("We lost context, please help")
   - VALET callback: `needs_human` with `interaction.type = 'context_lost'`
   - User can retry or cancel

### AD-5: Idempotent Side Effects

1. Pause: `UPDATE ... SET status = 'paused' WHERE status != 'paused'` — callback fires only on actual transition
2. Resume: conditional on `metadata.resume_requested = true` — worker clears flag atomically on pickup
3. Callbacks include `(job_id, event_type, nonce)` — duplicates are no-ops

### AD-6: Backward-Compatible Mode Contract

`mastra` is added to the existing enum. No existing values are removed or renamed.

```typescript
z.enum(['auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'])
```

---

## 5. Technical Design

### 5.1 New Files

```
packages/ghosthands/src/workflows/mastra/
├── init.ts              # Mastra singleton + PostgresStore
├── applyWorkflow.ts     # Workflow definition
├── steps/
│   ├── cookbookAttempt.ts
│   ├── executeHandler.ts
│   └── checkBlockers.ts
├── resumeCoordinator.ts # Worker-side resume logic
└── types.ts             # Persisted state schemas
```

### 5.2 Mastra Initialization

```typescript
// workflows/mastra/init.ts
import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { applyWorkflow } from './applyWorkflow.js';

let instance: Mastra | null = null;

export function getMastra(): Mastra {
  if (!instance) {
    instance = new Mastra({
      storage: new PostgresStore({
        connectionString: process.env.DATABASE_URL!,
      }),
      workflows: { applyWorkflow },
    });
  }
  return instance;
}
```

### 5.3 Workflow Definition

```typescript
// workflows/mastra/applyWorkflow.ts
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Schemas (serializable only — no Page, no adapter, no credentials) ──

const workflowInput = z.object({
  jobId: z.string().uuid(),
  targetUrl: z.string().url(),
  userId: z.string().uuid(),
  platform: z.string(),
  qualityPreset: z.enum(['speed', 'balanced', 'quality']),
  budget: z.number(),
  handlerType: z.enum(['smart_apply', 'apply']),  // which handler to delegate to
});

const cookbookResult = z.object({
  success: z.boolean(),
  mode: z.string().optional(),
  manualId: z.string().optional(),
  cookbookSteps: z.number().default(0),
  costUsd: z.number().default(0),
});

const handlerResult = z.object({
  success: z.boolean(),
  keepBrowserOpen: z.boolean().default(false),
  awaitingUserReview: z.boolean().default(false),
  error: z.string().optional(),
  pagesProcessed: z.number().default(0),
  costUsd: z.number().default(0),
  finalPage: z.string().optional(),
});

const blockerCheck = z.object({
  blocked: z.boolean(),
  blockerType: z.string().optional(),
  confidence: z.number().optional(),
  pageUrl: z.string().optional(),
});

// ── Steps ──

const cookbookAttemptStep = createStep({
  id: 'cookbook_attempt',
  inputSchema: workflowInput,
  outputSchema: cookbookResult,
  execute: async ({ inputData }) => {
    // Runtime context (adapter, costTracker, etc.) injected via closure
    // at workflow start — NOT in the schema.
    //
    // This step calls the existing V1 ExecutionEngine:
    //   const engine = new ExecutionEngine({ manualStore, cookbookExecutor });
    //   const result = await engine.execute({ job, adapter, costTracker, ... });
    //   return { success: result.success, mode: result.mode, ... };
    //
    // Implementation delegated to steps/cookbookAttempt.ts
    throw new Error('Placeholder — see steps/cookbookAttempt.ts');
  },
});

const executeHandlerStep = createStep({
  id: 'execute_handler',
  inputSchema: workflowInput,
  outputSchema: handlerResult,
  execute: async ({ inputData }) => {
    // Calls SmartApplyHandler.execute(ctx) or the resolved handler.
    // This is the same code path as JobExecutor step 10 today.
    //
    // The handler runs its full page loop internally.
    // Mastra doesn't decompose the handler — it wraps it.
    //
    // Implementation delegated to steps/executeHandler.ts
    throw new Error('Placeholder — see steps/executeHandler.ts');
  },
});

const checkBlockersStep = createStep({
  id: 'check_blockers',
  inputSchema: z.object({ jobId: z.string().uuid() }),
  outputSchema: blockerCheck,

  // resumeSchema: what the worker passes to workflow.resume()
  // NOTE: only contains resolutionType (enum). Actual credentials
  // are read from DB inside the step handler.
  resumeSchema: z.object({
    resolutionType: z.enum(['manual', 'code_entry', 'credentials', 'skip']),
  }),

  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData) {
      // ── Resumed from HITL ──
      // 1. Read sensitive resolution_data from DB
      // 2. Inject credentials/code via Playwright
      // 3. Clear resolution_data from DB immediately
      // 4. Verify blocker is resolved (up to 3 checks)
      // 5. Return { blocked: false }
      //
      // Implementation: steps/checkBlockers.ts
      return { blocked: false };
    }

    // ── Fresh check ──
    // Run BlockerDetector.detectWithAdapter(adapter)
    // If blocker found with confidence > 0.6:
    //   1. Update job status → 'paused'
    //   2. Send 'needs_human' callback with screenshot
    //   3. await suspend({ blockerType, pageUrl })
    //      ── workflow state saved to Postgres ──
    //      ── worker freed ──
    //
    // If no blocker: return { blocked: false }
    return { blocked: false };
  },
});

// ── Workflow Assembly ──

export const applyWorkflow = createWorkflow({
  id: 'gh_apply',
  inputSchema: workflowInput,
  outputSchema: handlerResult,
})
  .then(checkBlockersStep)      // Check blockers after initial navigation
  .then(cookbookAttemptStep)    // Try cookbook replay
  .branch([
    [
      async ({ inputData }) => inputData.success === true,
      createStep({
        id: 'cookbook_done',
        inputSchema: cookbookResult,
        outputSchema: handlerResult,
        execute: async ({ inputData }) => ({
          success: true,
          pagesProcessed: 1,
          costUsd: inputData.costUsd,
          finalPage: 'cookbook_complete',
        }),
      }),
    ],
    [
      async () => true,           // Cookbook failed or no manual
      executeHandlerStep,         // Run SmartApplyHandler
    ],
  ])
  .commit();
```

### 5.4 Runtime Context Injection

Mastra step schemas contain only serializable data. Non-serializable context is injected via closure when the workflow starts:

```typescript
// workflows/mastra/steps/executeHandler.ts
import type { HitlCapableAdapter } from '../../../adapters/types.js';
import type { CostTracker } from '../../../workers/costControl.js';
import type { ProgressTracker } from '../../../workers/progressTracker.js';

/**
 * Creates the executeHandler step with runtime context bound via closure.
 * Called once per job execution — the returned step has access to
 * adapter, costTracker, etc. without putting them in Mastra schemas.
 */
export function createExecuteHandlerStep(runtime: {
  adapter: HitlCapableAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  handler: TaskHandler;
  job: AutomationJob;
  credentials: Record<string, string> | null;
  dataPrompt: string;
  resumeFilePath: string | null;
}) {
  return createStep({
    id: 'execute_handler',
    inputSchema: workflowInput,
    outputSchema: handlerResult,
    execute: async ({ inputData }) => {
      const ctx: TaskContext = {
        job: runtime.job,
        adapter: runtime.adapter,
        costTracker: runtime.costTracker,
        progress: runtime.progress,
        credentials: runtime.credentials,
        dataPrompt: runtime.dataPrompt,
        resumeFilePath: runtime.resumeFilePath,
      };

      const result = await runtime.handler.execute(ctx);
      const cost = runtime.costTracker.getSnapshot();

      return {
        success: result.success,
        keepBrowserOpen: result.keepBrowserOpen ?? false,
        awaitingUserReview: result.awaitingUserReview ?? false,
        error: result.error,
        pagesProcessed: result.data?.pages_processed ?? 0,
        costUsd: cost.totalCost,
        finalPage: result.data?.final_page,
      };
    },
  });
}
```

**Enforcement:** A CI unit test asserts that no Mastra step `inputSchema` or `outputSchema` references types containing `Page`, `Browser`, `SupabaseClient`, `Adapter`, or any class instance. The test parses the Zod schemas and rejects non-primitive/non-serializable types.

### 5.5 JobExecutor Integration

```typescript
// workers/JobExecutor.ts — modifications to execute()

// After step 8.6 (initial blocker check), before step 9:
if (job.execution_mode === 'mastra') {
  const result = await this.runMastraWorkflow(job, adapter, costTracker, progress, handler, {
    credentials, dataPrompt, resumeFilePath, logEventFn,
  });
  // result is either:
  //   - completed (workflow finished)
  //   - suspended (HITL pause — worker returns, job stays paused)
  if (result.status === 'suspended') {
    // Worker is freed. Job is paused in DB. VALET has been notified.
    // Resume will come via POST /valet/resume → re-queue → new worker picks up.
    return;
  }
  // Fall through to existing finalization (screenshot, session save, callback, cost recording)
  // using result.output for task result data.
  taskResult = result.output;
  // ... existing finalization code at step 11+ ...
  return;
}

// Existing path for all other execution_modes (unchanged)
// Step 9: V1 ExecutionEngine ...
// Step 10: handler.execute(ctx) ...
```

```typescript
private async runMastraWorkflow(
  job: AutomationJob,
  adapter: HitlCapableAdapter,
  costTracker: CostTracker,
  progress: ProgressTracker,
  handler: TaskHandler,
  extras: { credentials; dataPrompt; resumeFilePath; logEventFn },
): Promise<{ status: 'completed' | 'suspended'; output?: HandlerResult }> {
  const mastra = getMastra();
  const workflow = mastra.getWorkflow('gh_apply');

  // Check if this is a resume (job was previously suspended)
  const isResume = job.metadata?.mastra_run_id && job.metadata?.resume_requested;

  if (isResume) {
    return this.resumeMastraWorkflow(job, adapter, costTracker, progress, extras);
  }

  // Fresh execution — build workflow with runtime context
  const run = await workflow.execute({
    inputData: {
      jobId: job.id,
      targetUrl: job.target_url,
      userId: job.user_id,
      platform: job.input_data.platform || 'other',
      qualityPreset: job.input_data.tier || 'balanced',
      budget: costTracker.remainingBudget(),
      handlerType: handler.type === 'smart_apply' ? 'smart_apply' : 'apply',
    },
  });

  // Store run ID for potential future resume
  await this.supabase
    .from('gh_automation_jobs')
    .update({ metadata: { ...(job.metadata || {}), mastra_run_id: run.id } })
    .eq('id', job.id);

  if (run.status === 'suspended') {
    return { status: 'suspended' };
  }

  return { status: 'completed', output: run.output };
}
```

### 5.6 Resume Coordinator (Worker-Side)

```typescript
// workflows/mastra/resumeCoordinator.ts

export async function resumeMastraWorkflow(
  job: AutomationJob,
  adapter: HitlCapableAdapter,
  costTracker: CostTracker,
  progress: ProgressTracker,
  extras: { ... },
): Promise<{ status: 'completed' | 'suspended'; output?: HandlerResult }> {
  const mastra = getMastra();
  const workflow = mastra.getWorkflow('gh_apply');

  const runId = job.metadata.mastra_run_id;

  // 1. Read resolution data from DB (sensitive — passwords, 2FA codes)
  const resolutionData = await readResolutionData(job.id);
  const resolutionType = resolutionData?.resolution_type || 'manual';

  // 2. Clear sensitive data from DB immediately
  await clearResolutionData(job.id);

  // 3. Clear resume_requested flag to prevent re-processing
  await supabase
    .from('gh_automation_jobs')
    .update({
      metadata: { ...(job.metadata || {}), resume_requested: false },
      status: 'running',
    })
    .eq('id', job.id);

  // 4. Inject credentials/code into browser if needed
  if (resolutionType === 'code_entry' && resolutionData?.resolution_data?.code) {
    await injectCode(adapter.page, resolutionData.resolution_data.code);
  } else if (resolutionType === 'credentials' && resolutionData?.resolution_data) {
    await injectCredentials(adapter.page, resolutionData.resolution_data);
  }

  // 5. Resume adapter pause gate
  await adapter.resume({ resolutionType });

  // 6. Verify blocker is resolved (up to 3 checks)
  for (let i = 0; i < 3; i++) {
    const stillBlocked = await detectBlockers(adapter);
    if (!stillBlocked) break;
    if (i === 2) {
      // Blocker persists after resolution — re-suspend
      return { status: 'suspended' };
    }
    await adapter.page.waitForTimeout(2000);
  }

  // 7. Resume Mastra workflow with non-sensitive metadata only
  const run = workflow.getRunById(runId);
  const resumed = await run.resume({
    step: 'check_blockers',
    resumeData: { resolutionType },
  });

  if (resumed.status === 'suspended') {
    return { status: 'suspended' };
  }

  return { status: 'completed', output: resumed.output };
}
```

### 5.7 Resume API Route Modification

```typescript
// api/routes/valet.ts — POST /valet/resume/:jobId modification

// For mastra jobs:
if (job.execution_mode === 'mastra') {
  // 1. Store resolution data (same as today)
  await storeResolutionData(jobId, body);

  // 2. Set resume flag + re-queue
  await pool.query(`
    UPDATE gh_automation_jobs
    SET status = 'pending',
        metadata = jsonb_set(
          COALESCE(metadata, '{}'),
          '{resume_requested}',
          'true'
        ),
        updated_at = NOW()
    WHERE id = $1 AND status = 'paused'
  `, [jobId]);

  // 3. Wake dispatcher
  await pool.query(`SELECT pg_notify('gh_job_created', $1)`, [jobId]);

  return c.json({ job_id: jobId, status: 'running', resolved_by: body.resolved_by });
}

// Existing path for non-mastra jobs (unchanged)
```

### 5.8 How the Worker Distinguishes Fresh vs. Resume

When `JobPoller` or `PgBossConsumer` picks up a `pending` job:

```typescript
// In JobExecutor.execute(), early in the method:

if (job.execution_mode === 'mastra' && job.metadata?.mastra_run_id && job.metadata?.resume_requested) {
  // This is a Mastra resume, not a fresh job.
  // Skip preflight (already done), create adapter, and resume workflow.
  const adapter = await this.createAndStartAdapter(job, llmSetup);
  await this.navigateToTarget(adapter, job.target_url);
  await this.restoreSession(adapter, job);
  return this.resumeMastraWorkflow(job, adapter, ...);
}

// Otherwise: fresh job, run normal flow
```

The `mastra_run_id` + `resume_requested` metadata fields are the discriminator. A fresh `pending` job has neither. A resumed job has both.

---

## 6. HITL: Before and After

### 6.1 Before (Current)

```
Blocker detected
  → adapter.pause()
  → job status = 'paused'
  → callback 'needs_human'
  → WORKER BLOCKED for up to 300s (waitForResume loop)
  → if resumed: inject credentials, adapter.resume(), continue
  → if timeout: job fails
  → if worker crashes: job is stuck forever
```

**Worker utilization during HITL: 0%**

### 6.2 After (Mastra)

```
Blocker detected (inside check_blockers step)
  → job status = 'paused'
  → callback 'needs_human'
  → await suspend({...})
  → workflow state saved to Postgres
  → WORKER FREED (returns from execute, picks up next job)

Resume request arrives (POST /valet/resume)
  → resolution stored in DB
  → job status = 'pending', resume_requested = true
  → pg_notify wakes dispatcher

Any available worker picks up the job
  → detects mastra_run_id + resume_requested
  → creates adapter, navigates, restores session
  → reads + clears resolution data from DB
  → injects credentials
  → workflow.resume() continues from suspend point
  → if blocker persists: re-suspend
  → if context mismatch: new HITL request ('context_lost')
```

**Worker utilization during HITL: 100% (freed to process other jobs)**

---

## 7. Checkpoint Boundaries (Phase 2, For Reference)

Phase 1 runs SmartApplyHandler as a single opaque step. Phase 2 would decompose it. Here are the natural checkpoint boundaries in SmartApplyHandler's actual page loop ([smartApplyHandler.ts:98-346](packages/ghosthands/src/workers/taskHandlers/smartApplyHandler.ts#L98)):

| Location | Line | Why It's Safe |
|----------|------|---------------|
| Top of `while` loop (before `detectPage`) | 98-101 | Page is loaded, no partial state. Can re-detect from scratch. |
| After `handleJobListing` (Apply clicked) | 150 | Page transition complete. Can re-detect next page. |
| After `handleGenericLogin` | 158-163 | Login attempted. Can verify login state on resume. |
| After `fillPage` returns | 318-343 | Fields filled, navigation triggered. Next loop iteration re-detects. |
| Before `clickNextButton` | 252 | Form filled but not submitted. Safe to re-verify before clicking. |

**NOT safe to suspend:**
- Mid-`fillPage` (partial form state, browser DOM is dirty)
- Mid-`adapter.act()` (LLM agent has in-flight actions)
- Mid-page transition (URL changing, DOM unstable)

Phase 2 would modify SmartApplyHandler to yield control at the top of each loop iteration, allowing Mastra to model each page as a workflow step.

---

## 8. VALET Contract Changes

### 8.1 New Execution Mode

Add `mastra` to accepted `execution_mode` values. Backward compatible — existing values unchanged.

### 8.2 New Interaction Type

When crash recovery fails to restore context:

```json
{
  "job_id": "...",
  "status": "needs_human",
  "interaction": {
    "type": "context_lost",
    "screenshot_url": "...",
    "page_url": "...",
    "message": "Browser context could not be restored after interruption. Please verify the page state.",
    "timeout_seconds": 300
  }
}
```

VALET should treat `context_lost` like any other HITL blocker — show the screenshot, provide a "I've resolved it" button, and call resume.

### 8.3 No Other Contract Changes

Callback payloads for `running`, `completed`, `failed`, `needs_human`, `resumed` are unchanged. Status API responses are unchanged. The `mastra` mode is transparent to VALET except for the new `execution_mode` value and `context_lost` interaction type.

---

## 9. Storage, Migration, Security

### 9.1 Storage

`@mastra/pg` PostgresStore with `process.env.DATABASE_URL` (existing Supabase Postgres).

Mastra auto-creates tables: `mastra_workflow_snapshot`, etc. These do NOT use the `gh_` prefix (Mastra-managed). Documented in migration inventory but not manually created.

### 9.2 Migration

```sql
-- migrations/015_mastra_mode.sql

-- 1. execution_mode is already TEXT — no ALTER needed.
--    Just document that 'mastra' is now a valid value.

-- 2. RLS for Mastra tables (auto-created by @mastra/pg)
--    Run AFTER Mastra has bootstrapped its tables:

ALTER TABLE IF EXISTS mastra_workflow_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY mastra_service_only ON mastra_workflow_snapshot
  FOR ALL USING (current_setting('role') = 'service_role');

-- 3. Cleanup: delete snapshots older than 7 days (run via cron or pg_cron)
-- SELECT cron.schedule('mastra-snapshot-cleanup', '0 3 * * *',
--   $$DELETE FROM mastra_workflow_snapshot WHERE updated_at < NOW() - INTERVAL '7 days'$$);
```

### 9.3 Security Controls

| Concern | Mitigation |
|---------|------------|
| Credentials in Mastra snapshots | `resumeSchema` contains `resolutionType` (enum) only. Passwords/codes read from DB directly, never enter Mastra schemas. |
| PII in workflow state | Same PII that's already in `gh_automation_jobs.input_data`. No new exposure. |
| Mastra tables without RLS | Migration 015 adds service-role-only RLS. |
| Snapshot retention | 7-day cleanup via scheduled SQL. |
| CI enforcement | Unit test rejects step schemas containing forbidden key names (`password`, `resolution_data`, `otp`, `credential`, `secret`, `token`). |

---

## 10. Cost and Progress

### 10.1 Cost

`CostTracker` remains the single source of truth for budget enforcement.

Mastra step outputs include `costUsd` as read-only metadata for observability. These are derived FROM `CostTracker`, never the reverse. No double-counting.

### 10.2 Progress

Existing `ProgressStep` vocabulary is preserved. Mapping:

| Workflow Event | Progress Step | Existing Literal |
|---------------|---------------|-----------------|
| `cookbook_attempt` starts | NAVIGATING | `navigating` |
| `cookbook_attempt` succeeds | COMPLETED | `completed` |
| `execute_handler` starts | FILLING_FORM | `filling_form` |
| `check_blockers` suspends | (no change — handler sets progress internally) | — |
| Workflow completes | COMPLETED | `completed` |

No new progress step literals are introduced. The handler internally calls `progress.setStep()` as it does today.

### 10.3 Progress Metadata Extension

Add optional `orchestrator` field to progress metadata:

```typescript
// In ProgressTracker, extend metadata type:
orchestrator?: 'legacy' | 'mastra';
```

This lets VALET know which orchestration path is active without overloading `execution_mode` semantics.

---

## 11. Dependencies

### 11.1 New Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `@mastra/core` | `1.7.x` (pinned exact) | Workflow engine |
| `@mastra/pg` | `1.7.x` (pinned exact) | PostgresStore |

### 11.2 Bun Compatibility

**Must be validated in Phase 0.** Mastra targets Node.js. Known risks:
- `@mastra/core` may use Node-specific APIs (worker_threads, vm, diagnostics_channel)
- `@mastra/pg` uses the `pg` package, which Bun supports

Phase 0 runs a trivial workflow (create → execute → suspend → resume) under Bun. If it fails, the entire Mastra integration is blocked until Bun compatibility is resolved or we switch to Node.js.

### 11.3 Version Pinning

Pin exact versions in `package.json`. Mastra is at 1.7.x with rapid iteration. Test on upgrade; don't auto-bump.

---

## 12. Rollout Plan

### Phase 0: Mandatory Spike (No Production Traffic)

**Gate:** Must pass ALL items before Phase 1 proceeds.

1. **Bun compatibility:** Install `@mastra/core` + `@mastra/pg`, run trivial workflow under Bun.
2. **Latency benchmark:** Measure workflow overhead (create + 3-step execute + snapshot persist). Threshold: < 500ms overhead vs. direct function calls.
3. **Suspend/resume roundtrip:** Verify suspend serializes to Postgres, resume from different process works.
4. **Secret persistence test:** Create workflow with step that handles credentials. Verify credentials don't appear in `mastra_workflow_snapshot` rows.
5. **Mastra resume API:** Verify `workflow.resume()` can be called from a different process than the one that called `workflow.execute()`. This is critical for AD-2.

**Abort if:** Bun incompatibility, credentials leak into snapshots, resume from different process doesn't work, overhead > 500ms.

### Phase 1: HITL Durable Suspend/Resume

1. Add `mastra` to execution mode enum.
2. Implement `applyWorkflow` with three steps: `check_blockers`, `cookbook_attempt`, `execute_handler`.
3. Implement worker-owned resume coordinator.
4. Modify resume API route for mastra-mode jobs.
5. Implement `context_lost` HITL interaction type.
6. Tests:
   - Happy path: cookbook success in mastra mode → parity with legacy
   - Happy path: handler execution in mastra mode → parity with legacy
   - HITL: blocker detected → suspend → worker freed → resume → complete
   - HITL crash: blocker → suspend → worker killed → new worker resumes → complete
   - HITL timeout: blocker → suspend → 300s expires → job fails
   - Context mismatch: suspend → resume → page state changed → `context_lost` → new HITL
   - Secret safety: resolution_data not in mastra_workflow_snapshot
7. Deploy as opt-in. No automatic routing to mastra mode.

### Phase 2: SmartApplyHandler Page-Level Decomposition

**Prerequisite:** Phase 1 incident-free for 2 weeks, 100+ mastra-mode jobs completed.

1. Modify SmartApplyHandler to accept a `checkpoint` callback.
2. At each page loop iteration top, handler calls `checkpoint({ pageIndex, pagesProcessed, ... })`.
3. Mastra workflow models the page loop as `doUntil`, with each iteration as a step.
4. HITL can now suspend at page boundaries (not just initial navigation).
5. Per-page cost attribution via step-level output.

### Phase 3: V3ExecutionEngine Integration (Future)

**Prerequisite:** V3ExecutionEngine is wired into JobExecutor for at least one execution mode.

1. Mastra wraps V3's SectionOrchestrator per-page loop.
2. Per-section steps enable finer-grained suspend/resume and observability.
3. This phase is explicitly NOT planned in detail because V3 wiring is a separate effort.

**Honest assessment:** Phase 3 requires re-building the Mastra workflow against V3's architecture. It is NOT incremental from Phase 2. Plan accordingly.

Rollback at any phase: set `execution_mode` away from `mastra`.

---

## 13. Success Metrics

| Metric | Phase 1 Threshold | Measurement |
|--------|-------------------|-------------|
| Success rate parity | mastra >= legacy - 1% | 500+ jobs |
| Median cost/job | mastra <= legacy + 5% | Mastra overhead included |
| Median wall time | mastra <= legacy + 15% | Workflow overhead expected |
| HITL worker utilization | mastra > 0% during pause (vs. legacy 0%) | New metric: jobs processed by worker during HITL pause |
| HITL crash recovery | >= 90% of crash-during-pause jobs successfully resume | New capability |
| Callback contract regressions | 0 | Automated contract tests |
| Credentials in snapshots | 0 incidents | CI test + periodic audit |
| Duplicate callback incidents | 0 | Idempotency guards |

---

## 14. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Bun incompatibility | **Blocking** | Phase 0 gate. No workaround — switch to Node or abandon. |
| `workflow.resume()` doesn't work cross-process | **Blocking** | Phase 0 gate. Core assumption of AD-2. |
| Re-queued resume job picked up by non-mastra-aware worker | High | Discriminator check: `mastra_run_id + resume_requested` must both be present. Worker without Mastra support skips these jobs (remains `pending`). |
| SmartApplyHandler internal state lost on crash recovery | High | AD-4: honest scope. Handler restarts from `target_url` with session cookies, same as current crash recovery. Not worse than today. |
| Mastra overhead exceeds 500ms per workflow | Medium | Phase 0 benchmark. If borderline, consider lazy initialization. |
| Phase 3 requires V3 wiring (separate effort) | Medium | Explicitly called out. Phase 3 is not committed. |
| Mastra version churn | Medium | Pin exact versions. Integration tests on upgrade. |
| `pending` status for resumed jobs confuses monitoring | Medium | Add `orchestrator: 'mastra'` + `resume_requested: true` to metadata. Monitoring queries filter on these. |
| Mastra tables grow unbounded | Low | 7-day snapshot cleanup. MAXLEN on any internal streams. |

---

## 15. Test Plan

### 15.1 Unit

1. **Schema guard:** No Mastra step schema contains forbidden keys (`password`, `resolution_data`, `otp`, `credential`, `secret`, `token`).
2. **Mode enum compatibility:** `mastra` is accepted; all existing modes still accepted.
3. **Resume discriminator:** Jobs with `mastra_run_id + resume_requested` are identified as resumes; jobs without are identified as fresh.
4. **Idempotent transitions:** Pause SQL only transitions from non-paused. Resume SQL only transitions from paused with `resume_requested`.

### 15.2 Integration

1. **Parity: cookbook path.** `execution_mode=mastra` with matching manual → cookbook succeeds → same result as legacy.
2. **Parity: handler path.** `execution_mode=mastra` with no manual → SmartApplyHandler runs → same result as legacy.
3. **HITL suspend.** Blocker detected → workflow suspends → worker returns → job status `paused` → callback sent.
4. **HITL resume.** Resume API called → job re-queued → worker picks up → credentials injected → workflow continues → completes.
5. **HITL crash recovery.** Suspend → kill worker process → new worker starts → picks up job → resumes from snapshot → completes.
6. **HITL timeout.** Suspend → 300s passes → job fails with `hitl_timeout`.
7. **Context mismatch.** Suspend → resume → page state unrecognizable → `context_lost` HITL request.
8. **Secret safety.** After HITL flow, query `mastra_workflow_snapshot` → no password/code values present.
9. **Legacy unaffected.** `execution_mode=smart_apply` runs exactly as before with zero Mastra involvement.

### 15.3 Contract

1. All callback payloads match existing schemas.
2. `context_lost` interaction type is documented and handled by VALET mock.
3. Status API responses for mastra-mode jobs match existing format.

---

## 16. Open Questions (Narrowed)

1. **Mastra table naming:** Mastra auto-creates `mastra_workflow_snapshot` etc. These don't follow the `gh_` prefix. Options: (a) accept it, (b) configure custom table prefix if Mastra supports it. Investigate in Phase 0.
2. **PgBossConsumer vs. JobPoller for resume dispatch:** Both exist. Resume uses `pg_notify('gh_job_created')` which wakes JobPoller. Does PgBossConsumer also pick up re-queued jobs? Verify in Phase 0.
3. **Snapshot size for long-running jobs:** A 15-page SmartApplyHandler run with full cookbookActions recorded — how large is the Mastra snapshot? If > 1MB, consider pruning intermediate state. Measure in Phase 0.

---

## 17. Implementation Checklist

### Phase 0
- [ ] Install `@mastra/core` + `@mastra/pg`, verify trivial workflow runs under Bun
- [ ] Benchmark workflow overhead (target < 500ms)
- [ ] Verify cross-process `workflow.resume()` works
- [ ] Verify no credentials in `mastra_workflow_snapshot` after suspend/resume
- [ ] Verify PgBossConsumer handles re-queued resume jobs
- [ ] Go/no-go decision

### Phase 1
- [ ] Add `mastra` to execution mode enum in `valet.ts` schemas
- [ ] Create `workflows/mastra/` directory and all files from Section 5.1
- [ ] Implement `getMastra()` singleton
- [ ] Implement `cookbookAttemptStep` wrapping V1 ExecutionEngine
- [ ] Implement `executeHandlerStep` wrapping resolved handler
- [ ] Implement `checkBlockersStep` with `suspend()`
- [ ] Implement `resumeCoordinator.ts`
- [ ] Modify `JobExecutor.execute()` to branch on `execution_mode === 'mastra'`
- [ ] Modify resume API route for mastra-mode jobs
- [ ] Add `context_lost` interaction type to callback payloads
- [ ] Add migration 015 (RLS on Mastra tables + snapshot cleanup)
- [ ] Add schema guard CI test
- [ ] Add idempotency guard tests
- [ ] Run full integration test suite (Section 15.2)
- [ ] Deploy as opt-in
