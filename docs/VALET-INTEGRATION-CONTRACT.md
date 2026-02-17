# VALET Integration Contract — Comprehensive Reference

**Date:** 2026-02-17
**Covers:** Sprints 1-5 (all GhostHands capabilities)
**Status:** Active
**Breaking Changes:** None (all additive, backward compatible)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication](#2-authentication)
3. [Job Lifecycle](#3-job-lifecycle)
4. [API Endpoints](#4-api-endpoints)
5. [Callback System (Push Notifications)](#5-callback-system-push-notifications)
6. [Real-Time Subscriptions](#6-real-time-subscriptions)
7. [Database Schema](#7-database-schema)
8. [Execution Modes & Cost Tracking](#8-execution-modes--cost-tracking)
9. [Session Management](#9-session-management)
10. [HITL (Human-in-the-Loop)](#10-hitl-human-in-the-loop)
11. [UI Visualization Guide](#11-ui-visualization-guide)
12. [Job Management (Cancel, Retry, Events)](#12-job-management-cancel-retry-events)
13. [Monitoring & Health](#13-monitoring--health)
14. [Worker Fleet & Deployment](#14-worker-fleet--deployment)
15. [Error Codes & Retry Logic](#15-error-codes--retry-logic)
16. [Migration Checklist](#16-migration-checklist)
17. [curl Examples](#17-curl-examples)
18. [Known Limitations](#18-known-limitations)

---

## 1. Overview

GhostHands is a browser automation service that executes jobs (apply to jobs, fill forms, scrape data) on behalf of VALET users. VALET submits jobs via REST API and receives results via:

1. **Callbacks (push):** GhostHands POSTs to `callback_url` on every status change
2. **Polling (pull):** VALET calls `GET /valet/status/:jobId`
3. **Real-time (stream):** Supabase Realtime subscriptions on `gh_automation_jobs` and `gh_job_events`

### Architecture

```
VALET Frontend ←→ VALET Backend ←→ GhostHands API ←→ GhostHands Workers
                                        ↑                    ↓
                                   Supabase DB ←──── Browser Automation
                                   (shared)          (Magnitude + Stagehand)
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Cookbook Mode** | Replay a saved manual (deterministic steps, near-zero LLM cost) |
| **Magnitude Mode** | Full AI agent exploration (LLM-driven, ~$0.02/job) |
| **Hybrid Mode** | Started cookbook, fell back to AI Agent mid-execution |
| **Manual** | Saved step-by-step playbook for a specific ATS platform + task |
| **HITL** | Human-in-the-loop — job pauses when it hits a blocker (CAPTCHA, login, etc.) |
| **Session** | Encrypted browser cookies/localStorage stored per user+domain |

---

## 2. Authentication

All endpoints require the `X-GH-Service-Key` header:

```
X-GH-Service-Key: <service_key>
```

The service key is a shared secret between VALET and GhostHands backends. It is NOT a user token — it authenticates the VALET service itself.

**Base URL:** `https://<gh-host>/api/v1/gh`

---

## 3. Job Lifecycle

```
                    ┌─────────────────────────────────────────────────┐
                    │                                                 │
   VALET creates    │                                                 │
   ┌────────┐  ┌───▼────┐  ┌─────────┐  ┌──────────┐  ┌───────────┐ │
   │ submit │→ │pending │→ │ running │→ │completed │  │  failed   │ │
   └────────┘  └───┬────┘  └────┬────┘  └──────────┘  └───────────┘ │
                   │            │                                     │
                   │            ├──→ paused ──→ running ──────────────┘
                   │            │    (HITL)     (resumed)
                   │            │
                   │            └──→ failed (error/timeout)
                   │
                   └──→ cancelled (by user)
```

### Status Values

| Status | Description | Callback Sent? |
|--------|-------------|----------------|
| `pending` | In queue, waiting for a worker | No |
| `running` | Worker picked up, executing | **Yes** (`running`) |
| `paused` | Blocked, waiting for human | **Yes** (`needs_human`) |
| `completed` | Finished successfully | **Yes** (`completed`) |
| `failed` | Failed after all retries | **Yes** (`failed`) |
| `cancelled` | Cancelled by user/system | No |
| `expired` | Timed out in queue | No |

---

## 4. API Endpoints

### 4.1 Create Job — `POST /valet/apply`

Rich application request with full profile data.

**Request:**

```json
{
  "valet_task_id": "valet-456",
  "valet_user_id": "00000000-0000-0000-0000-000000000001",
  "target_url": "https://boards.greenhouse.io/acme/jobs/123",
  "platform": "greenhouse",
  "callback_url": "https://valet.example.com/webhook/gh",
  "profile": {
    "first_name": "Alice",
    "last_name": "Smith",
    "email": "alice@example.com",
    "phone": "+1-555-0100",
    "linkedin_url": "https://linkedin.com/in/alicesmith",
    "portfolio_url": "https://alicesmith.dev",
    "location": {
      "city": "San Francisco",
      "state": "CA",
      "country": "US",
      "zip": "94102"
    },
    "work_authorization": "US Citizen",
    "salary_expectation": "$150,000-$180,000",
    "years_of_experience": 8,
    "education": [
      {
        "institution": "MIT",
        "degree": "BS",
        "field": "Computer Science",
        "graduation_year": 2018
      }
    ],
    "work_history": [
      {
        "company": "Google",
        "title": "Senior Engineer",
        "start_date": "2020-01",
        "end_date": "2025-12",
        "description": "Led frontend team for Search"
      }
    ],
    "skills": ["TypeScript", "React", "Node.js"]
  },
  "resume": {
    "storage_path": "resumes/alice-smith-2026.pdf"
  },
  "qa_answers": {
    "Are you authorized to work in the US?": "Yes",
    "How many years of React experience?": "6"
  },
  "quality": "balanced",
  "model": "qwen-72b",
  "image_model": "qwen-7b",
  "execution_mode": "auto",
  "priority": 5,
  "timeout_seconds": 300,
  "idempotency_key": "valet-456-apply-v1",
  "target_worker_id": null,
  "metadata": {}
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `valet_task_id` | string | Yes | - | VALET's task ID for correlation |
| `valet_user_id` | UUID | Yes | - | User ID (must exist in shared Supabase) |
| `target_url` | URL | Yes | - | ATS application URL |
| `platform` | enum | No | auto-detect | greenhouse, workday, linkedin, lever, icims, taleo, smartrecruiters, other |
| `callback_url` | URL | No | - | URL to POST status changes to |
| `profile` | object | Yes | - | User profile data |
| `resume` | object | No | - | Resume file reference |
| `qa_answers` | Record | No | {} | Pre-answered screening questions |
| `quality` | enum | No | balanced | speed, balanced, quality (maps to budget tier) |
| `model` | string | No | qwen-72b | LLM model alias for reasoning (see Model Reference) |
| `image_model` | string | No | same as model | Separate vision model for screenshots (must have vision support) |
| `execution_mode` | enum | No | auto | auto, ai_only, cookbook_only |
| `priority` | 1-10 | No | 5 | Higher = processed sooner |
| `timeout_seconds` | 30-1800 | No | 300 | Max execution time |
| `idempotency_key` | string | No | - | Prevents duplicate submissions |
| `target_worker_id` | string | No | null | Route to specific worker (null = any available) |
| `metadata` | object | No | {} | Arbitrary key-value pairs |

### 4.1.1 Model Reference

**Accuracy-focused models (recommended):**

| Alias | Provider | Vision | Input $/M | Output $/M | Best For |
|-------|----------|--------|-----------|------------|----------|
| **qwen3.5-plus** | Alibaba Cloud | Yes | $0.40 | $2.40 | **Quality preset** — frontier accuracy, native GUI automation, 1M context |
| **qwen3-235b** | SiliconFlow | Yes | $0.34 | $1.37 | **Balanced preset** — best accuracy-per-dollar |
| **gpt-5.2** | OpenAI | Yes | $1.75 | $14.00 | **Premium preset** — frontier reasoning |
| claude-opus | Anthropic | Yes | $5.00 | $25.00 | Best overall intelligence, adaptive reasoning |
| gemini-2.5-pro | Google | Yes | $1.25 | $10.00 | Strong vision and reasoning, 1M context |
| gpt-4.1 | OpenAI | Yes | $2.00 | $8.00 | Good vision (OCR, VQA), 1M context |

**Budget-friendly models:**

| Alias | Provider | Vision | Input $/M | Output $/M | Best For |
|-------|----------|--------|-----------|------------|----------|
| **qwen-7b** | SiliconFlow | Yes | $0.05 | $0.15 | **Speed preset** — cheapest, testing |
| **qwen-72b** | SiliconFlow | Yes | $0.25 | $0.75 | **Default** — proven for browser automation |
| gemini-2.5-flash | Google | Yes | $0.15 | $0.60 | Fast, cheap, decent accuracy |
| gemini-2.0-flash | Google | Yes | $0.10 | $0.40 | Ultra-fast Gemini |
| deepseek-chat | DeepSeek | No | $0.28 | $0.42 | Text-only reasoning (pair with vision model) |
| gpt-4o-mini | OpenAI | Yes | $0.15 | $0.60 | Budget OpenAI |
| claude-haiku | Anthropic | Yes | $0.80 | $4.00 | Budget Claude with vision |
| claude-sonnet | Anthropic | Yes | $3.00 | $15.00 | Strong Claude reasoning |
| gpt-4o | OpenAI | Yes | $2.50 | $10.00 | Proven multimodal |

**Cost per job (typical 8K input + 2K output tokens):**

| Setup | Models | Cost/Job | Savings vs gpt-4o |
|-------|--------|----------|-------------------|
| Speed | qwen-7b | $0.0007 | 98% |
| Balanced | qwen3-235b | $0.0055 | 86% |
| **Quality** | **qwen3.5-plus** | **$0.008** | **80%** |
| **Dual-model** | **qwen-7b + deepseek-chat** | **$0.0012** | **97%** |
| Premium | gpt-5.2 | $0.042 | — |
| Ultra-premium | claude-opus | $0.09 | — |

**Dual-model** routes screenshots to cheap vision model (`qwen-7b`) and reasoning to `deepseek-chat`.

### 4.1.2 Execution Modes

| Mode | Behavior |
|------|----------|
| `auto` | Check ManualStore for cookbook → replay if healthy → fallback to Magnitude AI |
| `ai_only` | Skip cookbook lookup, always use Magnitude LLM exploration |
| `cookbook_only` | Use cookbook only — fail if no manual exists or health < 30% |

### 4.1.3 Worker Selection

**Convention: Single-task-per-worker.** Each worker processes one job at a time. Scale horizontally.

| Scenario | `target_worker_id` | Behavior |
|----------|-------------------|----------|
| Any worker | `null` (default) | Next available worker picks it up |
| Specific worker | `"worker-prod-1"` | Only that worker can claim it |
| Worker busy | `"worker-prod-1"` | Job waits in queue until worker is free |
| Worker offline | `"worker-prod-1"` | Job stays pending (monitor with stuck job alerts) |

**Response (201):**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "valet_task_id": "valet-456",
  "status": "pending",
  "created_at": "2026-02-16T12:00:00Z"
}
```

**Response (409 — duplicate idempotency key):**

```json
{
  "job_id": "existing-job-id",
  "valet_task_id": "valet-456",
  "status": "completed",
  "duplicate": true
}
```

### 4.2 Create Generic Task — `POST /valet/task`

For non-apply tasks (scraping, form filling, custom).

```json
{
  "valet_task_id": "valet-789",
  "valet_user_id": "user-uuid",
  "job_type": "scrape",
  "target_url": "https://example.com/jobs",
  "task_description": "Scrape all job listings from this page",
  "input_data": {},
  "callback_url": "https://valet.example.com/webhook/gh",
  "quality": "speed",
  "priority": 3,
  "timeout_seconds": 120
}
```

Same response format as `/apply`.

### 4.3 Get Job Status — `GET /valet/status/:jobId`

Returns full job status with mode tracking, cost breakdown, and interaction data.

**Response:**

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "valet_task_id": "valet-456",
  "status": "completed",
  "status_message": "Application submitted",

  "execution_mode": "auto",
  "browser_mode": "server",
  "final_mode": "cookbook",

  "manual": {
    "id": "manual-uuid",
    "status": "cookbook_success",
    "health_score": 95,
    "fallback_reason": null
  },

  "cost_breakdown": {
    "total_cost_usd": 0.0005,
    "action_count": 8,
    "total_tokens": 0,
    "cookbook_steps": 8,
    "magnitude_steps": 0,
    "cookbook_cost_usd": 0.0005,
    "magnitude_cost_usd": 0.0,
    "image_cost_usd": 0.0003,
    "reasoning_cost_usd": 0.0002
  },

  "progress": {
    "step": "completed",
    "progress_pct": 100,
    "description": "Application complete",
    "action_index": 8,
    "total_actions_estimate": 10,
    "current_action": null,
    "started_at": "2026-02-16T12:00:01Z",
    "elapsed_ms": 3200,
    "eta_ms": null,
    "execution_mode": "cookbook",
    "manual_id": "manual-uuid"
  },

  "result": {
    "data": { "submitted": true, "confirmation_number": "APP-12345" },
    "summary": "Application submitted successfully",
    "screenshots": ["https://...final.png"]
  },

  "error": null,

  "interaction": null,

  "timestamps": {
    "created_at": "2026-02-16T12:00:00Z",
    "started_at": "2026-02-16T12:00:01Z",
    "completed_at": "2026-02-16T12:00:04Z"
  }
}
```

**Status-specific fields:**

| Field | When Present |
|-------|-------------|
| `result` | `status === 'completed'` |
| `error` | `status === 'failed'` |
| `interaction` | `status === 'paused'` |
| `progress` | `status === 'running'` (also available in other states as last snapshot) |
| `manual` | When a manual was looked up (any status) |
| `cost_breakdown` | When execution has started (any status) |

**`manual.status` values:**

| Value | Meaning |
|-------|---------|
| `cookbook_success` | Manual found, cookbook replayed successfully |
| `cookbook_failed_fallback` | Manual found, cookbook failed, AI Agent took over |
| `no_manual_available` | No matching manual in the database |
| `ai_only` | User requested AI-only mode (cookbook skipped) |

### 4.4 Resume Paused Job — `POST /valet/resume/:jobId`

Resume a job that was paused for human intervention (CAPTCHA, login, etc.).

**Request:**

```json
{
  "resolved_by": "human",
  "resolution_notes": "Solved CAPTCHA"
}
```

**Response (200):**

```json
{
  "job_id": "abc-123",
  "status": "running",
  "resolved_by": "human"
}
```

**Response (404):** Job not found
**Response (409):** Job is not paused

### 4.5 List Sessions — `GET /valet/sessions/:userId`

Returns stored browser sessions for a user (metadata only, no credentials).

**Response:**

```json
{
  "user_id": "user-uuid",
  "sessions": [
    {
      "domain": "linkedin.com",
      "last_used_at": "2026-02-16T10:30:00Z",
      "created_at": "2026-02-14T08:00:00Z",
      "updated_at": "2026-02-16T10:30:00Z",
      "expires_at": null
    }
  ],
  "count": 1
}
```

### 4.6 Clear Session — `DELETE /valet/sessions/:userId/:domain`

Delete stored session for a specific domain.

### 4.7 Clear All Sessions — `DELETE /valet/sessions/:userId`

Delete all stored sessions for a user ("log out everywhere").

---

## 5. Callback System (Push Notifications)

When a job has a `callback_url`, GhostHands POSTs to it on every significant status change. **This is the primary integration channel** — VALET should handle these callbacks to provide real-time updates to users.

### 5.1 Callback Status Types

| Status | Direction | When Fired |
|--------|-----------|------------|
| `running` | GH -> VALET | Job picked up by worker, execution started |
| `completed` | GH -> VALET | Job finished successfully |
| `failed` | GH -> VALET | Job failed after all retries |
| `needs_human` | GH -> VALET | Job paused, needs human intervention (CAPTCHA, login, etc.) |
| `resumed` | GH -> VALET | Previously paused job has resumed |

### 5.2 Callback Payload: `running`

Sent when the worker starts executing the job. Tells VALET the job is no longer queued.

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "valet_task_id": "valet-456",
  "status": "running",
  "completed_at": "2026-02-16T12:00:01Z"
}
```

### 5.3 Callback Payload: `completed`

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "valet_task_id": "valet-456",
  "status": "completed",
  "result_data": {
    "submitted": true,
    "confirmation_number": "APP-12345",
    "cost": {
      "input_tokens": 0,
      "output_tokens": 0,
      "total_cost_usd": 0.0005,
      "action_count": 8
    }
  },
  "result_summary": "Application submitted successfully",
  "screenshot_url": "https://...final.png",
  "cost": {
    "total_cost_usd": 0.0005,
    "action_count": 8,
    "total_tokens": 0
  },
  "execution_mode": "auto",
  "browser_mode": "server",
  "final_mode": "cookbook",
  "manual": {
    "id": "manual-uuid",
    "status": "cookbook_success",
    "health_score": 95,
    "fallback_reason": null
  },
  "cost_breakdown": {
    "total_cost_usd": 0.0005,
    "action_count": 8,
    "total_tokens": 0,
    "cookbook_steps": 8,
    "magnitude_steps": 0,
    "cookbook_cost_usd": 0.0005,
    "magnitude_cost_usd": 0.0,
    "image_cost_usd": 0.0003,
    "reasoning_cost_usd": 0.0002
  },
  "completed_at": "2026-02-16T12:00:04Z"
}
```

### 5.4 Callback Payload: `failed`

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "valet_task_id": "valet-456",
  "status": "failed",
  "error_code": "timeout",
  "error_message": "Job execution timeout",
  "cost": {
    "total_cost_usd": 0.012,
    "action_count": 5,
    "total_tokens": 8400
  },
  "completed_at": "2026-02-16T12:05:01Z"
}
```

### 5.5 Callback Payload: `needs_human`

```json
{
  "job_id": "abc-123",
  "valet_task_id": "valet-456",
  "status": "needs_human",
  "interaction": {
    "type": "captcha",
    "screenshot_url": "https://...blocker.png",
    "page_url": "https://company.workday.com/apply",
    "timeout_seconds": 300
  },
  "completed_at": "2026-02-16T12:02:00Z"
}
```

**`interaction.type` values:**

| Type | Description | User Action |
|------|-------------|-------------|
| `captcha` | reCAPTCHA, hCaptcha, Cloudflare challenge | Solve the CAPTCHA |
| `2fa` | Two-factor authentication prompt | Enter verification code |
| `login` | Login page or password field | Enter credentials |
| `bot_check` | Bot detection interstitial | Verify humanity |

### 5.6 Callback Payload: `resumed`

```json
{
  "job_id": "abc-123",
  "valet_task_id": "valet-456",
  "status": "resumed",
  "completed_at": "2026-02-16T12:03:00Z"
}
```

### 5.7 Callback Reliability

- **Retry policy:** 3 retries with exponential backoff (1s, 3s, 10s)
- **Timeout:** 10 seconds per attempt
- **Failure handling:** Callback failures are logged but never fail the job
- **Idempotency:** Callbacks may be delivered more than once; use `job_id` + `status` as dedup key

---

## 6. Real-Time Subscriptions

For richer real-time updates (action timeline, mode switching animations, thinking feed), VALET can subscribe to Supabase Realtime channels.

### 6.1 Prerequisites

Migrations must be applied:
- `gh_automation_jobs` must be in the `supabase_realtime` publication (base schema)
- `gh_job_events` must be in the `supabase_realtime` publication (migration `012_gh_job_events_realtime.sql`)

### 6.2 Job Progress Stream

Subscribe to `gh_automation_jobs` row updates for progress data:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const channel = supabase
  .channel(`gh-job-${jobId}`)
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'gh_automation_jobs',
      filter: `id=eq.${jobId}`,
    },
    (payload) => {
      const job = payload.new;
      const progress = job.metadata?.progress;

      if (progress) {
        updateProgressBar(progress.progress_pct);
        updateStepDescription(progress.description);
        updateCurrentAction(progress.current_action);
        updateExecutionMode(progress.execution_mode);  // 'cookbook' | 'magnitude'
        updateElapsedTime(progress.elapsed_ms);
      }

      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        channel.unsubscribe();
      }
    },
  )
  .subscribe();
```

### 6.3 Event Stream (Mode Switching, Actions, Thinking)

Subscribe to `gh_job_events` INSERT events for granular action-level updates:

```typescript
const eventChannel = supabase
  .channel(`gh-events-${jobId}`)
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'gh_job_events',
      filter: `job_id=eq.${jobId}`,
    },
    (payload) => {
      const event = payload.new;

      switch (event.event_type) {
        case 'job_started':
          showRunningState();
          break;

        case 'mode_selected':
          // Engine chose initial mode
          setCurrentMode(event.metadata.mode);          // 'cookbook' | 'magnitude'
          setModeReason(event.metadata.reason);          // 'manual_found' | 'no_manual_found' | 'health_too_low'
          break;

        case 'manual_found':
          setManualId(event.metadata.manual_id);
          setManualHealth(event.metadata.health_score);
          break;

        case 'mode_switched':
          // Cookbook failed, switching to AI Agent
          animateModeTransition(event.metadata.from_mode, event.metadata.to_mode);
          showFallbackReason(event.metadata.reason);
          break;

        case 'step_started':
          appendToTimeline({
            action: event.metadata.action,
            timestamp: event.created_at,
          });
          break;

        case 'step_completed':
          markTimelineStepDone(event.metadata.action);
          break;

        case 'manual_created':
          showToast(`New cookbook saved (${event.metadata.steps} steps)`);
          break;

        case 'hitl_paused':
          showBlockerUI(event.metadata.blocker_type);
          break;

        case 'job_completed':
          showCompletionUI(event.metadata);
          break;

        case 'job_failed':
          showErrorUI(event.metadata.error_code, event.metadata.error_message);
          break;
      }
    },
  )
  .subscribe();
```

### 6.4 Event Types Reference

| Event | Description | Key metadata fields |
|-------|-------------|---------------------|
| `job_started` | Worker picked up the job | `worker_id`, `quality_preset`, `task_budget` |
| `mode_selected` | Engine chose execution mode | `mode`, `manual_id?`, `reason` |
| `manual_found` | Manual lookup returned a match | `manual_id`, `health_score`, `url_pattern` |
| `mode_switched` | Fallback from cookbook to magnitude | `from_mode`, `to_mode`, `reason` |
| `step_started` | An action is being executed | `action`, `action_count` |
| `step_completed` | An action finished | `action`, `action_count` |
| `thought` | AI agent reasoning/thinking *(Sprint 5)* | `content` (truncated to 500 chars) |
| `tokens_used` | LLM token usage per step *(Sprint 5)* | `model`, `input_tokens`, `output_tokens`, `cost_usd` |
| `observation_started` | Stagehand observe() call *(Sprint 5)* | `instruction` |
| `observation_completed` | Stagehand observe() returned *(Sprint 5)* | `instruction`, `elements_found` |
| `cookbook_step_started` | Cookbook step executing *(Sprint 5)* | `step_index`, `action`, `selector` |
| `cookbook_step_completed` | Cookbook step succeeded *(Sprint 5)* | `step_index`, `action` |
| `cookbook_step_failed` | Cookbook step failed *(Sprint 5)* | `step_index`, `action`, `error` |
| `trace_recording_started` | TraceRecorder started *(Sprint 5)* | — |
| `trace_recording_completed` | TraceRecorder finished *(Sprint 5)* | `steps` |
| `manual_created` | New cookbook saved from trace | `steps`, `url_pattern` |
| `hitl_paused` | Job paused for human intervention | `blocker_type`, `confidence`, `page_url` |
| `hitl_resumed` | Job resumed after intervention | — |
| `hitl_timeout` | Human didn't respond in time | `timeout_seconds` |
| `browser_crash_detected` | Browser crashed | `attempt`, `error_message` |
| `browser_crash_recovered` | Crash recovered successfully | `attempt` |
| `session_restored` | Saved session loaded | `domain` |
| `session_saved` | Session saved for future use | `domain` |
| `budget_preflight_failed` | User over budget | `reason`, `remaining_budget` |
| `job_completed` | Job finished successfully | `handler`, `result_summary`, `action_count`, `cost_cents`, `final_mode` |
| `job_failed` | Job failed | `error_code`, `error_message`, `action_count` |

**Thought events** are throttled to max 1 per 2 seconds to avoid DB spam. Use them to show AI reasoning in real-time on the VALET UI.

---

## 7. Database Schema

### 7.1 Tables

All GhostHands tables use the `gh_` prefix (shared Supabase with VALET).

| Table | Description |
|-------|-------------|
| `gh_automation_jobs` | Job records (status, results, metadata) |
| `gh_job_events` | Granular event log per job |
| `gh_browser_sessions` | Encrypted browser sessions per user+domain |
| `gh_action_manuals` | Saved step-by-step playbooks per platform+task |
| `gh_user_usage` | Monthly cost tracking per user |
| `gh_user_credentials` | Encrypted platform credentials |

### 7.2 Key Columns on `gh_automation_jobs`

| Column | Type | Source | Description |
|--------|------|--------|-------------|
| `callback_url` | TEXT | Migration 005 | URL for push notifications |
| `valet_task_id` | TEXT | Migration 005 | VALET task correlation ID |
| `interaction_type` | TEXT | Migration 009 | Blocker type when paused |
| `interaction_data` | JSONB | Migration 009 | Blocker details (screenshot, page URL) |
| `paused_at` | TIMESTAMPTZ | Migration 009 | When job was paused |
| `execution_mode` | TEXT | Migration 011 | Requested mode: auto, ai_only, cookbook_only |
| `browser_mode` | TEXT | Migration 011 | Browser context: server, operator |
| `final_mode` | TEXT | Migration 011 | Actual mode used: cookbook, magnitude, hybrid |

### 7.3 Migrations (apply in order)

| # | File | Description |
|---|------|-------------|
| 005 | `005_add_callback_fields.sql` | callback_url + valet_task_id columns |
| 008 | `008_gh_browser_sessions.sql` | Encrypted session table with RLS |
| 009 | `009_hitl_columns.sql` | HITL interaction columns |
| 010 | `010_gh_action_manuals.sql` | Cookbook manuals table |
| 011 | `011_execution_mode_tracking.sql` | Execution mode columns |
| 012 | `012_gh_job_events_realtime.sql` | Enable Realtime on gh_job_events |

---

## 8. Execution Modes & Cost Tracking

### 8.1 Mode Selection Flow

```
Job submitted
  ↓
ManualStore.lookup(url, task_type, platform)
  ↓
Found manual?
  ├── Yes + health > 30% → Cookbook Mode (near-zero cost)
  │     ↓ success → done ($0.0005)
  │     ↓ failure → Magnitude Mode fallback ($0.02)
  │
  ├── Yes + health ≤ 30% → Magnitude Mode (manual too degraded)
  │
  └── No → Magnitude Mode (no manual exists)
        ↓ success → save trace as new manual for next time
```

### 8.2 Cost Comparison

| Mode | Avg Cost | Avg Time | LLM Tokens | Description |
|------|----------|----------|------------|-------------|
| Cookbook | $0.0005 | ~1s | 0 | Deterministic step replay |
| Magnitude | $0.02 | ~8s | ~8,000 | Full AI agent exploration |
| Hybrid | $0.015 | ~6s | ~6,000 | Partial cookbook + AI fallback |

### 8.3 Cost Breakdown in Responses

The `cost_breakdown` object appears in both status responses and callback payloads:

```json
{
  "cost_breakdown": {
    "total_cost_usd": 0.0005,
    "action_count": 8,
    "total_tokens": 0,
    "cookbook_steps": 8,
    "magnitude_steps": 0,
    "cookbook_cost_usd": 0.0005,
    "magnitude_cost_usd": 0.0,
    "image_cost_usd": 0.0003,
    "reasoning_cost_usd": 0.0002
  }
}
```

| Field | Description |
|-------|-------------|
| `total_cost_usd` | Total cost across all modes |
| `action_count` | Total actions executed |
| `total_tokens` | Total LLM tokens used |
| `cookbook_steps` | Steps replayed from saved manual |
| `magnitude_steps` | Steps driven by AI agent |
| `cookbook_cost_usd` | Cost from cookbook steps |
| `magnitude_cost_usd` | Cost from AI agent steps |
| `image_cost_usd` | Cost attributed to image/vision model (dual-model only) |
| `reasoning_cost_usd` | Cost attributed to reasoning model (dual-model only) |

**Savings calculation:**

```
estimated_full_ai_cost = action_count * $0.0025
savings_pct = (1 - total_cost_usd / estimated_full_ai_cost) * 100
```

---

## 9. Session Management

Browser sessions are automatically managed by GhostHands workers. VALET does not need to pass session data — it's loaded/saved transparently.

**API endpoints** (for user-facing session management):
- `GET /valet/sessions/:userId` — list stored sessions
- `DELETE /valet/sessions/:userId/:domain` — clear one
- `DELETE /valet/sessions/:userId` — clear all

See [Section 4.5-4.7](#45-list-sessions--get-valetsessionsuserid) for details.

---

## 10. HITL (Human-in-the-Loop)

When automation hits a blocker it can't solve (CAPTCHA, login, 2FA, bot check):

1. **GhostHands pauses** the job and takes a screenshot
2. **Sends `needs_human` callback** to VALET with blocker details
3. **VALET shows** the screenshot and blocker type to the user
4. **User resolves** the blocker (solves CAPTCHA, enters credentials, etc.)
5. **VALET calls** `POST /valet/resume/:jobId` to signal resolution
6. **GhostHands resumes** and sends `resumed` callback
7. If the user doesn't resolve within 5 minutes, the job **fails with `hitl_timeout`**

### HITL Callback Flow

```
GhostHands → VALET: { status: "needs_human", interaction: { type: "captcha", screenshot_url: "..." } }
                                  ↓
                          VALET shows UI to user
                                  ↓
                          User solves CAPTCHA
                                  ↓
VALET → GhostHands: POST /valet/resume/:jobId { resolved_by: "human" }
                                  ↓
GhostHands → VALET: { status: "resumed" }
                                  ↓
                          Job continues...
                                  ↓
GhostHands → VALET: { status: "completed", ... }
```

---

## 11. UI Visualization Guide

### 11.1 Mode Badge

Show the current execution mode:

| Mode | Badge | Color | Tooltip |
|------|-------|-------|---------|
| `cookbook` | "Cookbook" | Green | "Replaying saved manual — near-zero AI cost" |
| `magnitude` | "AI Agent" | Blue | "AI Agent exploring — full LLM reasoning" |
| `hybrid` | "Hybrid" | Amber | "Started cookbook, fell back to AI Agent" |

**Data source:** `progress.execution_mode` from Realtime, or `final_mode` from status API.

### 11.2 Action Timeline

A scrolling list of actions, color-coded by mode:

```
10:32:01  🟢  Navigated to application page
10:32:02  🟢  Filled "First Name" with "Alice"
10:32:02  🟢  Filled "Email" with "alice@example.com"
10:32:03  🟢  Clicked "Submit Application"
10:32:03  🟢  ✓ Cookbook complete (4 steps, $0.0005)
```

With fallback:

```
10:32:01  🟢  Navigated to application page
10:32:02  🟢  Filled "First Name" with "Alice"
10:32:03  🟠  Cookbook step failed: "Submit" button not found
10:32:03  🔵  Switching to AI Agent...
10:32:04  🔵  Analyzing page structure
10:32:05  🔵  Found alternative submit: "Apply Now" button
10:32:06  🔵  Clicked "Apply Now"
10:32:07  🔵  ✓ Application submitted via AI Agent ($0.018)
```

**Data source:** `gh_job_events` via Realtime (`step_started`, `step_completed`, `mode_switched`).

### 11.3 Thinking Feed

Shows the AI agent's current reasoning (visible in Magnitude mode):

```
"Looking for the submit button on this page..."
"Found a multi-step form, navigating to next page..."
```

**Data source:** `progress.current_action` from Realtime job updates.

### 11.4 Cost Breakdown Panel

```
┌─────────────────────────────────────────┐
│ Cost Breakdown                          │
│                                         │
│  Cookbook    8 steps    $0.0005   🟢     │
│  AI Agent   0 steps    $0.00     🔵     │
│  ─────────────────────────────────      │
│  Total      8 actions   $0.0005         │
│                                         │
│  💰 95% cheaper than full AI run        │
└─────────────────────────────────────────┘
```

**Data source:** `cost_breakdown` from status API or callback payload.

### 11.5 Blocker / HITL UI

When `needs_human` callback arrives:
1. Show notification: "Your automation needs help"
2. Display blocker screenshot (`interaction.screenshot_url`)
3. Show blocker type as label ("CAPTCHA Detected", "Login Required", etc.)
4. Show countdown timer (`interaction.timeout_seconds`)
5. Provide "I've resolved it" button → `POST /valet/resume/:jobId`
6. Provide "Cancel" button → cancel the job

---

## 12. Job Management (Cancel, Retry, Events)

These endpoints use the **jobs API** (not the `/valet/` prefix). They require the same `X-GH-Service-Key` auth.

**Base path:** `/api/v1/gh/jobs`

### 12.1 Cancel Job — `POST /jobs/:id/cancel`

Cancel a pending, queued, running, or paused job.

**Response (200):**

```json
{
  "id": "job-uuid",
  "status": "cancelled",
  "completed_at": "2026-02-16T12:05:00Z"
}
```

**Response (409):** Job already completed/failed/cancelled.

**Cancellable statuses:** `pending`, `queued`, `running`, `paused`

### 12.2 Retry Job — `POST /jobs/:id/retry`

Re-queue a failed or cancelled job. Creates a new attempt with `retry_count` incremented.

**Response (200):**

```json
{
  "id": "job-uuid",
  "status": "pending",
  "retry_count": 2
}
```

**Response (409):** Job is not in a retryable status.

**Retryable statuses:** `failed`, `cancelled`

### 12.3 Get Job Events — `GET /jobs/:id/events`

Returns the full event log for a job (mode_selected, step_started, step_completed, etc.).

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 100 | Max events to return |
| `offset` | number | 0 | Pagination offset |
| `event_type` | string | - | Filter by event type |

**Response:**

```json
{
  "events": [
    {
      "id": "event-uuid",
      "job_id": "job-uuid",
      "event_type": "mode_selected",
      "metadata": { "mode": "cookbook", "manual_id": "manual-uuid", "reason": "manual_found" },
      "actor": "worker-1",
      "created_at": "2026-02-16T12:00:01Z"
    },
    {
      "id": "event-uuid-2",
      "event_type": "step_started",
      "metadata": { "action": "click", "action_count": 1 },
      "actor": "worker-1",
      "created_at": "2026-02-16T12:00:02Z"
    }
  ],
  "total": 12,
  "limit": 100,
  "offset": 0
}
```

### 12.4 List Jobs — `GET /jobs`

List all jobs with filtering.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string[] | - | Filter by status(es) |
| `job_type` | string | - | Filter by job type |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |
| `sort` | string | `-created_at` | Sort field (prefix `-` for DESC) |

### 12.5 Batch Create — `POST /jobs/batch`

Create multiple jobs in a single request.

---

## 13. Monitoring & Health

Monitoring endpoints are **public** (no auth required) — designed for load balancers, uptime monitors, and ops dashboards.

**Base path:** `/api/v1/gh/monitoring`

### 13.1 Simple Health — `GET /health`

Lightweight health check for load balancers.

**Response (200):**

```json
{
  "status": "ok",
  "service": "ghosthands",
  "version": "0.1.0",
  "timestamp": "2026-02-16T12:00:00Z"
}
```

### 13.2 Detailed Health — `GET /monitoring/health`

Checks database, worker heartbeats, LLM providers, and storage.

**Response (200 — healthy/degraded, 503 — unhealthy):**

```json
{
  "status": "healthy",
  "checks": {
    "database": { "status": "healthy", "latency_ms": 5 },
    "worker_heartbeat": { "status": "healthy", "active_workers": 3, "stale_workers": 0 },
    "llm_provider": { "status": "healthy", "provider": "deepseek", "error_rate": 0.01 },
    "storage": { "status": "healthy", "bucket": "screenshots" }
  },
  "timestamp": "2026-02-16T12:00:00Z"
}
```

| Status | HTTP Code | Meaning |
|--------|-----------|---------|
| `healthy` | 200 | All checks passing |
| `degraded` | 200 | Some checks failing but service is operational |
| `unhealthy` | 503 | Critical failure, service should be restarted |

### 13.3 Metrics — `GET /monitoring/metrics`

Prometheus-format metrics for scraping.

```
Content-Type: text/plain; charset=utf-8

# HELP gh_jobs_completed_total Total completed jobs
# TYPE gh_jobs_completed_total counter
gh_jobs_completed_total 1234

# HELP gh_jobs_failed_total Total failed jobs
# TYPE gh_jobs_failed_total counter
gh_jobs_failed_total 56

# HELP gh_worker_active_jobs Currently active jobs per worker
# TYPE gh_worker_active_jobs gauge
gh_worker_active_jobs{worker="worker-1"} 2

# HELP gh_llm_cost_usd_total Total LLM cost
# TYPE gh_llm_cost_usd_total counter
gh_llm_cost_usd_total 45.67
```

### 13.4 Metrics JSON — `GET /monitoring/metrics/json`

Same metrics in JSON format:

```json
{
  "jobs": { "created": 1290, "completed": 1234, "failed": 56, "retried": 23 },
  "workers": { "active_jobs": 5, "max_concurrent": 10, "queue_depth": 3 },
  "llm": { "total_calls": 8900, "total_tokens": 4500000, "cost_per_hour_usd": 1.23 },
  "api": { "total_requests": 45000, "error_rate": 0.002 }
}
```

### 13.5 Alerts — `GET /monitoring/alerts`

Active alerts and stuck job detection.

```json
{
  "count": 1,
  "alerts": [
    {
      "type": "stuck_jobs",
      "severity": "warning",
      "message": "2 jobs have no heartbeat for >120 seconds",
      "jobs": ["job-uuid-1", "job-uuid-2"],
      "detected_at": "2026-02-16T12:00:00Z"
    }
  ],
  "checkedAt": "2026-02-16T12:00:05Z"
}
```

### 13.6 Dashboard — `GET /monitoring/dashboard`

Aggregated view combining health + metrics + alerts:

```json
{
  "health": { "status": "healthy", "checks": { ... } },
  "metrics": { "jobs": { ... }, "workers": { ... }, "llm": { ... } },
  "activeAlerts": [],
  "timestamp": "2026-02-16T12:00:00Z"
}
```

---

## 14. Worker Fleet & Deployment

VALET manages GhostHands worker lifecycle across EC2 instances via the deploy script. Each EC2 instance runs one compose stack (API + default worker) plus zero or more targeted workers.

### 14.1 Architecture

```
EC2 Instance
├── docker-compose (API + default worker)
│   ├── api        → :3100 (Hono HTTP server)
│   └── worker     → polls gh_automation_jobs
├── gh-worker-abc  → targeted worker (Docker container)
├── gh-worker-def  → targeted worker (Docker container)
└── scripts/deploy.sh
```

### 14.2 Deploy Script Commands

VALET calls `scripts/deploy.sh` on each EC2 instance via SSH:

| Command | Description | Drain? |
|---------|-------------|--------|
| `deploy [tag]` | Deploy new image tag, restart all workers | Yes (35s) |
| `rollback` | Rollback to previous image | Yes |
| `drain` | Stop worker pickup, let active jobs finish (60s) | Yes (60s) |
| `status` | Show compose + targeted worker status | No |
| `health` | Exit 0 if healthy, 1 if not (for scripting) | No |
| `start-worker <id>` | Start a targeted worker container | No |
| `stop-worker <id>` | Stop a targeted worker (35s drain) | Yes (35s) |
| `list-workers` | List all targeted worker containers | No |

### 14.3 Rolling Update Procedure

VALET should follow this sequence per EC2 instance:

```
1. ./scripts/deploy.sh drain
   → Worker stops picking up new jobs
   → Active jobs finish (up to 60s)
   → API stays running (status polling still works)

2. ./scripts/deploy.sh deploy <new-tag>
   → Pull new image from ECR
   → Restart compose (API + worker)
   → Restart all targeted workers
   → Health check (up to 60s)
   → Auto-rollback if health fails

3. Verify health:
   curl -sf http://<host>:3100/health

4. Move to next instance
```

**For zero-downtime across the fleet,** VALET should do a rolling update: drain + deploy one instance at a time, waiting for health confirmation before moving to the next.

### 14.4 Targeted Workers

Targeted workers are standalone Docker containers that VALET manages for routing specific jobs to specific workers (e.g., for sandbox isolation or user affinity).

**Start:**

```bash
ssh ec2-host "./scripts/deploy.sh start-worker user-abc-123"
```

**Stop:**

```bash
ssh ec2-host "./scripts/deploy.sh stop-worker user-abc-123"
```

**Route a job to a specific worker** by passing `target_worker_id` in the job creation request:

```json
{
  "valet_task_id": "task-001",
  "target_url": "...",
  "target_worker_id": "user-abc-123",
  "..."
}
```

Only the worker with `GH_WORKER_ID=user-abc-123` will pick up this job.

### 14.5 Graceful Shutdown Behavior

When a worker receives SIGTERM (from `docker stop` or `deploy.sh`):

1. **Stop polling** — no new jobs picked up
2. **Wait for active jobs** — up to 30s for current jobs to complete
3. **Release claimed jobs** — any jobs still in `queued`/`running` are set back to `pending` with `worker_id = NULL`
4. **Exit cleanly**

On a second SIGTERM (force):
1. **Force release** all claimed jobs immediately
2. **Exit with code 1**

**Impact on VALET:**
- Jobs released during shutdown will be re-picked by another worker
- Callback URL and valet_task_id are preserved on the job row — the new worker will send callbacks to the same URL
- Active jobs may lose in-progress state (browser session is saved on completion only)

### 14.6 Stuck Job Recovery

Jobs can get stuck if a worker crashes without cleanup. The system handles this automatically:

1. **On startup:** Each worker checks for stuck jobs (no heartbeat >120s) and resets them to `pending`
2. **Monitoring alert:** `GET /monitoring/alerts` reports stuck jobs
3. **Manual recovery:** Run `bun src/scripts/release-stuck-jobs.ts` to force-release stuck jobs

### 14.7 Required Environment Variables (per instance)

| Variable | Required | Description |
|----------|----------|-------------|
| `ECR_REGISTRY` | Yes | ECR registry URL |
| `ECR_REPOSITORY` | Yes | ECR repository name |
| `AWS_REGION` | Yes | AWS region for ECR login |
| `GH_WORKER_ID` | Per-worker | Worker identifier (set in compose or start-worker) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SUPABASE_URL` | Yes | Supabase API URL |
| `SUPABASE_KEY` | Yes | Supabase service role key |
| `GH_CREDENTIAL_KEY` | Yes | AES-256 encryption key (64 hex chars) |
| `GH_SERVICE_KEY` | Yes | API authentication key |

### 14.8 Deploy Script Output Parsing

The deploy script outputs machine-readable key=value pairs VALET can parse:

```bash
# On success:
DEPLOY_STATUS=success
DEPLOY_TAG=v1.2.3
DEPLOY_IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/ghosthands:v1.2.3

# On rollback:
DEPLOY_STATUS=rollback

# On rollback failure:
DEPLOY_STATUS=rollback_failed

# On drain:
DRAIN_STATUS=success

# On health check:
HEALTH_STATUS=healthy   # or unhealthy

# On start-worker:
WORKER_NAME=gh-worker-abc12345
WORKER_ID=user-abc-123
```

---

## 15. Error Codes & Retry Logic


### 12.1 Error Codes

| Code | Description | Retryable? | VALET UI Suggestion |
|------|-------------|------------|---------------------|
| `budget_exceeded` | User's monthly budget exhausted | No | "Budget limit reached. Upgrade plan?" |
| `action_limit_exceeded` | Too many actions in one job | No | "Task too complex. Try a simpler URL?" |
| `captcha_blocked` | CAPTCHA not solved | Yes | "CAPTCHA detected. Will retry." |
| `login_required` | Login page encountered | Yes | "Login required. Check saved sessions." |
| `timeout` | Job exceeded time limit | Yes | "Timed out. Will retry automatically." |
| `rate_limited` | Site rate-limited the bot | Yes | "Rate limited. Will retry after backoff." |
| `element_not_found` | Expected element missing | Yes | "Page changed. Will retry." |
| `network_error` | Connection issue | Yes | "Network error. Will retry." |
| `browser_crashed` | Browser process died | Yes | "Browser crashed. Recovering..." |
| `hitl_timeout` | Human didn't resolve blocker | No | "Timed out waiting for help. Retry?" |
| `validation_error` | Input data invalid | No | "Invalid input. Check profile data." |
| `internal_error` | Unexpected error | Yes | "Something went wrong. Will retry." |

### 12.2 Retry Behavior

- Retryable errors are retried up to `max_retries` times (default 3)
- Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped at 60s)
- Each retry re-queues the job as `pending`
- On final failure, status becomes `failed`

---

## 16. Migration Checklist

Apply these migrations **in order** on Supabase:

- [ ] `005_add_callback_fields.sql` — callback_url + valet_task_id columns
- [ ] `008_gh_browser_sessions.sql` — encrypted session storage
- [ ] `009_hitl_columns.sql` — HITL interaction columns
- [ ] `010_gh_action_manuals.sql` — cookbook manuals table
- [ ] `011_execution_mode_tracking.sql` — execution mode columns + index
- [ ] `012_gh_job_events_realtime.sql` — enable Realtime on gh_job_events

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GH_CREDENTIAL_KEY` | Yes | AES-256 encryption key (64 hex chars) for session encryption |
| `GH_CREDENTIAL_KEY_ID` | No | Key version ID (default: "1") |
| `GH_SERVICE_KEY` | Yes | Service key for X-GH-Service-Key authentication |
| `GH_MODEL` or `GH_DEFAULT_MODEL` | No | Default LLM model alias (default: qwen-72b) |
| `GH_IMAGE_MODEL` | No | Default vision model for dual-model mode |
| `DASHSCOPE_API_KEY` | For qwen3.5-plus | Alibaba Cloud API key for Qwen3.5-Plus |
| `GOOGLE_API_KEY` | For Gemini models | Google AI API key for Gemini models |

### VALET Code Changes

**Callback handler (required):**
- [ ] Handle `running` callback — update task to "Running" in VALET UI
- [ ] Handle `completed` callback — update task to "Done", show results
- [ ] Handle `failed` callback — update task to "Failed", show error
- [ ] Handle `needs_human` callback — show blocker UI with screenshot
- [ ] Handle `resumed` callback — update task to "Running" again

**Status polling (required as fallback):**
- [ ] Poll `GET /valet/status/:jobId` while job is active
- [ ] Parse optional `manual`, `cost_breakdown`, `interaction` fields (all null-safe)

**Real-time subscriptions (optional, recommended):**
- [ ] Subscribe to `gh_automation_jobs` updates for progress bar
- [ ] Subscribe to `gh_job_events` inserts for action timeline
- [ ] Handle `mode_selected`, `mode_switched`, `manual_found` events for mode UI

**Session management UI (optional):**
- [ ] Show "Saved Logins" in user settings
- [ ] Allow per-domain and clear-all session deletion

---

## 17. curl Examples

### Create a job

```bash
curl -X POST https://gh.example.com/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: $GH_SERVICE_KEY" \
  -d '{
    "valet_task_id": "task-001",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "target_url": "https://boards.greenhouse.io/acme/jobs/123",
    "callback_url": "https://valet.example.com/webhook/gh",
    "profile": {
      "first_name": "Alice",
      "last_name": "Smith",
      "email": "alice@example.com"
    }
  }'
```

### Create a dual-model job (cheap vision + smart reasoning)

```bash
curl -X POST https://gh.example.com/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: $GH_SERVICE_KEY" \
  -d '{
    "valet_task_id": "task-002",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "target_url": "https://boards.greenhouse.io/acme/jobs/123",
    "callback_url": "https://valet.example.com/webhook/gh",
    "model": "deepseek-chat",
    "image_model": "qwen-7b",
    "execution_mode": "ai_only",
    "profile": {
      "first_name": "Alice",
      "last_name": "Smith",
      "email": "alice@example.com"
    }
  }'
```

### Poll status

```bash
curl -s https://gh.example.com/api/v1/gh/valet/status/$JOB_ID \
  -H "X-GH-Service-Key: $GH_SERVICE_KEY" \
  | jq '{status, final_mode, manual, cost_breakdown}'
```

### Query mode events

```sql
SELECT event_type, metadata->>'mode' as mode,
       metadata->>'manual_id' as manual_id,
       metadata->>'reason' as reason,
       created_at
FROM gh_job_events
WHERE job_id = 'JOB_ID'
  AND event_type IN ('mode_selected', 'mode_switched', 'manual_found', 'manual_created')
ORDER BY created_at;
```

### Resume a paused job

```bash
curl -X POST https://gh.example.com/api/v1/gh/valet/resume/$JOB_ID \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: $GH_SERVICE_KEY" \
  -d '{ "resolved_by": "human", "resolution_notes": "Solved CAPTCHA" }'
```

### List user sessions

```bash
curl https://gh.example.com/api/v1/gh/valet/sessions/$USER_ID \
  -H "X-GH-Service-Key: $GH_SERVICE_KEY"
```

---

## 18. Known Limitations

1. **HITL resume is fire-and-forget:** When a job resumes after HITL, the remaining execution happens in the original handler call. If the handler already threw (common), the resumed job is logged as "resumed" but the actual continued execution needs a job restart.

2. **Fixed HITL timeout:** 5 minutes, not configurable per job yet.

3. **Blocker detection is DOM-only:** CSS selector patterns + text matching. No screenshot analysis. Image-based CAPTCHAs without standard selectors may not be detected.

4. **No cancel callback:** Job cancellation does not send a callback. VALET must poll status to detect cancellation.

5. **Cookbook is per-platform, not per-company:** A Greenhouse manual works across all Greenhouse jobs, but a company's custom application portal has no manual until the first successful run.

6. **`completed_at` field in callback payloads:** For `running` and `needs_human` callbacks, `completed_at` is actually the event timestamp (not a true completion time). This will be renamed to `timestamp` in a future version.

7. **Single-task-per-worker (Sprint 4):** Workers are hardcoded to process one job at a time. Scale horizontally by adding workers. This simplifies browser session management, cost tracking, and HITL pause/resume.

8. **Dual-model requires vision:** The `image_model` field is only used if the specified model has `vision: true` in the model registry. Non-vision models passed as `image_model` are silently ignored (single-model fallback).

9. **No worker registry/discovery API:** There is no endpoint to list active workers or their status. VALET must track workers via EC2 instance management + `deploy.sh status`. A worker registry is planned for Sprint 5.

10. **Thought events are throttled:** AI thinking events (`thought`) are limited to max 1 per 2 seconds to avoid excessive DB writes. For higher-resolution thinking, use `progress.current_action` from Realtime job updates.
