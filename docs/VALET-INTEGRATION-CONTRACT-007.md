# GhostHands Integration Contract Update: Worker Routing

**Migration:** `007_add_target_worker_id`
**Date:** 2026-02-15
**Status:** Ready for review
**Breaking:** No (fully backward compatible)

---

## Summary

Added `target_worker_id` field to `gh_automation_jobs` table, enabling job-to-worker routing. When set, only the matching worker will pick up the job. When NULL (default), any worker can pick it up. **Existing behavior is unchanged.**

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

**Run this migration before deploying updated workers.**

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

## Backward Compatibility

| Scenario | Before | After |
|----------|--------|-------|
| VALET creates job without `target_worker_id` | Any worker picks it up | Any worker picks it up (unchanged) |
| VALET creates job with `target_worker_id: null` | N/A | Any worker picks it up |
| VALET creates job with `target_worker_id: "X"` | N/A | Only worker "X" picks it up |
| Worker starts without `--worker-id` | Auto ID | Auto ID (unchanged) |
| Worker starts with `--worker-id=X` | N/A | Named worker, picks up targeted + shared jobs |

**No breaking changes.** All existing VALET integrations continue to work without modification.

---

## VALET Action Items

- [ ] Run migration `007_add_target_worker_id.sql` on shared Supabase
- [ ] (Optional) Update VALET job creation to pass `target_worker_id` when routing is needed
- [ ] (Optional) Update any VALET UI that displays job details to show `target_worker_id`

**None of these are blocking.** VALET can adopt `target_worker_id` at its own pace.

---

## Files Changed

| File | Change |
|------|--------|
| `src/db/migrations/007_add_target_worker_id.sql` | New migration (column + index + function) |
| `src/client/types.ts` | Added `target_worker_id` to schemas and interfaces |
| `src/api/schemas/job.ts` | Added `target_worker_id` to API CreateJobSchema |
| `src/api/controllers/jobs.ts` | Added `target_worker_id` to INSERT queries |
| `src/client/GhostHandsClient.ts` | Added `target_worker_id` to payload builders |
| `src/workers/main.ts` | Added `--worker-id` CLI argument |
| `src/scripts/submit-test-job.ts` | Added `--worker-id` targeting support |
| `test-worker.sh` | Passes `--worker-id` to both worker and job |
