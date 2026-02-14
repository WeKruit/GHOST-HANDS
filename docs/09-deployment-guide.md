# 09 - Deployment & Sandbox Infrastructure Guide

> Complete deployment reference for Valet's multi-tier infrastructure: Fly.io app services,
> Hatchet workflow engine, EC2 sandbox provisioning, VNC stack, Docker builds, CI/CD pipelines,
> networking, monitoring, and scaling strategy.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Current Fly.io Services](#2-current-flyio-services)
3. [Docker Build Strategy](#3-docker-build-strategy)
4. [Hatchet Engine Deployment](#4-hatchet-engine-deployment)
5. [CI/CD Pipeline](#5-cicd-pipeline)
6. [Multi-Tier Sandbox Provisioning](#6-multi-tier-sandbox-provisioning)
7. [VNC Stack for Human-in-the-Loop](#7-vnc-stack-for-human-in-the-loop)
8. [EC2 Dedicated Sandbox (Premium Tier)](#8-ec2-dedicated-sandbox-premium-tier)
9. [Browserbase Integration (Starter/Pro Tier)](#9-browserbase-integration-starterpro-tier)
10. [Networking & Security](#10-networking--security)
11. [Database & Connection Management](#11-database--connection-management)
12. [Monitoring & Observability](#12-monitoring--observability)
13. [Scaling Strategy](#13-scaling-strategy)
14. [Disaster Recovery](#14-disaster-recovery)

---

## 1. Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │            Fly.io  (iad region)          │
                    │                                          │
                    │  ┌─────────┐  ┌──────────┐  ┌────────┐ │
                    │  │ Web SPA │  │ API      │  │ Worker │ │
                    │  │ (nginx) │  │ (Fastify)│  │ (Node) │ │
                    │  │ :8080   │  │ :3000    │  │ gRPC   │ │
                    │  └────┬────┘  └────┬─────┘  └───┬────┘ │
                    │       │            │             │       │
                    │  ┌────┴────────────┴─────────────┴────┐ │
                    │  │         Fly Private Network          │ │
                    │  └────┬────────────┬─────────────┬────┘ │
                    │       │            │             │       │
                    │  ┌────┴────┐       │        ┌───┴────┐ │
                    │  │ Hatchet │       │        │ Redis  │ │
                    │  │ (lite)  │       │        │(Upstash)│ │
                    │  │ gRPC+UI │       │        └────────┘ │
                    │  └─────────┘       │                    │
                    └────────────────────┼────────────────────┘
                                         │
               ┌─────────────────────────┼──────────────────────┐
               │                         │                       │
        ┌──────┴──────┐          ┌──────┴──────┐        ┌──────┴──────┐
        │  Supabase   │          │  CloudAMQP  │        │  External   │
        │  Postgres   │          │  RabbitMQ   │        │  Services   │
        │  + Storage  │          │             │        │  (LLM, S3)  │
        └─────────────┘          └─────────────┘        └─────────────┘
```

### Service Inventory

| Service | Fly App Name (stg) | Fly App Name (prod) | Port | Protocol |
|---------|--------------------|--------------------|------|----------|
| API | valet-api-stg | valet-api | 3000 | HTTP/HTTPS |
| Worker | valet-worker-stg | valet-worker | N/A (gRPC client) | gRPC to Hatchet |
| Web SPA | valet-web-stg | valet-web | 8080 | HTTP/HTTPS |
| Hatchet | valet-hatchet-stg | (shared) | 7077 (gRPC) / 8888 (UI) | gRPC + HTTP |

---

## 2. Current Fly.io Services

### 2.1 API Server (`fly/api.toml`)

```toml
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = 30

[build]
  dockerfile = "apps/api/Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "3000"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "requests"
    hard_limit = 250
    soft_limit = 200

  [[http_service.checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/api/v1/health"

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

**Key decisions:**
- `auto_stop_machines = "stop"`: Saves cost when idle, auto-starts on request
- `min_machines_running = 1`: Always-on for health checks and immediate response
- Health check at `/api/v1/health` with 15s interval

### 2.2 Worker (`fly/worker.toml`)

```toml
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = 60

[build]
  dockerfile = "apps/worker/Dockerfile"

[env]
  NODE_ENV = "production"

[processes]
  worker = "node apps/worker/dist/main.js"

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
  processes = ["worker"]
```

**Key decisions:**
- No `[http_service]` — worker connects outbound to Hatchet via gRPC
- No `auto_stop_machines` — worker must stay running to poll for tasks
- 1 GB RAM for browser automation libraries (Stagehand/Playwright dependencies)
- `kill_timeout = 60` — allows in-progress tasks to finish gracefully

### 2.3 Web SPA (`fly/web.toml`)

```toml
primary_region = "iad"

[build]
  dockerfile = "apps/web/Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1
```

**Key decisions:**
- nginx serves static SPA on port 8080 (non-root user)
- 256 MB is sufficient for serving static files
- Build-time env vars injected: `VITE_API_URL`, `VITE_WS_URL`, `VITE_GOOGLE_CLIENT_ID`

### 2.4 Hatchet Engine (`fly/hatchet.toml`)

```toml
[build]
  image = "ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest"

[env]
  SERVER_AUTH_COOKIE_INSECURE = "false"
  SERVER_GRPC_BIND_ADDRESS = "0.0.0.0"
  SERVER_GRPC_PORT = "7077"
  SERVER_GRPC_INSECURE = "t"

# gRPC on port 443 (standard HTTPS, h2 ALPN)
[http_service]
  internal_port = 7077
  force_https = true
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 1

  [http_service.http_options]
    h2_backend = true

  [http_service.tls_options]
    alpn = ["h2"]

# Dashboard on port 8443
[[services]]
  protocol = "tcp"
  internal_port = 8888
  [[services.ports]]
    port = 8443
    handlers = ["tls", "http"]

[[vm]]
  memory = "1024mb"
  cpu_kind = "shared"
  cpus = 1
```

**Critical notes:**
- gRPC uses `[http_service]` with `h2_backend=true` and `alpn=["h2"]` — this is the **only** working pattern for gRPC on Fly.io
- Dashboard uses separate `[[services]]` on port 8443 with `handlers=["tls","http"]`
- `SERVER_GRPC_INSECURE=t` — Fly terminates TLS, Hatchet serves h2c internally
- `auto_stop_machines = "suspend"` — faster wake-up than "stop"

---

## 3. Docker Build Strategy

All Dockerfiles use multi-stage builds. Key patterns:

### 3.1 API Dockerfile (`apps/api/Dockerfile`)

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/llm/package.json ./packages/llm/
RUN pnpm install --frozen-lockfile
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
RUN pnpm turbo build --filter=@valet/api

# Stage 2: Runtime
FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/ ./packages/
RUN addgroup --system --gid 1001 valet && \
    adduser --system --uid 1001 --ingroup valet valet
USER valet
ENV NODE_ENV=production
CMD ["node", "apps/api/dist/main.js"]
```

### 3.2 Worker Dockerfile (`apps/worker/Dockerfile`)

Same pattern as API but includes browser dependencies:

```dockerfile
# Runtime stage adds browser libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    xdg-utils wget && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/worker/dist/main.js"]
```

### 3.3 Web Dockerfile (`apps/web/Dockerfile`)

```dockerfile
# Stage 1: Build with Vite
FROM node:20-slim AS builder
# ... same pnpm setup ...
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_GOOGLE_CLIENT_ID
RUN pnpm turbo build --filter=@valet/web

# Stage 2: nginx
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
```

### 3.4 Build Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| `pnpm prune --prod` breaks symlinks | pnpm workspace protocol | **DON'T** use `pnpm prune` in Docker. Copy full `node_modules` from builder |
| Missing `.js` extensions | ESM requires explicit extensions | Ensure all `import` statements use `.js` extension |
| Stale `.d.ts` phantom errors | `composite: true` + `outDir` cache | Clean `dist/` and `tsconfig.tsbuildinfo` before typecheck |
| `CI=true` required | pnpm prompts in non-TTY | Set `ENV CI=true` in Dockerfiles |
| Fly CLI Dockerfile path | Resolved relative to toml dir | Copy toml to repo root before deploy |

---

## 4. Hatchet Engine Deployment

### 4.1 Self-Hosted hatchet-lite

Hatchet runs as `hatchet-lite` — a single image bundling the engine, API, and dashboard.

**External dependencies:**
- Supabase Postgres (session pooler, port 5432)
- CloudAMQP RabbitMQ (AMQPS)

### 4.2 Required Secrets

```bash
fly secrets set -a valet-hatchet-stg \
  DATABASE_URL="postgresql://postgres.xxx:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  SERVER_TASKQUEUE_RABBITMQ_URL="amqps://user:pass@XXX.cloudamqp.com/vhost" \
  SERVER_AUTH_COOKIE_DOMAIN="valet-hatchet-stg.fly.dev" \
  SERVER_GRPC_BROADCAST_ADDRESS="valet-hatchet-stg.fly.dev:443" \
  DATABASE_MAX_CONNS=5 \
  DATABASE_MIN_CONNS=1 \
  DATABASE_MAX_QUEUE_CONNS=5 \
  DATABASE_MIN_QUEUE_CONNS=1
```

### 4.3 Critical Connection Constraints

| Constraint | Explanation |
|-----------|-------------|
| **Session pooler only** (port 5432) | Hatchet uses advisory locks; transaction pooler (port 6543) breaks them |
| **Max 5 connections per pool** | Supabase free tier = 60 max; Hatchet defaults to 50+50 which exhausts the pool |
| **No direct connection from Fly** | Fly→Supabase direct uses IPv6 and times out; always use the pooler |
| **Single shared instance** | Both staging and prod use `valet-hatchet-stg.fly.dev` — session pooler can't support 2 Hatchet instances |

### 4.4 Token Management

Hatchet tokens are tenant-scoped. Generate via SSH:

```bash
fly ssh console -a valet-hatchet-stg
# Free DB connections first:
kill 1
# Then generate:
/hatchet-admin token create --tenant-id <TENANT_ID> --config /config --name <name>
```

| Environment | Tenant ID |
|-------------|-----------|
| dev | `8a2eb94e-2203-414c-be79-fc4aceddaba2` |
| stg | `588b3f37-c0e6-4a9b-9b3c-1019def429eb` |

**CAUTION:** Restarting hatchet-lite regenerates encryption keys in `/config/server.yaml`, invalidating ALL existing tokens. Avoid unnecessary restarts.

### 4.5 Worker Connection Config

Workers connect to Hatchet via environment variables:

```env
HATCHET_CLIENT_TOKEN=<generated-token>
HATCHET_CLIENT_TLS_STRATEGY=tls
HATCHET_CLIENT_TLS_SERVER_NAME=valet-hatchet-stg.fly.dev
HATCHET_CLIENT_HOST_PORT=valet-hatchet-stg.fly.dev:443
```

**DO NOT** override `tls_config` in the SDK constructor — it blocks env var reading for `server_name`.

---

## 5. CI/CD Pipeline

### 5.1 Pipeline Architecture

```
feature/* → develop (CI only)
                ↓
            staging (auto-deploy to Fly stg)
                ↓
            main (auto-deploy to Fly prod, requires approval)
```

### 5.2 Selective Deploys (`cd-dev.yml`)

Uses `dorny/paths-filter` to detect which services changed:

```yaml
- uses: dorny/paths-filter@v3
  id: changes
  with:
    filters: |
      shared:  'packages/shared/**'
      contracts: 'packages/contracts/**'
      db:      'packages/db/**'
      api:     'apps/api/**'
      worker:  'apps/worker/**'
      web:     'apps/web/**'
```

Dependency resolution:
- **API**: deploys when `api/`, `shared/`, `contracts/`, `db/`, `llm/`, or `fly/` change
- **Worker**: deploys when `worker/`, `shared/`, `contracts/`, `db/`, `llm/`, or `fly/` change
- **Web**: deploys when `web/`, `shared/`, `contracts/`, `ui/`, or `fly/` change
- **Migrations**: only when `packages/db/drizzle/**` changes

### 5.3 Deploy Workflow (`deploy.yml`)

Reusable workflow called by environment-specific triggers:

```
validate → migrate (conditional) → deploy-api / deploy-worker / deploy-web (parallel)
```

Each deploy step:
1. Copies toml to repo root (`cp fly/api.toml fly-deploy.toml`)
2. Runs `flyctl deploy --config fly-deploy.toml --app <app> --remote-only`
3. Runs health check (API) or status verification (Worker)
4. Auto-rollback on health check failure

### 5.4 Manual Deploy Commands

```bash
# Staging
cp fly/api.toml fly-deploy.toml && fly deploy --config fly-deploy.toml --app valet-api-stg --remote-only
cp fly/worker.toml fly-deploy.toml && fly deploy --config fly-deploy.toml --app valet-worker-stg --remote-only
cp fly/web.toml fly-deploy.toml && fly deploy --config fly-deploy.toml --app valet-web-stg --remote-only \
  --build-arg VITE_API_URL=https://valet-api-stg.fly.dev \
  --build-arg VITE_WS_URL=wss://valet-api-stg.fly.dev \
  --build-arg VITE_GOOGLE_CLIENT_ID=<client-id>

# Production
cp fly/api.toml fly-deploy.toml && fly deploy --config fly-deploy.toml --app valet-api --remote-only
# ... same pattern
```

---

## 6. Multi-Tier Sandbox Provisioning

### 6.1 Tier-to-Infrastructure Mapping

| Tier | Product | Browser Infrastructure | Provisioning | Lifecycle |
|------|---------|----------------------|-------------|-----------|
| Free | Extension | User's own browser | N/A | Extension installed |
| Local ($9-12/mo) | Companion | User's machine (Chrome + companion app) | Companion launches Chrome locally | Persistent profile on user's machine |
| Starter ($19/mo) | Copilot | Browserbase cloud session | On-demand API call | Per-application session |
| Pro ($39/mo) | Autopilot | Browserbase cloud session | On-demand API call | Per-application session |
| Premium ($79-99/mo) | Dedicated | EC2 + AdsPower | Pre-provisioned pool | Persistent per-user |
| Future (V2) | Ephemeral | Fly Machines | Fly Machines API | Per-application container |

### 6.2 Provisioning Flow

```
Task Created (API)
    │
    ▼
Hatchet Event: task:created
    │
    ▼
Worker: provision-sandbox task
    │
    ├─── Free tier → Skip (extension handles locally)
    │
    ├─── Starter/Pro → Browserbase API
    │    │  POST /v1/sessions { projectId, proxies, keepAlive: true }
    │    │  → Returns { id, connectUrl, debuggerFullscreenUrl }
    │    │  → Store session_id in task context
    │    └── Connect Stagehand: new Stagehand({ env: "BROWSERBASE", ... })
    │
    ├─── Premium → AdsPower on EC2
    │    │  GET /api/v1/browser/start?user_id=<profile_id>
    │    │  → Returns { ws.selenium, ws.puppeteer, debug_port }
    │    │  → Connect via CDP: ws://ec2-host:debug_port
    │    └── Connect Stagehand: new Stagehand({ env: "LOCAL", cdpUrl })
    │
    └─── Future → Fly Machines API
         │  POST /v1/apps/{app}/machines { config, region }
         │  → Returns { id, private_ip }
         │  → Connect via Fly private network
         └── Connect via internal DNS: ws://machine-id.internal:9222
```

### 6.3 Session Lifecycle Management

```typescript
// ISandboxProvider interface (from doc 01)
interface ISandboxProvider {
  provision(config: SandboxConfig): Promise<SandboxSession>;
  terminate(sessionId: string): Promise<void>;
  healthCheck(sessionId: string): Promise<HealthStatus>;
  getConnectionInfo(sessionId: string): Promise<ConnectionInfo>;
}
```

**Browserbase session lifecycle:**
1. `POST /v1/sessions` → creates session with proxy and fingerprint
2. Stagehand connects via `env: "BROWSERBASE"`, `browserbaseSessionID`
3. Application runs through workflow
4. `POST /v1/sessions/{id}/stop` → terminates (or auto-terminates on idle timeout)

**AdsPower session lifecycle:**
1. Profile already exists (pre-created per user)
2. `GET /api/v1/browser/start?user_id={profileId}` → launches browser
3. Connect via CDP WebSocket URL
4. Application completes
5. `GET /api/v1/browser/stop?user_id={profileId}` → closes browser (profile persists)

### 6.6 Local Tier Deployment

The Local tier runs entirely on the user's machine with no server infrastructure needed.

**Architecture**:
```
Chrome Extension (MV3)
    ↓ Native Messaging
Companion App (Node.js binary, ~40MB)
    ├── Stagehand v3
    ├── Magnitude
    ├── Chrome Launcher (launches dedicated Chrome instance)
    └── HTTP client to Valet API (user profile, QA bank, LLM routing)
```

**Companion App Packaging**:

```bash
# Build companion app as standalone binary using pkg
cd apps/agent
pnpm build
pkg dist/main.js --target node20-macos-x64,node20-win-x64,node20-linux-x64 --output valet-companion
```

**Native Messaging Host Registration**:

macOS/Linux:
```json
{
  "name": "com.wekruit.valet.companion",
  "description": "WeKruit Valet Companion App",
  "path": "/Applications/Valet/valet-companion",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

Installed at:
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wekruit.valet.companion.json`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.wekruit.valet.companion.json`
- Windows: Registry key at `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.wekruit.valet.companion`

**Chrome Profile Management**:

Companion app creates and manages a dedicated Chrome profile at:
- macOS: `~/Library/Application Support/Valet/chrome-profile`
- Linux: `~/.config/valet/chrome-profile`
- Windows: `%APPDATA%\Valet\chrome-profile`

**Chrome Launch Command**:
```bash
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome \
  --user-data-dir="~/Library/Application Support/Valet/chrome-profile" \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check
```

**Deployment Process**:
1. User downloads installer from dashboard
2. Installer extracts companion binary to system location
3. Installer registers Native Messaging host
4. Extension detects companion on next launch
5. User can choose Local mode in extension settings

**No Server Infrastructure**:
- No additional Fly.io apps needed
- No VNC stack (uses extension overlay for HITL)
- No browser provisioning API calls
- User's own IP address (no proxy needed)

**Cost Model**:
- $0 infrastructure cost per application
- Only LLM API calls (~$0.02/app routed through Valet API)
- Subscription pays for API access + LLM routing

---

## 7. VNC Stack for Human-in-the-Loop

### 7.1 Component Stack

```
User Browser (noVNC React component)
    │  WebSocket (wss://...)
    ▼
websockify (:6080)
    │  TCP → WebSocket bridge
    ▼
x11vnc (:5900)
    │  VNC/RFB protocol
    ▼
Xvfb (:99, 1920x1080x24)
    │  X11 display server (in-memory)
    ▼
AdsPower Chromium (renders to DISPLAY=:99)
```

### 7.2 Process Configuration

**Xvfb:**
```bash
Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp
```
- 1920x1080x24: ~6 MB framebuffer
- `-ac`: disable X auth (all processes in same container)
- `-nolisten tcp`: Unix socket only

**x11vnc:**
```bash
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 \
  -listen 127.0.0.1 -ncache 10 -ncache_cr -xdamage \
  -noxrecord -cursor most -noscr -nowait_bog -threads -noxfixes
```
- `-ncache 10`: 10x framebuffer cache for instant window switching (~60 MB)
- `-listen 127.0.0.1`: localhost only (websockify bridges to network)
- `-shared`: multiple viewers (spectator + controller)

**websockify:**
```bash
websockify --web /usr/share/novnc 6080 localhost:5900
```
- Bridges WebSocket (:6080) to VNC TCP (:5900)
- Serves noVNC static files on the same port

### 7.3 Security Model

VNC itself has no authentication. Security layers:

1. **Per-session JWT tokens**: API generates a signed token with session_id + user_id + expiry
2. **WebSocket upgrade validation**: websockify validates token before establishing connection
3. **Fly private network**: VNC port is internal-only, not exposed to internet
4. **Session isolation**: Each sandbox has its own VNC stack, no cross-session access

### 7.4 When VNC is Used

| Scenario | Trigger | Hatchet Mechanism |
|----------|---------|-------------------|
| CAPTCHA detected | `anti_bot_detected` failure signal | `durableTask` + `context.waitFor("human:resolved")` |
| Engine exhausted | All retry/fallback paths failed | `durableTask` + `context.waitFor("human:resolved")` |
| User-requested review | Pro/Premium manual review step | `durableTask` + `context.waitFor("human:approved")` |
| Ambiguous form field | Low-confidence field match | `durableTask` + `context.waitFor("human:resolved")` |

---

## 8. EC2 Dedicated Sandbox (Premium Tier)

### 8.1 Architecture

```
┌────────────────────────────────────────────┐
│  EC2 Instance (t3.medium, Ubuntu 22.04)    │
│                                            │
│  systemd units:                            │
│  ├── xvfb.service      (DISPLAY=:99)       │
│  ├── x11vnc.service    (:5900)             │
│  ├── websockify.service (:6080)            │
│  ├── adspower.service  (:50325)            │
│  └── health.service    (:8089)             │
│                                            │
│  Network:                                  │
│  ├── :50325 → AdsPower Local API           │
│  ├── :6080  → VNC WebSocket (via LB)       │
│  └── :9222  → CDP (Chrome DevTools)        │
└────────────────────────────────────────────┘
```

### 8.2 Instance Sizing

| Component | Memory | CPU |
|-----------|--------|-----|
| Xvfb (1920x1080x24 + ncache) | ~60 MB | Minimal |
| AdsPower + Chromium | ~500-800 MB | 1 vCPU |
| x11vnc + websockify | ~30 MB | Minimal |
| Node.js health check | ~50 MB | Minimal |
| **Total** | **~1 GB** | **1-2 vCPU** |

Recommended: `t3.medium` (2 vCPU, 4 GB RAM) — supports 2-3 concurrent browser profiles.

### 8.3 AdsPower Headless Mode

AdsPower runs headless on EC2 (no GUI needed for the API server itself):

```bash
# systemd unit: /etc/systemd/system/adspower.service
[Service]
ExecStart=/opt/adspower/adspower --headless=true --api-key=${API_KEY}
Environment=DISPLAY=:99
Restart=always
```

API key required for headless mode. All browser operations via REST API at `http://localhost:50325`.

### 8.4 Profile Pool Strategy

Pre-create browser profiles per Premium user:

```typescript
// Profile pool per Premium user
interface ProfilePool {
  userId: string;
  profiles: Array<{
    profileId: string;      // AdsPower profile ID
    fingerprint: string;    // Fingerprint config name
    proxy: ProxyConfig;     // Residential proxy assigned
    lastUsed: Date;
    status: "idle" | "active" | "cooldown";
  }>;
}
```

**Rotation strategy:**
- 3-5 profiles per user
- Rotate per application to avoid fingerprint correlation
- Cooldown period: 30 minutes between uses of same profile
- Residential proxy rotation per session

---

## 9. Browserbase Integration (Starter/Pro Tier)

### 9.1 Session Creation

```typescript
import Browserbase from "@browserbasehq/sdk";

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });

// Create session with proxy (residential for anti-detection)
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  proxies: true,          // Enable residential proxy
  keepAlive: true,        // Keep alive for multi-step workflows
  browserSettings: {
    fingerprint: {
      devices: ["desktop"],
      locales: ["en-US"],
      operatingSystems: ["macos"],
    },
  },
});
```

### 9.2 Stagehand Native Integration

```typescript
import { Stagehand } from "@browserbasehq/stagehand";

const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  browserbaseSessionID: session.id,
  model: "anthropic/claude-sonnet-4-5",
});

await stagehand.init();
// Stagehand is now connected to the Browserbase session
```

### 9.3 Live View for Human-in-the-Loop

Browserbase provides a built-in Live View URL:

```typescript
const debugUrl = session.debuggerFullscreenUrl;
// Opens a browser-based viewer showing the remote session
// User can observe and, with proper permissions, interact
```

This replaces the need for a full VNC stack on Starter/Pro tiers.

### 9.4 Contexts API (Session Persistence)

```typescript
// Create a persistent context (retains cookies, localStorage)
const context = await bb.contexts.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID,
});

// Use context in new sessions
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  browserSettings: {
    context: { id: context.id, persist: true },
  },
});
```

---

## 10. Networking & Security

### 10.1 Fly.io Network Architecture

```
Internet
  │
  ├── HTTPS (:443) → Fly edge → API (:3000)
  ├── HTTPS (:443) → Fly edge → Web (:8080)
  ├── HTTPS (:443) → Fly edge → Hatchet gRPC (:7077)  [h2 ALPN]
  └── TLS (:8443)  → Fly edge → Hatchet Dashboard (:8888)

Internal (Fly private network, .internal DNS):
  Worker → Hatchet gRPC (via public URL, TLS)
  Worker → Supabase (via pooler, external)
  Worker → Upstash Redis (external, rediss://)
```

### 10.2 gRPC on Fly.io (Solved Pattern)

The **only** working configuration for gRPC on Fly.io:

```toml
[http_service]
  internal_port = 7077

  [http_service.http_options]
    h2_backend = true

  [http_service.tls_options]
    alpn = ["h2"]
```

**What fails:**
- `[[services]]` + `handlers=["tls"]` — no ALPN negotiation
- `[[services]]` + `handlers=["tls","http"]` — HTTP proxy can't forward gRPC
- Raw TCP without TLS — no encryption

### 10.3 Security Checklist

| Layer | Protection |
|-------|-----------|
| API | JWT auth, rate limiting (Upstash), CORS, Helmet headers |
| Database | TLS via pooler, connection limits, RLS (future) |
| Storage | Supabase Storage with bucket-level policies, MIME restrictions |
| VNC | Per-session JWT, private network only, session isolation |
| Hatchet | Token-based auth, TLS on gRPC |
| Worker | Non-root user in Docker, read-only filesystem (future) |
| Secrets | Fly secrets (encrypted at rest), no `.env` in images |

---

## 11. Database & Connection Management

### 11.1 Supabase Connection Modes

| Mode | URL | Port | Use Case |
|------|-----|------|----------|
| Transaction pooler | `DATABASE_URL` | 6543 | App runtime (pgbouncer, connection reuse) |
| Session pooler | `DATABASE_DIRECT_URL` | 5432 | Migrations, DDL, advisory locks |

### 11.2 Connection Budget (Free Tier: 60 max)

| Consumer | Connections | Notes |
|----------|------------|-------|
| Hatchet main pool | 5 | `DATABASE_MAX_CONNS=5` |
| Hatchet queue pool | 5 | `DATABASE_MAX_QUEUE_CONNS=5` |
| API (via transaction pooler) | ~10 | Pooled, shared across requests |
| Worker (via transaction pooler) | ~5 | Per-worker connections |
| Migrations (ephemeral) | 1 | Only during CI deploy |
| **Total** | **~26** | Well within 60 limit |

### 11.3 Drizzle + Hatchet Schema Coexistence

Hatchet creates `v1_*` partition tables and PascalCase tables (`User`, `Worker`, etc.) in the `public` schema.

**Fix:** Explicit `tablesFilter` whitelist in `drizzle.config.ts`:

```typescript
export default defineConfig({
  tablesFilter: [
    "users", "tasks", "resumes", "applications",
    "job_boards", "user_preferences", "subscriptions",
    "usage_records", "screenshots", "artifacts", "audit_logs",
  ],
});
```

### 11.4 Zombie Connection Cleanup

After Hatchet crash loops, zombie connections can exhaust the pool:

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = 'postgres'
  AND state = 'idle'
  AND query_start < NOW() - INTERVAL '5 minutes';
```

Run this before restarting Hatchet after crash loops.

---

## 12. Monitoring & Observability

### 12.1 Health Checks

| Service | Endpoint | Interval | Auto-Rollback |
|---------|----------|----------|---------------|
| API | `GET /api/v1/health` | 15s | Yes (5 retries → rollback) |
| Web | `GET /health` | 30s | No (static files) |
| Worker | `fly status --json` | On deploy | Yes |
| Hatchet | Dashboard at `:8443` | Manual | No |

### 12.2 Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| DB connection count | Supabase dashboard | > 50 (of 60 max) |
| Hatchet task queue depth | Hatchet dashboard | > 100 pending |
| Worker memory usage | Fly metrics | > 800 MB |
| API response time (p95) | Fly metrics | > 2000ms |
| Failed deployments | GitHub Actions | Any failure |
| RabbitMQ queue depth | CloudAMQP dashboard | > 1000 messages |

### 12.3 Logging Strategy

```
API logs    → Fly.io log drain → structured JSON
Worker logs → Fly.io log drain → structured JSON
Hatchet     → Fly.io log drain → hatchet-lite internal logs
```

All services use structured JSON logging with correlation IDs:
- `requestId`: per-HTTP request
- `taskId`: per-automation task
- `sessionId`: per-browser session
- `workflowRunId`: per-Hatchet workflow run

---

## 13. Scaling Strategy

### 13.1 Current Capacity (Single Machine per Service)

| Service | Machines | Capacity |
|---------|----------|----------|
| API | 1 × 512 MB | ~200 concurrent requests |
| Worker | 1 × 1 GB | ~5-10 concurrent tasks |
| Web | 1 × 256 MB | ~400 concurrent connections |
| Hatchet | 1 × 1 GB | ~50-100 concurrent workflows |

### 13.2 Scaling Triggers

| Metric | Threshold | Action |
|--------|-----------|--------|
| API p95 > 2s | Sustained 5 min | Scale to 2 machines |
| Worker queue depth > 20 | Sustained 10 min | Add worker machine |
| DB connections > 40 | Sustained 5 min | Upgrade Supabase plan |
| Hatchet task latency > 30s | Sustained 10 min | Add Hatchet resources |

### 13.3 Fly.io Scaling Commands

```bash
# Scale API to 2 machines
fly scale count 2 -a valet-api-stg

# Increase worker memory
fly scale vm shared-cpu-2x -a valet-worker-stg

# Scale worker to 3 machines
fly scale count 3 -a valet-worker-stg
```

### 13.4 Future: Ephemeral Sandboxes (Fly Machines API)

For V2, replace per-user EC2 with per-session Fly Machines:

```typescript
// Fly Machines API (future)
const machine = await fly.machines.create({
  app: "valet-sandbox",
  config: {
    image: "registry.fly.io/valet-sandbox:latest",
    guest: { cpus: 1, memory_mb: 1024 },
    env: { DISPLAY: ":99", SESSION_ID: taskId },
    services: [
      { ports: [{ port: 6080 }], protocol: "tcp" },  // VNC
      { ports: [{ port: 9222 }], protocol: "tcp" },  // CDP
    ],
  },
  region: "iad",
});

// Machine starts in ~3-5s
// Connect via private network: machine.private_ip
// Destroy after task completes
await fly.machines.destroy(machine.id, { force: true });
```

---

## 14. Disaster Recovery

### 14.1 Rollback Procedures

```bash
# Rollback specific service
fly releases rollback -a valet-api-stg -y

# View release history
fly releases -a valet-api-stg
```

### 14.2 Hatchet Recovery

If Hatchet enters crash loop:
1. Clean zombie DB connections (SQL above)
2. Check RabbitMQ queue health
3. `fly ssh console -a valet-hatchet-stg` then `kill 1` (restarts process)
4. If tokens invalidated, regenerate using `/hatchet-admin token create`
5. Update `HATCHET_CLIENT_TOKEN` in worker and API secrets

### 14.3 Database Recovery

Supabase provides:
- Point-in-time recovery (Pro plan)
- Daily backups (Free plan)
- Transaction logs for debugging

### 14.4 Secrets Rotation Checklist

| Secret | Rotation Frequency | Impact of Rotation |
|--------|-------------------|-------------------|
| JWT_SECRET | On compromise | All user sessions invalidated |
| HATCHET_CLIENT_TOKEN | On Hatchet restart | Workers disconnect until updated |
| DATABASE_URL | On password change | All services need restart |
| BROWSERBASE_API_KEY | Quarterly | Session creation fails until updated |
| Google OAuth client secret | On compromise | Login fails until updated |
