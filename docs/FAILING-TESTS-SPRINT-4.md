# Failing Tests — Fix in Sprint 4

**Recorded:** 2026-02-16
**Total Failures:** 55 tests across 5 e2e test files
**Root Cause:** All require live Supabase connection (`getTestSupabase()` → `createClient()` throws "supabaseUrl is required")
**Impact:** Zero impact on production. All unit/integration tests pass (543/543). These are e2e tests that were written against a live Supabase instance.

---

## Root Cause

All 5 files use `getTestSupabase()` from `__tests__/e2e/helpers.ts` which calls `createClient(process.env.SUPABASE_URL, ...)`. Without `SUPABASE_URL` set, every test in the suite fails immediately with:

```
Error: supabaseUrl is required.
  at validateSupabaseUrl (node_modules/@supabase/supabase-js/dist/index.mjs:150:29)
```

## Fix Strategy (Sprint 4)

**Option A (Recommended):** Add `SUPABASE_URL` and `SUPABASE_KEY` to CI test environment pointing to a dedicated test project. Tests run against real Supabase.

**Option B:** Refactor e2e tests to use a local Postgres (via `pg` pool) instead of Supabase client. Cheaper, no external dependency, but loses Supabase-specific features (RLS, Realtime).

**Option C:** Skip these tests in CI with `describe.skipIf(!process.env.SUPABASE_URL)` and run them manually before deploy.

---

## Failing Files (5)

### 1. `__tests__/e2e/jobLifecycle.test.ts` — 13 failures

| Test | Description |
|------|-------------|
| should create a job in pending status | Basic job INSERT |
| should pick up a pending job and claim it | Worker pickup flow |
| should not pick up jobs that are already claimed | Concurrency guard |
| should transition through running to completed | Full status flow |
| full lifecycle: create → pickup → run → complete → verify | End-to-end happy path |
| should pick jobs in priority order (highest first) | Priority queue |
| should cancel a pending job | Cancel flow |
| should not cancel an already-completed job | Cancel guard |
| should store result_data for VALET to retrieve | Completion data |
| should store screenshot URLs in the completed job record | Screenshot storage |
| should record job events throughout the lifecycle | Event audit trail |
| should respect idempotency keys (no duplicate creation) | Idempotency |
| should store input_data and metadata correctly | Data integrity |
| should filter jobs by status | Status filtering |

### 2. `__tests__/e2e/errorHandling.test.ts` — 10 failures

| Test | Description |
|------|-------------|
| should mark a job as failed with error code and details | Failure recording |
| should log a job_failed event on failure | Event logging |
| should re-queue a job for retry on retryable errors | Retry queue |
| should increment retry_count on each retry | Retry counter |
| should fail permanently when max retries exceeded | Max retry guard |
| should allow retrying a failed job | Manual retry |
| should not allow retrying a completed job | Retry guard |
| should store different error codes for different failure types | Error code mapping |
| should record partial cost data even on job failure | Partial cost |
| should detect and recover stuck jobs with stale heartbeats | Stuck job recovery |

### 3. `__tests__/e2e/concurrency.test.ts` — 13 failures

| Test | Description |
|------|-------------|
| should not allow two workers to pick up the same job | Double-pickup prevention |
| should distribute multiple jobs across workers | Job distribution |
| should handle 5 workers competing for 3 jobs correctly | Contention handling |
| should not pick up jobs that are already in non-pending status | Status guard |
| should execute multiple jobs in parallel without interference | Parallel isolation |
| should isolate events between concurrently executed jobs | Event isolation |
| should serve higher priority jobs first when multiple are pending | Priority under contention |
| should use FIFO within the same priority level | FIFO ordering |
| should handle cancel during job execution gracefully | Cancel race condition |
| should handle simultaneous status updates without data corruption | Status race condition |
| should respect maxConcurrent by not picking up when at capacity | Capacity limit |
| should pick up new jobs after completing existing ones | Job cycling |
| should handle batch insertion of 20 jobs efficiently | Bulk operations |

### 4. `__tests__/e2e/costControl.test.ts` — 6 failures

| Test | Description |
|------|-------------|
| should record job cost against user monthly usage | Cost recording |
| should accumulate costs across multiple jobs | Cost accumulation |
| should log a cost_recorded event in gh_job_events | Cost event logging |
| should deny a job when user budget is exhausted | Budget enforcement |
| CostControlService - Preflight Budget Check | Budget preflight |
| should record partial cost when job is killed mid-execution | Partial cost on kill |

### 5. `__tests__/e2e/progressUpdates.test.ts` — 13 failures

| Test | Description |
|------|-------------|
| should record events with correct structure | Event structure |
| should record multiple events in chronological order | Event ordering |
| should support different event types throughout job lifecycle | Event type variety |
| should update heartbeat timestamp on each beat | Heartbeat updates |
| should detect stale heartbeats (used for stuck job recovery) | Stale heartbeat detection |
| should track status changes from pending through running to completed | Status transitions |
| should record status_message updates | Status message tracking |
| should include cost data in completion events | Cost in events |
| should track action counts in event metadata | Action count tracking |
| should provide a complete audit trail for a job | Full audit trail |
| should isolate events between different jobs | Event isolation |
| should record events from different actors | Multi-actor events |

---

## Additional Context

- These tests were created in Sprint 1 against a live Supabase test project
- They validate the full database layer (RLS policies, indexes, triggers)
- The `helpers.ts` file provides `MockValetClient`, `simulateWorkerPickup`, etc.
- All use the `vitest` import (compatibility shim) but run under `bun:test`
- Session persistence integration test (`__tests__/integration/sessions/sessionPersistence.test.ts`) has the same issue (1 error, not counted in the 55)

## Sprint 4 Ticket

**GH-SPRINT4-001: Fix 55 e2e tests requiring live Supabase**
- Priority: P1
- Estimate: 1-2 hours
- Approach: Option A (add Supabase test credentials to CI) or Option C (conditional skip)
- Acceptance: `bun test` shows 0 failures in CI
