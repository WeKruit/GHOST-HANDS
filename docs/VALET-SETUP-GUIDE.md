# GhostHands Setup Guide for VALET

> Everything VALET needs to install, integrate, and manage GhostHands
> on your EC2 fleet.

---

## Table of Contents

1. [What is GhostHands](#1-what-is-ghosthands)
2. [EC2 Setup](#2-ec2-setup)
3. [Verify Installation](#3-verify-installation)
4. [API Integration](#4-api-integration)
5. [Callback Webhooks](#5-callback-webhooks)
6. [Handling Deployments](#6-handling-deployments)
7. [Deploy Script Reference](#7-deploy-script-reference)
8. [Monitoring & Health Checks](#8-monitoring--health-checks)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. What is GhostHands

GhostHands is a browser automation engine that runs job applications, fills
forms, and scrapes data using an AI-controlled browser. It runs as two Docker
containers on each EC2 instance:

- **API** (`127.0.0.1:3100`) — receives job requests from VALET
- **Worker** — picks up jobs from the database, runs Chromium, executes tasks

VALET and GhostHands share the same Supabase database. VALET sends automation
requests via the API; GhostHands executes them and (optionally) calls back
with results.

```
VALET Backend ──► http://localhost:3100/api/v1/gh/valet/apply ──► GhostHands API
                                                                       │
                                                                       ▼
                                                                 GhostHands Worker
                                                                 (Chromium + AI)
                                                                       │
                                                                       ▼
                                                              Callback to VALET
                                                              (POST callback_url)
```

---

## 2. EC2 Setup

### 2.1 Prerequisites

Each EC2 instance needs:

- **Docker** (v24+) and **Docker Compose** (v2+)
- **AWS CLI** (v2) — configured with permissions to pull from ECR
- **Minimum specs:** 2 vCPU, 4GB RAM (worker needs ~2GB for Chromium)

```bash
# Install Docker (if not already installed)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu

# Verify
docker --version        # v24+
docker compose version  # v2+
aws --version           # v2+
```

### 2.2 Clone & Configure

```bash
# Clone the repo
sudo mkdir -p /opt/ghosthands
sudo chown ubuntu:ubuntu /opt/ghosthands
cd /opt/ghosthands
git clone https://github.com/WeKruit/GHOST-HANDS.git .

# Create environment file
cp .env.example .env
```

### 2.3 Configure `.env`

Edit `/opt/ghosthands/.env` with production values:

```bash
# ─── Supabase (same instance as VALET) ───────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...                      # service_role key
DATABASE_URL=postgresql://postgres:pw@db.your-project.supabase.co:5432/postgres

# ─── GhostHands API ──────────────────────────────
GH_API_PORT=3100
GH_SERVICE_SECRET=<shared-secret-min-32-chars>   # VALET uses this to authenticate
CORS_ORIGIN=https://app.wekruit.com
NODE_ENV=production

# ─── LLM Providers ───────────────────────────────
GOOGLE_API_KEY=AIza...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GH_DEFAULT_MODEL=qwen-72b

# ─── Security ────────────────────────────────────
GH_ENCRYPTION_KEY=<base64-encoded-32-byte-key>   # openssl rand -base64 32

# ─── Worker ──────────────────────────────────────
MAX_CONCURRENT_JOBS=2
```

**Important:** `GH_SERVICE_SECRET` is the shared key between VALET and
GhostHands. VALET sends it in the `X-GH-Service-Key` header on every API call.

### 2.4 Set ECR Variables

Add these to the instance profile or export them (the deploy script needs them):

```bash
# Add to /etc/environment or ~/.bashrc
export ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com
export ECR_REPOSITORY=ghosthands
export AWS_REGION=us-east-1
```

### 2.5 First Deploy

```bash
cd /opt/ghosthands

# Login to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ECR_REGISTRY

# Pull and start
export ECR_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:latest"
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

---

## 3. Verify Installation

```bash
# Check containers are running
docker compose -f docker-compose.prod.yml ps

# Health check
curl http://localhost:3100/health
# Expected: {"status":"ok","timestamp":"..."}

# Detailed health (checks DB, storage, etc.)
curl http://localhost:3100/monitoring/health

# Submit a test job
curl -X POST http://localhost:3100/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: <your-GH_SERVICE_SECRET>" \
  -d '{
    "valet_task_id": "test-001",
    "valet_user_id": "00000000-0000-0000-0000-000000000001",
    "target_url": "https://httpbin.org/forms/post",
    "profile": {
      "first_name": "Test",
      "last_name": "User",
      "email": "test@example.com"
    },
    "quality": "speed"
  }'
# Expected: 201 with { job_id, valet_task_id, status: "pending", created_at }

# Check job status
curl http://localhost:3100/api/v1/gh/valet/status/<job_id> \
  -H "X-GH-Service-Key: <your-GH_SERVICE_SECRET>"
```

---

## 4. API Integration

### 4.1 Authentication

Every request from VALET must include the service key:

```
X-GH-Service-Key: <GH_SERVICE_SECRET>
```

### 4.2 Submit a Job Application

**`POST /api/v1/gh/valet/apply`**

This is the primary endpoint. It accepts a rich candidate profile, resume
reference, pre-answered screening questions, and an optional callback URL.

```typescript
const response = await fetch('http://localhost:3100/api/v1/gh/valet/apply', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-GH-Service-Key': process.env.GH_SERVICE_SECRET,
  },
  body: JSON.stringify({
    // ── Required ──────────────────────────────────
    valet_task_id: 'your-internal-task-id',  // for correlating results
    valet_user_id: 'user-uuid',              // VALET user ID
    target_url: 'https://boards.greenhouse.io/company/jobs/12345',
    profile: {
      first_name: 'Jane',
      last_name: 'Smith',
      email: 'jane@example.com',
      phone: '+14155551234',
      linkedin_url: 'https://linkedin.com/in/janesmith',
      portfolio_url: 'https://janesmith.dev',
      location: {
        city: 'San Francisco',
        state: 'CA',
        country: 'US',
        zip: '94105',
      },
      work_authorization: 'US Citizen',
      salary_expectation: '$150,000 - $180,000',
      years_of_experience: 8,
      education: [{
        institution: 'MIT',
        degree: 'B.S.',
        field: 'Computer Science',
        graduation_year: 2018,
      }],
      work_history: [{
        company: 'Stripe',
        title: 'Senior Software Engineer',
        start_date: '2020-06',
        end_date: '2025-12',
        description: 'Led payments infrastructure team',
      }],
      skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    },

    // ── Optional ──────────────────────────────────
    platform: 'greenhouse',  // helps GhostHands optimize for the ATS
    resume: {
      storage_path: 'resumes/user-uuid/resume.pdf',  // Supabase Storage path
      // OR s3_key: 'resumes/user-uuid/resume.pdf',
      // OR download_url: 'https://presigned-url...',
    },
    qa_answers: {
      'Are you authorized to work in the US?': 'Yes',
      'Willing to relocate?': 'Yes, to SF Bay Area',
    },
    callback_url: 'https://api.wekruit.com/webhooks/ghosthands',
    quality: 'balanced',      // 'speed' | 'balanced' | 'quality'
    priority: 5,              // 1 (low) to 10 (high)
    timeout_seconds: 300,     // max 1800
    idempotency_key: 'valet-jane-greenhouse-12345',  // prevents duplicates
  }),
});

const data = await response.json();
// { job_id: "uuid", valet_task_id: "your-internal-task-id", status: "pending", created_at: "..." }
```

### 4.3 Submit a Generic Task

**`POST /api/v1/gh/valet/task`**

For non-application tasks (scraping, form filling, custom automation):

```typescript
const response = await fetch('http://localhost:3100/api/v1/gh/valet/task', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-GH-Service-Key': process.env.GH_SERVICE_SECRET,
  },
  body: JSON.stringify({
    valet_task_id: 'scrape-task-001',
    valet_user_id: 'user-uuid',
    job_type: 'scrape',
    target_url: 'https://company.com/careers',
    task_description: 'Extract all open engineering positions with titles and URLs',
    input_data: {},
    callback_url: 'https://api.wekruit.com/webhooks/ghosthands',
    quality: 'speed',
  }),
});
```

### 4.4 Check Job Status

**`GET /api/v1/gh/valet/status/:jobId`**

```typescript
const response = await fetch(
  `http://localhost:3100/api/v1/gh/valet/status/${jobId}`,
  { headers: { 'X-GH-Service-Key': process.env.GH_SERVICE_SECRET } },
);

const status = await response.json();
// {
//   job_id: "uuid",
//   valet_task_id: "your-task-id",
//   status: "completed",         // pending | queued | running | completed | failed | cancelled
//   status_message: "Application submitted successfully",
//   progress: null,
//   result: {
//     data: { confirmation_id: "APP-7890", submitted: true },
//     summary: "Applied to Senior SWE at Stripe via Greenhouse",
//     screenshots: ["https://storage.../screenshot.png"]
//   },
//   error: null,                 // { code, details } if status is "failed"
//   timestamps: {
//     created_at: "2026-02-15T04:28:03Z",
//     started_at: "2026-02-15T04:28:05Z",
//     completed_at: "2026-02-15T04:30:12Z"
//   }
// }
```

### 4.5 Idempotency

If you send the same `idempotency_key` twice, the second request returns
`409 Conflict` with the existing job ID:

```json
{
  "job_id": "existing-uuid",
  "valet_task_id": "your-task-id",
  "status": "running",
  "duplicate": true
}
```

Use this to safely retry failed requests without creating duplicate jobs.

### 4.6 Other Endpoints

These are also available at `/api/v1/gh/`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/jobs` | POST | Create job (generic format) |
| `/jobs/batch` | POST | Create up to 50 jobs at once |
| `/jobs/:id` | GET | Full job details |
| `/jobs/:id/status` | GET | Lightweight status check |
| `/jobs/:id/cancel` | POST | Cancel a running/pending job |
| `/jobs/:id/retry` | POST | Retry a failed job |
| `/jobs` | GET | List jobs (with filters) |
| `/jobs/:id/events` | GET | Job execution event log |
| `/users/:id/usage` | GET | User usage stats |

See [`docs/API-INTEGRATION.md`](./API-INTEGRATION.md) for full details.

---

## 5. Callback Webhooks

When a job completes or fails, GhostHands POSTs to the `callback_url` you
provided:

### 5.1 Callback Payload

```json
{
  "job_id": "ba3856eb-73e2-4b8e-a821-649d52de4ecf",
  "valet_task_id": "your-internal-task-id",
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

For failed jobs:
```json
{
  "job_id": "...",
  "valet_task_id": "...",
  "status": "failed",
  "result_data": null,
  "result_summary": null,
  "screenshot_url": "https://storage.../screenshot-error.png",
  "error_code": "FORM_SUBMIT_FAILED",
  "error_details": { "message": "Submit button not found after 30s" },
  "completed_at": "2026-02-15T04:33:00.000Z"
}
```

### 5.2 Handling the Callback

```typescript
// VALET webhook handler
export async function POST(req: Request) {
  const payload = await req.json();

  // Use valet_task_id to find your internal task record
  await db.update('tasks')
    .set({
      automation_status: payload.status,
      automation_result: payload.result_data,
      error_code: payload.error_code,
      completed_at: payload.completed_at,
    })
    .where('id', payload.valet_task_id);

  // Notify user via Supabase Realtime, email, etc.
  if (payload.status === 'completed') {
    await notifyUser(payload.valet_task_id, 'Application submitted!');
  }

  return new Response('OK', { status: 200 });
}
```

### 5.3 Callback Behavior

- **Retries:** 3 attempts with delays of 1s, 3s, 10s
- **Timeout:** 10s per attempt
- **Fire-and-forget:** Callback failure does not affect the job's final status
- **Your handler should:** Return HTTP 2xx to acknowledge receipt

### 5.4 Alternative: Polling

If you don't want to set up a callback handler, you can poll:

```typescript
async function waitForJob(jobId: string): Promise<any> {
  while (true) {
    const res = await fetch(
      `http://localhost:3100/api/v1/gh/valet/status/${jobId}`,
      { headers: { 'X-GH-Service-Key': process.env.GH_SERVICE_SECRET } },
    );
    const data = await res.json();
    if (['completed', 'failed', 'cancelled'].includes(data.status)) {
      return data;
    }
    await new Promise(r => setTimeout(r, 3000)); // poll every 3s
  }
}
```

### 5.5 Alternative: Supabase Realtime

Since VALET and GhostHands share Supabase, you can subscribe to job updates
directly in the frontend:

```typescript
const channel = supabase
  .channel(`job-${jobId}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'gh_automation_jobs',
    filter: `id=eq.${jobId}`,
  }, (payload) => {
    // payload.new.status, payload.new.result_data, etc.
    updateUI(payload.new);
  })
  .subscribe();
```

---

## 6. Handling Deployments

GhostHands CI/CD builds Docker images and pushes them to ECR. It does **not**
deploy to your EC2 instances. Instead, it sends a webhook to VALET so you
control the rollout.

### 6.1 The Flow

```
GhostHands pushes to main
    │
    ▼
GitHub Actions: typecheck → tests → Docker build → push to ECR
    │
    ▼
Webhook POST to VALET_DEPLOY_WEBHOOK_URL
    │
    ▼
VALET receives webhook, verifies signature
    │
    ▼
VALET triggers rolling update on EC2 fleet
    │
    ▼
On each EC2: ./scripts/deploy.sh deploy <image-tag>
```

### 6.2 Webhook Payload

GhostHands CI/CD sends this to your webhook URL:

```json
{
  "event": "ghosthands.deploy_ready",
  "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/ghosthands:abc123",
  "image_tag": "abc123",
  "image_latest": "123456789.dkr.ecr.us-east-1.amazonaws.com/ghosthands:latest",
  "commit_sha": "abc123def456789",
  "commit_message": "fix: resolve form filling timeout on Workday",
  "branch": "main",
  "repository": "WeKruit/GHOST-HANDS",
  "run_id": "12345678",
  "run_url": "https://github.com/WeKruit/GHOST-HANDS/actions/runs/12345678",
  "timestamp": "2026-02-15T04:28:03Z"
}
```

**Headers:**
```
Content-Type: application/json
X-GH-Webhook-Signature: sha256=<HMAC-SHA256 signature>
X-GH-Event: deploy_ready
```

### 6.3 Verifying the Webhook Signature

```typescript
import crypto from 'crypto';

function verifyWebhook(body: string, signatureHeader: string): boolean {
  const secret = process.env.GH_DEPLOY_WEBHOOK_SECRET;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expected),
  );
}
```

### 6.4 Triggering the Rolling Update

Reference implementation for VALET's deploy controller:

```typescript
export async function handleGhostHandsDeployWebhook(req: Request) {
  const body = await req.text();
  const signature = req.headers.get('X-GH-Webhook-Signature') || '';

  if (!verifyWebhook(body, signature)) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body);
  if (payload.event !== 'ghosthands.deploy_ready') {
    return new Response('Unknown event', { status: 400 });
  }

  // Trigger rolling update (async — don't block the webhook response)
  rollingUpdate(payload.image_tag).catch(console.error);

  return Response.json({ status: 'deploy_initiated' });
}

async function rollingUpdate(imageTag: string) {
  const instances = await getEC2Instances(); // your instance list

  for (const instance of instances) {
    console.log(`Deploying to ${instance.id}...`);

    const result = await sshExec(instance.ip, `
      cd /opt/ghosthands &&
      export ECR_REGISTRY=${process.env.ECR_REGISTRY} &&
      export ECR_REPOSITORY=${process.env.ECR_REPOSITORY} &&
      export AWS_REGION=${process.env.AWS_REGION} &&
      ./scripts/deploy.sh deploy ${imageTag}
    `);

    // Parse output for DEPLOY_STATUS=success
    if (!result.stdout.includes('DEPLOY_STATUS=success')) {
      console.error(`Deploy failed on ${instance.id}. Halting rollout.`);
      // Alert ops team, don't continue to next instance
      break;
    }

    console.log(`${instance.id} updated.`);
  }
}
```

### 6.5 Setup: What VALET Needs to Provide

To enable this flow, set these GitHub Actions secrets in the GhostHands repo:

| Secret | Value | Who provides it |
|--------|-------|-----------------|
| `VALET_DEPLOY_WEBHOOK_URL` | Your webhook endpoint URL | VALET team |
| `VALET_DEPLOY_WEBHOOK_SECRET` | Shared HMAC signing key | Generate together |

Generate the shared secret:
```bash
openssl rand -hex 32
```

Both teams store this value — GhostHands in GitHub Secrets, VALET in its own
secret store.

---

## 7. Deploy Script Reference

**Location:** `scripts/deploy.sh` (on each EC2 instance at `/opt/ghosthands/scripts/deploy.sh`)

### Commands

| Command | What it does |
|---------|-------------|
| `./scripts/deploy.sh deploy <tag>` | ECR login, pull image, drain worker (35s), restart, health check. Auto-rolls back on failure. |
| `./scripts/deploy.sh deploy` | Same as above using `latest` tag |
| `./scripts/deploy.sh rollback` | Roll back to `latest` tag |
| `./scripts/deploy.sh drain` | Stop worker only (60s drain). API keeps running. |
| `./scripts/deploy.sh status` | Show running containers, images, and health |
| `./scripts/deploy.sh health` | Silent health check — exit 0 or exit 1 |

### Required Environment Variables

These must be set on the EC2 instance before running the script:

```bash
ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com
ECR_REPOSITORY=ghosthands
AWS_REGION=us-east-1
```

### Machine-Readable Output

The script prints status lines that VALET can parse:

```
DEPLOY_STATUS=success          # or: rollback, rollback_success, rollback_failed
DEPLOY_TAG=abc123def
DEPLOY_IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/ghosthands:abc123def
DRAIN_STATUS=success
HEALTH_STATUS=healthy          # or: unhealthy
```

---

## 8. Monitoring & Health Checks

### 8.1 Health Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | No | Basic liveness (`{"status":"ok"}`) |
| `GET /monitoring/health` | No | Deep check (DB, storage, LLM providers) |
| `GET /monitoring/metrics` | No | Prometheus-format metrics |

### 8.2 Recommended Monitoring

| What to watch | How | Alert if |
|--------------|-----|----------|
| API liveness | `curl localhost:3100/health` every 30s | Non-200 for > 2 min |
| Pending job queue | Query `gh_automation_jobs WHERE status='pending'` | > 20 pending for > 5 min |
| Job failure rate | Query `gh_job_events` | > 30% failure over 1 hour |
| Worker heartbeat | `last_heartbeat` on running jobs | Stale > 2 min |
| Container status | `docker compose ps` | Any container not "running" |

### 8.3 Logs

```bash
# API logs
docker compose -f docker-compose.prod.yml logs -f api

# Worker logs
docker compose -f docker-compose.prod.yml logs -f worker

# Both
docker compose -f docker-compose.prod.yml logs -f

# Last 100 lines
docker compose -f docker-compose.prod.yml logs --tail 100 worker
```

Logs are JSON-structured and capped at 50MB per container (rotated, 5 files).

---

## 9. Troubleshooting

### API returns 401

VALET is sending the wrong service key. Check that `X-GH-Service-Key` matches
the `GH_SERVICE_SECRET` in GhostHands' `.env` file.

```bash
# Verify the key works
curl -H "X-GH-Service-Key: $(grep GH_SERVICE_SECRET /opt/ghosthands/.env | cut -d= -f2)" \
  http://localhost:3100/api/v1/gh/jobs
```

### Health check failing

```bash
# Check if containers are running
docker compose -f docker-compose.prod.yml ps

# Check API logs for errors
docker compose -f docker-compose.prod.yml logs --tail 50 api

# Common causes:
# - Missing env vars (SUPABASE_URL, SUPABASE_SERVICE_KEY)
# - Database unreachable
# - Port 3100 already in use
```

### Worker not picking up jobs

```bash
# Check worker logs
docker compose -f docker-compose.prod.yml logs --tail 50 worker

# Common causes:
# - DATABASE_URL not set (worker needs direct Postgres for LISTEN/NOTIFY)
# - Worker hasn't connected yet (check for "Postgres connection established" in logs)
# - All workers are at MAX_CONCURRENT_JOBS capacity
```

### Jobs stuck in "running" state

Jobs with stale heartbeats (> 2 min) are auto-recovered on worker restart.
To force recovery:

```bash
# Restart the worker
docker compose -f docker-compose.prod.yml restart worker

# Or manually re-queue via SQL
psql $DATABASE_URL -c "
  UPDATE gh_automation_jobs
  SET status = 'pending', worker_id = NULL
  WHERE status IN ('queued', 'running')
    AND last_heartbeat < NOW() - INTERVAL '2 minutes';
"
```

### Deploy fails — ECR login error

```bash
# Verify AWS credentials
aws sts get-caller-identity

# Verify ECR access
aws ecr describe-repositories --region $AWS_REGION

# Manual ECR login
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ECR_REGISTRY
```

### Callback not received

- Verify `callback_url` is reachable from the EC2 instance
- Check worker logs for callback errors: `grep "callback" <(docker compose logs worker)`
- Callbacks retry 3 times (1s, 3s, 10s delays) — if all fail, the callback is dropped
- The job itself still completes/fails normally regardless of callback status

### Out of memory

Worker runs Chromium which uses ~500MB per active browser session. With
`MAX_CONCURRENT_JOBS=2`, the worker needs ~1.5–2GB RAM.

```bash
# Check memory usage
docker stats --no-stream

# Reduce concurrency if needed
# Edit .env: MAX_CONCURRENT_JOBS=1
docker compose -f docker-compose.prod.yml restart worker
```

---

## Quick Reference Card

```
# ── API Base URL ──────────────────────────────────
http://localhost:3100/api/v1/gh

# ── Auth Header ───────────────────────────────────
X-GH-Service-Key: <GH_SERVICE_SECRET>

# ── Key Endpoints ─────────────────────────────────
POST /valet/apply           Submit job application (rich profile)
POST /valet/task            Submit generic task
GET  /valet/status/:id      Check job status
POST /jobs/:id/cancel       Cancel a job
POST /jobs/:id/retry        Retry a failed job
GET  /health                Liveness check

# ── Deploy Commands (on EC2) ──────────────────────
./scripts/deploy.sh deploy <tag>   # Deploy specific image
./scripts/deploy.sh rollback       # Roll back to latest
./scripts/deploy.sh status         # Check what's running
./scripts/deploy.sh health         # Exit 0/1 health check
./scripts/deploy.sh drain          # Stop worker only

# ── Logs ──────────────────────────────────────────
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f worker
```

---

*Last updated: 2026-02-14*
*For deeper technical details, see:*
- [`docs/API-INTEGRATION.md`](./API-INTEGRATION.md) — full API reference
- [`docs/14-deployment-strategy.md`](./14-deployment-strategy.md) — architecture & CI/CD details
