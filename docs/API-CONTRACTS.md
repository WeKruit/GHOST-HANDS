# GhostHands API Contracts

Response shapes for the GH API (port 3100) and Worker status server (port 3101). These are the endpoints that ATM fleet proxy and VALET consume.

---

## API Server (port 3100)

### GET /health

Health check. No auth required.

```json
{
  "status": "ok",
  "service": "ghosthands",
  "version": "0.1.0",
  "environment": "staging",
  "commit_sha": "abc123def456",
  "api_healthy": true,
  "timestamp": "2026-02-25T12:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` | Always `"ok"` if the server is responding |
| `service` | `"ghosthands"` | Service identifier |
| `version` | `string` | Semver version (e.g. `"0.1.0"`) |
| `environment` | `string` | `GH_ENVIRONMENT` or `NODE_ENV` (default `"development"`) |
| `commit_sha` | `string` | Git commit SHA baked at Docker build time (default `"unknown"`) |
| `api_healthy` | `boolean` | `true` if the API can reach the database (cached 30s) |
| `timestamp` | `string` | ISO 8601 timestamp of the response |

### GET /health/version

Build metadata. No auth required.

```json
{
  "service": "ghosthands",
  "environment": "staging",
  "commit_sha": "abc123def456",
  "image_tag": "staging-abc123def456",
  "build_time": "2026-02-25T12:00:00Z",
  "uptime_ms": 3600000,
  "node_env": "production"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `service` | `"ghosthands"` | Service identifier |
| `environment` | `string` | `GH_ENVIRONMENT` or `NODE_ENV` |
| `commit_sha` | `string` | Git commit SHA from Docker build arg |
| `image_tag` | `string` | Docker image tag from build arg |
| `build_time` | `string` | ISO 8601 build timestamp from build arg |
| `uptime_ms` | `number` | Milliseconds since API server started |
| `node_env` | `string` | `NODE_ENV` value |

---

## Worker Status Server (port 3101)

### GET /worker/status

Full worker state. No auth required.

```json
{
  "worker_id": "gh-worker-asg-1",
  "ec2_instance_id": "i-0baf28dd8bb630810",
  "ec2_ip": "44.198.167.49",
  "active_jobs": 0,
  "max_concurrent": 1,
  "is_running": true,
  "is_draining": false,
  "dispatch_mode": "queue",
  "asg_name": "ghosthands-worker-asg",
  "uptime_ms": 3600000,
  "timestamp": "2026-02-25T12:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `worker_id` | `string` | Worker identity from `GH_WORKER_ID` or auto-generated |
| `ec2_instance_id` | `string` | EC2 instance ID from IMDSv2 metadata |
| `ec2_ip` | `string` | EC2 public IP from IMDSv2 metadata |
| `active_jobs` | `number` | Currently executing jobs (0 or 1) |
| `max_concurrent` | `number` | Always `1` (single-task-per-worker) |
| `is_running` | `boolean` | Whether the job processor is active |
| `is_draining` | `boolean` | Whether the worker is draining (no new jobs) |
| `dispatch_mode` | `string` | `"queue"` (pg-boss) or `"legacy"` (LISTEN/NOTIFY) |
| `asg_name` | `string \| null` | ASG name if running in Auto Scaling Group |
| `uptime_ms` | `number` | Milliseconds since worker process started |
| `timestamp` | `string` | ISO 8601 timestamp of the response |

### GET /worker/health

Deploy readiness check. Returns HTTP 200 if idle, 503 if busy or draining.

```json
{
  "status": "idle",
  "active_jobs": 0,
  "deploy_safe": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"idle" \| "busy" \| "draining"` | Current worker state |
| `active_jobs` | `number` | Currently executing jobs |
| `deploy_safe` | `boolean` | `true` only when idle and not draining |

**HTTP status codes:**
- `200` — Worker is idle and safe to deploy/restart
- `503` — Worker is busy or draining, do NOT restart

### POST /worker/drain

Signal the worker to stop accepting new jobs and finish current work. No auth required (internal network only).

```json
{
  "status": "draining",
  "active_jobs": 1,
  "worker_id": "gh-worker-asg-1"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"draining"` | Always `"draining"` after this call |
| `active_jobs` | `number` | Jobs still in progress |
| `worker_id` | `string` | Worker that received the drain signal |

---

## ATM Fleet Proxy Mapping

ATM proxies GH endpoints and transforms them into dashboard-compatible shapes:

| ATM path | GH source | Transform |
|----------|-----------|-----------|
| `/fleet/:id/health` | API:3100 `/health` + Worker:3101 `/worker/health` | Merge into `{status, deploySafe, apiHealthy, workerStatus, activeWorkers, uptimeMs}` |
| `/fleet/:id/version` | API:3100 `/health/version` | Pass through with field renames |
| `/fleet/:id/workers` | Worker:3101 `/worker/status` | Wrap in array |
