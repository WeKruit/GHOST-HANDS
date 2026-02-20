# GHOST-HANDS Regression Testing Plan

**Last Updated:** 2026-02-18
**Test Runner:** Vitest (config: `vitest.config.ts`) + Bun native test runner
**Test Root:** `packages/ghosthands/__tests__/`

---

## Table of Contents

1. [How to Run Tests](#1-how-to-run-tests)
2. [API Regression](#2-api-regression)
3. [Worker Regression](#3-worker-regression)
4. [Adapter Regression](#4-adapter-regression)
5. [Engine Regression](#5-engine-regression)
6. [Security Regression](#6-security-regression)
7. [Database Regression](#7-database-regression)
8. [Integration Regression](#8-integration-regression)
9. [CI Integration](#9-ci-integration)
10. [Rollback Procedure](#10-rollback-procedure)

---

## 1. How to Run Tests

```bash
# Unit tests (no external deps, fast)
bun run test:unit

# Integration tests (requires Supabase credentials in .env)
bun run test:integration

# E2E tests (full system, runs sequentially)
bun run test:e2e

# All tests
bun run test
```

**Environment requirements:**
- Unit tests: None (all external services mocked)
- Integration tests: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` in `packages/ghosthands/.env`
- E2E tests: Same as integration + local Supabase (or remote with service key)

**Vitest config** (`vitest.config.ts`):
```typescript
export default defineConfig({
  test: {
    include: ['packages/ghosthands/__tests__/**/*.test.ts'],
    envFile: 'packages/ghosthands/.env',
  },
});
```

---

## 2. API Regression

**Test locations:**
- `__tests__/unit/api/models.test.ts`
- `__tests__/unit/api/valetStatus.test.ts`

### P0 (must pass before deploy)

| ID | Test | Expected | File |
|----|------|----------|------|
| API-001 | `GET /health` returns 200 | `{ status: 'ok' }` | `unit/api/health.test.ts` |
| API-002 | Request without `X-GH-Service-Key` returns 401 | `{ error: 'Unauthorized' }` | `unit/api/auth.test.ts` |
| API-003 | `POST /api/v1/gh/jobs` creates job in DB | Job row with `status: 'pending'` | `e2e/jobLifecycle.test.ts` |
| API-004 | `POST /api/v1/gh/valet/apply` creates job with correct fields | `job_type: 'apply'`, `user_id`, `target_url`, `input_data` | `e2e/jobLifecycle.test.ts` |
| API-005 | `GET /api/v1/gh/valet/status/:id` returns job data | Full job object with status, events | `unit/api/valetStatus.test.ts` |
| API-006 | `GET /api/v1/gh/models` returns model catalog | `models[]` with 30+ entries, `presets[]`, `default` | `unit/api/models.test.ts` |
| API-007 | Duplicate `idempotency_key` returns existing job (409) | DB constraint violation / existing job returned | `e2e/jobLifecycle.test.ts` |

```typescript
// Example: API-006 model catalog test (from unit/api/models.test.ts)
import { Hono } from 'hono';
import { models } from '../../../src/api/routes/models';

describe('GET /models', () => {
  const app = new Hono();
  app.route('/models', models);

  test('returns 200 with models array', async () => {
    const res = await app.request('/models');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.models).toBeArray();
    expect(body.models.length).toBeGreaterThan(0);
  });

  test('each model has required fields', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    for (const model of body.models) {
      expect(model.alias).toBeString();
      expect(model.provider).toBeString();
      expect(typeof model.vision).toBe('boolean');
      expect(model.cost.input).toBeNumber();
      expect(model.cost.output).toBeNumber();
    }
  });
});
```

### P1

| ID | Test | Expected | File |
|----|------|----------|------|
| API-008 | `POST /valet/cancel/:id` sets `status=cancelled` | Status changes, `completed_at` set | `e2e/jobLifecycle.test.ts` |
| API-009 | Cancel on completed job is no-op | Status remains `completed` | `e2e/jobLifecycle.test.ts` |
| API-010 | `POST /valet/retry/:id` resets failed job to pending | `status: 'pending'`, `retry_count` incremented | `e2e/errorHandling.test.ts` |
| API-011 | Retry on completed job is no-op | Status remains `completed` | `e2e/errorHandling.test.ts` |
| API-012 | `GET /valet/events/:id` returns event list | Ordered array of job events | `e2e/jobLifecycle.test.ts` |
| API-013 | Excess requests return 429 | `{ allowed: false }` with `retryAfterSeconds` | `e2e/rateLimiting.test.ts` |
| API-014 | `GET /monitoring/workers` returns worker list | Array of active worker entries | `integration/workers/` |

---

## 3. Worker Regression

**Test locations:**
- `__tests__/unit/workers/handlers.test.ts`
- `__tests__/unit/workers/taskHandlerRegistry.test.ts`
- `__tests__/unit/workers/valetSchemas.test.ts`
- `__tests__/unit/workers/costTracking.test.ts`
- `__tests__/unit/workers/workerRegistry.test.ts`
- `__tests__/unit/workers/workerAffinity.test.ts`
- `__tests__/e2e/jobLifecycle.test.ts`
- `__tests__/e2e/costControl.test.ts`
- `__tests__/e2e/progressUpdates.test.ts`
- `__tests__/e2e/concurrency.test.ts`
- `__tests__/integration/workers/workerCallbacks.test.ts`

### P0 (must pass before deploy)

| ID | Test | Expected | File |
|----|------|----------|------|
| WRK-001 | Worker claims pending job (simulated `FOR UPDATE SKIP LOCKED`) | Job `status: 'queued'`, `worker_id` set, `last_heartbeat` set | `e2e/jobLifecycle.test.ts` |
| WRK-002 | Worker executes job through running to completed | `status: 'completed'`, `result_data` populated | `e2e/jobLifecycle.test.ts` |
| WRK-003 | Tokens recorded in `gh_job_events` on cost tracking | `event_type: 'cost_recorded'` with `total_cost` in metadata | `e2e/costControl.test.ts` |
| WRK-004 | Progress events emitted during execution | `job_started` and `job_completed` events logged | `e2e/jobLifecycle.test.ts` |
| WRK-005 | VALET callback_url receives POST on completion | `notifyCompleted` sends correct payload | `integration/hitl/hitlFlow.test.ts` |
| WRK-006 | `last_heartbeat` updates during execution | Heartbeat timestamp refreshed on claim | `e2e/jobLifecycle.test.ts` |
| WRK-007 | Priority ordering: highest priority claimed first | P10 picked before P5 before P1 | `e2e/jobLifecycle.test.ts` |
| WRK-008 | Already-claimed jobs are not picked up | Worker returns null for claimed/running jobs | `e2e/jobLifecycle.test.ts` |

```typescript
// Example: WRK-001 job pickup (from e2e/jobLifecycle.test.ts)
it('should pick up a pending job and claim it', async () => {
  await valet.createJob({ job_type: JOB_TYPE });

  const pickedUpId = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
  expect(pickedUpId).toBeDefined();

  const job = await valet.getJob(pickedUpId!);
  expect(job!.status).toBe('queued');
  expect(job!.worker_id).toBe(TEST_WORKER_ID);
  expect(job!.last_heartbeat).toBeDefined();
});
```

### P1

| ID | Test | Expected | File |
|----|------|----------|------|
| WRK-009 | Over-budget job throws `BudgetExceededError` | Error thrown with cost snapshot | `e2e/costControl.test.ts` |
| WRK-010 | >50 actions (or job-type limit) throws `ActionLimitExceededError` | Error at action limit+1 | `e2e/costControl.test.ts` |
| WRK-011 | Graceful drain: worker finishes active job on SIGTERM | Job reaches terminal state before exit | Manual test |
| WRK-012 | Crash recovery: browser crash triggers recovery (max 2 attempts) | Adapter restart, events re-wired | `unit/adapters/crashRecovery.test.ts` |
| WRK-013 | Session persistence: browser session saved after completion | `gh_browser_sessions` row upserted | `unit/sessions/SessionManager.test.ts` |
| WRK-014 | Task handler registry: all 4 built-in types registered | `apply`, `scrape`, `fill_form`, `custom` | `unit/workers/handlers.test.ts` |
| WRK-015 | Handler validation: apply handler rejects missing fields | `valid: false` with specific error messages | `unit/workers/handlers.test.ts` |
| WRK-016 | Stuck job recovery: stale heartbeat resets job to pending | Job with 3min-old heartbeat recovered | `e2e/errorHandling.test.ts` |

```typescript
// Example: WRK-009 budget enforcement (from e2e/costControl.test.ts)
it('should throw BudgetExceededError when task budget is exceeded', () => {
  const tracker = new CostTracker({
    jobId: 'test-job-budget-1',
    qualityPreset: 'speed', // budget = $0.02
  });

  tracker.recordTokenUsage({
    inputTokens: 500, outputTokens: 200,
    inputCost: 0.01, outputCost: 0.005,
  });

  expect(() => {
    tracker.recordTokenUsage({
      inputTokens: 500, outputTokens: 200,
      inputCost: 0.01, outputCost: 0.01,
    });
  }).toThrow(BudgetExceededError);
});
```

---

## 4. Adapter Regression

**Test locations:**
- `__tests__/unit/adapters/crashRecovery.test.ts`

| ID | Test | Expected | File |
|----|------|----------|------|
| ADP-001 | MockAdapter: `isConnected()` true after `start()` | `true` | `unit/adapters/crashRecovery.test.ts` |
| ADP-002 | MockAdapter: `isConnected()` false before `start()` | `false` | `unit/adapters/crashRecovery.test.ts` |
| ADP-003 | MockAdapter: `isConnected()` false after `simulateCrash()` | `false` | `unit/adapters/crashRecovery.test.ts` |
| ADP-004 | MockAdapter: `isActive()` remains true after crash | `true` (process alive, browser dead) | `unit/adapters/crashRecovery.test.ts` |
| ADP-005 | MockAdapter: `startDisconnected` config | `isActive()=true`, `isConnected()=false` | `unit/adapters/crashRecovery.test.ts` |
| ADP-006 | Crash recovery: crashed adapter can be stopped, new one started | New adapter `isConnected()=true` | `unit/adapters/crashRecovery.test.ts` |
| ADP-007 | Event handlers re-wired after recovery | New adapter receives events correctly | `unit/adapters/crashRecovery.test.ts` |
| ADP-008 | Session state passed to recovered adapter | Adapter starts with `storageState` | `unit/adapters/crashRecovery.test.ts` |
| ADP-009 | `browser_crashed` is in retryable errors set | `RETRYABLE_ERRORS.has('browser_crashed')` | `unit/adapters/crashRecovery.test.ts` |
| ADP-010 | `MAX_CRASH_RECOVERIES` is between 1 and 5 | `2` | `unit/adapters/crashRecovery.test.ts` |
| ADP-011 | Browser crash pattern matches known error messages | Regex matches all 5 known crash strings | `unit/adapters/crashRecovery.test.ts` |

```typescript
// Example: ADP-006 crash recovery (from unit/adapters/crashRecovery.test.ts)
test('crashed adapter can be stopped and a new one started', async () => {
  const adapter1 = new MockAdapter();
  await adapter1.start({
    url: 'https://linkedin.com/jobs/123',
    llm: { provider: 'mock', options: { model: 'mock' } },
  });

  adapter1.simulateCrash();
  expect(adapter1.isConnected()).toBe(false);

  await adapter1.stop();

  const adapter2 = new MockAdapter();
  await adapter2.start({
    url: 'https://linkedin.com/jobs/123',
    llm: { provider: 'mock', options: { model: 'mock' } },
  });

  expect(adapter2.isConnected()).toBe(true);
  expect(adapter2.isActive()).toBe(true);
});
```

---

## 5. Engine Regression

**Test locations:**
- `__tests__/unit/engine/executionEngine.test.ts`
- `__tests__/unit/engine/cookbookExecutor.test.ts`
- `__tests__/unit/engine/manualStore.test.ts`
- `__tests__/unit/engine/traceRecorder.test.ts`
- `__tests__/unit/engine/templateResolver.test.ts`
- `__tests__/unit/engine/locatorResolver.test.ts`
- `__tests__/unit/engine/pageObserver.test.ts`
- `__tests__/unit/engine/stagehandObserver.test.ts`
- `__tests__/unit/engine/actionBookSeeder.test.ts`
- `__tests__/unit/engine/types.test.ts`
- `__tests__/integration/engine/actionbookSeed.test.ts`
- `__tests__/integration/engine/manualTraining.test.ts`
- `__tests__/integration/modes/modeSwitching.test.ts`
- `__tests__/e2e/fullModeCycle.test.ts`

### ManualStore

| ID | Test | Expected | File |
|----|------|----------|------|
| ENG-001 | `lookup()` queries `gh_action_manuals` table | `from('gh_action_manuals')` called | `unit/engine/manualStore.test.ts` |
| ENG-002 | `lookup()` returns `ActionManual` on match | Non-null result with correct fields | `unit/engine/manualStore.test.ts` |
| ENG-003 | `lookup()` returns null on no match | `null` | `unit/engine/manualStore.test.ts` |
| ENG-004 | `lookup()` returns null on DB error | `null` (graceful) | `unit/engine/manualStore.test.ts` |
| ENG-005 | Health score converts DB 0-100 to domain 0-1 | `85 -> 0.85` | `unit/engine/manualStore.test.ts` |
| ENG-006 | `saveFromTrace()` inserts with `source: 'recorded'`, `health_score: 1.0` | New row created | `unit/engine/manualStore.test.ts` |
| ENG-007 | `saveFromActionBook()` inserts with `source: 'actionbook'`, `health_score: 0.8` | New row created | `unit/engine/manualStore.test.ts` |
| ENG-008 | `recordSuccess()` increments health (+2, cap 100) | Health updated | `unit/engine/manualStore.test.ts` |
| ENG-009 | `recordFailure()` decrements health (-5 normal, -15 severe, floor 0) | Health updated | `unit/engine/manualStore.test.ts` |
| ENG-010 | `urlToPattern()` wildcards numeric/UUID segments | `*.greenhouse.io/jobs/*` | `unit/engine/manualStore.test.ts` |
| ENG-011 | `urlMatchesPattern()` matches wildcard subdomains | `true` for matching URLs | `unit/engine/manualStore.test.ts` |

### CookbookExecutor

| ID | Test | Expected | File |
|----|------|----------|------|
| ENG-012 | `executeAll()` replays all steps successfully | `{ success: true, stepsCompleted: N }` | `unit/engine/cookbookExecutor.test.ts` |
| ENG-013 | `executeAll()` stops on first failure | `{ success: false, failedStepIndex: N }` | `unit/engine/cookbookExecutor.test.ts` |
| ENG-014 | Steps executed in order (sorted by `order` field) | Sequential execution verified | `unit/engine/cookbookExecutor.test.ts` |
| ENG-015 | Template variables resolved: `{{email}}` -> actual value | `fill('test@example.com')` called | `unit/engine/cookbookExecutor.test.ts` |
| ENG-016 | All actions supported: click, fill, select, check, uncheck, hover, press, scroll, navigate, wait | Each action type works | `unit/engine/cookbookExecutor.test.ts` |
| ENG-017 | Element not found returns failure | `{ success: false, error: 'No element found' }` | `unit/engine/cookbookExecutor.test.ts` |
| ENG-018 | Fill/select/press without value returns failure | `{ success: false, error: 'requires a value' }` | `unit/engine/cookbookExecutor.test.ts` |

### ExecutionEngine

| ID | Test | Expected | File |
|----|------|----------|------|
| ENG-019 | Manual found with good health -> cookbook mode | `{ success: true, mode: 'cookbook' }` | `unit/engine/executionEngine.test.ts` |
| ENG-020 | No manual found -> magnitude mode | `{ success: false, mode: 'magnitude' }` | `unit/engine/executionEngine.test.ts` |
| ENG-021 | Manual with health <= 0.3 -> skip cookbook -> magnitude | `mode: 'magnitude'`, cookbook not called | `unit/engine/executionEngine.test.ts` |
| ENG-022 | Cookbook failure -> fallback to magnitude mode | `mode: 'magnitude'`, `recordFailure` called | `unit/engine/executionEngine.test.ts` |
| ENG-023 | Cookbook throws error -> graceful fallback | Error captured, magnitude fallback | `unit/engine/executionEngine.test.ts` |
| ENG-024 | Platform detection: greenhouse URL -> `'greenhouse'` | `lookup` called with `'greenhouse'` | `unit/engine/executionEngine.test.ts` |
| ENG-025 | Unknown URL -> `'other'` platform | `lookup` called with `'other'` | `unit/engine/executionEngine.test.ts` |
| ENG-026 | `costTracker.setMode()` called with execution mode | `setMode('cookbook')` | `unit/engine/executionEngine.test.ts` |
| ENG-027 | `progress.setExecutionMode()` called with execution mode | `setExecutionMode('cookbook')` | `unit/engine/executionEngine.test.ts` |

### TraceRecorder

| ID | Test | Expected | File |
|----|------|----------|------|
| ENG-028 | Records click actions with locator from `elementFromPoint` | Step with `action: 'click'`, locator fields | `unit/engine/traceRecorder.test.ts` |
| ENG-029 | Records fill actions with typed value | Step with `action: 'fill'`, `value` set | `unit/engine/traceRecorder.test.ts` |
| ENG-030 | Template detection: replaces typed value with `{{field_name}}` | `{{email}}` when matching `user_data.email` | `unit/engine/traceRecorder.test.ts` |
| ENG-031 | Sequential order numbers assigned | `order: 0, 1, 2, ...` | `unit/engine/traceRecorder.test.ts` |
| ENG-032 | Null element skips step | Trace remains empty | `unit/engine/traceRecorder.test.ts` |
| ENG-033 | Empty locator strings omitted | `testId: undefined` when original was `''` | `unit/engine/traceRecorder.test.ts` |
| ENG-034 | All steps start with `healthScore: 1.0` | `1.0` | `unit/engine/traceRecorder.test.ts` |

---

## 6. Security Regression

**Test locations:**
- `__tests__/e2e/rateLimiting.test.ts`
- `__tests__/unit/sessions/SessionManager.test.ts`
- `__tests__/unit/detection/BlockerDetector.test.ts`

### Rate Limiting

| ID | Test | Expected | File |
|----|------|----------|------|
| SEC-001 | Free tier: allows N hourly requests, blocks N+1 | `allowed: true` then `allowed: false` | `e2e/rateLimiting.test.ts` |
| SEC-002 | Premium tier: higher hourly limit | 20 requests allowed | `e2e/rateLimiting.test.ts` |
| SEC-003 | Enterprise tier: unlimited | 100+ requests all allowed | `e2e/rateLimiting.test.ts` |
| SEC-004 | Blocked response includes `retryAfterSeconds` | `retryAfterSeconds > 0` | `e2e/rateLimiting.test.ts` |
| SEC-005 | Per-user independence: user A blocked, user B allowed | Independent counters | `e2e/rateLimiting.test.ts` |
| SEC-006 | Daily limits independent from hourly | Daily exhausted even if hourly window resets | `e2e/rateLimiting.test.ts` |
| SEC-007 | LinkedIn: most restrictive platform limit (5/hour) | Blocked at 6th request | `e2e/rateLimiting.test.ts` |
| SEC-008 | Different platforms tracked independently | LinkedIn blocked, Greenhouse allowed | `e2e/rateLimiting.test.ts` |
| SEC-009 | Combined: tier limit reached blocks even if platform has capacity | Tier check first | `e2e/rateLimiting.test.ts` |
| SEC-010 | Ascending tier limits: free < starter < pro < premium | Verified for hourly and daily | `e2e/rateLimiting.test.ts` |

### Encryption

| ID | Test | Expected | File |
|----|------|----------|------|
| SEC-011 | Encrypt -> decrypt roundtrip matches original | `JSON.parse(decrypted) === original` | `unit/sessions/SessionManager.test.ts` |
| SEC-012 | Different encryptions produce different ciphertexts (unique IV) | `ct1 !== ct2` | `unit/sessions/SessionManager.test.ts` |
| SEC-013 | Corrupted ciphertext returns null on load (no crash) | `loadSession` returns `null` | `unit/sessions/SessionManager.test.ts` |

### Blocker Detection

| ID | Test | Expected | File |
|----|------|----------|------|
| SEC-014 | Clean page: no blocker detected | `null` | `unit/detection/BlockerDetector.test.ts` |
| SEC-015 | reCAPTCHA iframe detected | `type: 'captcha', confidence: 0.95` | `unit/detection/BlockerDetector.test.ts` |
| SEC-016 | hCaptcha iframe detected | `type: 'captcha', confidence: 0.95` | `unit/detection/BlockerDetector.test.ts` |
| SEC-017 | Cloudflare challenge detected | `type: 'captcha', confidence: 0.95` | `unit/detection/BlockerDetector.test.ts` |
| SEC-018 | Login form detected | `type: 'login', confidence: 0.8` | `unit/detection/BlockerDetector.test.ts` |
| SEC-019 | Password input detected | `type: 'login', confidence: 0.6` | `unit/detection/BlockerDetector.test.ts` |
| SEC-020 | 2FA text detected | `type: '2fa'` | `unit/detection/BlockerDetector.test.ts` |
| SEC-021 | Bot check elements detected | `type: 'bot_check'` | `unit/detection/BlockerDetector.test.ts` |
| SEC-022 | Hidden CAPTCHA: confidence reduced by 50% | `0.95 * 0.5 = 0.475` | `unit/detection/BlockerDetector.test.ts` |
| SEC-023 | Highest confidence match returned when multiple hit | Captcha (0.95) beats login (0.6) | `unit/detection/BlockerDetector.test.ts` |

---

## 7. Database Regression

**Test locations:**
- `__tests__/e2e/jobLifecycle.test.ts`
- `__tests__/e2e/costControl.test.ts`
- `__tests__/e2e/errorHandling.test.ts`

| ID | Test | Expected | File |
|----|------|----------|------|
| DB-001 | `gh_automation_jobs`: CRUD works | Insert, read, update, delete all succeed | `e2e/jobLifecycle.test.ts` |
| DB-002 | `gh_job_events`: events created with FK to job | Events linked to job ID | `e2e/jobLifecycle.test.ts` |
| DB-003 | `gh_job_events`: cascade delete with parent job | Events deleted when job deleted | `e2e/helpers.ts:cleanupByJobType` |
| DB-004 | Idempotency: unique constraint on `idempotency_key` | Second insert with same key throws | `e2e/jobLifecycle.test.ts` |
| DB-005 | `gh_user_usage`: cost accumulation works | `total_cost_usd` incremented across jobs | `e2e/costControl.test.ts` |
| DB-006 | `gh_user_usage`: upsert with `user_id,period_start` conflict | Existing row updated, not duplicated | `e2e/costControl.test.ts` |
| DB-007 | `gh_browser_sessions`: upsert with `user_id,domain` conflict | Session updated on re-save | `unit/sessions/SessionManager.test.ts` |
| DB-008 | Filter jobs by status | `eq('status', 'pending')` returns correct count | `e2e/jobLifecycle.test.ts` |
| DB-009 | Scheduling: `scheduled_at` used for delayed jobs | Job with future `scheduled_at` not picked | `e2e/errorHandling.test.ts` |
| DB-010 | All GH tables use `gh_` prefix | No prefix-free table access | `unit/engine/manualStore.test.ts` |

```typescript
// Example: DB-004 idempotency (from e2e/jobLifecycle.test.ts)
it('should respect idempotency keys (no duplicate creation)', async () => {
  const key = `idem-${Date.now()}`;

  const job1 = await valet.createJob({ idempotency_key: key, job_type: JOB_TYPE });
  expect(job1.id).toBeDefined();

  await expect(
    insertTestJobs(supabase, { idempotency_key: key, job_type: JOB_TYPE }),
  ).rejects.toThrow();
});
```

---

## 8. Integration Regression

**Test locations:**
- `__tests__/e2e/jobLifecycle.test.ts`
- `__tests__/integration/hitl/hitlFlow.test.ts`
- `__tests__/e2e/costControl.test.ts`
- `__tests__/integration/sessions/sessionPersistence.test.ts`
- `__tests__/integration/events/eventLogging.test.ts`
- `__tests__/integration/workers/workerCallbacks.test.ts`
- `__tests__/integration/providers/llmConnectivity.test.ts`
- `__tests__/e2e/fullModeCycle.test.ts`

### Full Happy Path

| ID | Test | Expected | File |
|----|------|----------|------|
| INT-001 | Submit job -> pickup -> execute (mock) -> complete -> callback | All status transitions, events logged | `e2e/jobLifecycle.test.ts` |
| INT-002 | HITL: blocker detected -> pause -> needs_human callback -> resume -> complete | Callback sent, job resumes | `integration/hitl/hitlFlow.test.ts` |
| INT-003 | Cost: preflight budget check -> tokens tracked -> monthly usage updated | Usage row incremented | `e2e/costControl.test.ts` |
| INT-004 | Session: save -> restore on next job same user+domain | `loadSession` returns saved state | `integration/sessions/sessionPersistence.test.ts` |
| INT-005 | Mode cycle: magnitude run -> trace recorded -> manual saved -> cookbook replay | Full learning loop | `e2e/fullModeCycle.test.ts` |
| INT-006 | Mode switching: cookbook fails -> falls back to magnitude | `mode_switched` event logged | `integration/modes/modeSwitching.test.ts` |

```typescript
// Example: INT-001 full lifecycle (from e2e/jobLifecycle.test.ts)
it('full lifecycle: create -> pickup -> run -> complete -> verify', async () => {
  // 1. VALET creates the job
  const created = await valet.createJob({
    target_url: 'https://boards.greenhouse.io/acme/jobs/99999',
    task_description: 'Apply to Senior Engineer at Acme Corp',
    input_data: {
      user_data: { first_name: 'Alice', last_name: 'Smith', email: 'alice@test.com' },
      tier: 'pro',
    },
    tags: ['e2e', 'lifecycle'],
    job_type: JOB_TYPE,
  });
  expect(created.status).toBe('pending');

  // 2. Worker picks up
  const pickedUpId = await simulateWorkerPickup(supabase, TEST_WORKER_ID, JOB_TYPE);
  expect(pickedUpId).toBe(created.id);

  // 3. Worker executes
  await simulateJobExecution(supabase, pickedUpId!, 'completed', {
    result_data: { submitted: true, success_message: 'Application submitted!' },
    action_count: 12,
    total_tokens: 3500,
    llm_cost_cents: 8,
  });

  // 4. VALET verifies
  const final = await valet.getJob(pickedUpId!);
  expect(final!.status).toBe('completed');
  expect((final!.result_data as Record<string, unknown>).submitted).toBe(true);
  expect(final!.action_count).toBe(12);

  // 5. Verify event trail
  const events = await valet.getJobEvents(pickedUpId!);
  expect(events.length).toBeGreaterThanOrEqual(2);
});
```

### Error Handling Integration

| ID | Test | Expected | File |
|----|------|----------|------|
| INT-007 | Job failure stores error code and details | `error_code`, `error_details` populated | `e2e/errorHandling.test.ts` |
| INT-008 | Retryable error re-queues job with backoff | `status: 'pending'`, `scheduled_at` set | `e2e/errorHandling.test.ts` |
| INT-009 | Max retries exhausted -> permanent failure | `status: 'failed'` at `retry_count == max_retries` | `e2e/errorHandling.test.ts` |
| INT-010 | Exponential backoff: 5s, 10s, 20s, 40s, 60s (cap) | Formula: `min(60, 2^n * 5)` | `e2e/errorHandling.test.ts` |
| INT-011 | Partial cost recorded even on failure | `action_count`, `total_tokens` set on failed job | `e2e/errorHandling.test.ts` |
| INT-012 | Stuck job recovery: stale heartbeat resets to pending | Job with 3min-old heartbeat recovered | `e2e/errorHandling.test.ts` |

### Cost Control Integration

| ID | Test | Expected | File |
|----|------|----------|------|
| INT-013 | Preflight: sufficient budget -> allowed | `{ allowed: true }` | `e2e/costControl.test.ts` |
| INT-014 | Preflight: exhausted budget -> denied | `{ allowed: false, reason: 'Insufficient' }` | `e2e/costControl.test.ts` |
| INT-015 | Post-job cost recorded against monthly usage | `currentMonthCost` incremented | `e2e/costControl.test.ts` |
| INT-016 | Multiple jobs accumulate cost correctly | Total matches sum of individual costs | `e2e/costControl.test.ts` |
| INT-017 | Runtime kill: budget exceeded mid-execution | `BudgetExceededError` thrown, partial cost recorded | `e2e/costControl.test.ts` |
| INT-018 | Runtime kill: action limit exceeded | `ActionLimitExceededError` at limit+1 | `e2e/costControl.test.ts` |

### Concurrency

| ID | Test | Expected | File |
|----|------|----------|------|
| INT-019 | Two workers claim different jobs (no double-claim) | Each gets unique job ID | `e2e/concurrency.test.ts` |

---

## 9. CI Integration

### What Should Run on Every PR

```yaml
# .github/workflows/test.yml
- name: Unit Tests
  run: bun run test:unit
  # ~5-10 seconds, no external deps

- name: TypeScript Check
  run: bun run build
```

**Unit tests (`bun run test:unit`)** cover:
- All adapter tests
- All engine tests (ExecutionEngine, CookbookExecutor, ManualStore, TraceRecorder, etc.)
- All worker handler tests
- All detection tests (BlockerDetector)
- All session/encryption tests
- All API route unit tests
- All config/schema tests

### What Should Run Nightly (or on `main` merge)

```yaml
# .github/workflows/nightly.yml
- name: Integration Tests
  run: bun run test:integration
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
    SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
  # Requires live Supabase, ~30-60 seconds

- name: E2E Tests
  run: bun run test:e2e
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
    SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
  # Sequential, ~2-5 minutes
```

**Integration tests** cover: HITL flows, session persistence, event logging, mode switching, actionbook seeding, worker callbacks, LLM connectivity.

**E2E tests** cover: Full job lifecycle, error handling, cost controls, rate limiting, concurrency, progress updates, full mode cycle.

### Test Isolation

E2E tests use **unique `job_type` per test file** to avoid cross-file interference when running in parallel. Cleanup uses `cleanupByJobType()` rather than global `cleanupTestData()`.

---

## 10. Rollback Procedure

### Deploy.sh Rollback

```bash
# Rollback to previous version
./deploy.sh rollback

# Rollback to specific version tag
./deploy.sh rollback v1.2.3
```

### Manual Docker Rollback

```bash
# SSH to EC2 instance
ssh ec2-user@<instance-ip>

# List available images
docker images ghost-hands --format "{{.Tag}} {{.CreatedAt}}"

# Stop current containers
docker compose down

# Update docker-compose.yml to previous image tag
# Then restart
docker compose up -d

# Verify health
curl http://localhost:3100/health
curl http://localhost:3101/health
```

### Database Rollback

If a migration needs to be reversed:

```bash
# Run the rollback SQL against Supabase
psql "$DATABASE_URL" -f packages/ghosthands/src/scripts/rollback-integration-migration.sql
```

**Critical:** Always verify rollback in staging before production. Database rollbacks may require data migration if rows have been created with new schema.

### Post-Rollback Verification

After any rollback, run the P0 regression suite:

```bash
# Verify core functionality
bun run test:unit

# If Supabase is accessible, run integration checks
bun run test:integration

# Quick health check
curl -s http://localhost:3100/health | jq .
curl -s http://localhost:3100/api/v1/gh/models | jq '.total'
```

---

## Appendix: Test File Inventory

### Unit Tests (`__tests__/unit/`)

| Directory | File | Coverage Area |
|-----------|------|--------------|
| `adapters/` | `crashRecovery.test.ts` | MockAdapter crash simulation, recovery flow |
| `api/` | `models.test.ts` | Model catalog endpoint |
| `api/` | `valetStatus.test.ts` | VALET status endpoint |
| `config/` | `models.test.ts` | Model configuration validation |
| `connectors/` | `actionbookConnector.test.ts` | Actionbook connector |
| `detection/` | `BlockerDetector.test.ts` | CAPTCHA/login/2FA/bot detection |
| `engine/` | `executionEngine.test.ts` | Mode selection, cookbook/magnitude routing |
| `engine/` | `cookbookExecutor.test.ts` | Step replay, template substitution |
| `engine/` | `manualStore.test.ts` | Manual CRUD, health scoring, URL patterns |
| `engine/` | `traceRecorder.test.ts` | Action recording, locator extraction |
| `engine/` | `templateResolver.test.ts` | `{{variable}}` template resolution |
| `engine/` | `locatorResolver.test.ts` | CSS/testId/role locator resolution |
| `engine/` | `pageObserver.test.ts` | Page state observation |
| `engine/` | `stagehandObserver.test.ts` | Stagehand integration observer |
| `engine/` | `actionBookSeeder.test.ts` | Actionbook seed operations |
| `engine/` | `types.test.ts` | Type/schema validation |
| `events/` | `jobEventTypes.test.ts` | Event type constants |
| `sessions/` | `SessionManager.test.ts` | Session persistence, encryption |
| `workers/` | `handlers.test.ts` | Task handler types, validation |
| `workers/` | `taskHandlerRegistry.test.ts` | Handler registration |
| `workers/` | `valetSchemas.test.ts` | VALET schema validation |
| `workers/` | `costTracking.test.ts` | Per-task cost tracking |
| `workers/` | `workerRegistry.test.ts` | Worker registration |
| `workers/` | `workerAffinity.test.ts` | Worker affinity routing |

### Integration Tests (`__tests__/integration/`)

| Directory | File | Coverage Area |
|-----------|------|--------------|
| `engine/` | `actionbookSeed.test.ts` | Actionbook DB seeding |
| `engine/` | `manualTraining.test.ts` | Manual training flow |
| `events/` | `eventLogging.test.ts` | Event persistence to DB |
| `hitl/` | `hitlFlow.test.ts` | Human-in-the-loop callbacks |
| `modes/` | `modeSwitching.test.ts` | Cookbook/magnitude switching |
| `providers/` | `llmConnectivity.test.ts` | LLM provider connectivity |
| `sessions/` | `sessionPersistence.test.ts` | Session save/load via Supabase |
| `workers/` | `workerCallbacks.test.ts` | Worker callback delivery |

### E2E Tests (`__tests__/e2e/`)

| File | Coverage Area |
|------|--------------|
| `helpers.ts` | Test utilities, mock VALET client, job factory |
| `jobLifecycle.test.ts` | Full create -> pickup -> execute -> complete |
| `errorHandling.test.ts` | Failures, retries, error codes, backoff |
| `costControl.test.ts` | Budget checks, action limits, cost recording |
| `rateLimiting.test.ts` | Tier/platform rate limits, 429 responses |
| `concurrency.test.ts` | Parallel worker job claiming |
| `progressUpdates.test.ts` | Progress event emission |
| `fullModeCycle.test.ts` | Magnitude -> trace -> manual -> cookbook cycle |
