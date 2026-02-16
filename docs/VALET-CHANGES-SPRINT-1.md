# VALET Integration Changes: Sprint 1

**Date:** 2026-02-16
**Sprint:** 1 (Session Persistence + HITL Pause/Resume)
**Status:** Complete
**Breaking:** No (all changes are additive and backward compatible)

---

## Summary

Sprint 1 adds two capabilities to GhostHands that affect the shared VALET integration:

1. **Session Persistence** -- Browser sessions (cookies, localStorage) are now encrypted and stored per user/domain in a new `gh_browser_sessions` table. This reduces login-related blockers on repeat jobs.

2. **Human-in-the-Loop (HITL) Pause/Resume** -- When the automation encounters a blocker it cannot solve (CAPTCHA, 2FA, login wall, bot check), it pauses the job, notifies VALET via callback, and waits for a human to resolve it before resuming.

---

## 1. New Database Objects

### 1.1 New Table: `gh_browser_sessions`

**Migration:** `008_gh_browser_sessions.sql`

Stores encrypted browser session state per user and domain.

```sql
CREATE TABLE gh_browser_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    domain TEXT NOT NULL,
    session_data TEXT NOT NULL,          -- AES-256-GCM encrypted JSON
    encryption_key_id TEXT NOT NULL,     -- tracks key version for rotation
    expires_at TIMESTAMPTZ,             -- optional session expiry
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_gh_browser_sessions_user_domain UNIQUE (user_id, domain)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `session_data` | `TEXT` | Playwright `storageState()` output, encrypted with AES-256-GCM |
| `encryption_key_id` | `TEXT` | Which encryption key was used (enables key rotation) |
| `domain` | `TEXT` | Hostname extracted from target URL |
| `expires_at` | `TIMESTAMPTZ` | Optional; expired sessions are auto-cleaned |

**Indexes:**
- `idx_gh_browser_sessions_lookup` on `(user_id, domain)` -- primary lookup
- `idx_gh_browser_sessions_expiry` on `(expires_at)` WHERE `expires_at IS NOT NULL` -- cleanup

**RLS Policies:**
- Service role: full access (used by worker process)
- Authenticated users: SELECT and DELETE only on their own rows
- No client-side INSERT/UPDATE (all writes go through the worker's service role)

**Trigger:**
- `trg_gh_browser_sessions_updated_at` -- auto-updates `updated_at` on row modification

### 1.2 New Columns on `gh_automation_jobs`

**Migration:** `009_hitl_columns.sql`

Three new columns for HITL interaction tracking:

```sql
ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS interaction_type TEXT,
  ADD COLUMN IF NOT EXISTS interaction_data JSONB,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
```

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `interaction_type` | `TEXT` | `NULL` | Blocker type that triggered the pause: `captcha`, `2fa`, `login`, `bot_check` |
| `interaction_data` | `JSONB` | `NULL` | Details: screenshot URL, page URL, timeout config |
| `paused_at` | `TIMESTAMPTZ` | `NULL` | When the job was paused for human intervention |

**New Index:**
- `idx_gh_jobs_paused` on `(status)` WHERE `status = 'paused'` -- efficient lookup of paused jobs

---

## 2. API Changes

### 2.1 New Endpoint: `POST /api/v1/gh/valet/resume/:jobId`

Resume a job that was paused for human intervention.

**Request:**

```jsonc
POST /api/v1/gh/valet/resume/:jobId
Content-Type: application/json
X-GH-Service-Key: <service_key>

{
  "resolved_by": "human",            // "human" or "system" (required, default: "human")
  "resolution_notes": "Solved CAPTCHA" // optional, max 500 chars
}
```

| Field | Type | Required | Default | Validation |
|-------|------|----------|---------|------------|
| `resolved_by` | `"human" \| "system"` | No | `"human"` | Enum |
| `resolution_notes` | `string` | No | — | Max 500 chars |

**Response (200 -- success):**

```jsonc
{
  "job_id": "abc-123",
  "status": "running",
  "resolved_by": "human"
}
```

**Response (404 -- job not found):**

```jsonc
{
  "error": "not_found",
  "message": "Job not found"
}
```

**Response (409 -- job not paused):**

```jsonc
{
  "error": "invalid_state",
  "message": "Job is not paused (current status: running)"
}
```

**Behavior:**
1. Validates job exists and is in `paused` status
2. Sends `pg_notify('gh_job_resume', jobId)` to signal the waiting worker
3. Updates job status back to `running`, clears `paused_at`
4. Stores resolution info in `status_message`

### 2.2 Modified Endpoint: `GET /api/v1/gh/valet/status/:jobId`

When a job has `status = 'paused'`, the response now includes an `interaction` object with blocker details:

```jsonc
{
  "job_id": "abc-123",
  "valet_task_id": "valet-456",
  "status": "paused",
  "status_message": "Waiting for human: reCAPTCHA v2 detected",
  "interaction": {                         // NEW -- only present when status='paused'
    "type": "captcha",                     // blocker type
    "screenshot_url": "https://...",       // screenshot of the blocker
    "page_url": "https://company.workday.com/apply",
    "paused_at": "2026-02-16T06:30:00Z",
    "timeout_seconds": 300
  },
  "progress": { ... },
  "result": null,
  "error": null,
  "timestamps": {
    "created_at": "...",
    "started_at": "...",
    "completed_at": null
  }
}
```

The `interaction` field is `null` or absent when the job is not paused.

---

## 3. Callback Payload Changes

### 3.1 New Status Values

The callback payload `status` field now supports two additional values:

| Status | Direction | Description |
|--------|-----------|-------------|
| `completed` | GH -> VALET | Job finished successfully (existing) |
| `failed` | GH -> VALET | Job failed (existing) |
| `needs_human` | GH -> VALET | **NEW** -- Job paused, needs human intervention |
| `resumed` | GH -> VALET | **NEW** -- Previously paused job has resumed |

### 3.2 Callback: `needs_human` (GhostHands -> VALET)

When a blocker is detected, GhostHands POSTs to the job's `callback_url`:

```jsonc
{
  "job_id": "abc-123",
  "valet_task_id": "valet-456",
  "status": "needs_human",
  "interaction": {
    "type": "captcha",                    // "captcha" | "2fa" | "login" | "bot_check"
    "screenshot_url": "https://...",      // screenshot showing the blocker
    "page_url": "https://company.workday.com/apply",
    "timeout_seconds": 300                // seconds until the job times out
  },
  "completed_at": "2026-02-16T06:30:00Z"
}
```

**`interaction.type` values:**

| Type | Description | User Action |
|------|-------------|-------------|
| `captcha` | reCAPTCHA, hCAPTCHA, or Cloudflare challenge detected | Solve the CAPTCHA |
| `2fa` | Two-factor authentication prompt detected | Enter verification code |
| `login` | Login page or password field detected | Enter credentials |
| `bot_check` | Bot detection interstitial (Cloudflare, PerimeterX, DataDome) | Verify humanity |

### 3.3 Callback: `resumed` (GhostHands -> VALET)

After a paused job resumes:

```jsonc
{
  "job_id": "abc-123",
  "valet_task_id": "valet-456",
  "status": "resumed",
  "completed_at": "2026-02-16T06:32:00Z"
}
```

---

## 4. Integration Checklist for VALET Team

### 4.1 Handle `needs_human` Callback

When VALET receives a callback with `status: 'needs_human'`:

- [ ] Parse the `interaction` object from the callback payload
- [ ] Show a notification to the user: "Your automation needs help"
- [ ] Display the `interaction.screenshot_url` image showing the blocker
- [ ] Display the `interaction.type` as a human-readable label (e.g., "CAPTCHA Detected")
- [ ] Show a countdown timer based on `interaction.timeout_seconds`
- [ ] Provide "I've resolved it" and "Cancel" buttons

### 4.2 Call Resume Endpoint

When the user clicks "I've resolved it":

```bash
POST /api/v1/gh/valet/resume/:jobId
X-GH-Service-Key: <service_key>
Content-Type: application/json

{
  "resolved_by": "human",
  "resolution_notes": "Solved CAPTCHA"
}
```

### 4.3 Handle `resumed` Callback

- [ ] Update the task status in VALET UI from "Needs Attention" back to "Running"
- [ ] Clear the blocker notification

### 4.4 Poll Status Endpoint for Interaction Info

When checking job status via `GET /api/v1/gh/valet/status/:jobId`:

- [ ] Check if `status === 'paused'`
- [ ] If paused, read the `interaction` field for blocker details
- [ ] Display blocker info in the VALET UI

### 4.5 Handle Timeout

If the human doesn't resolve the blocker within `timeout_seconds`:

- [ ] The job will automatically fail with error code `hitl_timeout`
- [ ] VALET will receive a `failed` callback with `error_code: 'hitl_timeout'`
- [ ] Show "Automation timed out waiting for help" message
- [ ] Offer a "Retry" option

### 4.6 New Error Codes

| Error Code | Description | Suggested VALET UI |
|------------|-------------|--------------------|
| `hitl_timeout` | Human didn't respond within timeout | "Timed out waiting for help. Retry?" |
| `human_cancelled` | Human chose to cancel | "Task cancelled by user" |

---

## 5. Security Notes

### 5.1 Session Data Encryption

- All browser session data (cookies, localStorage) stored in `gh_browser_sessions` is encrypted with **AES-256-GCM**
- Each encryption operation uses a unique IV (12 bytes, NIST-recommended for GCM)
- Encryption envelope format: `[version:1][keyId:2][iv:12][authTag:16][ciphertext:*]`
- Key rotation is supported: old ciphertexts are decrypted with their original key via the embedded `keyId`
- Encryption key is sourced from `GH_CREDENTIAL_KEY` environment variable (64 hex chars = 256 bits)
- **No plaintext session data appears in logs, API responses, or error messages**

### 5.2 Row Level Security on `gh_browser_sessions`

| Role | SELECT | INSERT | UPDATE | DELETE |
|------|--------|--------|--------|--------|
| `service_role` (worker) | Yes | Yes | Yes | Yes |
| `authenticated` (user) | Own rows only | No | No | Own rows only |
| `anon` | No | No | No | No |

Users can view and delete their own sessions (e.g., "log out everywhere") but cannot modify session data directly.

### 5.3 Resume Endpoint Security

- The `/valet/resume/:jobId` endpoint is protected by the service key (`X-GH-Service-Key` header) -- same auth as all VALET routes
- Rate limiting is applied via `rateLimitMiddleware()`
- Input is validated by Zod schema (`ValetResumeSchema`)
- Job ID is passed as a parameterized query (`$1::UUID`) -- no SQL injection risk
- Only jobs in `paused` status can be resumed (state validation returns 409 otherwise)

### 5.4 HITL Migration Security

- Migration uses `IF NOT EXISTS` guards for idempotency
- New columns default to `NULL` -- no data migration needed
- Partial index on `status = 'paused'` is minimal and focused

### 5.5 No Secrets in Code or Logs

- Encryption keys are loaded from environment variables, never hardcoded
- `SessionManager` only logs domain names, never session data
- `JobExecutor` logs `session_restored` and `session_saved` events with domain only
- Error messages from encryption failures are generic ("envelope too short", "key not found")
- Stack traces are not exposed in API responses (handled by error middleware)

---

## 6. Backward Compatibility

All changes in Sprint 1 are **fully backward compatible**:

| Scenario | Before | After |
|----------|--------|-------|
| Job without `callback_url` | Runs normally | Runs normally (HITL never triggers without callback) |
| Job with `callback_url` | Gets `completed`/`failed` callbacks | Gets `completed`/`failed` + may get `needs_human`/`resumed` |
| VALET ignores `needs_human` callback | N/A | Job times out after 300s, fails with `hitl_timeout` |
| VALET doesn't call `/resume` | N/A | Same timeout behavior |
| Status endpoint for running job | Returns status object | Returns same object (no `interaction` field) |
| Status endpoint for paused job | N/A (new status) | Returns object with `interaction` field |

**VALET does not need to implement HITL handling immediately.** Without changes, paused jobs will timeout and fail as before. VALET can adopt HITL at its own pace.

---

## 7. Files Changed (Sprint 1)

### New Files

| File | Description |
|------|-------------|
| `src/db/migrations/008_gh_browser_sessions.sql` | Browser sessions table with RLS + indexes |
| `src/db/migrations/009_hitl_columns.sql` | HITL columns on gh_automation_jobs |
| `src/sessions/SessionManager.ts` | Encrypted session load/save/clear/cleanup |
| `src/detection/BlockerDetector.ts` | DOM-based blocker detection (CAPTCHA, 2FA, login, bot check) |
| `__tests__/unit/sessions/SessionManager.test.ts` | Unit tests for SessionManager (domain extraction, CRUD, encryption round-trips) |
| `src/__tests__/hitl/BlockerDetector.test.ts` | Unit tests for BlockerDetector (all blocker types, confidence, priority) |

### Modified Files

| File | Change |
|------|--------|
| `src/adapters/types.ts` | Added `pause()`, `resume()`, `isPaused()`, `getBrowserSession()` to adapter interface; added `storageState` to `AdapterStartOptions` |
| `src/adapters/magnitude.ts` | Implemented pause/resume (delegates to agent), getBrowserSession (Playwright storageState) |
| `src/adapters/mock.ts` | Implemented pause/resume (boolean toggle) for testing |
| `src/workers/callbackNotifier.ts` | Added `notifyHumanNeeded()`, `notifyResumed()` methods; expanded status union |
| `src/workers/JobExecutor.ts` | Session load/save; HITL `requestHumanIntervention()` + Postgres LISTEN/NOTIFY for resume signals; polling fallback |
| `src/api/routes/valet.ts` | Added `POST /valet/resume/:jobId` endpoint |
| `src/api/schemas/valet.ts` | Added `ValetResumeSchema` and `ValetResumeInput` type |

---

## 8. Testing with curl

### Resume a Paused Job

```bash
curl -X POST https://your-gh-api/api/v1/gh/valet/resume/JOB_ID_HERE \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY" \
  -d '{
    "resolved_by": "human",
    "resolution_notes": "Solved the CAPTCHA"
  }'
```

### Check Status (Paused Job)

```bash
curl https://your-gh-api/api/v1/gh/valet/status/JOB_ID_HERE \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY"
```

---

## 9. Migration Checklist

- [ ] Apply `008_gh_browser_sessions.sql` to Supabase (requires DIRECT connection, not pooler)
- [ ] Apply `009_hitl_columns.sql` to Supabase
- [ ] Set `GH_CREDENTIAL_KEY` environment variable on all workers (64 hex chars)
- [ ] (Optional) Set `GH_CREDENTIAL_KEY_ID` if using non-default key ID
- [ ] Deploy updated API with new `/valet/resume/:jobId` route
- [ ] Deploy updated workers with SessionManager + HITL support

---

## 10. Known Limitations (Sprint 1)

1. **HITL resume is fire-and-forget:** When a job resumes after HITL intervention, the catch block in JobExecutor returns early. The job's final cost recording, session saving, and completion callback for the resumed portion are not executed. A future sprint will refactor the execute loop to support mid-execution resume properly.

2. **No cancel-via-resume:** The resume endpoint only supports resuming (not cancelling) a paused job. To cancel a paused job, use the existing job cancellation mechanism. A future sprint may add `action: "cancel"` support to the resume endpoint.

3. **Fixed HITL timeout:** The timeout for human intervention is currently hardcoded to 300 seconds (5 minutes). The status endpoint also returns a hardcoded `timeout_seconds: 300`. A future sprint may make this configurable per job.

4. **Blocker detection is DOM-only:** The `BlockerDetector` uses CSS selector patterns and text matching against the visible page. It does not analyze screenshots or use LLM reasoning. Some blockers that are only visible in screenshots (image-based CAPTCHAs without standard selectors) may not be detected.
