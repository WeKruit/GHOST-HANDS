# GhostHands Deployment Pipeline

**Last Updated:** 2026-02-18

This document maps the entire CI/CD pipeline from git push to running code on EC2.

---

## Pipeline Overview

```
git push (main or staging)
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ GitHub Actions CI (.github/workflows/ci.yml)                │
│     ├── typecheck (bun run build)                               │
│     ├── test-unit (bun run test:unit)                           │
│     └── test-integration (needs Supabase secrets)               │
└────────────────────────┬────────────────────────────────────────┘
                         │ (push to main or staging)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ Docker Build & Push to ECR                                  │
│     staging: ECR:staging-$sha                                   │
│     main:    ECR:$sha + :latest                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ Deploy Webhook to VALET                                     │
│     POST $VALET_DEPLOY_WEBHOOK_URL                              │
│     Event: ghosthands.deploy_ready                              │
│     HMAC-SHA256 signed with VALET_DEPLOY_WEBHOOK_SECRET         │
│     Handler: VALET /api/v1/webhooks/ghosthands/deploy           │
└────────────────────────┬────────────────────────────────────────┘
                         │ (if auto-deploy enabled)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ VALET DeployService → Rolling Deploy                        │
│     1. Creates deploy record + notifies admins                  │
│     2. Checks config:auto_deploy:<environment> in Redis         │
│     3. If enabled: finds running sandboxes for environment      │
│     4. For each sandbox:                                        │
│        a. GET http://<ip>:8000/health → check activeWorkers     │
│        b. Wait for drain (poll until activeWorkers == 0)        │
│        c. POST http://<ip>:8000/deploy { image_tag }            │
│     5. Updates deploy status (deploying → completed/failed)     │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ EC2 Deploy Server (port 8000)                               │
│     scripts/deploy-server.ts — Bun HTTP server                  │
│     1. Verifies X-Deploy-Secret header                          │
│     2. Runs scripts/deploy-manual.sh deploy <image_tag>         │
│        → ECR login, docker compose pull, graceful drain,        │
│          compose up, health check, rollback on failure           │
│     3. Returns { success, message } to VALET                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ✅ Worker Start & Registration                                 │
│     1. Worker UPSERT into gh_worker_registry (3 retries)        │
│     2. Heartbeat every 30s                                      │
│     3. HTTP status server on GH_WORKER_PORT (default 3101)      │
│     4. SIGTERM → drain → deregister → exit                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Branch / Environment Mapping

| Branch | Image Tag | Deploy Target | Auto-Deploy |
|--------|-----------|---------------|-------------|
| `staging` | `staging-<sha>` | Staging sandboxes | Via VALET admin config |
| `main` | `<sha>` + `latest` | Staging first, then production | Via VALET admin config |

**Flow for main branch:**
1. CI builds image tagged `<sha>` + `latest`
2. `deploy-staging` job sends webhook with `environment: staging`
3. After staging succeeds, `deploy-production` sends webhook with `environment: production`

**Flow for staging branch:**
1. CI builds image tagged `staging-<sha>` (no `:latest`)
2. `deploy-staging` job sends webhook with `environment: staging`
3. No production deploy

---

## Step-by-Step Details

### Step 1: GitHub Actions CI

**File:** `.github/workflows/ci.yml`

| Trigger | Jobs |
|---------|------|
| Push to main | typecheck, test-unit, test-integration, docker, deploy-staging, deploy-production |
| Push to staging | typecheck, test-unit, test-integration, docker, deploy-staging |
| PR to main | typecheck, test-unit, test-integration |

**Secrets required:**

| Secret | Used by |
|--------|---------|
| `SUPABASE_URL` | test-integration |
| `SUPABASE_SECRET_KEY` | test-integration |
| `SUPABASE_PUBLISHABLE_KEY` | test-integration |
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

### Step 2: Docker Build

**File:** `Dockerfile`

Multi-stage build:
1. **deps** (`oven/bun:1.2-debian`): `bun install --frozen-lockfile`
2. **build**: Copy source + `bun run build` (TypeScript compilation)
3. **runtime**: System deps for Chromium, Patchright browser install, non-root user

Build args baked into image:
- `COMMIT_SHA` — Git commit SHA
- `BUILD_TIME` — ISO 8601 build timestamp
- `IMAGE_TAG` — ECR image tag (includes `staging-` prefix for staging)

Same image, different CMD:
- API: `bun packages/ghosthands/src/api/server.ts` (port 3100)
- Worker: `bun packages/ghosthands/src/workers/main.ts` (port 3101)
- Deploy Server: `bun scripts/deploy-server.ts` (port 8000)

### Step 3: ECR Push

- Staging: `$ECR_REGISTRY/$ECR_REPOSITORY:staging-$SHA`
- Main: `$ECR_REGISTRY/$ECR_REPOSITORY:$SHA` + `:latest`

### Step 4: Deploy Webhook

CI sends HMAC-signed POST to VALET with payload:
```json
{
  "event": "ghosthands.deploy_ready",
  "image": "ECR_REGISTRY/ECR_REPOSITORY:TAG",
  "image_tag": "staging-SHA or SHA",
  "commit_sha": "...",
  "commit_message": "...",
  "branch": "staging|main",
  "environment": "staging|production",
  "run_url": "https://github.com/.../actions/runs/..."
}
```

Headers:
- `X-GH-Webhook-Signature: sha256=HMAC`
- `X-GH-Event: deploy_ready`
- `X-GH-Environment: staging|production`

**VALET handler:** `POST /api/v1/webhooks/ghosthands/deploy` — verifies HMAC signature, creates deploy record, checks auto-deploy config.

### Step 5: VALET DeployService

**File (VALET):** `apps/api/src/modules/sandboxes/deploy.service.ts`

Rolling deploy across sandboxes:
1. `createFromWebhook()` creates deploy record in Redis
2. Checks `config:auto_deploy:<environment>` Redis key
3. If enabled, `triggerDeploy()` starts rolling deploy:
   - Finds sandboxes with matching environment + `ec2Status: running`
   - For each: drain → deploy → verify
4. Admins can manually trigger via `POST /api/v1/admin/deploys/:id/trigger`

**Drain logic:**
- `GET http://<ip>:8000/health` → reads `activeWorkers` count
- Polls every 5s until `activeWorkers === 0` (5-minute timeout)

**Deploy call:**
- `POST http://<ip>:8000/deploy` with `{ image_tag }` body
- 60-second timeout
- Expects `{ success: boolean, message: string }` response

### Step 6: EC2 Deploy Server

**File:** `scripts/deploy-server.ts`

Lightweight Bun HTTP server running on port 8000 on each EC2 sandbox.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | None | Returns `activeWorkers` count for drain logic |
| `GET /version` | None | Returns current image version info |
| `POST /deploy` | `X-Deploy-Secret` | Triggers `deploy.sh deploy <image_tag>` |
| `POST /drain` | `X-Deploy-Secret` | Triggers `deploy.sh drain` |

**Auth:** `X-Deploy-Secret` header must match `GH_DEPLOY_SECRET` env var (timing-safe comparison).

**Required env var:** `GH_DEPLOY_SECRET` — shared secret between VALET and EC2 deploy servers.

### Step 7: Worker Registration

On startup (`workers/main.ts`):
1. UPSERT into `gh_worker_registry` (worker_id, status=active, ec2 metadata)
2. 3-retry registration with exponential backoff (2s, 4s)
3. Verification query after insert
4. Heartbeat every 30s (updates last_heartbeat, current_job_id, status)
5. On SIGTERM: drain active jobs → mark offline → exit

---

## Enabling Auto-Deploy

Auto-deploy is controlled per-environment via VALET admin API:

```bash
# Check current config
curl -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.valet.app/api/v1/admin/deploys/config

# Enable auto-deploy for staging
curl -X PUT -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"staging": true}' \
  https://api.valet.app/api/v1/admin/deploys/config

# Enable auto-deploy for production
curl -X PUT -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"prod": true}' \
  https://api.valet.app/api/v1/admin/deploys/config
```

**Recommended setup:**
- Staging: auto-deploy enabled (pushes to `staging` branch auto-deploy)
- Production: auto-deploy disabled (manual trigger via admin UI after staging verification)

---

## Verifying Deployed Version

After deploying, check what code is running:

```bash
# Via deploy server (port 8000)
curl -s http://<sandbox_ip>:8000/version | jq

# Via GH API (port 3100, localhost only)
ssh ec2-user@HOST "curl -s http://localhost:3100/health/version" | jq

# Via deploy script
./scripts/deploy-ec2.sh --verify
```

Returns:
```json
{
  "service": "ghosthands",
  "environment": "staging",
  "commit_sha": "a44c35d...",
  "image_tag": "staging-a44c35d...",
  "build_time": "2026-02-18T12:00:00Z",
  "uptime_ms": 12345,
  "node_env": "production"
}
```

---

## Manual Deploy Workflow

For manual deploys (or when auto-deploy is disabled):

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

## Docker Compose Files

| File | Environment | Deploy Server | Notes |
|------|-------------|---------------|-------|
| `docker-compose.prod.yml` | Production | Port 8000 | `GH_ENVIRONMENT=production` (default) |
| `docker-compose.staging.yml` | Staging | Port 8000 | `GH_ENVIRONMENT=staging` |

Both include: API (3100), Worker (3101), Deploy Server (8000).

`scripts/deploy-manual.sh` auto-detects compose file based on `GH_ENVIRONMENT` env var.
Primary deploys now use Kamal (`config/deploy.yml`).

---

## EC2 Environment Setup

Required env vars in `.env` on each EC2 sandbox:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase API URL |
| `SUPABASE_SECRET_KEY` | Service key for DB access |
| `DATABASE_URL` | Postgres connection string |
| `GH_SERVICE_SECRET` | API authentication |
| `GH_ENCRYPTION_KEY` | AES-256-GCM for credentials |
| `GH_DEPLOY_SECRET` | Deploy server auth (shared with VALET) |
| `GH_ENVIRONMENT` | `staging` or `production` |
| `ECR_REGISTRY` | ECR registry URL |
| `ECR_REPOSITORY` | ECR repository name |
| `AWS_REGION` | AWS region for ECR login |
| `GH_WORKER_ID` | Worker identity for registry |
| `EC2_INSTANCE_ID` | EC2 instance metadata |
| `EC2_IP` | EC2 public IP |

---

## VALET-Side Setup

### GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `AWS_ACCESS_KEY_ID` | ECR push |
| `AWS_SECRET_ACCESS_KEY` | ECR push |
| `AWS_REGION` | ECR push |
| `ECR_REPOSITORY` | ECR push |
| `ECR_REGISTRY` | Deploy webhook payload |
| `VALET_DEPLOY_WEBHOOK_URL` | Where CI sends deploy notifications |
| `VALET_DEPLOY_WEBHOOK_SECRET` | HMAC signing for webhook |
| `SUPABASE_URL` | Integration tests |
| `SUPABASE_SECRET_KEY` | Integration tests |
| `SUPABASE_PUBLISHABLE_KEY` | Integration tests |
| `SUPABASE_DIRECT_URL` | Integration tests |
| `GH_SERVICE_SECRET` | Integration tests |
| `GH_ENCRYPTION_KEY` | Integration tests |

### VALET Environment Variables

| Variable | Purpose |
|----------|---------|
| `VALET_DEPLOY_WEBHOOK_SECRET` | Verify HMAC signature from GH CI |
| `GH_DEPLOY_SECRET` | Auth header sent to EC2 deploy server |

**Note:** `GH_DEPLOY_SECRET` must be set in VALET's environment so the DeployService can authenticate with EC2 deploy servers. VALET's `deployToSandbox()` method needs to include `X-Deploy-Secret` header. This is a pending change on the VALET side.

---

## Troubleshooting

### Image pushed to ECR but not deployed
1. Check if VALET webhook URL is configured: `VALET_DEPLOY_WEBHOOK_URL`
2. Check CI logs for webhook response status
3. Check VALET API logs for webhook handler errors
4. Check if auto-deploy is enabled: `GET /api/v1/admin/deploys/config`
5. Manually trigger: `POST /api/v1/admin/deploys/:id/trigger`

### Deploy server returning 401
- Verify `GH_DEPLOY_SECRET` matches between VALET and EC2
- Check `X-Deploy-Secret` header is being sent

### Worker not registering after deploy
- Check `gh_worker_registry` table
- Verify `SUPABASE_SECRET_KEY` and `DATABASE_URL` in `.env`
- Check worker container logs: `docker compose -f docker-compose.prod.yml logs worker`

### Health check failing
- API must be healthy before worker starts (depends_on condition)
- Check port 3100 is accessible: `curl http://localhost:3100/health`
- Check deploy server port 8000: `curl http://localhost:8000/health`
