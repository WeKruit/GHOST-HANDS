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

## API Reference

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

**Job types:** `apply`, `scrape`, `fill_form`, `custom`
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

## VALET Integration Example

From the VALET backend (Node.js/TypeScript):

```typescript
const GH_API = process.env.GHOSTHANDS_API_URL || 'http://localhost:3100';
const GH_KEY = process.env.GH_SERVICE_SECRET;

// Create a job application
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
