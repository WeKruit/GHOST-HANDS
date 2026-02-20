# GhostHands API Integration Guide

## Quick Start

### 1. Start Services

```bash
cd packages/ghosthands

# Terminal 1: API Server
bun run api          # Starts on port 3100

# Terminal 2: Worker
bun run worker       # Polls for and executes jobs
```

### 2. Authentication

Two methods supported:

**Service-to-service** (for VALET backend):
```bash
-H "X-GH-Service-Key: <GH_SERVICE_SECRET from .env>"
```

**User JWT** (for frontend clients):
```bash
-H "Authorization: Bearer <supabase-jwt-token>"
```

---

## VALET-Specific Endpoints

These endpoints are purpose-built for the VALET hiring platform. They accept rich profile data, resume references, and support completion callbacks.

**Base URL:** `http://localhost:3100/api/v1/gh/valet`

### POST /valet/apply — Submit Job Application

Creates a job application with full candidate profile, resume, and pre-answered screening questions.

**Request:**
```json
{
  "valet_task_id": "valet-task-abc123",
  "valet_user_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_url": "https://boards.greenhouse.io/company/jobs/12345",
  "platform": "greenhouse",

  "resume": {
    "storage_path": "resumes/user-id/resume-v3.pdf",
    "download_url": "https://presigned-url..."
  },

  "profile": {
    "first_name": "Jane",
    "last_name": "Smith",
    "email": "jane@example.com",
    "phone": "+14155551234",
    "linkedin_url": "https://linkedin.com/in/janesmith",
    "portfolio_url": "https://janesmith.dev",
    "location": {
      "city": "San Francisco",
      "state": "CA",
      "country": "US",
      "zip": "94105"
    },
    "work_authorization": "US Citizen",
    "salary_expectation": "$150,000 - $180,000",
    "years_of_experience": 8,
    "education": [
      {
        "institution": "MIT",
        "degree": "B.S.",
        "field": "Computer Science",
        "graduation_year": 2018
      }
    ],
    "work_history": [
      {
        "company": "Stripe",
        "title": "Senior Software Engineer",
        "start_date": "2020-06",
        "end_date": "2025-12",
        "description": "Led payments infrastructure team"
      }
    ],
    "skills": ["TypeScript", "React", "Node.js", "PostgreSQL"]
  },

  "qa_answers": {
    "Are you authorized to work in the US?": "Yes",
    "Willing to relocate?": "Yes, to SF Bay Area"
  },

  "callback_url": "https://api.wekruit.com/webhooks/ghosthands",
  "quality": "balanced",
  "priority": 5,
  "timeout_seconds": 300,
  "idempotency_key": "valet-apply-user123-greenhouse-12345"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `valet_task_id` | string | Yes | VALET's task ID for correlation |
| `valet_user_id` | UUID | Yes | VALET user ID |
| `target_url` | URL | Yes | Application page URL |
| `platform` | enum | No | ATS platform hint: `greenhouse`, `workday`, `linkedin`, `lever`, `icims`, `taleo`, `smartrecruiters`, `other` |
| `resume` | object | No | Resume reference (at least one of: `storage_path`, `s3_key`, `download_url`) |
| `profile` | object | Yes | Candidate profile (see schema below) |
| `qa_answers` | map | No | Pre-answered screening questions |
| `callback_url` | URL | No | Webhook URL for completion notification |
| `quality` | enum | No | `speed` (fast/cheap), `balanced` (default), `quality` (accurate/expensive) |
| `priority` | 1-10 | No | Job priority (default: 5) |
| `timeout_seconds` | 30-1800 | No | Max execution time (default: 300) |
| `idempotency_key` | string | No | Prevents duplicate job creation |

**Response (201):**
```json
{
  "job_id": "ba3856eb-73e2-4b8e-a821-649d52de4ecf",
  "valet_task_id": "valet-task-abc123",
  "status": "pending",
  "created_at": "2026-02-15T04:28:03.476Z"
}
```

**Duplicate (409):**
```json
{
  "job_id": "existing-job-id",
  "valet_task_id": "valet-task-abc123",
  "status": "running",
  "duplicate": true
}
```

### POST /valet/task — Generic Task Request

Creates any automation task (scrape, fill_form, custom, etc.).

**Request:**
```json
{
  "valet_task_id": "valet-task-xyz789",
  "valet_user_id": "550e8400-e29b-41d4-a716-446655440000",
  "job_type": "scrape",
  "target_url": "https://company.com/careers",
  "task_description": "Extract all open engineering positions",
  "input_data": {},
  "callback_url": "https://api.wekruit.com/webhooks/ghosthands",
  "quality": "speed",
  "priority": 3,
  "timeout_seconds": 120
}
```

**Response (201):** Same format as `/valet/apply`.

### GET /valet/status/:jobId — Job Status

Returns a VALET-friendly status object with progress, results, and error details.

**Response (200):**
```json
{
  "job_id": "ba3856eb-73e2-4b8e-a821-649d52de4ecf",
  "valet_task_id": "valet-task-abc123",
  "status": "completed",
  "status_message": "Application submitted successfully",
  "progress": null,
  "result": {
    "data": { "confirmation_id": "APP-7890", "submitted": true },
    "summary": "Applied to Senior SWE at Stripe via Greenhouse",
    "screenshots": ["https://storage.../screenshot-final.png"]
  },
  "error": null,
  "timestamps": {
    "created_at": "2026-02-15T04:28:03.476Z",
    "started_at": "2026-02-15T04:28:05.000Z",
    "completed_at": "2026-02-15T04:30:12.000Z"
  }
}
```

### Callback Webhook

When a `callback_url` is provided, GhostHands POSTs a notification when the job completes or fails:

**Callback payload:**
```json
{
  "job_id": "ba3856eb-73e2-4b8e-a821-649d52de4ecf",
  "valet_task_id": "valet-task-abc123",
  "status": "completed",
  "result_data": {
    "confirmation_id": "APP-7890",
    "submitted": true
  },
  "result_summary": "Applied to Senior SWE at Stripe via Greenhouse",
  "screenshot_url": "https://storage.../screenshot-final.png",
  "error_code": null,
  "error_details": null,
  "completed_at": "2026-02-15T04:30:12.000Z"
}
```

**Callback behavior:**
- Retries 3 times on failure (delays: 1s, 3s, 10s)
- 10s timeout per attempt
- Callback failure does not affect job status (fire-and-forget)
- VALET should return HTTP 2xx to acknowledge

---

## Generic API Reference

**Base URL:** `http://localhost:3100/api/v1/gh`

### Create a Job

```bash
POST /api/v1/gh/jobs
```

**Request Body:**
```json
{
  "user_id": "uuid-of-user",
  "job_type": "apply",
  "target_url": "https://company.com/careers/job-123",
  "task_description": "Apply to Senior Software Engineer position",
  "input_data": {
    "tier": "starter",
    "resume_id": "optional-uuid",
    "user_data": {
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "phone": "+1234567890",
      "linkedin_url": "https://linkedin.com/in/johndoe"
    },
    "platform": "greenhouse",
    "qa_overrides": {
      "Are you authorized to work?": "Yes"
    }
  },
  "priority": 5,
  "max_retries": 3,
  "timeout_seconds": 300,
  "tags": ["engineering", "senior"],
  "idempotency_key": "optional-dedup-key",
  "metadata": {}
}
```

**Required fields:** `job_type`, `target_url`, `task_description`
**Required for service callers:** `user_id` (UUID)

**Job types:** Any string (extensible). Built-in: `apply`, `scrape`, `fill_form`, `custom`
**Tiers:** `free`, `starter`, `pro`, `premium`
**Platforms:** `linkedin`, `greenhouse`, `lever`, `workday`, `icims`, `taleo`, `smartrecruiters`, `other`

**Response (201):**
```json
{
  "id": "ba3856eb-73e2-4b8e-a821-649d52de4ecf",
  "status": "pending",
  "created_at": "2026-02-15T04:28:03.476Z"
}
```

### Batch Create Jobs

```bash
POST /api/v1/gh/jobs/batch
```

```json
{
  "jobs": [
    {
      "job_type": "apply",
      "target_url": "https://example.com/job-1",
      "task_description": "Apply to Job 1"
    },
    {
      "job_type": "apply",
      "target_url": "https://example.com/job-2",
      "task_description": "Apply to Job 2"
    }
  ],
  "defaults": {
    "priority": 3,
    "max_retries": 2,
    "tags": ["batch-apply"]
  }
}
```

### Get Job Details

```bash
GET /api/v1/gh/jobs/:id
```

### Get Job Status (Lightweight)

```bash
GET /api/v1/gh/jobs/:id/status
```

**Response:**
```json
{
  "id": "ba3856eb-...",
  "status": "running",
  "status_message": "Filling application form (step 3/5)",
  "started_at": "2026-02-15T04:28:05.000Z",
  "last_heartbeat": "2026-02-15T04:28:35.000Z",
  "completed_at": null
}
```

### List Jobs

```bash
GET /api/v1/gh/jobs?status=running,pending&job_type=apply&limit=20&offset=0&sort=created_at:desc
```

### Get Job Events

```bash
GET /api/v1/gh/jobs/:id/events?limit=50&offset=0
```

### Cancel a Job

```bash
POST /api/v1/gh/jobs/:id/cancel
```

### Retry a Failed Job

```bash
POST /api/v1/gh/jobs/:id/retry
```

### Get User Usage

```bash
GET /api/v1/gh/users/:user_id/usage
```

### Health Check

```bash
GET /health
```

### Monitoring

```bash
GET /monitoring/health
GET /monitoring/metrics        # Prometheus format
GET /monitoring/metrics/json
GET /monitoring/alerts
GET /monitoring/dashboard
```

---

## Job Lifecycle

```
pending → queued → running → completed
                          ↘ failed → (retry) → pending
                    ↘ cancelled
```

| Status | Meaning |
|--------|---------|
| `pending` | Created, waiting for worker pickup |
| `queued` | Claimed by a worker, about to execute |
| `running` | Browser automation in progress |
| `completed` | Successfully finished |
| `failed` | Error occurred (may be retried) |
| `cancelled` | Manually cancelled |

---

## LLM Model Configuration

Models are configured in `packages/ghosthands/src/config/models.config.json`.

### Current Available Models

| Model Key | Provider | Vision | Cost (in/out $/M) |
|-----------|----------|--------|--------------------|
| `qwen-7b` | SiliconFlow | Yes | $0.05 / $0.15 |
| `qwen-72b` | SiliconFlow | Yes | $0.25 / $0.75 |
| `deepseek-chat` | DeepSeek | No | $0.27 / $1.10 |
| `glm-5` | Zhipu AI | Yes | $0.50 / $0.50 |
| `gpt-4o` | OpenAI | Yes | $2.50 / $10.00 |
| `claude-sonnet` | Anthropic | Yes | $3.00 / $15.00 |

### Model Selection Priority

1. Job-level override: `metadata.model` in job request
2. Environment variable: `GH_MODEL`
3. Fallback: `GH_DEFAULT_MODEL`
4. Config default: `qwen-72b`

**Premium tier** always uses `claude-sonnet` regardless of overrides.

### Switching Models

```bash
# In .env - change the global default
GH_MODEL=qwen-72b     # Vision + cheap
GH_MODEL=deepseek-chat # Text-only, very cheap
GH_MODEL=glm-5         # Vision, requires ZHIPU_API_KEY

# Per-job override (in request body)
{
  "metadata": { "model": "gpt-4o" }
}
```

---

## VALET Integration Examples

### Using the VALET-Specific Endpoints (Recommended)

```typescript
// valet/lib/ghosthands.ts
const GH_API = process.env.GHOSTHANDS_API_URL || 'http://localhost:3100';
const GH_KEY = process.env.GH_SERVICE_SECRET;

// Submit a rich application via the VALET endpoint
async function submitApplication(params: {
  valetTaskId: string;
  userId: string;
  jobUrl: string;
  platform: string;
  profile: Record<string, any>;
  resume?: { storage_path?: string; download_url?: string };
  qaAnswers?: Record<string, string>;
  callbackUrl?: string;
}) {
  const response = await fetch(`${GH_API}/api/v1/gh/valet/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GH-Service-Key': GH_KEY,
    },
    body: JSON.stringify({
      valet_task_id: params.valetTaskId,
      valet_user_id: params.userId,
      target_url: params.jobUrl,
      platform: params.platform,
      resume: params.resume,
      profile: params.profile,
      qa_answers: params.qaAnswers,
      callback_url: params.callbackUrl,
      quality: 'balanced',
      idempotency_key: `valet-${params.userId}-${params.jobUrl}`,
    }),
  });

  if (response.status === 409) {
    const dup = await response.json();
    return { jobId: dup.job_id, status: dup.status, duplicate: true };
  }

  const data = await response.json();
  return { jobId: data.job_id, status: data.status, duplicate: false };
}

// Check status via the VALET-specific endpoint
async function getJobStatus(jobId: string) {
  const res = await fetch(`${GH_API}/api/v1/gh/valet/status/${jobId}`, {
    headers: { 'X-GH-Service-Key': GH_KEY },
  });
  return res.json();
}

// Handle the callback webhook (in VALET's webhook handler)
async function handleGhostHandsCallback(req: Request) {
  const payload = await req.json();
  // payload: { job_id, valet_task_id, status, result_data, screenshot_url, ... }

  // Update VALET's task record with the result
  await db.update('tasks')
    .set({
      automation_status: payload.status,
      automation_result: payload.result_data,
      completed_at: payload.completed_at,
    })
    .where('id', payload.valet_task_id);

  return new Response('OK', { status: 200 });
}
```

### Using the Generic API

```typescript
const GH_API = process.env.GHOSTHANDS_API_URL || 'http://localhost:3100';
const GH_KEY = process.env.GH_SERVICE_SECRET;

// Create a job
async function submitApplication(userId: string, jobUrl: string, resumeId: string) {
  const response = await fetch(`${GH_API}/api/v1/gh/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GH-Service-Key': GH_KEY,
    },
    body: JSON.stringify({
      user_id: userId,
      job_type: 'apply',
      target_url: jobUrl,
      task_description: `Apply to position at ${new URL(jobUrl).hostname}`,
      input_data: {
        resume_id: resumeId,
        tier: 'starter',
      },
    }),
  });

  return response.json(); // { id, status, created_at }
}

// Poll for job completion
async function waitForJob(jobId: string): Promise<string> {
  while (true) {
    const res = await fetch(`${GH_API}/api/v1/gh/jobs/${jobId}/status`, {
      headers: { 'X-GH-Service-Key': GH_KEY },
    });
    const { status } = await res.json();
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise(r => setTimeout(r, 3000));
  }
}
```

---

## curl Examples

```bash
# Health check
curl http://localhost:3100/health

# ── VALET endpoints ──────────────────────────────────

# Submit application via VALET endpoint
curl -X POST http://localhost:3100/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production" \
  -d '{
    "valet_task_id": "valet-task-001",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "target_url": "https://boards.greenhouse.io/company/jobs/12345",
    "platform": "greenhouse",
    "profile": {
      "first_name": "Jane",
      "last_name": "Smith",
      "email": "jane@example.com"
    },
    "quality": "balanced"
  }'

# Check status via VALET endpoint
curl http://localhost:3100/api/v1/gh/valet/status/<JOB_ID> \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production"

# Submit generic task via VALET endpoint
curl -X POST http://localhost:3100/api/v1/gh/valet/task \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production" \
  -d '{
    "valet_task_id": "valet-task-002",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "job_type": "scrape",
    "target_url": "https://company.com/careers",
    "task_description": "Extract all open positions"
  }'

# ── Generic endpoints ────────────────────────────────

# Create job
curl -X POST http://localhost:3100/api/v1/gh/jobs \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production" \
  -d '{
    "user_id": "00000000-0000-0000-0000-000000000001",
    "job_type": "apply",
    "target_url": "https://example.com/careers/swe",
    "task_description": "Apply to software engineer position",
    "input_data": { "tier": "starter" }
  }'

# Check status
curl http://localhost:3100/api/v1/gh/jobs/<JOB_ID>/status \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production"

# List all jobs
curl "http://localhost:3100/api/v1/gh/jobs?limit=10" \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production"

# Cancel a job
curl -X POST http://localhost:3100/api/v1/gh/jobs/<JOB_ID>/cancel \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production"

# Retry a failed job
curl -X POST http://localhost:3100/api/v1/gh/jobs/<JOB_ID>/retry \
  -H "X-GH-Service-Key: test-service-key-for-development-only-change-in-production"
```
