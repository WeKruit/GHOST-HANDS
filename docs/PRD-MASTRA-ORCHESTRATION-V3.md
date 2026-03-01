# PRD: Mastra-Orchestrated Execution for GHOST-HANDS (V3)

**Author:** Claude (rewrite from V2 PRD critique)
**Date:** 2026-03-01
**Status:** Draft
**Supersedes:** PRD-MASTRA-ORCHESTRATION-V2.md

---

## 0. What Changed from V2 (and Why)

V2 was built on an outdated understanding of the codebase. This section documents every structural problem and how V3 addresses it.

### 0.1 V2 Described the Wrong Runtime

**V2 said:** The active production flow is `JobExecutor -> ExecutionEngine (cookbook-first) -> fallback TaskHandler`.

**Reality:** The system has a full V3 execution engine:
- `V3ExecutionEngine` — top-level orchestrator (cookbook -> orchestrator fallback)
- `SectionOrchestrator` — multi-page form loop with per-section, per-field execution
- Three `LayerHand` implementations: `DOMHand` ($0/action), `StagehandHand` ($0.0005/action), `MagnitudeHand` ($0.005/action)
- Cost-aware escalation: DOMHand -> StagehandHand -> MagnitudeHand per field based on confidence
- `CookbookExecutorV3` — two-strategy replay (DOM-first, GUI fallback)

The V1 `ExecutionEngine` still exists but V3 is the actively developed path. Any orchestration migration must target V3.

**V3 fix:** This PRD is grounded in the V3 architecture. All references are to actual files and interfaces.

### 0.2 V2's "Coarse Workflow" Adds Overhead for Zero Value

**V2 proposed:** 5 coarse workflow nodes: `prepare_context`, `check_blockers`, `cookbook_attempt`, `handler_fallback`, `finalize_job`.

**Problem:** These are 5 sequential function calls. Wrapping them in a workflow engine adds:
- Mastra initialization and step serialization overhead
- Extra DB writes for workflow snapshots between steps
- A new dependency in the critical path
- No actual improvement — the steps are already sequential and don't benefit from branching, parallelism, or suspend/resume

**V3 fix:** Mastra orchestration is applied where it adds value — at the Hand/layer selection level and HITL suspend/resume — not as a wrapper around sequential calls.

### 0.3 V2 Never Justified Why Mastra

**Problem:** Mastra's core strength is LLM-powered agent orchestration (agents reason about which tools/sub-agents to invoke). But Hand selection in GHOST-HANDS is deterministic:
- Field confidence > 0.8 -> DOMHand
- Confidence 0.5-0.8 -> StagehandHand
- Confidence < 0.5 -> MagnitudeHand
- On failure -> escalate to next layer

This is a heuristic cascade, not an LLM reasoning task. Using Mastra's Agent primitive to select Hands would be more expensive and less predictable than the current approach.

**V3 fix:** This PRD uses Mastra's workflow primitives (steps, branching, suspend/resume) for control flow, NOT its Agent primitive for Hand selection. Agent primitives are reserved for cases where LLM reasoning genuinely helps (e.g., ambiguous field matching, complex multi-page navigation).

### 0.4 V2 Had No Concrete API Mapping

**Problem:** V2 said "add Mastra workflow" but showed zero code. No step definitions, no schemas, no tool registrations. Impossible to review or implement.

**V3 fix:** Section 6 includes concrete Mastra code for every proposed workflow step.

### 0.5 V2 Punted on HITL

**Problem:** V2 said "keep existing HITL implementation as source of truth" and deferred Mastra's native `suspend()`/`resume()` indefinitely. But suspend/resume is Mastra's best feature for this use case — it serializes workflow state, persists it to Postgres, and resumes exactly where it left off after a deployment or restart.

**V3 fix:** HITL uses Mastra's `suspend()`/`resume()` from Phase 1. The existing HITL side effects (DB state transitions, VALET callbacks, credential injection, security cleanup) are preserved as explicit steps around the suspend point.

### 0.6 V2 Left Storage as an Open Question

**Problem:** "Which storage backend for Mastra run state?" was listed as an open question. GHOST-HANDS already uses Postgres via Supabase. Mastra has `@mastra/pg` (PostgresStore).

**V3 fix:** Storage is `@mastra/pg` pointing at the existing Supabase Postgres. Decision made. See Section 6.2.

### 0.7 V2 Ignored Dependency and Runtime Concerns

**Problem:** No mention of `@mastra/core` or `@mastra/pg` as dependencies. No discussion of Bun compatibility, bundle size, or version pinning.

**V3 fix:** Section 7 covers dependency analysis.

### 0.8 V2 Had No Security Analysis

**Problem:** Mastra persists workflow snapshots to Postgres. These could contain sensitive data (credentials, resolution data, user PII). V2's "runtime-only context must never be persisted" rule is necessary but insufficient.

**V3 fix:** Section 10 includes a security analysis with concrete mitigations.

---

## 1. Executive Summary

This PRD proposes using Mastra's workflow primitives to orchestrate the V3 execution engine in GHOST-HANDS. The integration targets two specific pain points:

1. **HITL suspend/resume** — Replace the current LISTEN/NOTIFY + polling HITL gate with Mastra's native `suspend()`/`resume()`, gaining durable state persistence across deployments.
2. **Per-page execution traceability** — Model the SectionOrchestrator's multi-page loop as a Mastra workflow with observable steps, enabling step-level cost tracking and replay.

What this does NOT do:
- Replace Hand selection logic with LLM-driven agent reasoning
- Replace the adapter layer or Hand implementations
- Replace the job queue (pg LISTEN/NOTIFY + JobPoller)
- Replace the Hono API or callback system

---

## 2. Current State (Actual, As Implemented)

### 2.1 V3 Runtime Path

```
JobExecutor.execute(job)
  │
  ├─ Preflight: CostControlService budget check
  ├─ Adapter: createAdapter('magnitude' | 'stagehand')
  ├─ Session: SessionManager.load(userId, domain)
  │
  └─ V3ExecutionEngine.execute(ctx)
       │
       ├─ Cookbook path (if manual exists + health > 0.3):
       │  └─ CookbookExecutorV3: DOM-first replay, GUI fallback
       │
       └─ Orchestrator path (if no cookbook or cookbook failed):
            └─ SectionOrchestrator.run(ctx)
                 │
                 └─ For each page (max 15):
                      ├─ Observe: DOMHand scans form fields (free)
                      ├─ Group: SectionGrouper clusters by Y-position
                      ├─ For each section:
                      │  ├─ Match: FieldMatcher (7-strategy heuristic)
                      │  ├─ Plan: assign Hand by confidence
                      │  ├─ Execute: DOMHand → StagehandHand → MagnitudeHand
                      │  ├─ Review: verify field values
                      │  └─ Record: add to cookbook trace
                      ├─ Check blockers → HITL if detected
                      └─ Navigate to next page or submit
```

### 2.2 Key Files

| Component | File | Size |
|-----------|------|------|
| LayerHand (base) | `engine/v3/LayerHand.ts` | Abstract class, 6-method contract |
| DOMHand | `engine/v3/layers/DOMHand.ts` | Pure DOM injection, $0/action |
| StagehandHand | `engine/v3/layers/StagehandHand.ts` | a11y observe + DOM fill, $0.0005/action |
| MagnitudeHand | `engine/v3/layers/MagnitudeHand.ts` | Full GUI agent, $0.005/action |
| SectionOrchestrator | `engine/v3/SectionOrchestrator.ts` | 44KB, multi-page loop |
| V3ExecutionEngine | `engine/v3/V3ExecutionEngine.ts` | Cookbook-first, orchestrator fallback |
| CookbookExecutorV3 | `engine/v3/CookbookExecutorV3.ts` | Two-strategy replay |
| Adapter interface | `adapters/types.ts` | BrowserAutomationAdapter, HitlCapableAdapter |
| MagnitudeAdapter | `adapters/magnitude.ts` | 437 lines |
| StagehandAdapter | `adapters/stagehand.ts` | 631 lines |
| JobExecutor | `workers/JobExecutor.ts` | ~1260 lines |
| Job schemas | `api/schemas/job.ts` | Zod validation |

### 2.3 HITL Today (Actual Implementation)

Current HITL flow in `JobExecutor`:

1. `BlockerDetector.detectWithAdapter()` finds blocker (captcha/login/2fa)
2. Job status → `paused` in DB
3. `CallbackNotifier` sends `needs_human` to VALET with screenshot + blocker type
4. `pg_notify('gh_job_resume', jobId)` listener waits (+ 3s poll fallback)
5. VALET calls `POST /valet/resume/:jobId` with optional `resolution_type` + `resolution_data`
6. Resume route stores resolution in `interaction_data` JSONB, fires `pg_notify`
7. `waitForResume()` returns `ResumeResult` with resolution context
8. `readAndClearResolutionData()` reads + immediately deletes sensitive data
9. Based on `resolutionType`: inject 2FA code, credentials, or skip
10. `adapter.resume(context)` unblocks the pause gate
11. Post-resume verification: re-check blockers up to 3 times
12. Default timeout: 300s

**Problems with current approach:**
- State is split between DB columns, LISTEN/NOTIFY, and in-memory promise gates
- If the worker crashes during HITL pause, the job is stuck (no durable state snapshot)
- Resume logic is interleaved with execution logic in JobExecutor (~200 lines of HITL code)
- No way to inspect "what step was the workflow at when it paused"

### 2.4 Existing Control Plane

- `execution_mode` column on `gh_automation_jobs`: `auto`, `ai_only`, `cookbook_only`
- `final_mode` column: `cookbook`, `magnitude`, `hybrid`, `v3_orchestrator`
- `engine_type` column: `cookbook` or `magnitude`
- API schema validates allowed modes (Zod enum in `job.ts`)

---

## 3. Problem Statement

Two specific problems justify adding a workflow layer:

### 3.1 HITL Is Fragile

The current HITL implementation is a hand-rolled state machine spread across JobExecutor, Postgres LISTEN/NOTIFY, adapter pause gates, and DB column updates. If a worker crashes while a job is paused, the job is lost. There is no durable snapshot of "where the workflow was" at the time of pause.

Mastra's `suspend()`/`resume()` solves this directly: it serializes workflow state to Postgres, survives restarts, and resumes at the exact step.

### 3.2 SectionOrchestrator Is a 44KB Monolith

`SectionOrchestrator.ts` is a single file containing the multi-page loop, per-section execution, escalation logic, blocker detection, and cookbook recording. It works, but:

- No step-level observability (you can't see "which page/section is currently executing" from outside)
- No step-level cost attribution (cost is aggregated, not per-page or per-section)
- No step-level retry (if page 3 of 5 fails, the whole orchestrator fails)
- Adding new orchestration patterns (parallel section fill, conditional page skip) requires modifying the monolith

Modeling the per-page loop as a Mastra workflow gives step-level observability, cost attribution, and retry semantics without rewriting the core logic.

---

## 4. Goals and Non-Goals

### 4.1 Goals

1. Replace HITL's hand-rolled state machine with Mastra `suspend()`/`resume()`.
2. Model SectionOrchestrator's per-page loop as a Mastra workflow for step-level observability.
3. Preserve the deterministic Hand escalation policy (DOMHand → StagehandHand → MagnitudeHand). Do NOT replace it with LLM-driven agent selection.
4. Preserve existing cost controls, callbacks, DB updates, and VALET contracts.
5. Use `@mastra/pg` backed by the existing Supabase Postgres.
6. Enable opt-in rollout via `execution_mode` flag.

### 4.2 Non-Goals

1. **NOT replacing Hand selection with Mastra Agents.** Hand selection is deterministic (confidence-based heuristics). Making it LLM-driven would add cost and reduce predictability.
2. **NOT replacing the job queue.** `pg LISTEN/NOTIFY` + `JobPoller` + `gh_pickup_next_job()` works. Mastra is not a job queue.
3. **NOT replacing adapters.** `MagnitudeAdapter`, `StagehandAdapter` stay as-is. Hands continue to use them.
4. **NOT adding Mastra's Agent primitive for orchestration.** Workflow steps + tools only.
5. **NOT modeling the coarse job lifecycle as a workflow.** Preflight, adapter setup, session load, and finalization remain imperative code in JobExecutor. Only the execution phase becomes a workflow.

---

## 5. Proposed Solution

### 5.1 Where Mastra Fits

```
JobExecutor.execute(job)
  │
  ├─ [UNCHANGED] Preflight, adapter setup, session load
  │
  ├─ [NEW] If execution_mode === 'mastra':
  │    └─ MastraExecutionWorkflow.execute(ctx)
  │         │
  │         ├─ Step: cookbook_attempt (wraps CookbookExecutorV3)
  │         │  └─ On success → finalize
  │         │  └─ On failure → continue to orchestrate
  │         │
  │         └─ Step: orchestrate_pages (replaces SectionOrchestrator loop)
  │              │
  │              └─ doUntil(allPagesComplete || maxPages):
  │                   │
  │                   ├─ Step: observe_page → DOMHand.observe()
  │                   ├─ Step: group_sections → SectionGrouper
  │                   ├─ Step: fill_sections → for each section:
  │                   │    ├─ match fields (FieldMatcher)
  │                   │    ├─ plan actions (confidence → Hand)
  │                   │    └─ execute + review + escalate
  │                   ├─ Step: check_blockers
  │                   │    └─ If blocker: suspend(blockerPayload)
  │                   │       └─ On resume: inject credentials, verify
  │                   └─ Step: navigate_or_submit
  │
  ├─ [UNCHANGED] If execution_mode !== 'mastra':
  │    └─ V3ExecutionEngine.execute(ctx) (existing path)
  │
  └─ [UNCHANGED] Finalization, callback, cost recording
```

### 5.2 What Becomes Mastra Steps vs. What Stays Imperative

| Logic | Mastra Step? | Rationale |
|-------|-------------|-----------|
| Preflight budget check | No | Single function call, no branching/suspend needed |
| Adapter creation | No | Non-serializable runtime setup |
| Session load | No | Non-serializable browser state |
| Cookbook attempt | Yes | Benefits from step-level observability and cost tracking |
| Per-page observe | Yes | Observable, restartable |
| Section grouping | Yes | Pure computation, easy to trace |
| Per-section fill | Yes | Benefits from step-level retry and cost attribution |
| Blocker check + HITL | Yes | Primary use case for suspend/resume |
| Page navigation | Yes | Observable, retryable |
| Finalization + callback | No | Side effects that must run exactly once, outside workflow |

### 5.3 HITL via Mastra Suspend/Resume

```
Step: check_blockers
  │
  ├─ BlockerDetector.detectWithAdapter(adapter)
  │
  ├─ If blocker detected:
  │    ├─ Update job status → 'paused' in DB
  │    ├─ Send 'needs_human' callback to VALET
  │    ├─ await suspend({
  │    │    blocker_type: 'captcha',
  │    │    page_url: currentUrl,
  │    │    screenshot_url: screenshotUrl,
  │    │    timeout_seconds: 300
  │    │  })
  │    │  ── workflow state serialized to Postgres ──
  │    │  ── worker is free to pick up other jobs ──
  │    │
  │    ├─ On resume (VALET calls API → workflow.resume()):
  │    │    ├─ resumeData contains resolution_type + resolution_data
  │    │    ├─ Inject credentials/code via existing Playwright selectors
  │    │    ├─ Clear resolution_data from DB (security)
  │    │    ├─ adapter.resume(context)
  │    │    └─ Re-check blockers (up to 3 times)
  │    │
  │    └─ On timeout (300s):
  │         └─ Fail with error_code: 'hitl_timeout'
  │
  └─ If no blocker: continue to next step
```

**Key advantage over current approach:** If the worker crashes while the job is suspended, Mastra's PostgresStore has the full workflow snapshot. A new worker can resume the workflow from the suspend point without re-executing prior steps.

### 5.4 Hand Selection Stays Deterministic

The current escalation policy is preserved exactly:

```typescript
// This logic does NOT change. It stays in SectionOrchestrator / fill_sections step.
function selectHand(confidence: number, escalationPolicy: EscalationPolicy): LayerId {
  if (confidence > 0.8) return 'dom';
  if (confidence > 0.5) return 'stagehand';
  return 'magnitude';
}

function escalate(currentLayer: LayerId, policy: EscalationPolicy): LayerId | null {
  const order = policy.layerOrder; // ['dom', 'stagehand', 'magnitude']
  const idx = order.indexOf(currentLayer);
  return idx < order.length - 1 ? order[idx + 1] : null;
}
```

Mastra Agent primitives are NOT used for Hand selection. This is a workflow step that calls deterministic functions.

### 5.5 New Execution Mode

Add `mastra` to the `execution_mode` enum:

```typescript
// api/schemas/job.ts
const executionModeEnum = z.enum(['auto', 'ai_only', 'cookbook_only', 'mastra']);
```

Behavior:
- `execution_mode !== 'mastra'` → existing V3ExecutionEngine path (unchanged)
- `execution_mode === 'mastra'` → Mastra workflow in JobExecutor

Rollback: set `execution_mode` to any non-mastra value.

---

## 6. Technical Design

### 6.1 Mastra Initialization

```typescript
// workflows/mastra/init.ts
import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';

let mastraInstance: Mastra | null = null;

export function getMastra(): Mastra {
  if (!mastraInstance) {
    mastraInstance = new Mastra({
      storage: new PostgresStore({
        connectionString: process.env.DATABASE_URL!,
      }),
      workflows: {
        applyWorkflow,
      },
    });
  }
  return mastraInstance;
}
```

### 6.2 Storage

`@mastra/pg` PostgresStore using the existing `DATABASE_URL` (Supabase Postgres).

Mastra auto-creates its own tables (`mastra_workflow_snapshot`, etc.) with composite indexes. These tables do NOT use the `gh_` prefix because they are Mastra-managed. Document them in the migration inventory.

**Cleanup policy:** Workflow snapshots for completed/failed jobs should be pruned after 7 days. Add a cron job or scheduled task.

### 6.3 Workflow Definition

```typescript
// workflows/mastra/applyWorkflow.ts
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// ── Schemas ──

const workflowInputSchema = z.object({
  jobId: z.string().uuid(),
  targetUrl: z.string().url(),
  executionMode: z.enum(['auto', 'mastra']),
  userData: z.record(z.unknown()),
  platformHint: z.string().optional(),
  budget: z.number(),
  qualityPreset: z.enum(['speed', 'balanced', 'quality']),
});

const pageResultSchema = z.object({
  pageIndex: z.number(),
  fieldsFound: z.number(),
  fieldsFilled: z.number(),
  costIncurred: z.number(),
  cookbookActions: z.array(z.unknown()),
  blockerDetected: z.boolean(),
});

const workflowOutputSchema = z.object({
  success: z.boolean(),
  totalCost: z.number(),
  pagesProcessed: z.number(),
  finalMode: z.string(),
  cookbookActions: z.array(z.unknown()),
  errorCode: z.string().optional(),
});

// ── Steps ──

const cookbookAttemptStep = createStep({
  id: 'cookbook_attempt',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({
    cookbookSuccess: z.boolean(),
    cost: z.number(),
    fallbackReason: z.string().optional(),
  }),
  execute: async ({ inputData, mapiData }) => {
    // Wraps existing CookbookExecutorV3
    // Runtime context (adapter, page) passed via mapiData or injected
    // Returns success/failure without modifying CookbookExecutorV3 internals
  },
});

const observePageStep = createStep({
  id: 'observe_page',
  inputSchema: z.object({ pageIndex: z.number() }),
  outputSchema: z.object({
    fields: z.array(z.unknown()),
    buttons: z.array(z.unknown()),
    fingerprint: z.string(),
    blockers: z.array(z.unknown()),
  }),
  execute: async ({ inputData }) => {
    // Calls DOMHand.observe(ctx) — free, no LLM
  },
});

const fillSectionsStep = createStep({
  id: 'fill_sections',
  inputSchema: z.object({
    sections: z.array(z.unknown()),
    pageIndex: z.number(),
  }),
  outputSchema: z.object({
    fieldsFilled: z.number(),
    costIncurred: z.number(),
    cookbookActions: z.array(z.unknown()),
    errors: z.array(z.unknown()),
  }),
  execute: async ({ inputData }) => {
    // Existing per-section logic:
    // 1. FieldMatcher.match()
    // 2. Plan actions (confidence → Hand)
    // 3. Execute with escalation (DOM → Stagehand → Magnitude)
    // 4. Review results
    // 5. Record cookbook actions
  },
});

const checkBlockersStep = createStep({
  id: 'check_blockers',
  inputSchema: z.object({ pageIndex: z.number() }),
  outputSchema: z.object({ blocked: z.boolean(), blockerType: z.string().optional() }),
  resumeSchema: z.object({
    resolutionType: z.enum(['manual', 'code_entry', 'credentials', 'skip']),
    resolutionData: z.record(z.unknown()).optional(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (resumeData) {
      // Resumed from HITL — inject credentials, verify blocker resolved
      return { blocked: false };
    }

    const blockers = await detectBlockers(adapter);
    if (blockers.length > 0 && blockers[0].confidence > 0.6) {
      // Update DB, send callback, then suspend
      await updateJobStatus(jobId, 'paused');
      await sendCallback(jobId, 'needs_human', blockers[0]);
      await suspend({
        blockerType: blockers[0].type,
        pageUrl: await adapter.getCurrentUrl(),
        screenshotUrl: await captureAndUpload(),
        timeoutSeconds: 300,
      });
    }

    return { blocked: false };
  },
});

const navigateOrSubmitStep = createStep({
  id: 'navigate_or_submit',
  inputSchema: z.object({
    pageIndex: z.number(),
    isLastPage: z.boolean(),
  }),
  outputSchema: z.object({
    navigated: z.boolean(),
    submitted: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    if (inputData.isLastPage) {
      // Click submit via MagnitudeHand
      return { navigated: false, submitted: true };
    }
    // Navigate to next page
    return { navigated: true, submitted: false };
  },
});

// ── Workflow Assembly ──

export const applyWorkflow = createWorkflow({
  id: 'gh_apply',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(cookbookAttemptStep)
  .branch([
    [
      async ({ inputData }) => inputData.cookbookSuccess === true,
      createStep({
        id: 'cookbook_success',
        inputSchema: z.object({ cookbookSuccess: z.boolean(), cost: z.number() }),
        outputSchema: workflowOutputSchema,
        execute: async ({ inputData }) => ({
          success: true,
          totalCost: inputData.cost,
          pagesProcessed: 1,
          finalMode: 'cookbook',
          cookbookActions: [],
        }),
      }),
    ],
    [
      async () => true, // default: cookbook failed or skipped
      createWorkflow({ id: 'orchestrate_pages', /* doUntil loop over pages */ })
        .then(observePageStep)
        .then(fillSectionsStep)
        .then(checkBlockersStep)
        .then(navigateOrSubmitStep),
    ],
  ])
  .commit();
```

### 6.4 Runtime Context Boundary

**Serializable state** (persisted in Mastra snapshots):

```typescript
interface WorkflowPersistedState {
  jobId: string;
  targetUrl: string;
  executionMode: string;
  pageIndex: number;
  totalCost: number;
  fieldsFilled: number;
  cookbookActions: CookbookAction[];
  lastStepOutcome: 'success' | 'failure' | 'suspended';
  blockerMetadata?: { type: string; confidence: number };
}
```

**Non-serializable context** (injected at workflow start, NOT persisted):

```typescript
interface WorkflowRuntimeContext {
  adapter: HitlCapableAdapter;
  page: Page;                       // Playwright page
  costTracker: CostTracker;
  progressTracker: ProgressTracker;
  logger: Logger;
  supabase: SupabaseClient;
}
```

**Enforcement:** Runtime context is passed via closure, not through Mastra's step I/O schemas. Zod schemas for step inputs/outputs only contain serializable data. A unit test asserts that no step schema references `Page`, `Browser`, `SupabaseClient`, or adapter types.

**On resume after crash:** The workflow snapshot is loaded from Postgres. Runtime context must be re-created:
1. Create new adapter + start browser
2. Navigate to `targetUrl`
3. Restore session from `gh_browser_sessions`
4. Inject runtime context into resumed workflow

### 6.5 Resume API Integration

When VALET calls `POST /valet/resume/:jobId`:

```typescript
// api/routes/valet.ts (modified)
app.post('/valet/resume/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const body = await c.req.json();

  const job = await getJob(jobId);

  if (job.execution_mode === 'mastra') {
    // Resume via Mastra workflow
    const mastra = getMastra();
    const workflow = mastra.getWorkflow('gh_apply');
    const run = workflow.getRunById(job.metadata.mastra_run_id);
    await run.resume({
      step: 'check_blockers',
      resumeData: {
        resolutionType: body.resolution_type || 'manual',
        resolutionData: body.resolution_data,
      },
    });
    // Clear sensitive data immediately
    await clearResolutionData(jobId);
    return c.json({ job_id: jobId, status: 'running' });
  }

  // Existing HITL resume path for non-mastra jobs
  // ... (unchanged)
});
```

### 6.6 JobExecutor Integration

```typescript
// workers/JobExecutor.ts (modified execute method)
async execute(job: AutomationJob): Promise<void> {
  // Steps 0-3: Unchanged (preflight, adapter, session, blocker check)

  if (job.execution_mode === 'mastra') {
    const result = await this.runMastraExecution(job);
    // Steps 9-11: Unchanged (finalization, callback, cost recording)
    return;
  }

  // Existing V3ExecutionEngine path: unchanged
}

private async runMastraExecution(job: AutomationJob): Promise<ExecutionResult> {
  const mastra = getMastra();
  const workflow = mastra.getWorkflow('gh_apply');

  const run = await workflow.execute({
    inputData: {
      jobId: job.id,
      targetUrl: job.target_url,
      executionMode: job.execution_mode,
      userData: job.input_data.user_data,
      platformHint: job.input_data.platform,
      budget: this.costTracker.remainingBudget(),
      qualityPreset: job.input_data.tier || 'balanced',
    },
  });

  // Store run ID for resume correlation
  await this.updateJobMetadata(job.id, { mastra_run_id: run.id });

  if (run.status === 'suspended') {
    // HITL pause — worker returns, job stays in 'paused' state
    // Resume will be triggered by POST /valet/resume/:jobId
    return;
  }

  return run.output;
}
```

---

## 7. Dependencies

### 7.1 New Dependencies

| Package | Version | Purpose | Size |
|---------|---------|---------|------|
| `@mastra/core` | `^1.7.0` | Workflow engine, step primitives | ~2MB |
| `@mastra/pg` | `^1.7.0` | PostgresStore for workflow snapshots | ~200KB |

### 7.2 Bun Compatibility

Mastra targets Node.js. Verify Bun compatibility:
- `@mastra/core` uses standard Node APIs (fs, crypto, events) — Bun supports these
- `@mastra/pg` uses `pg` package — Bun supports this
- **Risk:** Mastra may use Node-specific APIs not yet in Bun. Mitigation: run integration tests under Bun before merge.

### 7.3 Version Pinning

Pin `@mastra/core` and `@mastra/pg` to exact versions in `package.json`. Mastra is at 1.7.x and iterating rapidly — minor version bumps may include breaking changes.

---

## 8. Mode/Schema Updates

### 8.1 Execution Mode Enum

Add `mastra` to:
- `api/schemas/job.ts` — Zod enum for `execution_mode`
- `engine/v3/V3ExecutionEngine.ts` — `V3ExecutionMode` type
- `workers/costControl.ts` — mode unions in progress metadata

### 8.2 Job Metadata

Add `mastra_run_id` to `gh_automation_jobs.metadata` JSONB when `execution_mode === 'mastra'`. This correlates the job to its Mastra workflow run for resume.

### 8.3 Migration

```sql
-- migrations/015_mastra_mode.sql
-- No schema changes needed. execution_mode is already TEXT.
-- Mastra creates its own tables automatically via PostgresStore.
-- Document Mastra tables in migration inventory:
--   mastra_workflow_snapshot (auto-created)
--   mastra_workflow_snapshot_idx (auto-created)
```

---

## 9. Cost and Progress

### 9.1 Cost Tracking

Existing `CostTracker` remains authoritative. Mastra steps report cost via step output schemas, which are synced back to `CostTracker` after each step:

```typescript
// In fill_sections step:
const result = await executeSection(section, layerStack, ctx);
costTracker.addCost(result.costIncurred);
// Return costIncurred in step output for Mastra-level observability
return { costIncurred: result.costIncurred, ... };
```

### 9.2 Progress Tracking

`ProgressTracker` continues to emit lifecycle updates. Mastra step transitions map to progress steps:

| Mastra Step | Progress Step |
|-------------|---------------|
| `cookbook_attempt` start | `analyzing` |
| `observe_page` | `navigating` |
| `fill_sections` | `filling` |
| `check_blockers` (suspend) | `paused` |
| `navigate_or_submit` (submit) | `submitting` |
| Workflow complete | `completed` |

---

## 10. Security Analysis

### 10.1 Workflow Snapshot Contents

Mastra serializes step inputs/outputs to Postgres. Ensure NO sensitive data enters step schemas:

| Data | In Snapshot? | Mitigation |
|------|-------------|------------|
| User PII (name, email) | Yes (in `userData`) | Accept: same data already in `gh_automation_jobs.input_data` |
| Passwords | NO | Never in step schemas. Credentials flow through runtime context only |
| 2FA codes | NO | `resumeData` is processed and cleared immediately on resume |
| Browser cookies | NO | Session state is in `gh_browser_sessions`, not workflow state |
| Screenshots | URL only | Screenshot URLs are public (Supabase Storage), not sensitive |
| API keys | NO | Environment variables, never in workflow state |

### 10.2 Resolution Data Handling

On HITL resume, `resolution_data` (which may contain passwords or 2FA codes) flows through:

1. VALET → `POST /valet/resume` → stored briefly in `interaction_data` JSONB
2. `workflow.resume()` passes `resumeData` to the `check_blockers` step
3. Step processes resolution (injects credentials via Playwright), then clears `interaction_data`
4. Mastra snapshot contains `resumeData` after resume — but only `resolutionType` (enum), NOT `resolutionData` (credentials)

**Mitigation:** The `resumeSchema` for `check_blockers` should include `resolutionType` but NOT `resolutionData`. Credentials are read from `interaction_data` JSONB directly in the step handler, not through Mastra's resume data flow.

### 10.3 Snapshot Cleanup

Add a cleanup job to delete Mastra workflow snapshots older than 7 days:

```sql
DELETE FROM mastra_workflow_snapshot
WHERE updated_at < NOW() - INTERVAL '7 days';
```

### 10.4 RLS

Mastra tables do NOT have RLS by default. Add RLS policies to prevent user-level access to workflow snapshots (service role only).

---

## 11. Observability

### 11.1 Step-Level Events

Each Mastra step emits events to `gh_job_events`:

```typescript
// In each step's execute():
await logEvent(jobId, {
  event_type: `mastra_step_${step.id}`,
  metadata: {
    mastra_run_id: runId,
    step_id: step.id,
    step_status: 'started' | 'completed' | 'failed' | 'suspended',
    cost_incurred: stepCost,
    duration_ms: stepDuration,
  },
});
```

### 11.2 Mastra Tracing

Enable Mastra's built-in AI tracing. Export to the existing structured logger:

```typescript
const mastra = new Mastra({
  // ...
  logger: {
    // Route Mastra logs through existing structured logger
  },
});
```

### 11.3 Correlation

Every `gh_job_events` entry for a Mastra-mode job includes `mastra_run_id` in metadata. This enables querying all events for a workflow run:

```sql
SELECT * FROM gh_job_events
WHERE job_id = $1
  AND metadata->>'mastra_run_id' = $2
ORDER BY created_at;
```

---

## 12. Rollout Plan

### Phase 0: Validation (Before Any Code)

1. **Bun compatibility test:** Install `@mastra/core` and `@mastra/pg`, run a trivial workflow under Bun. If it fails, stop — Mastra won't work with the current runtime.
2. **Latency benchmark:** Measure overhead of Mastra workflow execution (step serialization, snapshot persistence) on a trivial 3-step workflow. If overhead > 500ms, evaluate whether the observability gains justify it.
3. **Baseline metrics:** Record current success rate, cost/job, duration, and HITL reliability for comparison.

### Phase 1: HITL Only

1. Implement `check_blockers` step with `suspend()`/`resume()`.
2. Wire resume API to call `workflow.resume()` for `execution_mode === 'mastra'` jobs.
3. Keep all other execution logic in existing V3ExecutionEngine — only the HITL path uses Mastra.
4. Test: blocker detection → pause → resume → credential injection → verify → continue.
5. Test: worker crash during HITL pause → new worker resumes from snapshot.
6. Deploy as opt-in (`execution_mode: 'mastra'`).

### Phase 2: Per-Page Workflow

1. Model the multi-page loop as Mastra `doUntil` workflow.
2. Each page is a sequence of steps: observe → group → fill → check_blockers → navigate.
3. Existing SectionOrchestrator logic moves into step handlers (not rewritten, just wrapped).
4. Test: multi-page applications with mode parity against V3ExecutionEngine.
5. Test: step-level cost attribution matches aggregate cost.

### Phase 3: Controlled A/B

1. Route a percentage of jobs to `execution_mode: 'mastra'` (server-side random assignment, logged for analysis).
2. Compare: success rate, cost, duration, HITL reliability.
3. Acceptance criteria (Section 13).
4. Fix parity regressions before expanding.

### Phase 4: Expand + Optimize

1. Increase mastra traffic based on A/B results.
2. Add step-level retry (if page 3 fails, retry page 3 only).
3. Add conditional page skip (if observe finds no fields, skip fill).
4. Evaluate Mastra's parallel step for parallel section fills (if sections are independent).

Rollback at any phase: set `execution_mode` away from `mastra`.

---

## 13. Success Metrics

| Metric | Threshold | Measurement |
|--------|-----------|-------------|
| Success rate | mastra >= legacy - 1% absolute | Compare over 500+ jobs |
| Median cost/job | mastra <= legacy + 5% | Include Mastra overhead |
| Median wall time | mastra <= legacy + 15% | 15% not 10% — workflow overhead is expected |
| HITL pause → resume success | mastra >= legacy | Same blocker types |
| HITL crash recovery | mastra > legacy | New capability: resume after worker crash |
| Step-level observability | Events per page in gh_job_events | New capability: not in legacy |
| Zero callback schema breaks | 0 regressions | Automated contract tests |

---

## 14. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Bun incompatibility with @mastra/core | **Blocking** | Phase 0 validation before any implementation |
| Workflow overhead adds latency | High | Phase 0 latency benchmark; 500ms threshold |
| Non-serializable state leaks into snapshots | High | Zod schemas + unit test enforcement |
| Credentials in Mastra snapshots | High | Resume credentials bypass Mastra schema (Section 10.2) |
| HITL resume race condition (Mastra + LISTEN/NOTIFY both active) | High | Mastra-mode jobs use ONLY Mastra resume; disable LISTEN/NOTIFY for mastra jobs |
| Mastra version churn (1.x rapid iteration) | Medium | Pin exact versions; integration tests on upgrade |
| Double-counting costs (Mastra observability + existing CostTracker) | Medium | CostTracker remains single source of truth; Mastra step costs are read-only metadata |
| Mastra tables without RLS | Medium | Add RLS policies in migration (Section 10.4) |
| SectionOrchestrator refactor breaks existing behavior | Medium | Phase 2 wraps, doesn't rewrite; parity tests required |

---

## 15. Open Questions

1. **Mastra under Bun:** Has anyone run `@mastra/core` under Bun in production? If not, Phase 0 is mandatory before committing to this approach.
2. **Worker freeing during HITL:** When Mastra suspends, the workflow returns. Can the worker immediately pick up a new job? This would be a significant improvement over the current approach (worker is blocked during HITL pause).
3. **Mastra table naming:** Mastra auto-creates tables like `mastra_workflow_snapshot`. These don't follow the `gh_` prefix convention. Is this acceptable, or should we configure custom table names?
4. **Snapshot size:** For a 15-page multi-section application with cookbook actions recorded, how large would the Mastra snapshot be? Benchmark against Postgres row size limits.

---

## 16. Implementation Checklist

1. [ ] Phase 0: Bun compatibility test for `@mastra/core` + `@mastra/pg`
2. [ ] Phase 0: Latency benchmark (trivial workflow, measure overhead)
3. [ ] Add `@mastra/core` and `@mastra/pg` to `package.json` (pinned versions)
4. [ ] Create `workflows/mastra/` directory structure
5. [ ] Implement `getMastra()` singleton with PostgresStore
6. [ ] Add `mastra` to `execution_mode` Zod enum
7. [ ] Implement `check_blockers` step with `suspend()`/`resume()`
8. [ ] Modify resume API route to handle Mastra-mode jobs
9. [ ] Implement `cookbook_attempt` step wrapping CookbookExecutorV3
10. [ ] Implement per-page workflow steps (observe, fill, navigate)
11. [ ] Add runtime context boundary tests
12. [ ] Add snapshot security tests (no credentials in persisted state)
13. [ ] Add RLS to Mastra-created tables
14. [ ] Add snapshot cleanup job (7-day TTL)
15. [ ] Add step-level event emission to `gh_job_events`
16. [ ] Integration tests: full workflow parity
17. [ ] Integration tests: HITL suspend → crash → resume
18. [ ] A/B rollout with metrics comparison

---

## 17. Appendix: Why NOT Mastra Agents for Hand Selection

The V2 PRD and initial discussions suggested using Mastra's Agent primitive to orchestrate Hands. Here's why that's wrong for this use case:

**Current approach (deterministic heuristics):**
```
Field confidence 0.92 → DOMHand → success → $0.00
Field confidence 0.65 → StagehandHand → success → $0.0005
Field confidence 0.30 → MagnitudeHand → success → $0.005
```
- Cost: predictable, minimal
- Latency: fast (no LLM reasoning for selection)
- Reliability: deterministic, testable

**Hypothetical Mastra Agent approach:**
```
Agent receives field list → LLM reasons about which Hand to use → selects Hand → executes
```
- Cost: adds $0.001-0.01 per field for LLM reasoning about Hand selection
- Latency: adds 1-3s per field for LLM inference
- Reliability: non-deterministic, harder to test

For a 20-field form, the agent approach would add $0.02-0.20 and 20-60 seconds just for Hand selection. The current heuristic approach does this in <1ms for $0.00.

**When Mastra Agents WOULD make sense:**
- Ambiguous multi-page navigation (LLM decides which link to click)
- Free-form task description interpretation (LLM decides what to do)
- Dynamic error recovery (LLM reasons about how to fix a failure)

These are future optimizations. The current deterministic approach works.
