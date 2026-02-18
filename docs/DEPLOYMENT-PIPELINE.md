# GhostHands Deployment Pipeline

**Last Updated:** 2026-02-18

This document maps the entire CI/CD pipeline from git push to running code on EC2, marking each step's status.

---

## Pipeline Overview

```
git push main
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ GitHub Actions CI (.github/workflows/ci.yml)                │
│     ├── typecheck (bun run build)                               │
│     ├── test-unit (bun run test:unit)                           │
│     └── test-integration (needs Supabase secrets)               │
└────────────────────────┬────────────────────────────────────────┘
                         │ (main branch push only)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ Docker Build & Push to ECR                                  │
│     docker build --build-arg COMMIT_SHA=... → ECR:$sha + :latest│
│     Needs: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION │
│            ECR_REPOSITORY                                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ⚠️  Deploy Webhook to VALET                                    │
│     POST $VALET_DEPLOY_WEBHOOK_URL                              │
│     Event: ghosthands.deploy_ready                              │
│     HMAC-SHA256 signed with VALET_DEPLOY_WEBHOOK_SECRET         │
│                                                                 │
│     Status: CI sends it, but VALET handler is NOT yet built.    │
│     Webhook silently fails (non-blocking), logged as warning.   │
└────────────────────────┬────────────────────────────────────────┘
                         │ (intended: VALET → EC2 deploy trigger)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ❌ EC2 Container Restart — THE BROKEN LINK                     │
│                                                                 │
│     Current state: NOTHING triggers EC2 to pull the new image.  │
│     - No VALET DeployService (handler doesn't exist)            │
│     - No watchtower or image polling agent on EC2               │
│     - No cron job or systemd timer                              │
│                                                                 │
│     The deploy.sh script EXISTS and is complete, but            │
│     nobody calls it automatically.                              │
│                                                                 │
│     WORKAROUND: Manual deploy via scripts/deploy-ec2.sh         │
│       ./scripts/deploy-ec2.sh              # Full pipeline      │
│       ./scripts/deploy-ec2.sh --deploy-only # Just EC2 restart  │
│       ./scripts/deploy-ec2.sh --verify      # Check version     │
└────────────────────────┬────────────────────────────────────────┘
                         │ (when deploy.sh runs)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ Worker Start & Registration                                 │
│     1. ECR login + docker compose pull                          │
│     2. Graceful drain (HTTP POST /worker/drain → wait for idle) │
│     3. docker compose up -d (API + Worker)                      │
│     4. Restart any targeted workers                             │
│     5. Health check (30 attempts, 2s interval)                  │
│     6. Worker UPSERT into gh_worker_registry                    │
│     7. Heartbeat every 30s                                      │
│     8. SIGTERM → drain → deregister → exit                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Details

### Step 1: GitHub Actions CI ✅

**File:** `.github/workflows/ci.yml`

| Trigger | Jobs |
|---------|------|
| Push to main | typecheck, test-unit, test-integration, docker, deploy-staging, deploy-production |
| PR to main | typecheck, test-unit, test-integration |

**Secrets required:**

| Secret | Used by |
|--------|---------|
| `SUPABASE_URL` | test-integration |
| `SUPABASE_SERVICE_KEY` | test-integration |
| `SUPABASE_DIRECT_URL` | test-integration |
| `GH_SERVICE_SECRET` | test-integration |
| `GH_ENCRYPTION_KEY` | test-integration |
| `AWS_ACCESS_KEY_ID` | docker |
| `AWS_SECRET_ACCESS_KEY` | docker |
| `AWS_REGION` | docker |
| `ECR_REPOSITORY` | docker |
| `ECR_REGISTRY` | deploy-staging, deploy-production |
| `VALET_DEPLOY_WEBHOOK_URL` | deploy-staging, deploy-production |
| `VALET_DEPLOY_WEBHOOK_SECRET` | deploy-staging, deploy-production |

### Step 2: Docker Build ✅

**File:** `Dockerfile`

Multi-stage build:
1. **deps** (`oven/bun:1.2-debian`): `bun install --frozen-lockfile`
2. **build**: Copy source + `bun run build` (TypeScript compilation)
3. **runtime**: System deps for Chromium, Patchright browser install, non-root user

Build args baked into image:
- `COMMIT_SHA` — Git commit SHA
- `BUILD_TIME` — ISO 8601 build timestamp
- `IMAGE_TAG` — ECR image tag

Same image, different CMD:
- API: `bun packages/ghosthands/src/api/server.ts` (port 3100)
- Worker: `bun packages/ghosthands/src/workers/main.ts` (port 3101)

### Step 3: ECR Push ✅

Tags: `$ECR_REGISTRY/$ECR_REPOSITORY:$COMMIT_SHA` + `:latest`

### Step 4: Deploy Webhook ⚠️

CI sends HMAC-signed POST to VALET with payload:
```json
{
  "event": "ghosthands.deploy_ready",
  "image": "ECR_REGISTRY/ECR_REPOSITORY:SHA",
  "image_tag": "SHA",
  "commit_sha": "...",
  "commit_message": "...",
  "environment": "staging|production",
  "run_url": "https://github.com/.../actions/runs/..."
}
```

Headers:
- `X-GH-Webhook-Signature: sha256=HMAC`
- `X-GH-Event: deploy_ready`
- `X-GH-Environment: staging|production`

**Current gap:** VALET does not have a webhook handler for this event. The webhook returns a non-2xx status and CI logs a warning. Non-blocking.

### Step 5: EC2 Container Restart ❌

**This is the broken link.** There is no automation to pull the new image on EC2.

**`scripts/deploy.sh`** is the intended mechanism — it's comprehensive and handles:
- ECR login + docker compose pull
- Graceful worker drain (HTTP + SIGTERM fallback)
- Compose up with new image
- Targeted worker restart
- Health check with retry
- Rollback on failure

But nothing invokes it automatically.

### Step 6: Worker Registration ✅

On startup (`workers/main.ts`):
1. UPSERT into `gh_worker_registry` (worker_id, status=active, ec2 metadata)
2. Heartbeat every 30s (updates last_heartbeat, current_job_id, status)
3. On SIGTERM: drain active jobs → mark offline → exit

---

## Verifying Deployed Version

After deploying, check what code is running:

```bash
# Via SSH
ssh ec2-user@HOST "curl -s http://localhost:3100/health/version" | jq

# Via deploy script
./scripts/deploy-ec2.sh --verify
```

Returns:
```json
{
  "service": "ghosthands",
  "commit_sha": "a44c35d...",
  "image_tag": "a44c35d...",
  "build_time": "2026-02-18T12:00:00Z",
  "uptime_ms": 12345,
  "node_env": "production"
}
```

---

## Manual Deploy Workflow

Until the VALET deploy webhook handler is built, use the manual deploy script:

```bash
# Full pipeline: build → push ECR → SSH deploy → verify
./scripts/deploy-ec2.sh

# Just push to ECR (CI is broken but you have AWS creds)
./scripts/deploy-ec2.sh --push-only

# Just restart EC2 (image already in ECR from CI)
./scripts/deploy-ec2.sh --deploy-only

# Check what's running
./scripts/deploy-ec2.sh --status
./scripts/deploy-ec2.sh --verify
```

Configuration: copy `.env.deploy.example` to `.env.deploy`.

---

## What Needs to Be Built

### Priority 1: VALET Deploy Webhook Handler
Build `POST /api/v1/webhooks/ghosthands/deploy` in VALET that:
1. Validates HMAC-SHA256 signature
2. Records deployment in database
3. SSHs to EC2 (or calls an EC2 endpoint) to run `scripts/deploy.sh deploy <tag>`
4. Reports success/failure back

### Priority 2: EC2 Deploy Agent (Alternative)
Instead of VALET triggering deploys, run a lightweight agent on EC2 that:
- Polls ECR for new `:latest` tag every 60s
- Compares with currently running image digest
- If different, runs `scripts/deploy.sh deploy latest`

This is simpler than SSH-based deploys and doesn't require VALET to have EC2 access.

---

## Docker Compose (Production)

**File:** `docker-compose.prod.yml`

- References `${ECR_IMAGE}` for both API and Worker
- API on port 3100 (localhost only), Worker on port 3101
- Health checks, restart policies, log rotation
- Memory limits: API 512MB, Worker 2GB
- `MAX_CONCURRENT_JOBS=1` (single-task-per-worker)

---

## GitHub Actions Secrets Checklist

| Secret | Purpose | Set? |
|--------|---------|------|
| `AWS_ACCESS_KEY_ID` | ECR push | Check in GitHub Settings |
| `AWS_SECRET_ACCESS_KEY` | ECR push | Check in GitHub Settings |
| `AWS_REGION` | ECR push | Check in GitHub Settings |
| `ECR_REPOSITORY` | ECR push | Check in GitHub Settings |
| `ECR_REGISTRY` | Deploy webhook payload | Check in GitHub Settings |
| `SUPABASE_URL` | Integration tests | Check in GitHub Settings |
| `SUPABASE_SERVICE_KEY` | Integration tests | Check in GitHub Settings |
| `SUPABASE_DIRECT_URL` | Integration tests | Check in GitHub Settings |
| `GH_SERVICE_SECRET` | Integration tests | Check in GitHub Settings |
| `GH_ENCRYPTION_KEY` | Integration tests | Check in GitHub Settings |
| `VALET_DEPLOY_WEBHOOK_URL` | Deploy notification | Optional until handler exists |
| `VALET_DEPLOY_WEBHOOK_SECRET` | Deploy notification | Optional until handler exists |

**To check:** Go to GitHub → Settings → Secrets and variables → Actions
