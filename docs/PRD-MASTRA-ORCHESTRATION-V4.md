# PRD: Mastra Orchestration for GHOST-HANDS (V4, Runtime-Aligned)

**Author:** Codex (proposed replacement for V3)  
**Date:** 2026-03-01  
**Status:** Draft - Go/No-Go Ready  
**Supersedes:** `PRD-MASTRA-ORCHESTRATION-V3.md`  

---

## 1. Executive Summary

This V4 plan is designed to be executable against the current codebase without breaking existing contracts.

### Core decisions

1. The current runtime baseline is `JobExecutor -> ExecutionEngine -> handler fallback` (not `V3ExecutionEngine` as active path).
2. Add `execution_mode: 'mastra'` without removing existing modes.
3. Resume ownership is worker-side, not API-side.
4. No credentials/2FA values are allowed in workflow snapshots.
5. HITL crash-resume claims are limited to supported recovery boundaries; no false "exact browser continuation" claims.

### Rollout shape

- Phase 0: compatibility and risk spike (required gate)
- Phase 1: Mastra mode with parity execution (no behavior regression)
- Phase 2: worker-owned suspend/resume for checkpoint-safe HITL cases
- Phase 3: optional per-page decomposition after parity is proven

---

## 2. Current-State Facts (Source of Truth)

1. `JobExecutor` currently imports and runs `ExecutionEngine` cookbook-first, then handler fallback.
2. `V3ExecutionEngine` exists in repo but is not wired in `JobExecutor`.
3. `execution_mode` currently supports `auto`, `ai_only`, `cookbook_only`, `hybrid`, `smart_apply`, `agent_apply` in VALET schemas.
4. HITL resume endpoint today stores resolution data, emits `pg_notify('gh_job_resume')`, and sets status.
5. `ProgressTracker` and `CostTracker` have specific mode unions that must remain backward-compatible.

Design in this PRD must not contradict these facts.

---

## 3. Problem Statement

We want workflow-level observability and safer orchestration evolution, but prior plans introduced architecture contradictions:

1. Wrong runtime baseline
2. API process trying to resume workflows that require worker runtime context
3. Secret leakage risk via resume payload snapshots
4. Breaking existing mode enums/contracts
5. Non-compilable integration examples

This PRD resolves those issues with an incremental, contract-safe migration.

---

## 4. Goals and Non-Goals

### 4.1 Goals

1. Introduce Mastra as an opt-in orchestration engine via `execution_mode='mastra'`.
2. Preserve all existing behavior for non-mastra modes.
3. Keep existing callback and DB status semantics stable.
4. Add durable run metadata and step-level observability.
5. Enable safe rollback by mode toggle only.

### 4.2 Non-Goals

1. Replacing queue systems (`JobPoller`/`PgBossConsumer`).
2. Replacing adapters or Hand internals in Phase 1.
3. Removing legacy HITL route behavior for non-mastra jobs.
4. Claiming exact mid-page browser continuation after worker crash without explicit checkpoint recovery support.

---

## 5. Architectural Decisions (Binding)

## AD-1: Runtime Baseline Alignment

Phase-1 mastra path wraps currently active execution behavior, not hypothetical future wiring.

## AD-2: Backward-Compatible Mode Contract

`mastra` is added to existing enums. No existing mode values are removed.

## AD-3: Worker-Owned Resume

API `/valet/resume/:jobId` does **not** call `workflow.resume()` directly.  
API records resume intent and data, then signals/requeues work.  
Worker performs resume when runtime context is available.

## AD-4: Secret-Safe Resume Flow

`resolution_data` does not traverse workflow resume schema.  
Worker reads sensitive resolution data directly from DB, uses it, then clears it.

## AD-5: Idempotent Side Effects

All pause/resume callbacks and status transitions must be guarded to avoid duplicates under retries/resume races.

## AD-6: Honest Recovery Scope

Durable resume is guaranteed only at defined checkpoint boundaries.  
If browser/page state cannot be reconstructed safely, job transitions to explicit recoverable failure (`resume_context_mismatch`) and requests human intervention again.

---

## 6. Proposed Design

## 6.1 Mode and Schema Changes

Update execution mode allowlists to include `mastra` while retaining:

- `auto`
- `ai_only`
- `cookbook_only`
- `hybrid`
- `smart_apply`
- `agent_apply`

Targets:

1. `packages/ghosthands/src/api/schemas/valet.ts`
2. any downstream typed mode unions used by API clients/workers

No changes to `api/schemas/job.ts` for execution mode (it does not own that contract today).

## 6.2 New Components

Add:

1. `workflows/mastra/init.ts`  
   Mastra singleton + storage wiring.
2. `workflows/mastra/applyWorkflow.ts`  
   Workflow definition for mastra-mode execution phase.
3. `workflows/mastra/runtimeContext.ts`  
   Runtime-only context builder (adapter/page/costTracker/progress/supabase/logger).
4. `workflows/mastra/resumeCoordinator.ts`  
   Worker-side resume loader/validator/clearer.

## 6.3 Workflow Scope by Phase

### Phase 1 Workflow (parity-first)

Workflow nodes are minimal and map to existing behavior:

1. `cookbook_attempt` (existing engine cookbook decision path)
2. `handler_fallback` (existing handler execution path when needed)
3. `emit_outcome` (workflow-level status metadata only)

This phase is intentionally low-risk and behavior-preserving.

### Phase 2 Workflow (HITL suspend/resume)

Introduce `check_blockers` + suspend/resume **only** for checkpoint-safe blocker points:

- before section fill
- before navigation submit decisions

Mid-action blocker handling remains legacy until deterministic checkpoint replay is validated.

### Phase 3 Workflow (optional decomposition)

Only after parity:

1. observe
2. section grouping
3. fill sections
4. blocker check
5. navigate/submit

No decomposition is allowed until Phase-2 parity and incident-free operation.

## 6.4 Runtime vs Persisted State Contract

### Persisted workflow state (allowed)

- IDs, counters, page index, cost numbers, non-sensitive blocker metadata, run status

### Runtime-only context (never persisted)

- adapter
- Playwright page/browser handles
- Supabase client
- logger instances
- credentials/codes

Guardrail:

1. Step schemas must contain serializable data only.
2. CI test fails if schema includes forbidden runtime types or forbidden key names (`password`, `resolution_data`, `otp`, etc.).

## 6.5 Worker-Owned Resume Flow

### API route behavior (`/valet/resume/:jobId`)

For `execution_mode='mastra'`:

1. Validate job is paused.
2. Store resume intent + sensitive resolution data in DB.
3. Set resumable status (`pending` for legacy poller compatibility) and updated timestamp.
4. Emit wake signal (notify/requeue strategy per dispatch mode).
5. Return accepted response.

API route does not call Mastra resume directly.

### Worker behavior

When worker picks job:

1. Build runtime context (adapter/page/session).
2. Load mastra run ID from job metadata.
3. If run is suspended and pending resume intent exists:
   - read sensitive resolution data
   - call workflow resume with non-sensitive resume metadata
   - apply credentials/code via adapter
   - clear sensitive data in DB immediately
4. Continue workflow execution.

## 6.6 Idempotency Rules

Required guards:

1. Pause transition SQL must be conditional (`WHERE status != 'paused'`) and callback fires only on actual transition.
2. Resume transition SQL must be conditional to prevent double resume.
3. Callback emission keys include `(job_id, event_type, phase_nonce)`; duplicates are ignored.
4. Resume intent has monotonic nonce; worker applies each nonce at most once.

---

## 7. Storage, Migration, and Security

## 7.1 Storage Backend

Use `@mastra/pg` with existing Postgres connection.

## 7.2 Migration Policy

Do not rely on undocumented auto-created tables alone.

Required:

1. migration note enumerating mastra tables created in each environment
2. explicit SQL migration for RLS/policies/indexes/retention jobs if needed
3. deployment order documenting when Mastra storage bootstrap runs

## 7.3 Sensitive Data Controls

1. `resolution_data` must never be part of workflow input/output/resume schemas.
2. Sensitive DB fields are cleared immediately after consumption.
3. Snapshot retention defaults to 7 days for completed/failed runs.
4. Access to Mastra tables is service-role only unless explicitly widened.

---

## 8. Cost and Progress Integration

## 8.1 Cost

`CostTracker` remains authoritative for limits and accounting.

Workflow step costs are metadata only and must reconcile to `CostTracker` totals.

No pseudo-APIs not present in codebase are allowed in implementation tasks.

## 8.2 Progress

Preserve existing progress step vocabulary:

- `analyzing_page`
- `filling_form`
- `submitting`
- etc.

Do not invent new literals (`analyzing`, `filling`, `paused`) without schema and client updates.

If needed, add `orchestrator: 'legacy' | 'mastra'` metadata field rather than overloading existing mode unions.

---

## 9. Rollout Plan (with Hard Gates)

### Phase 0 - Mandatory Spike (No production traffic)

1. Bun compatibility validation for `@mastra/core` + `@mastra/pg`.
2. Minimal workflow latency benchmark.
3. Secret-persistence red-team test (verify credentials cannot enter snapshots).
4. Go/No-Go decision.

Abort criteria:

- incompatible runtime behavior under Bun
- unresolved secret persistence path
- unacceptable overhead without measurable value

### Phase 1 - Parity Execution Mode

1. Add `mastra` mode and worker branch.
2. Run parity wrapper workflow (no suspend/resume yet).
3. Compare success/cost/duration vs legacy.

### Phase 2 - HITL Durable Resume (checkpoint-safe only)

1. Worker-owned resume coordinator.
2. API resume intent path for mastra jobs.
3. Suspend/resume at safe boundaries only.
4. Validate crash/restart behavior in integration tests.

### Phase 3 - Optional Decomposition

1. Introduce per-page/per-section workflow steps.
2. Add selective step retry where idempotency is proven.
3. Expand traffic only after parity and incident thresholds are met.

Rollback at any point: route jobs away from `execution_mode='mastra'`.

---

## 10. Success Criteria

1. Success rate: mastra >= legacy - 1% absolute (500+ jobs)
2. Median cost/job: mastra <= legacy + 5%
3. Median duration/job: mastra <= legacy + 15%
4. Callback contract regressions: zero
5. Secret leak incidents in snapshots: zero
6. Duplicate pause/resume callback incidents: zero
7. Crash-recovery resume success (checkpoint-safe scenarios): >= 99%

---

## 11. Test Plan

## 11.1 Unit

1. Mode enum compatibility tests
2. Runtime vs persisted schema guard tests
3. Idempotent transition tests for pause/resume SQL paths

## 11.2 Integration

1. Legacy mode unaffected
2. Mastra mode parity path (cookbook success/fallback)
3. Mastra resume intent -> worker resume flow
4. Sensitive data clear-after-use behavior
5. Crash during suspended checkpoint -> resumed execution on new worker

## 11.3 Contract

1. VALET callback schema unchanged
2. Existing execution modes remain accepted

---

## 12. Implementation Checklist

1. [ ] Add `mastra` mode to VALET schemas (preserve all existing values)
2. [ ] Add worker branch for `execution_mode='mastra'`
3. [ ] Implement Mastra init + workflow modules
4. [ ] Implement runtime context builder
5. [ ] Implement worker-owned resume coordinator
6. [ ] Implement mastra-mode API resume intent path
7. [ ] Add idempotency guards for pause/resume side effects
8. [ ] Add schema guard tests for forbidden sensitive fields
9. [ ] Add compatibility/performance/security phase-0 reports
10. [ ] Run staged A/B rollout and capture metrics

---

## 13. Open Questions (Narrowed)

1. For queue dispatch mode, what is the canonical wake mechanism for resumed mastra jobs (notify-only vs explicit requeue)?
2. Which blocker points are officially "checkpoint-safe" for suspend in Phase 2?
3. Should run correlation live in dedicated DB columns or `metadata` JSONB long-term?

