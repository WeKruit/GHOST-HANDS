# 14 - GhostHands Deployment Strategy & VALET Integration

> Complete deployment architecture, Docker configuration, CI/CD pipeline,
> and VALET integration guide for the GhostHands automation system.

---

## Table of Contents

1. [Deployment Architecture](#1-deployment-architecture)
2. [Process Architecture](#2-process-architecture)
3. [Docker Configuration](#3-docker-configuration)
4. [Platform Deployment (Fly.io)](#4-platform-deployment-flyio)
5. [VALET Integration Guide](#5-valet-integration-guide)
6. [Configuration Management](#6-configuration-management)
7. [CI/CD Pipeline](#7-cicd-pipeline)
8. [Scaling Strategy](#8-scaling-strategy)
9. [Monitoring & Observability](#9-monitoring--observability)
10. [Runbooks](#10-runbooks)

---

## 1. Deployment Architecture

### 1.1 Architecture Diagram

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                     INTERNET                             │
                    └──────────┬──────────────────────────────┬────────────────┘
                               │                              │
                    ┌──────────▼──────────┐       ┌──────────▼──────────┐
                    │   VALET Frontend    │       │   VALET Backend     │
                    │   (Vercel/Next.js)  │       │   (Next.js API      │
                    │                     │       │    Routes)           │
                    └──────────┬──────────┘       └──────────┬──────────┘
                               │                              │
                    Supabase   │  Channel 1: DB Insert        │ Channel 2: REST API
                    Realtime   │  (Direct Supabase)           │ (HTTP)
                    (WebSocket)│                              │
                               │                              │
┌──────────────────────────────┼──────────────────────────────┼────────────────────────────┐
│  Fly.io Private Network      │                              │                            │
│                              │                              │                            │
│  ┌───────────────────────────┼──────────────────────────────┼───────────────┐            │
│  │  GhostHands API (Fly Machine)                            │               │            │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐   │               │            │
│  │  │  Hono API   │  │  Auth       │  │  Rate Limiter  │   │               │            │
│  │  │  Server     │◄─┤  Middleware │◄─┤  + CSP         │◄──┘               │            │
│  │  │  :3100      │  │             │  │                │                    │            │
│  │  └──────┬──────┘  └─────────────┘  └────────────────┘                    │            │
│  │         │                                                                │            │
│  └─────────┼────────────────────────────────────────────────────────────────┘            │
│            │                                                                             │
│  ┌─────────┼────────────────────────────────────────────────────────────────┐            │
│  │         │  GhostHands Worker (Fly Machine, N instances)                  │            │
│  │         │                                                                │            │
│  │  ┌──────▼──────┐  ┌─────────────┐  ┌────────────────┐                   │            │
│  │  │  JobPoller   │  │ JobExecutor │  │ BrowserAgent   │                   │            │
│  │  │             │  │             │  │ (Patchright)   │                   │            │
│  │  │ LISTEN/     │──▶  Cost      │──▶  ManualConn.   │                   │            │
│  │  │ NOTIFY +    │  │  Control   │  │  LLM Calls     │                   │            │
│  │  │ Poll Loop   │  │  Heartbeat │  │  Screenshots   │                   │            │
│  │  └──────┬──────┘  └──────┬─────┘  └────────────────┘                   │            │
│  │         │                │                                               │            │
│  └─────────┼────────────────┼───────────────────────────────────────────────┘            │
│            │                │                                                            │
└────────────┼────────────────┼────────────────────────────────────────────────────────────┘
             │                │
             │                │
    ┌────────▼────────────────▼──────────────────────────────┐
    │              Supabase (Shared with VALET)               │
    │                                                         │
    │  ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
    │  │  Postgres   │ │  Storage │ │  Auth    │ │Realtime│ │
    │  │             │ │  (S3)    │ │          │ │        │ │
    │  │ gh_auto_    │ │          │ │ JWT      │ │ Status │ │
    │  │ mation_jobs │ │ screen-  │ │ Verify   │ │ Push   │ │
    │  │ gh_job_     │ │ shots/   │ │          │ │        │ │
    │  │ events      │ │ gh/...   │ │          │ │        │ │
    │  │ gh_user_    │ │          │ │          │ │        │ │
    │  │ credentials │ │          │ │          │ │        │ │
    │  │ gh_user_    │ │          │ │          │ │        │ │
    │  │ usage       │ │          │ │          │ │        │ │
    │  └─────────────┘ └──────────┘ └──────────┘ └────────┘ │
    └─────────────────────────────────────────────────────────┘
```

### 1.2 Component Summary

| Component | Runtime | Role | Instances |
|-----------|---------|------|-----------|
| **GhostHands API** | Bun on Fly.io Machine | REST API, auth, validation, monitoring | 1 (auto-scale to 2) |
| **GhostHands Worker** | Bun on Fly.io Machine | Job polling, browser automation, LLM calls | 1-4 (scale by load) |
| **Supabase** | Managed (supabase.com) | Postgres, Storage, Auth, Realtime | Shared with VALET |
| **VALET Frontend** | Next.js on Vercel | User-facing web app | Managed by Vercel |
| **VALET Backend** | Next.js API routes | Orchestration, user management | Managed by Vercel |

### 1.3 Why Fly.io

| Criterion | Fly.io | Railway | AWS ECS |
|-----------|--------|---------|---------|
| Chromium/Patchright support | Native (Linux VMs) | Docker-based (works) | Docker-based (works) |
| Long-running processes | Fly Machines (persistent) | Excellent | Excellent |
| Auto-scale from zero | Yes (Machine stop/start) | Yes | Complex (Fargate) |
| Private networking | Built-in (WireGuard) | Private networking | VPC required |
| Cost at low scale | ~$3-5/mo per machine | ~$5/mo per service | ~$15/mo minimum |
| Deploy from Docker | Yes | Yes | Yes |
| Regions | 30+ regions worldwide | Limited regions | All AWS regions |
| Health checks | Built-in | Built-in | ALB health checks |

**Decision:** Fly.io for the API and workers. Supabase remains managed.
The worker needs a real Linux VM (not serverless) because Patchright/Chromium
requires a persistent browser process with ~500MB memory per active session.

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
│ - Monitoring routes    │          │   - BrowserAgent       │
│                        │          │   - Cost control       │
│ Connections:           │          │   - Heartbeat (30s)    │
│ - Supabase pooled      │          │                        │
│                        │          │ Connections:           │
│ Port: 3100             │          │ - Supabase pooled      │
│ Memory: ~128MB         │          │ - Postgres direct      │
│ CPU: 0.25 vCPU         │          │   (for LISTEN/NOTIFY)  │
└────────────────────────┘          │                        │
                                    │ Memory: ~1-2GB         │
                                    │ CPU: 1-2 vCPU          │
                                    └────────────────────────┘
```

**Why separate processes:**

1. **Different resource profiles** -- The API is lightweight (128MB, 0.25 CPU).
   The worker runs Chromium browsers (1-2GB RAM per concurrent job).
2. **Independent scaling** -- Scale workers based on queue depth without
   scaling the stateless API.
3. **Isolation** -- A browser crash in the worker does not affect API
   availability.
4. **Graceful shutdown** -- Workers drain active jobs on SIGTERM (30s
   timeout). The API can restart instantly.

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

This is already implemented in `src/workers/main.ts` (lines 66-84).

---

## 3. Docker Configuration

### 3.1 Dockerfile (Production)

```dockerfile
# ──────────────────────────────────────────────────
# Stage 1: Install dependencies
# ──────────────────────────────────────────────────
FROM oven/bun:1.2-debian AS deps

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock turbo.json ./

# Copy all package.json files for workspace resolution
COPY packages/ghosthands/package.json packages/ghosthands/
COPY packages/magnitude-core/package.json packages/magnitude-core/
COPY packages/magnitude-extract/package.json packages/magnitude-extract/

# Install all dependencies (including workspace links)
RUN bun install --frozen-lockfile

# ──────────────────────────────────────────────────
# Stage 2: Build TypeScript
# ──────────────────────────────────────────────────
FROM deps AS build

# Copy full source
COPY packages/ packages/
COPY turbo.json ./

# Build all packages (magnitude-core -> magnitude-extract -> ghosthands)
RUN bun run build

# ──────────────────────────────────────────────────
# Stage 3: Production runtime
# ──────────────────────────────────────────────────
FROM oven/bun:1.2-debian AS runtime

# Install Chromium dependencies for Patchright
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/ghosthands/dist ./packages/ghosthands/dist
COPY --from=build /app/packages/ghosthands/package.json ./packages/ghosthands/
COPY --from=build /app/packages/ghosthands/node_modules ./packages/ghosthands/node_modules
COPY --from=build /app/packages/magnitude-core/dist ./packages/magnitude-core/dist
COPY --from=build /app/packages/magnitude-core/package.json ./packages/magnitude-core/
COPY --from=build /app/packages/magnitude-extract/dist ./packages/magnitude-extract/dist
COPY --from=build /app/packages/magnitude-extract/package.json ./packages/magnitude-extract/

# Copy source for bun direct execution (bun can run .ts files directly)
COPY --from=build /app/packages/ghosthands/src ./packages/ghosthands/src

# Install Patchright browser binaries
RUN cd packages/magnitude-core && npx patchright install chromium

# Create non-root user for security
RUN groupadd -r ghosthands && useradd -r -g ghosthands -m ghosthands
USER ghosthands

# Default: start API server
# Override with CMD ["bun", "packages/ghosthands/src/workers/main.ts"] for worker
EXPOSE 3100
CMD ["bun", "packages/ghosthands/src/api/server.ts"]
```

### 3.2 docker-compose.yml (Local Development)

```yaml
# docker-compose.yml
# Local development environment for GhostHands API + Worker
#
# Usage:
#   cp .env.example .env   # Fill in real values
#   docker compose up      # Start all services
#   docker compose up api  # Start API only
#   docker compose up worker  # Start worker only

version: "3.8"

services:
  # ── GhostHands API Server ──────────────────────────────
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
      # Mount source for hot-reload with bun --watch
      - ./packages/ghosthands/src:/app/packages/ghosthands/src:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3100/health"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    restart: unless-stopped

  # ── GhostHands Worker ──────────────────────────────────
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
    # Workers need more memory for Chromium
    deploy:
      resources:
        limits:
          memory: 2g
          cpus: "2.0"
    restart: unless-stopped
```

### 3.3 .env.example

```bash
# ─── Supabase ───────────────────────────────────────────
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...                    # service_role key (bypasses RLS)
SUPABASE_ANON_KEY=eyJ...                       # anon key (for frontend/RLS)
SUPABASE_DIRECT_URL=postgresql://postgres:password@db.your-project.supabase.co:5432/postgres

# ─── GhostHands API ────────────────────────────────────
GH_API_PORT=3100
GH_SERVICE_SECRET=your-secret-key-min-32-chars  # Service-to-service auth
CORS_ORIGIN=http://localhost:3000               # VALET frontend URL

# ─── LLM Providers ─────────────────────────────────────
GOOGLE_API_KEY=AIza...                          # Gemini (default/free tier)
OPENAI_API_KEY=sk-...                           # GPT-4o-mini (starter tier)
ANTHROPIC_API_KEY=sk-ant-...                    # Claude Sonnet (premium tier)
GH_DEFAULT_MODEL=gpt-4o-mini

# ─── Security ──────────────────────────────────────────
GH_ENCRYPTION_KEY=base64-encoded-32-byte-key    # AES-256-GCM for credentials

# ─── Worker ────────────────────────────────────────────
MAX_CONCURRENT_JOBS=2
NODE_ENV=development
```

---

## 4. Platform Deployment (Fly.io)

### 4.1 fly.toml -- API Server

```toml
# fly.toml -- GhostHands API Server
app = "ghosthands-api"
primary_region = "iad"  # US East (closest to Supabase)

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  GH_API_PORT = "3100"

[http_service]
  internal_port = 3100
  force_https = true
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[http_service.checks]]
  grace_period = "10s"
  interval = "15s"
  method = "GET"
  path = "/health"
  timeout = "3s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
  cpus = 1
```

### 4.2 fly.toml -- Worker

```toml
# fly.worker.toml -- GhostHands Worker
app = "ghosthands-worker"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  MAX_CONCURRENT_JOBS = "2"

[processes]
  worker = "bun packages/ghosthands/src/workers/main.ts"

# Workers don't serve HTTP but need a health endpoint
# Use a lightweight TCP check on stdout or a sidecar
# For now, rely on Fly's process monitoring

[[vm]]
  size = "performance-2x"  # 2 vCPU, 4GB RAM
  memory = "4096mb"
  cpus = 2

[checks]
  [checks.worker_alive]
    type = "tcp"
    port = 9090         # Optional: expose a minimal health port
    interval = "30s"
    timeout = "5s"
    grace_period = "30s"
```

### 4.3 Deployment Commands

```bash
# ─── First-time setup ──────────────────────────────────
# 1. Install Fly CLI
curl -L https://fly.io/install.sh | sh

# 2. Login
fly auth login

# 3. Create apps
fly apps create ghosthands-api
fly apps create ghosthands-worker

# 4. Set secrets (same secrets for both apps)
fly secrets set \
  SUPABASE_URL="https://your-project.supabase.co" \
  SUPABASE_SERVICE_KEY="eyJ..." \
  SUPABASE_DIRECT_URL="postgresql://..." \
  GH_SERVICE_SECRET="$(openssl rand -hex 32)" \
  GH_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  GOOGLE_API_KEY="AIza..." \
  OPENAI_API_KEY="sk-..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  --app ghosthands-api

fly secrets set \
  SUPABASE_URL="https://your-project.supabase.co" \
  SUPABASE_SERVICE_KEY="eyJ..." \
  SUPABASE_DIRECT_URL="postgresql://..." \
  GH_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  GOOGLE_API_KEY="AIza..." \
  OPENAI_API_KEY="sk-..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  --app ghosthands-worker

# ─── Deploy ─────────────────────────────────────────────
# Deploy API
fly deploy --config fly.toml --app ghosthands-api

# Deploy Worker
fly deploy --config fly.worker.toml --app ghosthands-worker

# ─── Verify ─────────────────────────────────────────────
# Check API health
curl https://ghosthands-api.fly.dev/health

# Check logs
fly logs --app ghosthands-api
fly logs --app ghosthands-worker

# Scale workers
fly scale count 2 --app ghosthands-worker
```

### 4.4 Environment Matrix

| Variable | Development | Staging | Production |
|----------|-------------|---------|------------|
| `NODE_ENV` | `development` | `staging` | `production` |
| `SUPABASE_URL` | Local or dev project | Staging project | Production project |
| `GH_API_PORT` | `3100` | `3100` | `3100` |
| `MAX_CONCURRENT_JOBS` | `1` | `2` | `2-4` |
| `CORS_ORIGIN` | `http://localhost:3000` | `https://staging.wekruit.com` | `https://app.wekruit.com` |
| `GH_DEFAULT_MODEL` | `gemini-2.5-pro-preview-05-06` | `gpt-4o-mini` | `gpt-4o-mini` |
| Browser headless | `false` | `true` | `true` |
| Log level | `debug` | `info` | `warn` |

---

## 5. VALET Integration Guide

### 5.1 Integration Overview

VALET interacts with GhostHands through two channels:

1. **Channel 1 (DB Queue):** VALET backend inserts directly into
   `gh_automation_jobs` via the Supabase service-role client. Workers pick up
   jobs via `LISTEN/NOTIFY` + polling. This is the lowest-latency path.

2. **Channel 2 (REST API):** VALET backend calls `POST /api/v1/gh/jobs` on the
   GhostHands API. The API validates the request and inserts into the same table.
   This provides validation, rate limiting, and a clean HTTP interface.

Both channels produce the same result: a row in `gh_automation_jobs` that
workers process identically.

### 5.2 Installing the Client

The `GhostHandsClient` class is exported from the `ghosthands` package.
In the VALET Next.js app, install it as a workspace dependency or copy the
client files.

```typescript
// valet/lib/ghosthands.ts
import { GhostHandsClient } from 'ghosthands/client';

// ── Option A: REST API mode (recommended for production) ──────────
export const gh = new GhostHandsClient(
  process.env.GHOSTHANDS_API_URL!,   // e.g., https://ghosthands-api.fly.dev/api/v1/gh
  process.env.GH_SERVICE_SECRET!,     // Service-to-service API key
);

// ── Option B: Direct DB mode (lowest latency, no API dependency) ──
export const ghDirect = new GhostHandsClient({
  mode: 'db',
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
});
```

### 5.3 Creating a Job from VALET

```typescript
// valet/app/api/apply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { gh } from '@/lib/ghosthands';

export async function POST(request: NextRequest) {
  // 1. Authenticate the user via Supabase Auth
  const supabase = createRouteHandlerClient({ cookies });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Parse the request body
  const body = await request.json();

  // 3. Create the GhostHands automation job
  try {
    const job = await gh.createJob(user.id, {
      jobType: 'apply',
      targetUrl: body.jobUrl,
      taskDescription: `Apply to ${body.jobTitle} at ${body.company}`,
      inputData: {
        resumePath: body.resumePath,
        resumeId: body.resumeId,
        userData: {
          first_name: body.firstName,
          last_name: body.lastName,
          email: body.email,
          phone: body.phone,
          linkedin_url: body.linkedinUrl,
        },
        tier: body.subscriptionTier || 'starter',
        platform: body.platform,
        qaOverrides: body.qaOverrides || {},
      },
      priority: body.priority || 5,
      maxRetries: 3,
      timeoutSeconds: 300,
      tags: [body.platform, body.company?.toLowerCase()].filter(Boolean),
      idempotencyKey: `valet-apply-${user.id}-${body.jobUrl}`,
      metadata: {
        valet_task_id: body.valetTaskId,
        subscription_tier: body.subscriptionTier,
      },
    });

    return NextResponse.json(
      { jobId: job.id, status: job.status },
      { status: 201 },
    );
  } catch (err: any) {
    // Handle duplicate idempotency key (job already exists)
    if (err.code === 'duplicate_idempotency_key') {
      return NextResponse.json({
        error: 'duplicate',
        existingJobId: err.existingJobId,
        existingStatus: err.existingStatus,
      }, { status: 409 });
    }
    throw err;
  }
}
```

### 5.4 Subscribing to Job Status (Frontend)

```typescript
// valet/components/JobTracker.tsx
'use client';
import { useEffect, useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

interface JobStatus {
  id: string;
  status: string;
  status_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
}

export function JobTracker({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const supabase = createClientComponentClient();

  useEffect(() => {
    // Initial fetch
    supabase
      .from('gh_automation_jobs')
      .select('id, status, status_message, started_at, completed_at, result_summary')
      .eq('id', jobId)
      .single()
      .then(({ data }) => { if (data) setJob(data); });

    // Real-time subscription
    const channel = supabase
      .channel(`job-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'gh_automation_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          setJob(payload.new as JobStatus);
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [jobId, supabase]);

  if (!job) return <div>Loading...</div>;

  return (
    <div>
      <p>Status: {job.status}</p>
      {job.status_message && <p>{job.status_message}</p>}
      {job.result_summary && <p>Result: {job.result_summary}</p>}
    </div>
  );
}
```

### 5.5 Polling Fallback (Server-Side)

For server-side code (API routes, background jobs) where WebSocket connections
are impractical:

```typescript
// valet/lib/ghosthands-poll.ts
import { gh } from '@/lib/ghosthands';

export async function waitForJobResult(jobId: string, timeoutMs = 300_000) {
  const result = await gh.pollForCompletion(jobId, {
    intervalMs: 2000,
    timeoutMs,
  });
  return result;
}
```

### 5.6 Batch Job Creation

```typescript
// valet/app/api/apply-batch/route.ts
import { gh } from '@/lib/ghosthands';

export async function POST(request: NextRequest) {
  const { user } = await authenticateUser(request);
  const { applications } = await request.json();

  const result = await gh.createBatch(user.id, applications.map((app: any) => ({
    jobType: 'apply' as const,
    targetUrl: app.jobUrl,
    taskDescription: `Apply to ${app.jobTitle} at ${app.company}`,
    inputData: {
      userData: app.userData,
      tier: app.tier,
      qaOverrides: app.qaOverrides,
    },
    tags: ['batch', app.platform],
    idempotencyKey: `batch-${user.id}-${app.jobUrl}`,
  })));

  return NextResponse.json({
    created: result.created.length,
    jobIds: result.created.map(j => j.id),
    errors: result.errors,
  }, { status: 201 });
}
```

### 5.7 Authentication Flow

```
VALET Frontend          VALET Backend             GhostHands API
     │                       │                         │
     │── Login ──────────────│                         │
     │                       │                         │
     │◄─ Supabase JWT ───────│                         │
     │                       │                         │
     │── "Apply to job" ────►│                         │
     │   (JWT in cookie)     │                         │
     │                       │── POST /api/v1/gh/jobs ─│
     │                       │   X-GH-Service-Key: ... │
     │                       │   body: { user_id, ... }│
     │                       │                         │
     │                       │◄─ 201 { jobId } ────────│
     │                       │                         │
     │◄─ { jobId } ──────────│                         │
     │                       │                         │
     │── Subscribe Realtime ─┼─────────────────────────│
     │   (Supabase WS)      │                         │
     │                       │                         │
     │◄─ status: running ────┼─────────────── (DB triggers Realtime)
     │◄─ status: completed ──┼─────────────── (DB triggers Realtime)
```

**Auth tokens used:**

| Path | Token | Header |
|------|-------|--------|
| Frontend -> VALET Backend | Supabase user JWT | Cookie (httpOnly) |
| VALET Backend -> GH API | `GH_SERVICE_SECRET` | `X-GH-Service-Key` |
| Frontend -> Supabase Realtime | Supabase anon key + JWT | WebSocket auth |
| Worker -> Supabase DB | Service role key | `SUPABASE_SERVICE_KEY` |

---

## 6. Configuration Management

### 6.1 Secrets Management

All secrets are managed via Fly.io's encrypted secrets store. Never store
secrets in source code, Dockerfiles, or `fly.toml`.

```bash
# Set secrets for API
fly secrets set SUPABASE_SERVICE_KEY="eyJ..." --app ghosthands-api

# Set secrets for Worker
fly secrets set SUPABASE_SERVICE_KEY="eyJ..." --app ghosthands-worker

# List current secrets (shows names, not values)
fly secrets list --app ghosthands-api

# Rotate a secret
fly secrets set GH_SERVICE_SECRET="$(openssl rand -hex 32)" --app ghosthands-api
# Then update VALET's copy of the secret
```

### 6.2 Required Environment Variables

| Variable | API | Worker | Description |
|----------|-----|--------|-------------|
| `SUPABASE_URL` | Yes | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Yes | Service role key (full DB access) |
| `SUPABASE_DIRECT_URL` | No | Yes | Direct Postgres URL for LISTEN/NOTIFY |
| `GH_SERVICE_SECRET` | Yes | No | Shared secret for VALET -> GH auth |
| `GH_ENCRYPTION_KEY` | No | Yes | AES-256-GCM key for credential encryption |
| `GH_API_PORT` | Yes | No | API listen port (default: 3100) |
| `MAX_CONCURRENT_JOBS` | No | Yes | Max parallel browser sessions (default: 2) |
| `GOOGLE_API_KEY` | No | Yes | Gemini API key (free/default tier) |
| `OPENAI_API_KEY` | No | Yes | OpenAI key (starter/pro tier) |
| `ANTHROPIC_API_KEY` | No | Yes | Anthropic key (premium tier) |
| `CORS_ORIGIN` | Yes | No | Allowed CORS origin |
| `NODE_ENV` | Yes | Yes | `development`, `staging`, or `production` |

### 6.3 Secret Rotation Procedure

1. Generate new secret value
2. Set it on Fly.io: `fly secrets set KEY="new-value" --app <app>`
3. Fly.io automatically restarts the machines with the new secret
4. Update any dependent services (VALET) with the new value
5. Verify health check passes: `curl https://ghosthands-api.fly.dev/health`

---

## 7. CI/CD Pipeline

### 7.1 GitHub Actions Workflow

```yaml
# .github/workflows/ghosthands-ci.yml
name: GhostHands CI/CD

on:
  push:
    branches: [main]
    paths:
      - 'packages/ghosthands/**'
      - 'packages/magnitude-core/**'
      - 'Dockerfile'
      - '.github/workflows/ghosthands-ci.yml'
  pull_request:
    branches: [main]
    paths:
      - 'packages/ghosthands/**'
      - 'packages/magnitude-core/**'

env:
  FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

jobs:
  # ── Lint & Type Check ─────────────────────────────────
  lint:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.8
      - run: bun install --frozen-lockfile
      - run: bun run check-types
      - run: bun run lint

  # ── Unit Tests ────────────────────────────────────────
  test-unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.8
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: cd packages/ghosthands && bun run test:unit

  # ── Integration Tests ─────────────────────────────────
  test-integration:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: [lint, test-unit]
    # Only run on main branch (needs real Supabase)
    if: github.ref == 'refs/heads/main'
    env:
      SUPABASE_URL: ${{ secrets.STAGING_SUPABASE_URL }}
      SUPABASE_SERVICE_KEY: ${{ secrets.STAGING_SUPABASE_SERVICE_KEY }}
      SUPABASE_DIRECT_URL: ${{ secrets.STAGING_SUPABASE_DIRECT_URL }}
      GH_SERVICE_SECRET: ${{ secrets.STAGING_GH_SERVICE_SECRET }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.8
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: cd packages/ghosthands && bun run test:integration

  # ── Build Docker Image ────────────────────────────────
  build:
    name: Build Docker Image
    runs-on: ubuntu-latest
    needs: [lint, test-unit]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          tags: ghosthands:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # ── Deploy to Staging ─────────────────────────────────
  deploy-staging:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    needs: [build, test-integration]
    if: github.ref == 'refs/heads/main'
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master

      # Deploy API
      - run: flyctl deploy --config fly.toml --app ghosthands-api-staging

      # Deploy Worker
      - run: flyctl deploy --config fly.worker.toml --app ghosthands-worker-staging

      # Verify health
      - run: |
          sleep 10
          curl -f https://ghosthands-api-staging.fly.dev/health || exit 1

  # ── Deploy to Production ──────────────────────────────
  deploy-production:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [deploy-staging]
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master

      # Deploy API
      - run: flyctl deploy --config fly.toml --app ghosthands-api

      # Deploy Worker (rolling restart to drain active jobs)
      - run: flyctl deploy --config fly.worker.toml --app ghosthands-worker --strategy rolling

      # Verify health
      - run: |
          sleep 15
          curl -f https://ghosthands-api.fly.dev/health || exit 1
          curl -f https://ghosthands-api.fly.dev/monitoring/health | jq '.status'
```

### 7.2 Pipeline Flow

```
PR opened:
  lint ──► test-unit ──► build (no push)

Push to main:
  lint ──► test-unit ──► test-integration ──► build ──► deploy-staging ──► deploy-production
                                                            │
                                                            └── Manual approval gate
                                                                (GitHub environment protection)
```

---

## 8. Scaling Strategy

### 8.1 Scaling Dimensions

```
                Low Load          Medium Load        High Load
                (< 10 jobs/hr)    (10-50 jobs/hr)    (50+ jobs/hr)
                ──────────────    ───────────────    ──────────────
API instances:  1                 1                  2 (auto-scale)
Worker          1 (2 concurrent)  2 (4 concurrent)   4 (8 concurrent)
instances:
Worker RAM:     2GB each          4GB each           4GB each
Supabase:       Free/Pro plan     Pro plan           Pro plan +
                                                     read replicas
```

### 8.2 Worker Scaling

Workers scale based on queue depth. Each worker handles `MAX_CONCURRENT_JOBS`
(default: 2) browser sessions simultaneously.

```bash
# Scale workers manually
fly scale count 3 --app ghosthands-worker

# Scale worker VM size
fly scale vm performance-4x --app ghosthands-worker  # 4 vCPU, 8GB RAM
```

**Auto-scaling strategy** (future): Monitor the `gh_automation_jobs` table for
pending job count. When pending > 2 * total_worker_capacity, scale up.
When pending = 0 for 10 minutes, scale down to minimum (1).

### 8.3 Database Connection Management

Supabase Pro plan provides 60 connections. Allocate them:

| Consumer | Connection Type | Pool Size | Notes |
|----------|----------------|-----------|-------|
| API Server (x1) | Pooled (pgbouncer) | 5 | Via `SUPABASE_URL` |
| Worker (x1) | Pooled (pgbouncer) | 5 | Via `SUPABASE_URL` |
| Worker (x1) | Direct | 1 | LISTEN/NOTIFY only |
| VALET Backend | Pooled | 10 | Shared Supabase client |
| VALET Frontend | Pooled (anon) | 10 | Via Supabase JS client |
| Supabase Realtime | Internal | ~5 | Managed by Supabase |
| **Total** | | **~36** | Well within 60 limit |

When scaling to 4 workers: 4 * (5 pooled + 1 direct) = 24 connections for
workers alone, still within limits.

---

## 9. Monitoring & Observability

### 9.1 Health Endpoints

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `GET /health` | Basic liveness probe | No |
| `GET /monitoring/health` | Deep health check (DB, storage, LLM, workers) | No |
| `GET /monitoring/metrics` | Prometheus-style metrics | No |

### 9.2 Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Queue depth (pending jobs) | DB query | > 20 for > 5 min |
| Job completion rate | `gh_job_events` | < 70% over 1 hour |
| Job execution time (p95) | `started_at` to `completed_at` | > 300s |
| Worker heartbeat staleness | `last_heartbeat` column | > 120s for any running job |
| API response time (p99) | Metrics middleware | > 2s |
| LLM cost per job | `llm_cost_cents` column | > 50 cents per job |
| Error rate by code | `error_code` column | > 30% any single code |

### 9.3 Log Aggregation

Both API and worker use structured logging (pino). On Fly.io, logs are
automatically captured and available via:

```bash
# Real-time logs
fly logs --app ghosthands-api
fly logs --app ghosthands-worker

# Search logs (via Fly.io dashboard or log drain)
# Configure a log drain to ship to Datadog, Grafana Cloud, or Axiom:
fly logs ship --app ghosthands-api --destination axiom
```

---

## 10. Runbooks

### 10.1 Deploy a New Version

```bash
# 1. Ensure tests pass locally
cd packages/ghosthands && bun run test

# 2. Commit and push to main
git push origin main

# 3. CI/CD pipeline runs automatically
# 4. Monitor deploy in GitHub Actions
# 5. Verify health:
curl https://ghosthands-api.fly.dev/health
curl https://ghosthands-api.fly.dev/monitoring/health
```

### 10.2 Restart a Stuck Worker

```bash
# Check worker status
fly status --app ghosthands-worker

# Restart all machines (graceful -- drains active jobs)
fly machines restart --app ghosthands-worker

# Force restart a specific machine
fly machines restart <machine-id> --app ghosthands-worker --force
```

### 10.3 Scale Workers Up/Down

```bash
# Scale to 3 worker instances
fly scale count 3 --app ghosthands-worker

# Scale down to 1
fly scale count 1 --app ghosthands-worker

# Check current scale
fly scale show --app ghosthands-worker
```

### 10.4 Recover Stuck Jobs

Jobs with stale heartbeats are automatically recovered by the worker's
`recoverStuckJobs()` method on startup. To manually recover:

```sql
-- Find stuck jobs (no heartbeat for 2+ minutes)
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

### 10.5 Rotate Secrets

```bash
# Generate new secret
NEW_SECRET=$(openssl rand -hex 32)

# Update on Fly.io (triggers machine restart)
fly secrets set GH_SERVICE_SECRET="$NEW_SECRET" --app ghosthands-api

# Update VALET's environment with the same secret
# (in Vercel dashboard or via vercel CLI)
vercel env add GH_SERVICE_SECRET production
# Paste the same $NEW_SECRET value

# Verify
curl -H "X-GH-Service-Key: $NEW_SECRET" https://ghosthands-api.fly.dev/api/v1/gh/jobs
```

### 10.6 View Job Execution Logs

```bash
# View all logs for a specific job (search in worker logs)
fly logs --app ghosthands-worker | grep "job-id-here"

# Or query job events from the database
# SELECT * FROM gh_job_events WHERE job_id = 'uuid' ORDER BY created_at;
```

### 10.7 Emergency: Stop All Processing

```bash
# Stop all worker machines immediately
fly scale count 0 --app ghosthands-worker

# Jobs in the queue will remain in 'pending' status
# Resume when ready:
fly scale count 1 --app ghosthands-worker
```

---

*Last updated: 2026-02-14*

*Depends on:*
- [12-valet-ghosthands-integration.md](./12-valet-ghosthands-integration.md) -- DB schema, API spec
- [13-integration-architecture-decision.md](./13-integration-architecture-decision.md) -- Architecture decision
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- Package structure

*Consumed by: DevOps, VALET backend team, on-call engineers*
