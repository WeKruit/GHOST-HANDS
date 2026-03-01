# PRD: Mastra-Orchestrated Execution Mode for GHOST-HANDS (V2)

**Author:** Codex (rewrite from Spencer + Claude draft)  
**Date:** 2026-03-01  
**Status:** Draft - Implementation Ready  
**Target Branch:** `codex/mastra-prd-v2` (or equivalent)  

---

## 1. Executive Summary

This PRD proposes adding a new `execution_mode` in GHOST-HANDS that runs a Mastra workflow for orchestration while preserving existing worker contracts, callbacks, cost controls, and HITL behavior.

The key correction versus prior drafts: the active production flow today is `JobExecutor -> ExecutionEngine (cookbook-first) -> fallback TaskHandler`, not `V3ExecutionEngine`/`SectionOrchestrator` as the primary runtime path. The migration plan below is designed around that reality.

---

## 2. Current State (As Implemented)

### 2.1 Runtime Path Today

Current apply-style execution in `JobExecutor`:

1. Preflight budget and job lifecycle setup
2. Adapter start + optional observer
3. Blocker check + existing HITL flow
4. `ExecutionEngine` cookbook lookup/replay
5. On cookbook miss/failure, run task handler (typically Magnitude-driven)
6. Persist completion metadata, screenshots, callbacks, cost, and events

### 2.2 Existing Control Plane Contract

- External control is primarily `execution_mode`, not `engine_version`.
- API schemas already validate allowed execution modes.
- Progress and cost trackers currently support mode sets centered around `cookbook`, `magnitude`, and `hybrid`.

### 2.3 HITL Today

HITL is not only LISTEN/NOTIFY. It also includes:

- DB state transitions (`running -> paused -> running/failed`)
- VALET callback notifications (`needs_human`, `resumed`)
- Adapter pause/resume
- Optional credential/code injection before resume
- Security cleanup of resolution data after read

Any migration must preserve all of these side effects.

---

## 3. Problem Statement

The orchestration layer is effective but difficult to evolve safely:

1. Control flow is spread across `JobExecutor`, `ExecutionEngine`, task handlers, and adapter event wiring.
2. Multi-step execution is imperative and harder to inspect as a single workflow run.
3. HITL, observability, and retry/cost logic are cross-cutting concerns.
4. Introducing new orchestration patterns currently requires touching multiple subsystems.

We need a workflow layer that improves traceability and extensibility without breaking the proven worker contract.

---

## 4. Goals and Non-Goals

### 4.1 Goals

1. Add an opt-in Mastra orchestration mode using `execution_mode`.
2. Preserve current job lifecycle semantics, callbacks, and DB updates.
3. Preserve existing cost and budget enforcement using `CostTracker` and `CostControlService`.
4. Preserve current HITL behavior during initial migration.
5. Enable A/B rollout with fast rollback by mode flag only.

### 4.2 Non-Goals

1. Replacing queueing/dispatch (`pg-boss`, worker launcher, polling/consumer).
2. Replacing Hono API routes and payload contracts.
3. Rewriting all Hands/layers at once.
4. Replacing session persistence, manual store schema, or callback protocol in initial rollout.

---

## 5. Proposed Solution

## 5.1 New Execution Mode

Add a new `execution_mode` value: `mastra`.

Behavior:

- When `execution_mode !== 'mastra'`: existing behavior unchanged.
- When `execution_mode === 'mastra'`: run Mastra workflow in `JobExecutor` after current preflight/session/adapter setup.

Rationale:

- Aligns with existing API and worker contracts.
- Avoids introducing a second gating system (`engine_version`) for rollout control.

## 5.2 Orchestration Boundary

Mastra will orchestrate coarse execution phases first, then optionally finer-grained layer steps later.

### Phase-1 workflow nodes (coarse)

1. `prepare_context` (normalization, prompt/user data shaping)
2. `check_blockers` (calls existing blocker detection logic)
3. `cookbook_attempt` (existing `ExecutionEngine` cookbook path)
4. `handler_fallback` (existing handler execution path)
5. `finalize_job` (existing completion + metadata + callback write path)

This avoids immediate mismatch with current `LayerHand` interfaces.

### Phase-2 workflow nodes (fine-grained, optional)

After parity is proven, internal handler/orchestrator steps may be split into:

- observe
- match
- execute
- verify
- navigate
- record

But only once parity and stability are achieved.

## 5.3 HITL Strategy

Initial approach: keep existing HITL implementation in `JobExecutor` as source of truth.

- Mastra workflow can represent “blocked” state.
- Actual pause/resume side effects continue using existing `requestHumanIntervention` and resume readers.
- Suspend/resume migration inside Mastra is deferred until parity tests confirm no behavior regressions in callbacks/security cleanup.

## 5.4 State Model (Critical)

Define two state classes:

1. Persisted workflow state (serializable):
   - `jobId`, url, execution mode, counters, cost snapshot numbers, last step outcome, blocker metadata IDs, etc.
2. Runtime-only context (non-serializable):
   - `adapter`, Playwright `page`, open browser/session handles, logger instances, DB clients.

Rule: runtime-only context must never be persisted in Mastra storage.

## 5.5 Model Routing

Do not replace current model resolver initially.

Use existing `buildLLMClient()` and `loadModelConfig()` behavior for:

- model alias resolution
- dual-model (`image_model`) setup
- env fallback behavior

Mastra route-level model selection is a later optimization if needed.

---

## 6. Technical Design

## 6.1 JobExecutor Integration Point

In `JobExecutor.execute(job)`:

1. Keep steps 0-8.6 intact (preflight, adapter/session setup, blocker check).
2. Branch by `job.execution_mode`:
   - `mastra` -> invoke `runMastraExecution(job, ctx)`
   - others -> existing path untouched
3. Reuse existing completion/error handling utilities for consistent DB/callback behavior.

## 6.2 Proposed New Files

- `packages/ghosthands/src/workflows/mastra/applyWorkflow.ts`
- `packages/ghosthands/src/workflows/mastra/types.ts`
- `packages/ghosthands/src/workflows/mastra/runtimeContext.ts`
- `packages/ghosthands/src/workflows/mastra/steps/*.ts`
- `packages/ghosthands/src/workflows/mastra/index.ts`

No immediate changes to:

- existing handler implementations
- `ExecutionEngine` internals
- blocker detector internals

## 6.3 Mode/Schema Updates

Update enum allowlist for `execution_mode` in:

- API request schema(s)
- any typed mode unions in worker/client surfaces

Add telemetry labels for `mastra` mode in progress and job events.

## 6.4 Cost and Progress

Keep existing trackers authoritative:

- `CostTracker` still enforces budget + action limits.
- `ProgressTracker` still emits lifecycle updates.

Required update:

- Extend execution mode unions so `mastra` is representable in progress metadata and downstream consumers.

## 6.5 Observability

For each Mastra run:

1. Emit run/step IDs into `gh_job_events`.
2. Correlate with existing `job_id`.
3. Keep existing event types for compatibility, adding new optional metadata fields instead of replacing event names.

---

## 7. Rollout Plan

### Phase 0: Baseline + Instrumentation (2-3 days)

1. Document current baseline metrics from non-mastra runs:
   - success rate
   - cost/job
   - average duration
   - HITL pause/resume success
2. Add feature flag config for `execution_mode=mastra`.
3. Add minimal run correlation IDs in events.

### Phase 1: Coarse Workflow Parity (1 week)

1. Implement Mastra workflow that wraps existing cookbook + handler path.
2. Keep HITL in existing code path.
3. Run integration tests and staging smoke tests.
4. Launch with opt-in only.

### Phase 2: Controlled A/B (1 week)

1. Route small percentage (or selected users) to `mastra`.
2. Compare against baseline metrics.
3. Fix parity regressions.

### Phase 3: Expand Coverage (1 week)

1. Increase traffic to `mastra` once parity is stable.
2. Add richer step-level tracing fields.
3. Consider selective decomposition into finer workflow steps.

### Phase 4: Optional Deep Migration (future)

1. Evaluate moving HITL suspend/resume into Mastra-native primitives.
2. Evaluate replacing imperative subloops with declarative subgraphs.
3. Decommission legacy orchestration paths only after sustained parity.

Rollback at any phase: set `execution_mode` away from `mastra`.

---

## 8. Testing Strategy

## 8.1 Unit Tests

1. Workflow step contract tests (input/output schema validation).
2. Runtime-context boundary tests (non-serializable objects never persisted).
3. Mode-routing tests for `execution_mode=mastra`.

## 8.2 Integration Tests

1. Cookbook success path in `mastra` mode.
2. Cookbook miss/failure -> handler fallback path.
3. Blocker detected -> HITL pause -> resume -> continue.
4. Timeout in HITL path -> proper failure semantics.
5. Callback payload parity vs legacy path.

## 8.3 Regression Tests

Run existing suites for:

- HITL behavior
- blocker detection
- handler execution
- API schema validation

No reduction in existing test coverage is permitted for merge.

---

## 9. Success Metrics

1. Success rate parity: `mastra >= legacy - 1%` absolute.
2. Cost parity: `mastra <= legacy + 5%` median cost/job.
3. Duration parity: `mastra <= legacy + 10%` median wall time.
4. HITL reliability parity:
   - pause callback delivery parity
   - resume success parity
   - timeout behavior parity
5. Operational safety:
   - zero schema-breaking callback changes
   - zero critical regressions in status transitions

---

## 10. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Runtime mismatch with current production path | High | Start with coarse workflow wrapping existing path, not Hand rewrites |
| Non-serializable state leakage into workflow store | High | Strict runtime-context boundary + tests |
| HITL regressions during suspend/resume changes | High | Keep existing HITL path in initial rollout |
| Added latency from workflow engine | Medium | Benchmark against baseline and enforce SLO thresholds |
| Mode proliferation/confusion | Medium | Single authoritative mode gate (`execution_mode`) |
| Tracking schema drift in progress/cost | Medium | Extend unions and compatibility tests before rollout |

---

## 11. Open Questions

1. Should `mastra` remain a permanent execution mode or eventually become default `auto` path behavior?
2. Which storage backend should be used for Mastra run state in production, given current infra constraints?
3. At what measured threshold should we begin replacing legacy orchestration internals instead of just wrapping them?

---

## 12. Implementation Checklist

1. Add `mastra` to execution mode schemas/types.
2. Introduce workflow module files and runtime context.
3. Add `JobExecutor` branch for `execution_mode=mastra`.
4. Wire existing cookbook + fallback handler path into workflow steps.
5. Preserve current HITL callback/DB semantics.
6. Add run correlation metadata in job events.
7. Add tests (unit + integration + regression).
8. Stage rollout with A/B and rollback guardrail.

---

## 13. Notes on Compatibility

This PRD intentionally avoids immediate dependency on a full Hand-level rewrite. The current `LayerHand` API is based on `observe/process/execute/review`, not `fillFields`-style wrappers, and should only be refactored in a later phase with dedicated parity validation.

