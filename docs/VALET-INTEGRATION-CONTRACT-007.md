# GhostHands Integration Contract Update: Worker Routing & Job Management

**Migration:** `007_add_target_worker_id`
**Date:** 2026-02-15
**Status:** Applied to production Supabase
**Breaking:** No (fully backward compatible)

---

## Summary

Added `target_worker_id` field across the entire stack — database, REST API, VALET routes, and client SDK. When set, only the matching worker picks up the job. When NULL (default), any worker can pick it up. **All existing behavior is unchanged.**

Also added a job management CLI for cancel/retry/status without needing extra terminals.

---

## Database Changes

### New Column

```sql
ALTER TABLE gh_automation_jobs
  ADD COLUMN target_worker_id TEXT DEFAULT NULL;
```

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `target_worker_id` | `TEXT` | `NULL` | Route job to a specific worker. NULL = any worker. |

### New Index

```sql
CREATE INDEX idx_gh_jobs_target_worker
  ON gh_automation_jobs (target_worker_id)
  WHERE target_worker_id IS NOT NULL;
```

### Updated Function: `gh_pickup_next_job`

The pickup function now filters by `target_worker_id`:

```sql
-- Before (any worker grabs any pending job):
WHERE status = 'pending'
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())

-- After (respects routing):
WHERE status = 'pending'
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())
  AND (target_worker_id IS NULL OR target_worker_id = p_worker_id)  -- NEW
```

**Effect:** Jobs with `target_worker_id = NULL` (the default) work exactly as before. Jobs with a specific `target_worker_id` are only picked up by the matching worker.

### Migration File

`packages/ghosthands/src/db/migrations/007_add_target_worker_id.sql`

**Already applied to live Supabase.** No action needed.

---

## API Changes

### POST `/api/v1/gh/jobs` (Create Job)

New optional field in request body:

```jsonc
{
  "job_type": "apply",
  "target_url": "https://example.com/careers",
  "task_description": "Apply to the Software Engineer position",
  "input_data": { /* ... */ },

  // NEW - optional, defaults to null
  "target_worker_id": "worker-adam"
}
```

| Field | Type | Required | Default | Validation |
|-------|------|----------|---------|------------|
| `target_worker_id` | `string \| null` | No | `null` | Max 100 chars |

**If omitted or null:** Any available worker picks up the job (existing behavior).
**If set:** Only the worker running with `--worker-id=<value>` will pick it up.

### POST `/api/v1/gh/jobs/batch` (Batch Create)

Same field available per-job in the `jobs` array.

### GET `/api/v1/gh/jobs/:id` (Get Job)

Response now includes `target_worker_id` in the job object:

```jsonc
{
  "id": "abc-123",
  "status": "pending",
  "target_worker_id": "worker-adam",  // NEW (nullable)
  // ... other fields unchanged
}
```

---

## VALET Route Changes

### POST `/api/v1/gh/valet/apply` (Apply Request)

New optional field:

```jsonc
{
  "valet_task_id": "valet-123",
  "valet_user_id": "uuid-here",
  "target_url": "https://example.com/careers",
  "profile": { /* ... */ },

  // NEW - optional, defaults to null
  "target_worker_id": "worker-prod-1"
}
```

| Field | Type | Required | Default | Validation |
|-------|------|----------|---------|------------|
| `target_worker_id` | `string \| null` | No | `null` | Max 100 chars, nullable |

When VALET sends `target_worker_id`, the job is routed to that specific worker. When omitted/null, any worker picks it up (same as before).

### POST `/api/v1/gh/valet/task` (Generic Task)

Same new field:

```jsonc
{
  "valet_task_id": "valet-456",
  "valet_user_id": "uuid-here",
  "job_type": "scrape",
  "target_url": "https://example.com",
  "task_description": "Extract job listing details",

  // NEW - optional, defaults to null
  "target_worker_id": "worker-prod-1"
}
```

### GET `/api/v1/gh/valet/status/:jobId` (Status Check)

No changes — this endpoint reads from the existing `gh_automation_jobs` table which already includes the new column.

---

## Client SDK Changes

### TypeScript Types Updated

```typescript
// CreateJobParams (snake_case) - used by VALET REST calls
interface CreateJobParams {
  // ... existing fields ...
  target_worker_id?: string | null;  // NEW
}

// CreateJobOptions (camelCase) - convenience interface
interface CreateJobOptions {
  // ... existing fields ...
  targetWorkerId?: string | null;  // NEW
}

// AutomationJob (response type)
interface AutomationJob {
  // ... existing fields ...
  target_worker_id: string | null;  // NEW
}
```

### Client Usage

```typescript
import { GhostHandsClient } from 'ghosthands';

const client = new GhostHandsClient(apiUrl, apiKey);

// Route to specific worker:
await client.createJob({
  job_type: 'apply',
  target_url: 'https://example.com/careers',
  task_description: 'Apply to position',
  target_worker_id: 'worker-adam',  // Only worker-adam picks this up
});

// Any worker (default, backward compatible):
await client.createJob({
  job_type: 'apply',
  target_url: 'https://example.com/careers',
  task_description: 'Apply to position',
  // target_worker_id omitted = any worker
});
```

---

## Worker Changes

Workers now accept a `--worker-id` CLI argument:

```bash
# Named worker (recommended for dev/testing):
bun run worker -- --worker-id=adam

# Auto-generated ID (default, production):
bun run worker
```

A worker with `--worker-id=adam` will pick up:
- Jobs with `target_worker_id = NULL` (shared pool)
- Jobs with `target_worker_id = 'adam'` (targeted)

A worker with `--worker-id=adam` will **NOT** pick up:
- Jobs with `target_worker_id = 'sarah'` (targeted to someone else)

---

## Job Management CLI

New `job` CLI for managing jobs without extra terminals:

```bash
bun run job list                    # List recent jobs (aliases: ls)
bun run job status <id>             # Show job details (aliases: s)
bun run job cancel <id>             # Cancel a specific job (aliases: c)
bun run job cancel --all            # Cancel all active jobs
bun run job cancel --worker=<name>  # Cancel all jobs for a worker
bun run job retry <id>              # Retry a failed/cancelled job (aliases: r)
bun run job logs <id>               # Show job event log (aliases: l)
```

Short IDs supported: `bun run job cancel a23c` matches `a23c728e-...`

**Useful for VALET debugging:** If a VALET-submitted job is stuck, use:
```bash
bun run job status <job_id>    # Check what happened
bun run job logs <job_id>      # See step-by-step events
bun run job retry <job_id>     # Re-queue it
bun run job cancel <job_id>    # Kill it
```

---

## Human-in-the-Loop (HITL) — Coming in Phase 2

### Overview

When GhostHands encounters a blocker it can't solve (CAPTCHA, 2FA, bot check, login required), it will:
1. **Pause** the automation and take a screenshot
2. **Notify VALET** via the existing callback URL with `status: 'needs_human'`
3. **Wait** for VALET to call a resume endpoint (or timeout after 5 minutes)

VALET is responsible for showing the notification to the user and providing a way to resolve the blocker.

### Callback: `needs_human` (GhostHands → VALET)

When a blocker is detected, GhostHands POSTs to the job's `callback_url`:

```jsonc
{
  "job_id": "abc-123",
  "valet_task_id": "valet-456",
  "status": "needs_human",
  "interaction": {
    "reason": "captcha",                // "captcha" | "2fa" | "login" | "bot_check" | "screening_question"
    "description": "reCAPTCHA v2 detected on application page",
    "screenshot_url": "https://storage.../blocker-screenshot.png",
    "current_url": "https://company.workday.com/apply",
    "paused_at": "2026-02-16T06:30:00Z",
    "expires_at": "2026-02-16T06:35:00Z",
    "timeout_seconds": 300
  },
  "progress": {
    "step": "filling_form",
    "progress_pct": 45,
    "actions_completed": 7
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"needs_human"` | New callback status (in addition to `"completed"` and `"failed"`) |
| `interaction.reason` | `string` | What blocker was detected |
| `interaction.screenshot_url` | `string` | Screenshot showing the blocker |
| `interaction.expires_at` | `string` | When the interaction times out (job will fail) |
| `interaction.timeout_seconds` | `number` | Seconds until timeout |

### Resume Endpoint (VALET → GhostHands)

After the user resolves the blocker, VALET calls:

```
POST /api/v1/gh/valet/resume/:jobId
```

**Request:**
```jsonc
{
  "action": "resume",        // "resume" or "cancel"
  "resolution": "solved",    // what the human did
  "notes": "Solved CAPTCHA"  // optional
}
```

**Response (success):**
```jsonc
{
  "job_id": "abc-123",
  "status": "running",
  "resumed_at": "2026-02-16T06:32:00Z"
}
```

**Response (job not paused):**
```jsonc
// 409 Conflict
{
  "error": "not_paused",
  "message": "Job is running, not paused"
}
```

### Status Response (Updated)

`GET /api/v1/gh/valet/status/:jobId` now includes interaction info when paused:

```jsonc
{
  "job_id": "abc-123",
  "status": "paused",
  "status_message": "Waiting for human: reCAPTCHA detected",
  "interaction": {
    "reason": "captcha",
    "description": "reCAPTCHA v2 detected",
    "screenshot_url": "https://...",
    "current_url": "https://company.workday.com/apply",
    "paused_at": "2026-02-16T06:30:00Z",
    "expires_at": "2026-02-16T06:35:00Z",
    "timeout_seconds": 300
  },
  "progress": { ... },
  "timestamps": { ... }
}
```

### New Error Codes

| Error Code | Description | Human Action |
|------------|-------------|------------|
| `captcha_blocked` | CAPTCHA/reCAPTCHA detected | Solve the CAPTCHA |
| `2fa_required` | Two-factor authentication prompt | Enter verification code |
| `login_required` | Login page detected | Enter credentials |
| `bot_check` | Bot detection interstitial | Verify humanity |
| `human_timeout` | Human didn't respond in time | Job failed — retry |
| `human_cancelled` | Human chose to cancel | Job cancelled |

### VALET Action Items (Phase 2)

- [ ] Handle `needs_human` callback — show notification to user
- [ ] Build UI to display blocker screenshot and resolution buttons
- [ ] Implement "I'm done" button → `POST /valet/resume/:jobId` with `action: "resume"`
- [ ] Implement "Cancel" button → `POST /valet/resume/:jobId` with `action: "cancel"`
- [ ] Handle `human_timeout` — show "automation timed out" message
- [ ] (Future) Live browser viewer via CDP WebSocket for real-time takeover

### Backward Compatibility

This feature is **fully opt-in**. Jobs without `callback_url` will never trigger HITL — they'll continue to retry and fail as today. VALET only needs to implement HITL handling when ready.

---

## Backward Compatibility

| Scenario | Before | After |
|----------|--------|-------|
| VALET creates job without `target_worker_id` | Any worker picks it up | Any worker picks it up (unchanged) |
| VALET creates job with `target_worker_id: null` | N/A | Any worker picks it up |
| VALET creates job with `target_worker_id: "X"` | N/A | Only worker "X" picks it up |
| Worker starts without `--worker-id` | Auto ID | Auto ID (unchanged) |
| Worker starts with `--worker-id=X` | N/A | Named worker, picks up targeted + shared jobs |
| VALET `/valet/apply` without `target_worker_id` | Works | Works (unchanged) |
| VALET `/valet/task` without `target_worker_id` | Works | Works (unchanged) |

**No breaking changes.** All existing VALET integrations continue to work without modification.

---

## VALET Action Items

- [x] Migration `007_add_target_worker_id.sql` applied to shared Supabase
- [ ] (Optional) Update VALET job creation to pass `target_worker_id` when routing is needed
- [ ] (Optional) Update `/valet/apply` calls to include `target_worker_id` for worker isolation
- [ ] (Optional) Update any VALET UI that displays job details to show `target_worker_id`

**None of these are blocking.** VALET can adopt `target_worker_id` at its own pace.

---

## Testing with curl

### VALET Apply with Worker Routing

```bash
curl -X POST https://your-gh-api/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY" \
  -d '{
    "valet_task_id": "test-123",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "target_url": "https://example.com/careers",
    "profile": {
      "first_name": "Test",
      "last_name": "User",
      "email": "test@example.com"
    },
    "target_worker_id": "adam"
  }'
```

### VALET Apply without Routing (any worker)

```bash
curl -X POST https://your-gh-api/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY" \
  -d '{
    "valet_task_id": "test-456",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "target_url": "https://example.com/careers",
    "profile": {
      "first_name": "Test",
      "last_name": "User",
      "email": "test@example.com"
    }
  }'
```

### Check Job Status

```bash
curl https://your-gh-api/api/v1/gh/valet/status/JOB_ID_HERE \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY"
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/db/migrations/007_add_target_worker_id.sql` | New migration (column + index + function) |
| `src/client/types.ts` | Added `target_worker_id` to schemas and interfaces |
| `src/api/schemas/job.ts` | Added `target_worker_id` to API CreateJobSchema |
| `src/api/schemas/valet.ts` | Added `target_worker_id` to ValetApplySchema and ValetTaskSchema |
| `src/api/controllers/jobs.ts` | Added `target_worker_id` to INSERT queries |
| `src/api/routes/valet.ts` | Added `target_worker_id` to both `/apply` and `/task` INSERT queries |
| `src/client/GhostHandsClient.ts` | Added `target_worker_id` to payload builders |
| `src/workers/main.ts` | Added `--worker-id` CLI argument + two-phase shutdown |
| `src/scripts/job.ts` | **NEW** — Job management CLI (list/status/cancel/retry/logs) |
| `src/scripts/submit-test-job.ts` | Added `--worker-id` targeting support |
| `test-worker.sh` | Passes `--worker-id` to both worker and job, shows CLI hints |
| `package.json` | Added `job` script |
