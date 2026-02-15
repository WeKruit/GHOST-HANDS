# 14 - GhostHands Deployment Strategy & VALET Integration

> Complete deployment architecture for GhostHands: Docker images pushed to ECR,
> rolling updates controlled by VALET across its EC2 fleet.

---

## Table of Contents

1. [Deployment Architecture](#1-deployment-architecture)
2. [Process Architecture](#2-process-architecture)
3. [Docker Configuration](#3-docker-configuration)
4. [CI/CD Pipeline](#4-cicd-pipeline)
5. [VALET-Controlled Deployment](#5-valet-controlled-deployment)
6. [Configuration Management](#6-configuration-management)
7. [Scaling Strategy](#7-scaling-strategy)
8. [Monitoring & Observability](#8-monitoring--observability)
9. [Runbooks](#9-runbooks)

---

## 1. Deployment Architecture

### 1.1 Architecture Diagram

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          GitHub Actions CI/CD                             │
│                                                                           │
│  Push to main → typecheck → test → docker build → push to ECR            │
│                                                       │                   │
│                                                       ▼                   │
│                                            ┌──────────────────┐           │
│                                            │  AWS ECR          │           │
│                                            │  ghosthands:sha   │           │
│                                            │  ghosthands:latest│           │
│                                            └────────┬─────────┘           │
│                                                     │                     │
│                           Webhook: deploy_ready     │                     │
│                           (image tag + commit SHA)  │                     │
└─────────────────────────────────────────────────────┼─────────────────────┘
                                                      │
                                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     VALET Deployment Controller                           │
│                                                                           │
│  1. Receives webhook from GhostHands CI/CD                               │
│  2. Validates HMAC signature                                             │
│  3. Triggers rolling update across EC2 fleet:                            │
│     ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                 │
│     │  EC2 #1     │   │  EC2 #2     │   │  EC2 #N     │                 │
│     │  drain      │   │  (serving)  │   │  (serving)  │                 │
│     │  pull new   │   │             │   │             │                 │
│     │  restart    │   │             │   │             │                 │
│     │  health ✓   │   │  → drain    │   │             │                 │
│     │  (serving)  │   │  → update   │   │  → drain    │                 │
│     │             │   │  → health ✓ │   │  → update   │                 │
│     └─────────────┘   └─────────────┘   └─────────────┘                 │
└───────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Per EC2 Instance (Docker Compose)                                        │
│                                                                           │
│  ┌──────────────────────┐     ┌──────────────────────────────────┐       │
│  │  ghosthands-api      │     │  ghosthands-worker               │       │
│  │  127.0.0.1:3100      │     │  2GB RAM, 2 CPU                 │       │
│  │  512MB RAM            │     │  Chromium + Patchright           │       │
│  │  Health: /health      │     │  MAX_CONCURRENT_JOBS=2           │       │
│  └──────────┬───────────┘     └──────────────┬───────────────────┘       │
│             │                                 │                           │
│             └──────────┬──────────────────────┘                           │
│                        │                                                  │
│                        ▼                                                  │
│             Supabase (shared with VALET)                                  │
│             PostgreSQL + Storage + Auth + Realtime                        │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Summary

| Component | Runtime | Role | Instances |
|-----------|---------|------|-----------|
| **GhostHands API** | Bun in Docker | REST API, auth, validation, monitoring | 1 per EC2 |
| **GhostHands Worker** | Bun in Docker | Job polling, browser automation, LLM | 1 per EC2 |
| **VALET Controller** | VALET backend | Receives webhook, triggers EC2 updates | Managed by VALET |
| **ECR** | AWS | Docker image registry | Shared |
| **Supabase** | Managed | Postgres, Storage, Auth, Realtime | Shared with VALET |

### 1.3 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **ECR for images** | Same AWS account as VALET EC2, fast pulls, no egress fees |
| **VALET controls deployment** | VALET owns the EC2 fleet; GhostHands doesn't need SSH keys or instance lists |
| **Docker Compose on EC2** | Simple, no ECS/K8s overhead for current scale |
| **API on 127.0.0.1:3100** | VPC-internal only; VALET calls localhost, not public internet |
| **Webhook notification** | Decouples CI/CD from deployment; GhostHands builds, VALET deploys |

---

## 2. Process Architecture

### 2.1 Two-Process Design

GhostHands runs as **two separate processes**: the API server and the worker.
They share no in-memory state and communicate exclusively through the Supabase
database.

```
Process 1: API Server               Process 2: Worker
┌────────────────────────┐          ┌────────────────────────┐
│ bun src/api/server.ts  │          │ bun src/workers/main.ts│
│                        │          │                        │
│ - HTTP request handler │          │ - LISTEN/NOTIFY on     │
│ - Auth middleware       │          │   gh_job_created       │
│ - Zod validation       │          │ - Poll loop (5s)       │
│ - CORS                 │          │ - JobExecutor          │
│ - Monitoring routes    │          │   - TaskHandlerRegistry│
│                        │          │   - BrowserAgent       │
│ Connections:           │          │   - Cost control       │
│ - Supabase pooled      │          │   - Heartbeat (30s)    │
│                        │          │   - Callback notifier  │
│ Port: 3100             │          │                        │
│ Memory: ~128MB–512MB   │          │ Connections:           │
│ CPU: 0.25 vCPU         │          │ - Supabase pooled      │
└────────────────────────┘          │ - Postgres direct      │
                                    │   (for LISTEN/NOTIFY)  │
                                    │                        │
                                    │ Memory: ~1–2GB         │
                                    │ CPU: 1–2 vCPU          │
                                    └────────────────────────┘
```

### 2.2 Graceful Shutdown Sequence

Both processes handle SIGTERM/SIGINT for graceful shutdown:

```
SIGTERM received
    │
    ├── API Server:
    │   1. Stop accepting new connections
    │   2. Drain in-flight requests (5s max)
    │   3. Exit 0
    │
    └── Worker:
        1. Stop polling for new jobs (poller.stop())
        2. Unsubscribe from LISTEN/NOTIFY
        3. Wait for active jobs to finish (30s max)
        4. If jobs still running after 30s, log warning and exit
        5. Close Postgres direct connection
        6. Exit 0
```

This is critical for rolling updates — VALET's deploy script sends `docker compose stop -t 35 worker` to allow active jobs to complete before restarting with the new image.

---

## 3. Docker Configuration

### 3.1 Dockerfile (Production)

```dockerfile
# ──────────────────────────────────────────────────
# Stage 1: Install dependencies
# ──────────────────────────────────────────────────
FROM oven/bun:1.2-debian AS deps

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY packages/ghosthands/package.json packages/ghosthands/
COPY packages/magnitude-core/package.json packages/magnitude-core/
COPY packages/magnitude-extract/package.json packages/magnitude-extract/

RUN bun install --frozen-lockfile

# ──────────────────────────────────────────────────
# Stage 2: Build TypeScript
# ──────────────────────────────────────────────────
FROM deps AS build

COPY packages/ packages/
COPY turbo.json ./

RUN bun run build

# ──────────────────────────────────────────────────
# Stage 3: Production runtime
# ──────────────────────────────────────────────────
FROM oven/bun:1.2-debian AS runtime

# Install Chromium dependencies for Patchright
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
    fonts-noto-color-emoji fonts-liberation curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/ghosthands/dist ./packages/ghosthands/dist
COPY --from=build /app/packages/ghosthands/package.json ./packages/ghosthands/
COPY --from=build /app/packages/ghosthands/node_modules ./packages/ghosthands/node_modules
COPY --from=build /app/packages/magnitude-core/dist ./packages/magnitude-core/dist
COPY --from=build /app/packages/magnitude-core/package.json ./packages/magnitude-core/
COPY --from=build /app/packages/magnitude-extract/dist ./packages/magnitude-extract/dist
COPY --from=build /app/packages/magnitude-extract/package.json ./packages/magnitude-extract/

COPY --from=build /app/packages/ghosthands/src ./packages/ghosthands/src

RUN cd packages/magnitude-core && npx patchright install chromium

RUN groupadd -r ghosthands && useradd -r -g ghosthands -m ghosthands
USER ghosthands

EXPOSE 3100
CMD ["bun", "packages/ghosthands/src/api/server.ts"]
```

### 3.2 docker-compose.prod.yml

```yaml
# Production Docker Compose — run on each EC2 instance
# VALET triggers deploys via scripts/deploy.sh

services:
  api:
    image: ${ECR_IMAGE:-ghosthands:latest}
    command: ["bun", "packages/ghosthands/src/api/server.ts"]
    ports:
      - "127.0.0.1:3100:3100"
    env_file: .env
    environment:
      - NODE_ENV=production
      - GH_API_PORT=3100
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3100/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    deploy:
      resources:
        limits:
          memory: 512m
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

  worker:
    image: ${ECR_IMAGE:-ghosthands:latest}
    command: ["bun", "packages/ghosthands/src/workers/main.ts"]
    env_file: .env
    environment:
      - NODE_ENV=production
      - MAX_CONCURRENT_JOBS=2
    depends_on:
      api:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 2g
          cpus: "2.0"
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
```

### 3.3 docker-compose.yml (Local Development)

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["bun", "--watch", "packages/ghosthands/src/api/server.ts"]
    ports:
      - "3100:3100"
    env_file: .env
    environment:
      - NODE_ENV=development
      - GH_API_PORT=3100
    volumes:
      - ./packages/ghosthands/src:/app/packages/ghosthands/src:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3100/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["bun", "--watch", "packages/ghosthands/src/workers/main.ts"]
    env_file: .env
    environment:
      - NODE_ENV=development
      - MAX_CONCURRENT_JOBS=1
    volumes:
      - ./packages/ghosthands/src:/app/packages/ghosthands/src:ro
    depends_on:
      api:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 2g
          cpus: "2.0"
    restart: unless-stopped
```

---

## 4. CI/CD Pipeline

### 4.1 Pipeline Overview

GhostHands CI/CD builds and tests the code, pushes Docker images to ECR,
and **notifies VALET** when a new image is ready. GhostHands does **not**
deploy directly — VALET controls the EC2 fleet.

```
Push to main:
  typecheck ──┐
              ├── docker build + ECR push ──► notify-valet (webhook)
  test-unit ──┘            │                       │
                           │                       ▼
  test-integration ────────┘               VALET triggers rolling
                                           update on EC2 fleet
PR opened:
  typecheck ──► (no deploy)
  test-unit ──► (no deploy)
  test-integration ──► (no deploy)
```

### 4.2 GitHub Actions Workflow

**File:** `.github/workflows/ci.yml`

| Job | Trigger | Purpose |
|-----|---------|---------|
| `typecheck` | push + PR | TypeScript compilation check |
| `test-unit` | push + PR | Unit tests |
| `test-integration` | push + PR | Integration tests (needs Supabase secrets) |
| `docker` | main push only | Build Docker image, push to ECR with commit SHA + `latest` tags |
| `notify-valet` | main push only | POST webhook to VALET with image tag, SHA, and run metadata |

### 4.3 Webhook Payload

When CI/CD completes successfully on `main`, it sends a webhook to VALET:

```json
{
  "event": "ghosthands.deploy_ready",
  "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/ghosthands:abc123def",
  "image_tag": "abc123def",
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
X-GH-Webhook-Signature: sha256=<HMAC-SHA256 of body using VALET_DEPLOY_WEBHOOK_SECRET>
X-GH-Event: deploy_ready
```

### 4.4 Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `AWS_ROLE_ARN` | IAM role for ECR push (OIDC) |
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `ECR_REGISTRY` | ECR registry URL (e.g., `123456789.dkr.ecr.us-east-1.amazonaws.com`) |
| `ECR_REPOSITORY` | ECR repository name (e.g., `ghosthands`) |
| `VALET_DEPLOY_WEBHOOK_URL` | VALET's endpoint for deploy notifications |
| `VALET_DEPLOY_WEBHOOK_SECRET` | Shared secret for HMAC webhook signatures |
| `SUPABASE_URL` | For integration tests |
| `SUPABASE_SERVICE_KEY` | For integration tests |
| `SUPABASE_DIRECT_URL` | For integration tests |
| `GH_SERVICE_SECRET` | For integration tests |
| `GH_ENCRYPTION_KEY` | For integration tests |

---

## 5. VALET-Controlled Deployment

### 5.1 How It Works

GhostHands does **not** deploy itself. The deployment flow is:

1. **GhostHands CI/CD** pushes a new Docker image to ECR
2. **GhostHands CI/CD** sends a `deploy_ready` webhook to VALET
3. **VALET** validates the webhook signature (HMAC-SHA256)
4. **VALET** triggers a rolling update across its EC2 fleet
5. On each EC2 instance, VALET runs `scripts/deploy.sh deploy <image-tag>`
6. The deploy script pulls the new image, drains the worker, restarts, and health checks
7. VALET waits for health confirmation before proceeding to the next instance

### 5.2 Rolling Update Strategy

VALET controls the rollout pace:

```
Instance 1:  drain → pull → restart → health ✓ → serving
Instance 2:         drain → pull → restart → health ✓ → serving
Instance 3:                drain → pull → restart → health ✓ → serving
```

**Rules for VALET's deploy controller:**

1. **One instance at a time** (configurable by VALET)
2. **Drain worker first** — `deploy.sh` stops the worker with a 35s timeout, letting active browser sessions complete
3. **Health check gate** — don't proceed to next instance until `GET /health` returns 200
4. **Auto-rollback** — if health check fails, `deploy.sh` automatically rolls back to `latest` tag
5. **Abort on failure** — if rollback also fails on any instance, VALET should halt the rollout

### 5.3 Deploy Script Reference

**Location:** `scripts/deploy.sh`
**Called by:** VALET (via SSH or local execution on each EC2 instance)

| Command | Description |
|---------|-------------|
| `./scripts/deploy.sh deploy <tag>` | Pull image, drain worker, restart all, health check |
| `./scripts/deploy.sh deploy` | Same as above, using `latest` tag |
| `./scripts/deploy.sh rollback` | Roll back to `latest` tag |
| `./scripts/deploy.sh drain` | Stop worker only (for maintenance) |
| `./scripts/deploy.sh status` | Show running containers and health |
| `./scripts/deploy.sh health` | Exit 0 if healthy, exit 1 if not |

**Required environment variables on EC2:**
```bash
ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com
ECR_REPOSITORY=ghosthands
AWS_REGION=us-east-1
GHOSTHANDS_DIR=/opt/ghosthands   # optional, defaults to /opt/ghosthands
```

**Output parsing:** The deploy script outputs machine-readable status lines that VALET can parse:
```
DEPLOY_STATUS=success
DEPLOY_TAG=abc123def
DEPLOY_IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/ghosthands:abc123def
```

### 5.4 VALET Webhook Handler (Reference Implementation)

```typescript
// In VALET's backend — webhook handler for GhostHands deploy notifications

import crypto from 'crypto';

const WEBHOOK_SECRET = process.env.GH_DEPLOY_WEBHOOK_SECRET;

export async function handleGhostHandsDeployWebhook(req: Request) {
  const body = await req.text();
  const signature = req.headers.get('X-GH-Webhook-Signature');

  // Verify HMAC signature
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  if (signature !== expected) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body);

  if (payload.event !== 'ghosthands.deploy_ready') {
    return new Response('Unknown event', { status: 400 });
  }

  // Trigger rolling update across EC2 fleet
  await triggerRollingUpdate({
    imageTag: payload.image_tag,
    commitSha: payload.commit_sha,
    commitMessage: payload.commit_message,
  });

  return new Response(JSON.stringify({ status: 'deploy_initiated' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function triggerRollingUpdate(params: {
  imageTag: string;
  commitSha: string;
  commitMessage: string;
}) {
  const instances = await getEC2Instances(); // VALET's instance list

  for (const instance of instances) {
    console.log(`Deploying to ${instance.id} (${instance.ip})...`);

    // SSH into instance and run deploy script
    const result = await sshExec(instance.ip, [
      `cd /opt/ghosthands`,
      `ECR_REGISTRY=${process.env.ECR_REGISTRY}`,
      `ECR_REPOSITORY=${process.env.ECR_REPOSITORY}`,
      `AWS_REGION=${process.env.AWS_REGION}`,
      `./scripts/deploy.sh deploy ${params.imageTag}`,
    ].join(' && '));

    if (!result.success) {
      console.error(`Deploy failed on ${instance.id}. Halting rollout.`);
      // Alert ops team
      break;
    }

    console.log(`${instance.id} updated successfully.`);
  }
}
```

### 5.5 Manual Deployment

For emergency or manual deploys (bypassing VALET):

```bash
# SSH into EC2 instance
ssh ubuntu@<ec2-ip>

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 123456789.dkr.ecr.us-east-1.amazonaws.com

# Deploy specific tag
cd /opt/ghosthands
ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com \
ECR_REPOSITORY=ghosthands \
./scripts/deploy.sh deploy abc123def

# Or deploy latest
ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com \
ECR_REPOSITORY=ghosthands \
./scripts/deploy.sh deploy

# Check status
./scripts/deploy.sh status

# Rollback
ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com \
ECR_REPOSITORY=ghosthands \
./scripts/deploy.sh rollback
```

---

## 6. Configuration Management

### 6.1 Secrets Management

Secrets are stored as environment variables on each EC2 instance (in the `.env`
file at `/opt/ghosthands/.env`). VALET manages these via its own secret
management system.

### 6.2 Required Environment Variables

| Variable | API | Worker | Description |
|----------|-----|--------|-------------|
| `SUPABASE_URL` | Yes | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Yes | Service role key (full DB access) |
| `DATABASE_URL` | No | Yes | Postgres URL for queries + LISTEN/NOTIFY |
| `GH_SERVICE_SECRET` | Yes | No | Shared secret for VALET → GH auth |
| `GH_ENCRYPTION_KEY` | No | Yes | AES-256-GCM key for credential encryption |
| `GH_API_PORT` | Yes | No | API listen port (default: 3100) |
| `MAX_CONCURRENT_JOBS` | No | Yes | Max parallel browser sessions (default: 2) |
| `GOOGLE_API_KEY` | No | Yes | Gemini API key (free/default tier) |
| `OPENAI_API_KEY` | No | Yes | OpenAI key (starter/pro tier) |
| `ANTHROPIC_API_KEY` | No | Yes | Anthropic key (premium tier) |
| `CORS_ORIGIN` | Yes | No | Allowed CORS origin |
| `NODE_ENV` | Yes | Yes | `production` |

### 6.3 Environment Matrix

| Variable | Development | Production |
|----------|-------------|------------|
| `NODE_ENV` | `development` | `production` |
| `SUPABASE_URL` | Local or dev project | Production project |
| `GH_API_PORT` | `3100` | `3100` |
| `MAX_CONCURRENT_JOBS` | `1` | `2` |
| `CORS_ORIGIN` | `http://localhost:3000` | `https://app.wekruit.com` |
| `GH_DEFAULT_MODEL` | `qwen-72b` | `qwen-72b` |
| Browser headless | `false` | `true` |

---

## 7. Scaling Strategy

### 7.1 Scaling Dimensions

```
                Low Load          Medium Load        High Load
                (< 10 jobs/hr)    (10-50 jobs/hr)    (50+ jobs/hr)
                ──────────────    ───────────────    ──────────────
EC2 instances:  1                 2                  3-4
Workers/inst:   1 (2 concurrent)  1 (2 concurrent)   1 (2 concurrent)
Total capacity: 2 concurrent      4 concurrent       6-8 concurrent
Worker RAM:     2GB each          2GB each           2GB each
```

### 7.2 Scaling Model

VALET manages the EC2 fleet size. When demand increases, VALET can:
1. Launch additional EC2 instances with GhostHands pre-installed
2. Each instance runs its own API + Worker via Docker Compose
3. All instances share the same Supabase database
4. Workers compete for jobs via `FOR UPDATE SKIP LOCKED` — no coordination needed

### 7.3 Database Connection Management

Supabase Pro plan provides 60 connections. Allocation per instance:

| Consumer | Connection Type | Per Instance |
|----------|----------------|-------------|
| API Server | Pooled (pgbouncer) | 5 |
| Worker | Pooled (pgbouncer) | 5 |
| Worker | Direct (LISTEN/NOTIFY) | 1 |
| **Total per instance** | | **11** |

With 4 instances: 44 connections. VALET uses the remaining ~16 connections.

---

## 8. Monitoring & Observability

### 8.1 Health Endpoints

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `GET /health` | Basic liveness probe | No |
| `GET /monitoring/health` | Deep health check (DB, storage, LLM, workers) | No |
| `GET /monitoring/metrics` | Prometheus-style metrics | No |

### 8.2 Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Queue depth (pending jobs) | DB query | > 20 for > 5 min |
| Job completion rate | `gh_job_events` | < 70% over 1 hour |
| Job execution time (p95) | `started_at` to `completed_at` | > 300s |
| Worker heartbeat staleness | `last_heartbeat` column | > 120s |
| API response time (p99) | Metrics middleware | > 2s |
| LLM cost per job | `llm_cost_cents` column | > 50 cents |
| Error rate by code | `error_code` column | > 30% any single code |

### 8.3 Logging

Both API and worker output JSON-structured logs. On EC2, logs are captured by
Docker's `json-file` driver (max 50MB, 5 files rotated).

VALET can ship these to CloudWatch, Datadog, or Grafana Cloud using a log
aggregation agent on each EC2 instance.

---

## 9. Runbooks

### 9.1 Deploy a New Version

Automatic (normal flow):
```
1. Push to main
2. CI/CD runs tests + builds Docker image → pushes to ECR
3. CI/CD sends webhook to VALET
4. VALET triggers rolling update across EC2 fleet
5. Verify: curl http://<ec2-ip>:3100/health
```

### 9.2 Manual Deploy (Emergency)

```bash
ssh ubuntu@<ec2-ip>
cd /opt/ghosthands

# Set ECR vars
export ECR_REGISTRY=123456789.dkr.ecr.us-east-1.amazonaws.com
export ECR_REPOSITORY=ghosthands
export AWS_REGION=us-east-1

# Deploy specific commit
./scripts/deploy.sh deploy <commit-sha>

# Or latest
./scripts/deploy.sh deploy
```

### 9.3 Rollback

```bash
ssh ubuntu@<ec2-ip>
cd /opt/ghosthands
export ECR_REGISTRY=... ECR_REPOSITORY=... AWS_REGION=...
./scripts/deploy.sh rollback
```

### 9.4 Recover Stuck Jobs

Jobs with stale heartbeats are automatically recovered by the worker on startup.
To manually recover:

```sql
-- Find stuck jobs
SELECT id, worker_id, last_heartbeat, status
FROM gh_automation_jobs
WHERE status IN ('queued', 'running')
  AND last_heartbeat < NOW() - INTERVAL '2 minutes';

-- Re-queue stuck jobs
UPDATE gh_automation_jobs
SET status = 'pending',
    worker_id = NULL,
    error_details = jsonb_build_object('recovered_by', 'manual', 'reason', 'stuck_job_recovery')
WHERE status IN ('queued', 'running')
  AND last_heartbeat < NOW() - INTERVAL '2 minutes';
```

### 9.5 Stop All Processing

```bash
# Drain worker on a specific instance
ssh ubuntu@<ec2-ip>
cd /opt/ghosthands
./scripts/deploy.sh drain

# Jobs in the queue remain 'pending' and will be picked up
# when the worker restarts or by other instances
```

### 9.6 Check Instance Status

```bash
ssh ubuntu@<ec2-ip>
cd /opt/ghosthands
./scripts/deploy.sh status
```

---

*Last updated: 2026-02-14*

*Depends on:*
- [12-valet-ghosthands-integration.md](./12-valet-ghosthands-integration.md) — DB schema, API spec
- [API-INTEGRATION.md](./API-INTEGRATION.md) — API endpoints reference
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Package structure

*Consumed by: VALET backend team, DevOps, on-call engineers*
