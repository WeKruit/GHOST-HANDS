# 12 - VALET-GhostHands Integration Architecture

> Defines how VALET's backend sends automation commands to GhostHands,
> tracks job status, stores results, and manages multi-user credentials.
> All GhostHands tables use the `gh_` prefix to coexist with VALET in a
> shared Supabase database.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Command Interface — Dual-Channel Design](#2-command-interface--dual-channel-design)
3. [Job Queue System — `gh_automation_jobs`](#3-job-queue-system--gh_automation_jobs)
4. [REST API Specification](#4-rest-api-specification)
5. [Storage Integration](#5-storage-integration)
6. [Multi-User Credential Management](#6-multi-user-credential-management)
7. [Webhook & Real-Time Events](#7-webhook--real-time-events)
8. [Database Migration SQL](#8-database-migration-sql)
9. [Sequence Diagrams](#9-sequence-diagrams)
10. [Error Handling & Retry Strategy](#10-error-handling--retry-strategy)
11. [Security Considerations](#11-security-considerations)
12. [Implementation Checklist](#12-implementation-checklist)

---

## 1. Overview

GhostHands is a self-learning browser automation agent built on Magnitude.
VALET is WeKruit's job application orchestration backend. They share:

- **Same Supabase instance** (Postgres + S3 Storage + Auth)
- **Same deployment environment** (can run in the same worker process or as separate services)
- **Same user model** — VALET's `users` table is the source of truth

GhostHands extends VALET with:
- ActionBook manuals (learned automation sequences)
- Browser agent execution (via Magnitude core)
- Screenshot/artifact capture
- Per-step result tracking

### Design Principles

1. **Database-first job queue** — jobs are rows in `gh_automation_jobs`; no external queue needed for MVP
2. **REST API as convenience layer** — the API writes to the same tables; either channel works
3. **Loose coupling** — VALET never imports GhostHands code; communication is via DB + REST
4. **Audit-complete** — every state transition is logged with timestamps and actor
5. **Idempotent operations** — job creation uses client-supplied idempotency keys

---

## 2. Command Interface — Dual-Channel Design

VALET can send commands to GhostHands via two channels. Both write to the same
`gh_automation_jobs` table, so downstream processing is identical.

### Channel 1: Database Job Queue (Primary)

VALET inserts a row into `gh_automation_jobs` directly. GhostHands polls or
listens via Postgres `NOTIFY` for new jobs.

```
VALET Backend                    Shared Supabase DB                GhostHands Worker
     |                                |                                |
     |-- INSERT gh_automation_jobs -->|                                |
     |                                |-- NOTIFY gh_job_created ------>|
     |                                |                                |-- Pick up job
     |                                |                                |-- UPDATE status='running'
     |                                |                                |-- Execute automation
     |                                |                                |-- UPDATE status='completed'
     |<-- Poll/subscribe status ------|                                |
```

**When to use:** Server-side VALET code (Node.js services, Hatchet workflows)
that already has a database connection.

### Channel 2: REST API (Convenience)

VALET calls GhostHands HTTP endpoints. The API validates the request and
inserts into the same `gh_automation_jobs` table.

```
VALET Backend                    GhostHands API                   Shared Supabase DB
     |                                |                                |
     |-- POST /api/v1/gh/jobs ------->|                                |
     |                                |-- INSERT gh_automation_jobs -->|
     |<-- 201 { jobId, status } ------|                                |
     |                                |                                |
     |-- GET /api/v1/gh/jobs/:id ---->|                                |
     |                                |-- SELECT ... ----------------->|
     |<-- 200 { job details } --------|                                |
```

**When to use:** External integrations, VALET frontend, or services without
direct DB access.

### Recommendation

Use **both**. The database channel is the source of truth. The REST API
provides validation, authentication, and a clean interface for the frontend.
The GhostHands worker only reads from the database — it doesn't care which
channel created the job.

---

## 3. Job Queue System — `gh_automation_jobs`

### 3.1 Table Schema

```sql
CREATE TABLE IF NOT EXISTS gh_automation_jobs (
    -- Identity
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) UNIQUE,  -- Client-supplied dedup key

    -- Ownership
    user_id         UUID NOT NULL,  -- References VALET users.id
    created_by      VARCHAR(100) NOT NULL DEFAULT 'valet',  -- 'valet', 'api', 'manual'

    -- Job specification
    job_type        VARCHAR(50) NOT NULL,  -- 'apply', 'scrape', 'fill_form', 'custom'
    target_url      TEXT NOT NULL,
    task_description TEXT NOT NULL,         -- Natural language: "Apply to SWE at Tesla"
    input_data      JSONB NOT NULL DEFAULT '{}',  -- Structured input (resume_id, user_data, etc.)

    -- Scheduling
    priority        INTEGER NOT NULL DEFAULT 5,  -- 1=highest, 10=lowest
    scheduled_at    TIMESTAMPTZ,                 -- NULL = run immediately
    max_retries     INTEGER NOT NULL DEFAULT 3,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER NOT NULL DEFAULT 300, -- 5 min default

    -- Status tracking
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- Valid: pending, queued, running, paused, completed, failed, cancelled, expired
    status_message  TEXT,           -- Human-readable status detail
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    last_heartbeat  TIMESTAMPTZ,   -- Worker pings every 30s to detect stuck jobs

    -- Execution context
    worker_id       VARCHAR(100),   -- Which worker instance picked this up
    manual_id       UUID,           -- gh_action_manuals.id if using a learned manual
    engine_type     VARCHAR(20),    -- 'magnitude', 'stagehand', 'manual_replay'

    -- Results
    result_data     JSONB,          -- Structured output (confirmation_id, extracted_data, etc.)
    result_summary  TEXT,           -- Human-readable: "Applied successfully, conf #12345"
    error_code      VARCHAR(50),    -- Structured error: 'captcha_blocked', 'login_required', etc.
    error_details   JSONB,          -- Stack trace, page state, etc.

    -- Artifacts
    screenshot_urls JSONB DEFAULT '[]',  -- Array of S3 URLs
    artifact_urls   JSONB DEFAULT '[]',  -- Resumes, filled forms, etc.

    -- Metadata
    metadata        JSONB DEFAULT '{}',  -- Arbitrary k/v for extensibility
    tags            JSONB DEFAULT '[]',  -- ['greenhouse', 'swe', 'urgent']

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.2 Status State Machine

```
                   ┌──────────────────────────────────────┐
                   │                                      │
                   v                                      │
pending ──> queued ──> running ──> completed               │
              │          │                                 │
              │          ├──> paused ──> running            │
              │          │                                 │
              │          ├──> failed ───> queued (retry)────┘
              │          │
              │          └──> cancelled
              │
              └──> expired (if scheduled_at + timeout passed)
```

**Transition Rules:**
- `pending -> queued`: Worker acknowledges job (sets worker_id)
- `queued -> running`: Worker starts execution (sets started_at)
- `running -> completed`: Successful finish (sets completed_at, result_data)
- `running -> failed`: Error occurred (sets error_code, error_details)
- `failed -> queued`: Automatic retry if retry_count < max_retries
- `running -> paused`: Human intervention needed (CAPTCHA, review)
- `paused -> running`: Human resolved the intervention
- `* -> cancelled`: User or VALET cancels the job
- `pending -> expired`: scheduled_at + timeout_seconds elapsed without pickup

### 3.3 Indexes

```sql
-- Primary query: find jobs to process
CREATE INDEX idx_gh_jobs_status_priority
    ON gh_automation_jobs(status, priority ASC, created_at ASC)
    WHERE status IN ('pending', 'queued');

-- User's job history
CREATE INDEX idx_gh_jobs_user_status
    ON gh_automation_jobs(user_id, status, created_at DESC);

-- Idempotency check
-- (covered by UNIQUE constraint on idempotency_key)

-- Heartbeat monitoring (find stuck running jobs)
CREATE INDEX idx_gh_jobs_heartbeat
    ON gh_automation_jobs(last_heartbeat)
    WHERE status = 'running';

-- Scheduled jobs
CREATE INDEX idx_gh_jobs_scheduled
    ON gh_automation_jobs(scheduled_at)
    WHERE status = 'pending' AND scheduled_at IS NOT NULL;

-- Manual lookup (which manual was used)
CREATE INDEX idx_gh_jobs_manual
    ON gh_automation_jobs(manual_id)
    WHERE manual_id IS NOT NULL;
```

### 3.4 Job Event Log — `gh_job_events`

Every state transition and significant event is logged for audit and debugging.

```sql
CREATE TABLE IF NOT EXISTS gh_job_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES gh_automation_jobs(id) ON DELETE CASCADE,
    event_type  VARCHAR(50) NOT NULL,
    -- Types: 'status_change', 'screenshot', 'manual_match', 'manual_miss',
    --        'retry', 'heartbeat', 'error', 'artifact_saved', 'human_intervention',
    --        'step_completed', 'step_failed'
    from_status VARCHAR(20),
    to_status   VARCHAR(20),
    message     TEXT,
    metadata    JSONB DEFAULT '{}',
    actor       VARCHAR(100) NOT NULL DEFAULT 'system',  -- 'system', 'worker', 'user', 'valet'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gh_job_events_job ON gh_job_events(job_id, created_at ASC);
CREATE INDEX idx_gh_job_events_type ON gh_job_events(job_id, event_type);
```

### 3.5 Worker Polling Query

```sql
-- Atomic job pickup: claims the highest-priority unclaimed job
WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE gh_automation_jobs
SET status = 'queued',
    worker_id = $1,
    updated_at = NOW()
FROM next_job
WHERE gh_automation_jobs.id = next_job.id
RETURNING gh_automation_jobs.*;
```

This uses `FOR UPDATE SKIP LOCKED` so multiple workers can safely poll
concurrently without contention.

### 3.6 Postgres NOTIFY for Real-Time Pickup

```sql
-- Trigger function to notify workers of new jobs
CREATE OR REPLACE FUNCTION gh_notify_new_job()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('gh_job_created', json_build_object(
        'id', NEW.id,
        'job_type', NEW.job_type,
        'priority', NEW.priority,
        'user_id', NEW.user_id
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gh_automation_jobs_notify
    AFTER INSERT ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION gh_notify_new_job();
```

Workers subscribe to the `gh_job_created` channel on the **direct** connection
(not the pooler — pgbouncer doesn't support LISTEN/NOTIFY).

---

## 4. REST API Specification

Base URL: `/api/v1/gh`

Authentication: Bearer token (Supabase JWT or GhostHands API key).

### 4.1 Create Job

```
POST /api/v1/gh/jobs
```

**Request:**
```json
{
  "idempotency_key": "valet-task-550e8400-apply",
  "job_type": "apply",
  "target_url": "https://boards.greenhouse.io/tesla/jobs/12345",
  "task_description": "Apply to Software Engineer position at Tesla",
  "input_data": {
    "resume_id": "uuid-of-resume",
    "user_data": {
      "first_name": "Jane",
      "last_name": "Doe",
      "email": "jane@example.com",
      "phone": "+1-555-0100",
      "linkedin_url": "https://linkedin.com/in/janedoe"
    },
    "qa_overrides": {
      "Are you authorized to work in the US?": "Yes",
      "Desired salary": "150000"
    }
  },
  "priority": 3,
  "scheduled_at": null,
  "max_retries": 3,
  "timeout_seconds": 300,
  "tags": ["greenhouse", "swe", "tesla"],
  "metadata": {
    "valet_task_id": "550e8400-e29b-41d4-a716-446655440000",
    "subscription_tier": "pro"
  }
}
```

**Response (201 Created):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pending",
  "created_at": "2026-02-14T10:30:00Z",
  "estimated_start": "2026-02-14T10:30:05Z"
}
```

**Response (409 Conflict — duplicate idempotency_key):**
```json
{
  "error": "duplicate_idempotency_key",
  "existing_job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "existing_status": "running"
}
```

### 4.2 Get Job

```
GET /api/v1/gh/jobs/:id
```

**Response (200):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "job_type": "apply",
  "target_url": "https://boards.greenhouse.io/tesla/jobs/12345",
  "task_description": "Apply to Software Engineer position at Tesla",
  "status": "completed",
  "status_message": "Application submitted successfully",
  "priority": 3,
  "retry_count": 0,
  "max_retries": 3,
  "worker_id": "worker-us-east-1a",
  "engine_type": "manual_replay",
  "manual_id": "manual-uuid-for-greenhouse-apply",
  "result_data": {
    "confirmation_id": "GH-2026-78901",
    "submitted_at": "2026-02-14T10:32:15Z",
    "fields_filled": 12,
    "llm_calls": 0,
    "manual_used": true
  },
  "result_summary": "Applied successfully. Confirmation: GH-2026-78901",
  "screenshot_urls": [
    "https://unistzvhgvgjyzotwzxr.storage.supabase.co/storage/v1/object/public/screenshots/jobs/a1b2c3d4/final.png"
  ],
  "artifact_urls": [],
  "tags": ["greenhouse", "swe", "tesla"],
  "started_at": "2026-02-14T10:30:05Z",
  "completed_at": "2026-02-14T10:32:15Z",
  "created_at": "2026-02-14T10:30:00Z"
}
```

### 4.3 Get Job Status (Lightweight)

```
GET /api/v1/gh/jobs/:id/status
```

**Response (200):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "running",
  "status_message": "Filling form fields (7/12)",
  "progress_pct": 58,
  "started_at": "2026-02-14T10:30:05Z",
  "last_heartbeat": "2026-02-14T10:31:45Z",
  "estimated_completion": "2026-02-14T10:33:00Z"
}
```

### 4.4 Cancel Job

```
POST /api/v1/gh/jobs/:id/cancel
```

**Response (200):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "cancelled",
  "cancelled_at": "2026-02-14T10:31:00Z"
}
```

**Response (409 — job already completed):**
```json
{
  "error": "job_not_cancellable",
  "current_status": "completed"
}
```

### 4.5 List Jobs

```
GET /api/v1/gh/jobs?user_id=<uuid>&status=running,pending&limit=20&offset=0
```

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `user_id` | UUID | required | Filter by user |
| `status` | string (csv) | all | Filter by status(es) |
| `job_type` | string | all | Filter by job type |
| `limit` | int | 20 | Page size (max 100) |
| `offset` | int | 0 | Pagination offset |
| `sort` | string | `created_at:desc` | Sort field and direction |

**Response (200):**
```json
{
  "jobs": [ ... ],
  "total": 47,
  "limit": 20,
  "offset": 0
}
```

### 4.6 Get Job Events

```
GET /api/v1/gh/jobs/:id/events?limit=50
```

**Response (200):**
```json
{
  "events": [
    {
      "id": "evt-uuid",
      "event_type": "status_change",
      "from_status": "pending",
      "to_status": "queued",
      "message": "Job picked up by worker-us-east-1a",
      "actor": "worker",
      "created_at": "2026-02-14T10:30:05Z"
    },
    {
      "id": "evt-uuid-2",
      "event_type": "manual_match",
      "message": "Found manual for greenhouse.io/apply with health_score 95.2",
      "metadata": { "manual_id": "manual-uuid", "health_score": 95.2 },
      "actor": "system",
      "created_at": "2026-02-14T10:30:06Z"
    },
    {
      "id": "evt-uuid-3",
      "event_type": "step_completed",
      "message": "Filled 'First Name' field",
      "metadata": { "field": "first_name", "method": "manual_replay" },
      "actor": "worker",
      "created_at": "2026-02-14T10:30:08Z"
    }
  ],
  "total": 15
}
```

### 4.7 Retry Job

```
POST /api/v1/gh/jobs/:id/retry
```

Only valid for jobs with status `failed` or `cancelled`. Resets status to
`pending` and increments `retry_count`.

**Response (200):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pending",
  "retry_count": 1
}
```

### 4.8 Bulk Create Jobs

```
POST /api/v1/gh/jobs/batch
```

**Request:**
```json
{
  "jobs": [
    { "job_type": "apply", "target_url": "...", "task_description": "...", "input_data": {} },
    { "job_type": "apply", "target_url": "...", "task_description": "...", "input_data": {} }
  ],
  "defaults": {
    "priority": 5,
    "max_retries": 3,
    "timeout_seconds": 300,
    "tags": ["batch-2026-02-14"]
  }
}
```

**Response (201):**
```json
{
  "created": 2,
  "job_ids": ["uuid-1", "uuid-2"]
}
```

---

## 5. Storage Integration

### 5.1 S3 Bucket Structure

GhostHands uses the shared Supabase S3 storage. Paths are namespaced to
avoid conflicts with VALET.

```
screenshots/
  gh/
    jobs/
      {job_id}/
        step-001-navigate.png
        step-002-form-detected.png
        step-003-fields-filled.png
        final-confirmation.png

artifacts/
  gh/
    jobs/
      {job_id}/
        filled-form-snapshot.html
        extracted-data.json
    manuals/
      {manual_id}/
        steps.json

resumes/
  (shared with VALET — no gh/ prefix needed)
  {user_id}/
    {resume_id}.pdf
```

### 5.2 Screenshot Upload Flow

```typescript
// Worker uploads screenshot during job execution
async function uploadScreenshot(
  jobId: string,
  stepName: string,
  screenshotBuffer: Buffer
): Promise<string> {
  const path = `gh/jobs/${jobId}/${stepName}.png`;
  const { data, error } = await supabase.storage
    .from('screenshots')
    .upload(path, screenshotBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) throw error;

  const { data: { publicUrl } } = supabase.storage
    .from('screenshots')
    .getPublicUrl(path);

  return publicUrl;
}
```

### 5.3 Result Storage Pattern

Job results are stored in two places:
1. **`gh_automation_jobs.result_data`** — structured JSON for programmatic access
2. **S3 artifacts** — large files (HTML snapshots, extracted CSVs)

```typescript
// Example result_data for a successful application
{
  "confirmation_id": "GH-2026-78901",
  "submitted_at": "2026-02-14T10:32:15Z",
  "fields_filled": 12,
  "fields_skipped": 0,
  "llm_calls": 0,        // 0 when using manual replay
  "manual_used": true,
  "manual_id": "uuid",
  "cost_usd": 0.0005,
  "duration_ms": 130000,
  "engine_switches": 0,
  "extracted_data": {
    "job_title": "Software Engineer",
    "company": "Tesla",
    "location": "Austin, TX"
  }
}

// Example result_data for a failed job
{
  "last_step": "fill_form",
  "fields_filled": 7,
  "fields_remaining": 5,
  "error_at_field": "resume_upload",
  "page_url": "https://boards.greenhouse.io/tesla/jobs/12345/apply#step2"
}
```

---

## 6. Multi-User Credential Management

### 6.1 Architecture

User credentials (login cookies, platform tokens) are stored encrypted in the
database. GhostHands never stores plaintext credentials on disk.

```sql
CREATE TABLE IF NOT EXISTS gh_user_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,  -- References VALET users.id
    platform        VARCHAR(50) NOT NULL,  -- 'linkedin', 'greenhouse', 'lever', 'workday'
    credential_type VARCHAR(30) NOT NULL,  -- 'cookies', 'oauth_token', 'session_state'

    -- Encrypted storage
    encrypted_data  BYTEA NOT NULL,        -- AES-256-GCM encrypted JSON
    encryption_key_id VARCHAR(100) NOT NULL, -- Key ID for rotation

    -- Metadata
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    is_valid        BOOLEAN DEFAULT true,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, platform, credential_type)
);

CREATE INDEX idx_gh_creds_user_platform
    ON gh_user_credentials(user_id, platform)
    WHERE is_valid = true;
```

### 6.2 Credential Lifecycle

```
User logs into platform via VALET UI
    |
    v
VALET captures cookies/tokens
    |
    v
Encrypt with AES-256-GCM (key from env: GH_ENCRYPTION_KEY)
    |
    v
Store in gh_user_credentials
    |
    v
GhostHands worker loads credentials for job
    |
    v
Decrypt in-memory, inject into browser context
    |
    v
After job: update last_used_at, re-capture if cookies changed
    |
    v
If login fails: mark is_valid=false, trigger re-auth notification
```

### 6.3 Encryption Implementation

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function encrypt(data: object, key: Buffer): { encrypted: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const jsonStr = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as: iv (16) + tag (16) + encrypted
  return { encrypted: Buffer.concat([iv, tag, encrypted]), iv, tag };
}

function decrypt(encryptedData: Buffer, key: Buffer): object {
  const iv = encryptedData.subarray(0, 16);
  const tag = encryptedData.subarray(16, 32);
  const data = encryptedData.subarray(32);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}
```

### 6.4 Multi-User Job Isolation

Each job runs in its own browser context. Credentials are loaded per-job:

```typescript
async function prepareJobContext(job: AutomationJob): Promise<BrowserContext> {
  // 1. Load user's credentials for this platform
  const creds = await loadCredentials(job.user_id, detectPlatform(job.target_url));

  // 2. Create isolated browser context
  const context = await browser.newContext({
    // No shared state between users
    storageState: creds ? {
      cookies: creds.cookies,
      origins: creds.localStorage || [],
    } : undefined,
  });

  return context;
}
```

---

## 7. Webhook & Real-Time Events

### 7.1 Supabase Realtime (Primary)

VALET subscribes to job status changes via Supabase Realtime:

```typescript
// VALET frontend subscribes to job updates
const subscription = supabase
  .channel('gh-job-updates')
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'gh_automation_jobs',
      filter: `user_id=eq.${userId}`,
    },
    (payload) => {
      const { new: job } = payload;
      updateJobUI(job.id, job.status, job.status_message);
    }
  )
  .subscribe();
```

### 7.2 Webhook Callbacks (Optional)

For server-to-server notifications, VALET can register a webhook URL per job:

```json
{
  "metadata": {
    "webhook_url": "https://valet.wekruit.com/webhooks/gh-job-completed",
    "webhook_events": ["completed", "failed"],
    "webhook_secret": "whsec_..."
  }
}
```

GhostHands sends a POST to the webhook URL on matching events:

```json
{
  "event": "job.completed",
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "result_summary": "Applied successfully. Confirmation: GH-2026-78901",
  "timestamp": "2026-02-14T10:32:15Z",
  "signature": "sha256=..."
}
```

---

## 8. Database Migration SQL

Complete migration for all GhostHands integration tables. Run after the
existing `supabase-migration.sql` (which creates `gh_action_manuals`).

```sql
-- ============================================================================
-- GhostHands VALET Integration Tables
-- ============================================================================
-- Run in: Supabase SQL Editor (requires DIRECT connection, not pooler)
-- Prerequisite: gh_action_manuals table already exists
-- ============================================================================

-- ─── Automation Jobs Queue ───

CREATE TABLE IF NOT EXISTS gh_automation_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) UNIQUE,
    user_id         UUID NOT NULL,
    created_by      VARCHAR(100) NOT NULL DEFAULT 'valet',
    job_type        VARCHAR(50) NOT NULL,
    target_url      TEXT NOT NULL,
    task_description TEXT NOT NULL,
    input_data      JSONB NOT NULL DEFAULT '{}',
    priority        INTEGER NOT NULL DEFAULT 5,
    scheduled_at    TIMESTAMPTZ,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER NOT NULL DEFAULT 300,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    status_message  TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    last_heartbeat  TIMESTAMPTZ,
    worker_id       VARCHAR(100),
    manual_id       UUID REFERENCES gh_action_manuals(id),
    engine_type     VARCHAR(20),
    result_data     JSONB,
    result_summary  TEXT,
    error_code      VARCHAR(50),
    error_details   JSONB,
    screenshot_urls JSONB DEFAULT '[]',
    artifact_urls   JSONB DEFAULT '[]',
    metadata        JSONB DEFAULT '{}',
    tags            JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_gh_jobs_status_priority
    ON gh_automation_jobs(status, priority ASC, created_at ASC)
    WHERE status IN ('pending', 'queued');

CREATE INDEX IF NOT EXISTS idx_gh_jobs_user_status
    ON gh_automation_jobs(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_jobs_heartbeat
    ON gh_automation_jobs(last_heartbeat)
    WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_gh_jobs_scheduled
    ON gh_automation_jobs(scheduled_at)
    WHERE status = 'pending' AND scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gh_jobs_manual
    ON gh_automation_jobs(manual_id)
    WHERE manual_id IS NOT NULL;

-- RLS
ALTER TABLE gh_automation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own jobs"
    ON gh_automation_jobs FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Service role full access to jobs"
    ON gh_automation_jobs FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- ─── Job Events Log ───

CREATE TABLE IF NOT EXISTS gh_job_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES gh_automation_jobs(id) ON DELETE CASCADE,
    event_type  VARCHAR(50) NOT NULL,
    from_status VARCHAR(20),
    to_status   VARCHAR(20),
    message     TEXT,
    metadata    JSONB DEFAULT '{}',
    actor       VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gh_job_events_job
    ON gh_job_events(job_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_gh_job_events_type
    ON gh_job_events(job_id, event_type);

ALTER TABLE gh_job_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view events for own jobs"
    ON gh_job_events FOR SELECT
    TO authenticated
    USING (job_id IN (
        SELECT id FROM gh_automation_jobs WHERE user_id = auth.uid()
    ));

CREATE POLICY "Service role full access to events"
    ON gh_job_events FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- ─── User Credentials (Encrypted) ───

CREATE TABLE IF NOT EXISTS gh_user_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    platform        VARCHAR(50) NOT NULL,
    credential_type VARCHAR(30) NOT NULL,
    encrypted_data  BYTEA NOT NULL,
    encryption_key_id VARCHAR(100) NOT NULL,
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    is_valid        BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, platform, credential_type)
);

CREATE INDEX IF NOT EXISTS idx_gh_creds_user_platform
    ON gh_user_credentials(user_id, platform)
    WHERE is_valid = true;

ALTER TABLE gh_user_credentials ENABLE ROW LEVEL SECURITY;

-- Only service role can access credentials (never exposed to client)
CREATE POLICY "Service role only for credentials"
    ON gh_user_credentials FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- ─── Updated_at Triggers ───

-- Reuse the function from the first migration if it exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_gh_automation_jobs_updated_at ON gh_automation_jobs;
CREATE TRIGGER update_gh_automation_jobs_updated_at
    BEFORE UPDATE ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_gh_user_credentials_updated_at ON gh_user_credentials;
CREATE TRIGGER update_gh_user_credentials_updated_at
    BEFORE UPDATE ON gh_user_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ─── Postgres NOTIFY for Real-Time Job Pickup ───

CREATE OR REPLACE FUNCTION gh_notify_new_job()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('gh_job_created', json_build_object(
        'id', NEW.id,
        'job_type', NEW.job_type,
        'priority', NEW.priority,
        'user_id', NEW.user_id
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gh_automation_jobs_notify ON gh_automation_jobs;
CREATE TRIGGER gh_automation_jobs_notify
    AFTER INSERT ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION gh_notify_new_job();

-- ─── Status Change Event Logging Trigger ───

CREATE OR REPLACE FUNCTION gh_log_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO gh_job_events (job_id, event_type, from_status, to_status, message, actor)
        VALUES (
            NEW.id,
            'status_change',
            OLD.status,
            NEW.status,
            'Status changed from ' || OLD.status || ' to ' || NEW.status,
            COALESCE(NEW.worker_id, 'system')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gh_automation_jobs_log_status ON gh_automation_jobs;
CREATE TRIGGER gh_automation_jobs_log_status
    AFTER UPDATE OF status ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION gh_log_status_change();

-- ─── Enable Supabase Realtime ───

ALTER PUBLICATION supabase_realtime ADD TABLE gh_automation_jobs;

-- ─── Verification ───

DO $$
BEGIN
    RAISE NOTICE 'VALET-GhostHands integration migration complete!';
    RAISE NOTICE '  Tables: gh_automation_jobs, gh_job_events, gh_user_credentials';
    RAISE NOTICE '  Triggers: notify, updated_at, status logging';
    RAISE NOTICE '  RLS: enabled on all tables';
    RAISE NOTICE '  Realtime: gh_automation_jobs added to publication';
END $$;
```

---

## 9. Sequence Diagrams

### 9.1 Happy Path — Job Application with Manual Replay

```
VALET                  GhostHands API        DB                    Worker
  |                        |                  |                      |
  |-- POST /gh/jobs ------>|                  |                      |
  |                        |-- INSERT ------->|                      |
  |<-- 201 {jobId} --------|                  |                      |
  |                        |                  |-- NOTIFY ----------->|
  |                        |                  |                      |
  |                        |                  |<-- UPDATE queued ----|
  |                        |                  |                      |
  |                        |                  |                      |-- Load credentials
  |                        |                  |                      |-- Create browser ctx
  |                        |                  |<-- UPDATE running ---|
  |                        |                  |                      |
  |                        |                  |                      |-- manual:lookup
  |                        |                  |                      |   Found! health=95
  |                        |                  |                      |
  |                        |                  |                      |-- manual:execute
  |                        |                  |                      |   (0 LLM calls)
  |                        |                  |                      |
  |                        |                  |                      |-- Upload screenshot
  |                        |                  |<-- UPDATE completed -|
  |                        |                  |                      |
  |<-- Realtime update ----|                  |                      |
  |    status=completed    |                  |                      |
```

### 9.2 First-Time Exploration (No Manual)

```
Worker                    Browser              ManualConnector       DB
  |                         |                      |                  |
  |-- manual:lookup ------->|                      |                  |
  |<-- NOT FOUND -----------|                      |                  |
  |                         |                      |                  |
  |-- Navigate to URL ----->|                      |                  |
  |                         |                      |                  |
  |-- Agent LLM loop: ----->|                      |                  |
  |   observe -> act ------>|                      |                  |
  |   observe -> act ------>|                      |                  |
  |   ... (5-10 LLM calls)  |                      |                  |
  |                         |                      |                  |
  |-- Task complete ------->|                      |                  |
  |                         |                      |                  |
  |-- manual:save --------->|                      |                  |
  |                         |-- INSERT manual ---->|                  |
  |                         |                      |-- to DB -------->|
  |                         |                      |                  |
  |-- UPDATE job completed--|                      |                  |
```

### 9.3 Failed Job with Retry

```
Worker                    Browser              DB
  |                         |                   |
  |-- Execute job --------->|                   |
  |                         |-- CAPTCHA! ------>|
  |                         |                   |
  |-- UPDATE paused ------->|                   |
  |                         |                   |
  |  ... wait for human ... |                   |
  |  ... timeout (5 min) ...|                   |
  |                         |                   |
  |-- UPDATE failed ------->|                   |
  |   error_code='captcha'  |                   |
  |   retry_count++ ------->|                   |
  |                         |                   |
  |-- Check: retries < max  |                   |
  |-- UPDATE pending ------>|  (re-queue)       |
  |                         |                   |
  |-- (picks up again) ---->|                   |
  |-- Different proxy ----->|                   |
  |-- Succeeds! ----------->|                   |
  |-- UPDATE completed ---->|                   |
```

---

## 10. Error Handling & Retry Strategy

### 10.1 Error Codes

| Code | Description | Retryable | Action |
|------|-------------|-----------|--------|
| `captcha_blocked` | CAPTCHA detected, couldn't solve | Yes | Retry with different proxy |
| `login_required` | Session expired, need re-auth | No | Mark creds invalid, notify user |
| `element_not_found` | Expected form element missing | Yes | Retry; if repeated, invalidate manual |
| `page_changed` | Page structure changed significantly | Yes | Invalidate manual, explore mode |
| `timeout` | Operation exceeded timeout | Yes | Retry with increased timeout |
| `rate_limited` | Target site rate limiting | Yes | Retry with delay (exponential backoff) |
| `anti_bot_detected` | Bot detection triggered | No | Switch to higher-tier provider |
| `upload_failed` | Resume upload failed | Yes | Retry upload step only |
| `network_error` | Connection lost to browser | Yes | Reconnect and retry |
| `internal_error` | Unexpected GhostHands error | Yes | Retry; alert if persistent |

### 10.2 Retry Policy

```typescript
interface RetryPolicy {
  maxRetries: 3;
  backoff: {
    type: 'exponential';
    initialDelayMs: 5000;    // 5 seconds
    maxDelayMs: 300000;      // 5 minutes
    multiplier: 2;
    jitter: true;            // +/- 20% random jitter
  };
  retryableErrors: [
    'captcha_blocked',
    'element_not_found',
    'page_changed',
    'timeout',
    'rate_limited',
    'upload_failed',
    'network_error',
    'internal_error',
  ];
  nonRetryableErrors: [
    'login_required',
    'anti_bot_detected',
  ];
}
```

### 10.3 Stuck Job Detection

A background process checks for jobs whose `last_heartbeat` is stale:

```sql
-- Find stuck jobs (no heartbeat for 2 minutes)
UPDATE gh_automation_jobs
SET status = 'failed',
    error_code = 'worker_timeout',
    error_details = jsonb_build_object(
        'last_heartbeat', last_heartbeat,
        'detected_at', NOW()
    ),
    updated_at = NOW()
WHERE status = 'running'
  AND last_heartbeat < NOW() - INTERVAL '2 minutes';
```

---

## 11. Security Considerations

### 11.1 Authentication

- **VALET-to-GhostHands API**: Service-to-service JWT signed with shared secret (`GH_SERVICE_SECRET` env var). No user interaction required.
- **Frontend-to-GhostHands API**: Supabase JWT from authenticated session. RLS enforces user_id scoping.
- **Worker-to-DB**: Service role key (full access, bypasses RLS).

### 11.2 Authorization

| Actor | Can Create Jobs | Can View Jobs | Can Cancel | Can View Credentials |
|-------|----------------|---------------|------------|---------------------|
| User (via frontend) | Own jobs only | Own jobs only | Own jobs only | Never |
| VALET service | Any user | Any user | Any user | Via service role |
| GhostHands worker | N/A | All (service role) | N/A | Decrypt for job execution |

### 11.3 Credential Security

1. **Encryption at rest**: AES-256-GCM with key from environment variable
2. **No credential logging**: All log output strips credential fields
3. **Key rotation**: `encryption_key_id` column supports rolling to new keys
4. **Browser isolation**: Each job gets its own browser context (no cross-user leakage)
5. **Memory cleanup**: Decrypted credentials are zeroed after browser context is created

### 11.4 Input Validation

All API inputs are validated with Zod schemas before database insertion:

```typescript
const CreateJobSchema = z.object({
  job_type: z.enum(['apply', 'scrape', 'fill_form', 'custom']),
  target_url: z.string().url().max(2048),
  task_description: z.string().min(1).max(1000),
  input_data: z.record(z.unknown()).default({}),
  priority: z.number().int().min(1).max(10).default(5),
  max_retries: z.number().int().min(0).max(10).default(3),
  timeout_seconds: z.number().int().min(30).max(1800).default(300),
  tags: z.array(z.string().max(50)).max(20).default([]),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).default({}),
});
```

---

## 12. Implementation Checklist

### Phase 1: Core Job Queue (Week 1)

- [ ] Run integration migration SQL
- [ ] Create `gh_automation_jobs` table with all indexes and triggers
- [ ] Create `gh_job_events` table
- [ ] Implement worker polling with `FOR UPDATE SKIP LOCKED`
- [ ] Implement Postgres NOTIFY listener for real-time pickup
- [ ] Implement heartbeat mechanism (worker pings every 30s)
- [ ] Implement stuck job detection background process
- [ ] Write unit tests for job state machine transitions

### Phase 2: REST API (Week 1-2)

- [ ] Implement `POST /api/v1/gh/jobs` with Zod validation
- [ ] Implement `GET /api/v1/gh/jobs/:id`
- [ ] Implement `GET /api/v1/gh/jobs/:id/status`
- [ ] Implement `POST /api/v1/gh/jobs/:id/cancel`
- [ ] Implement `GET /api/v1/gh/jobs` (list with filters)
- [ ] Implement `GET /api/v1/gh/jobs/:id/events`
- [ ] Implement `POST /api/v1/gh/jobs/:id/retry`
- [ ] Implement `POST /api/v1/gh/jobs/batch`
- [ ] Add authentication middleware (JWT validation)
- [ ] Write API integration tests

### Phase 3: Storage & Credentials (Week 2)

- [ ] Create `gh_user_credentials` table
- [ ] Implement AES-256-GCM encryption/decryption utilities
- [ ] Implement credential CRUD with encryption
- [ ] Implement screenshot upload to S3 `gh/` prefix
- [ ] Implement artifact upload to S3 `gh/` prefix
- [ ] Test credential isolation between users
- [ ] Test S3 path namespacing

### Phase 4: Integration with Magnitude Agent (Week 2-3)

- [ ] Wire job pickup to Magnitude BrowserAgent.act()
- [ ] Integrate ManualConnector lookup/execute/save with job lifecycle
- [ ] Map job events to gh_job_events rows
- [ ] Implement result_data population on completion
- [ ] Implement error_code mapping on failure
- [ ] End-to-end test: VALET creates job -> GhostHands executes -> result stored

### Phase 5: Real-Time & Webhooks (Week 3)

- [ ] Enable Supabase Realtime on gh_automation_jobs
- [ ] Test frontend subscription to job updates
- [ ] Implement webhook delivery for configured URLs
- [ ] Implement webhook signature verification
- [ ] Load test with 50 concurrent jobs

---

*Last updated: 2026-02-14*

*Depends on:*
- [supabase-migration.sql](../supabase-migration.sql) — Base GhostHands table (gh_action_manuals)
- [01-shared-interfaces.md](./01-shared-interfaces.md) — System interfaces
- [08-comprehensive-integration-plan.md](./08-comprehensive-integration-plan.md) — VALET architecture

*Consumed by: Worker implementation, API route implementation, frontend job dashboard*
