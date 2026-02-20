# Failing Tests — Fix in Sprint 4

**Recorded:** 2026-02-16
**Updated:** 2026-02-17
**Total Failures:** 7 tests across 4 e2e files + 1 error (session persistence)
**Previous:** 55 failures — fixed 48 by adding `bunfig.toml` env preload + switching to `bun test`

---

## What Was Fixed

**Root cause (48 tests):** `bun test` from project root didn't load `packages/ghosthands/.env`. Vitest (`vitest run`) loaded it via `vitest.config.ts` `envFile` but ran under Node.js v24, which has fetch issues with Supabase.

**Fix applied:**
1. Created `bunfig.toml` at repo root with preload script
2. Created `packages/ghosthands/test-env.ts` — loads package `.env` when CWD is repo root
3. Switched root `package.json` test scripts from `vitest run` to `bun test`

**Result:** 566 pass, 7 fail, 1 error (was 543 pass, 55 fail)

---

## Remaining 7 Failures (Real Logic Issues)

These are genuine test bugs — the Supabase connection works, but the test assertions or helper functions have issues.

### 1. `__tests__/e2e/concurrency.test.ts` — 3 failures

| Test | Root Cause |
|------|------------|
| should not allow two workers to pick up the same job | `simulateWorkerPickup` doesn't use `FOR UPDATE SKIP LOCKED` — concurrent updates succeed |
| should handle 5 workers competing for 3 jobs correctly | Same — 5 pickups succeed when only 3 should (got 5, expected <=3) |
| should respect maxConcurrent by not picking up when at capacity | Worker capacity not enforced in mock helper |

**Fix:** Update `simulateWorkerPickup()` in `helpers.ts` to use a proper `SELECT ... FOR UPDATE SKIP LOCKED` query via raw SQL, matching the real `JobPoller.pickupJob()` implementation.

### 2. `__tests__/e2e/errorHandling.test.ts` — 2 failures

| Test | Root Cause |
|------|------------|
| should store different error codes for different failure types | Test inserts multiple error types but query returns wrong order (missing `ORDER BY`) |
| should record partial cost data even on job failure | `llm_cost_cents` column not set by test helper on failure path |

**Fix:** Add `ORDER BY created_at` to error code query. Set `llm_cost_cents` in failure simulation.

### 3. `__tests__/e2e/progressUpdates.test.ts` — 1 failure

| Test | Root Cause |
|------|------------|
| should update heartbeat timestamp on each beat | Heartbeat update uses `updated_at` but test checks `last_heartbeat` column — timing race between two rapid updates |

**Fix:** Add small delay between heartbeat calls or compare with tolerance.

### 4. `__tests__/e2e/costControl.test.ts` — 1 failure

| Test | Root Cause |
|------|------------|
| should log a cost_recorded event in gh_job_events | Test expects `cost_recorded` event type but the event is logged as `cost_update` |

**Fix:** Align event type constant — either update test or update the event logger.

---

## 1 Error (Not a Failure)

### `__tests__/integration/sessions/sessionPersistence.test.ts`

**Error:** `supabaseUrl is required` — this integration test creates its own Supabase client directly (doesn't use the e2e helpers). Needs the same env loading fix or to use `getTestSupabase()`.

---

## Sprint 4 Tickets

**GH-SPRINT4-001: Fix simulateWorkerPickup concurrency (3 tests)**
- Priority: P1
- File: `__tests__/e2e/helpers.ts` — `simulateWorkerPickup()`
- Fix: Use raw SQL with `FOR UPDATE SKIP LOCKED` instead of Supabase `.update()`
- Tests: concurrency double-pickup, 5-worker contention, maxConcurrent

**GH-SPRINT4-002: Fix error handling test assertions (2 tests)**
- Priority: P2
- File: `__tests__/e2e/errorHandling.test.ts`
- Fix: Add ORDER BY, set llm_cost_cents on failure path

**GH-SPRINT4-003: Fix heartbeat timing race (1 test)**
- Priority: P2
- File: `__tests__/e2e/progressUpdates.test.ts`
- Fix: Add delay or tolerance to heartbeat comparison

**GH-SPRINT4-004: Fix cost event type mismatch (1 test)**
- Priority: P2
- File: `__tests__/e2e/costControl.test.ts`
- Fix: Align `cost_recorded` vs `cost_update` event type

**GH-SPRINT4-005: Fix session persistence test env loading (1 error)**
- Priority: P2
- File: `__tests__/integration/sessions/sessionPersistence.test.ts`
- Fix: Use `getTestSupabase()` from e2e helpers or load env explicitly
