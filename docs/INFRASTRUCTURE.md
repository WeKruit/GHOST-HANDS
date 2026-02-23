# GhostHands Infrastructure Guide

> Architecture, costs, operations, and onboarding for the GhostHands worker fleet.

---

## Architecture Overview

```
                          VALET API (Fly.io)
                               │
                    AutoScaleService (every 60s)
                     │                    │
              reads queue depth    adjusts ASG capacity
              from pg-boss        via AWS SDK
                               │
                    ┌──────────┴──────────┐
                    │   AWS Auto Scaling   │
                    │       Group          │
                    │  min=1, max=10       │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         EC2 Worker 1    EC2 Worker 2    EC2 Worker N
         (t3.large)      (t3.large)      (t3.large)
              │                │                │
         Docker (host net):  Docker (host net):  Docker (host net):
         - GH API (3100)    - GH API (3100)    - GH API (3100)
         - GH Worker (3101) - GH Worker (3101) - GH Worker (3101)
         - Deploy Srv (8000)- Deploy Srv (8000)- Deploy Srv (8000)
```

### How It Works

1. **VALET enqueues tasks** into pg-boss (Supabase Postgres)
2. **AutoScaleService** runs every 60s, reads queue depth, calculates `desired = ceil(queueDepth / JOBS_PER_WORKER)`, clamped to `[min, max]`
3. **AWS ASG** provisions/terminates EC2 instances to match desired capacity
4. **Each EC2** runs 3 Docker containers (API, Worker, Deploy Server) — all on host networking
5. **GH Worker** polls pg-boss for jobs, executes browser automation, sends callbacks to VALET
6. **On scale-in:** ASG sends SIGTERM → worker drains in-flight jobs → calls `CompleteLifecycleAction` → instance terminates

### Key Design Decisions

- **One worker per EC2** (`MAX_CONCURRENT_JOBS=1`, `JOBS_PER_WORKER=1`) — browser automation is memory-intensive
- **Golden AMI** — pre-baked with Docker + GH image for fast boot (~90s to healthy)
- **Pull-based dispatch** — workers poll pg-boss, no inbound ports needed for job dispatch (ports still open for health checks and VNC)
- **Ephemeral workers** — no persistent state on instances; all state is in Supabase
- **Host networking** — all 3 containers use `network_mode: host` to avoid bridge/host conflicts between compose and Docker API deploys
- **No .env file reads at runtime** — deploy-server uses `process.env` (populated by compose `env_file`), optionally augmented by AWS Secrets Manager at startup

---

## AWS Resources

| Resource | Name/ID | Type | Notes |
|----------|---------|------|-------|
| **AMI** | `ghosthands-worker-golden-YYYYMMDD` | Custom AMI | Snapshot of production worker |
| **Launch Template** | `ghosthands-worker-lt` | t3.large, 40GB gp3 | UserData auto-starts Docker |
| **Auto Scaling Group** | `ghosthands-worker-asg` | min=1, max=10 | us-east-1a |
| **Lifecycle Hook** | `ghosthands-drain-hook` | Instance Terminating | 300s heartbeat timeout |
| **IAM Role** | `ghosthands-worker-role` | EC2 instance role | ASG lifecycle + ECR + CloudWatch |
| **Instance Profile** | `ghosthands-worker-profile` | Attached to Launch Template | |
| **Security Group** | `sg-0f7cbba074ee13801` | `valet-worker-staging` | Ports: 22, 80, 443, 3100, 6080, 8000, 8080 |
| **Key Pair** | `valet-worker` | SSH access | `~/.ssh/valet-worker.pem` |
| **VPC** | `vpc-001f5437cfda3f468` | Default | us-east-1 |
| **Subnet** | `subnet-069f1f6705a683148` | us-east-1a | Public subnet |

---

## CI/CD Deploy Pipeline

### Pipeline Order

```
Push to staging/main
  │
  ├─ typecheck (parallel)
  ├─ unit tests (parallel)
  │
  └─ integration tests (needs: typecheck)
       │
       └─ Docker Build & Push to ECR
            │
            └─ Deploy to ASG Fleet (SSH → deploy.sh)    ← EC2 updated FIRST
                 │
                 ├─ Deploy Staging (notify VALET webhook) ← VALET notified AFTER
                 └─ Deploy Production (main branch only)
```

**Critical ordering:** ASG deploy runs BEFORE VALET notification. This ensures the deploy-server on EC2 has the new code before VALET tries to call it.

### Two Deploy Paths

| Path | Trigger | How It Works |
|------|---------|-------------|
| **ASG Deploy** (CI) | `git push` → GitHub Actions | SSH into each ASG instance → `git pull` → `deploy.sh` → `docker compose up -d` |
| **VALET Auto-Deploy** (webhook) | CI notifies VALET webhook | VALET calls `POST /deploy` on deploy-server → Docker API creates new containers |

Both paths update the same containers. `deploy.sh` removes standalone containers (from Docker API deploys) before running `docker compose up` to prevent port conflicts.

### Deploy Server

Each EC2 runs a deploy-server on port 8000 that accepts commands from VALET:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | None | Worker health + active task count |
| `GET /metrics` | None | CPU, memory, disk stats |
| `GET /containers` | None | Running Docker containers |
| `GET /workers` | None | Worker registry status |
| `POST /deploy` | `X-Deploy-Secret` | Rolling deploy via Docker Engine API |
| `POST /drain` | `X-Deploy-Secret` | Graceful worker drain |
| `POST /cleanup` | `X-Deploy-Secret` | Disk cleanup (Docker prune + tmp + logs) |
| `POST /admin/refresh-secrets` | `X-Deploy-Secret` | Re-fetch secrets from AWS Secrets Manager |

### VALET Retry Logic

VALET's `DeployService` retries failed deploy-server calls with exponential backoff (10s, 20s, 30s — max 3 attempts) before marking a sandbox deploy as failed.

---

## Secrets Management

### How Secrets Reach EC2

```
AWS Secrets Manager (ghosthands/{environment})
         │
    EC2 bootstrap (UserData)
         │
    pull-secrets.sh → /opt/ghosthands/.env (600 perms)
         │
    docker compose env_file → process.env (in containers)
         │
    deploy-server also fetches AWS SM at startup (non-fatal)
```

1. **EC2 boots** → UserData script runs `pull-secrets.sh`
2. **`pull-secrets.sh`** fetches JSON from AWS Secrets Manager (`ghosthands/staging`), converts to `.env` format, writes to `/opt/ghosthands/.env`
3. **Docker compose** loads `.env` via `env_file:` directive → vars available in `process.env`
4. **Deploy-server** also fetches from AWS SM at startup as an additional source (existing env vars take precedence)
5. **Runtime-injected vars** (`GH_WORKER_ID`, `EC2_INSTANCE_ID`, `EC2_IP`) are set by UserData, NOT stored in AWS SM

### Important: No .env File Reads in Code

The deploy-server does **NOT** read `.env` files from disk at runtime. The `container-configs.ts` module reads `process.env` and filters to known prefixes (`DATABASE_`, `SUPABASE_`, `GH_`, `ANTHROPIC_`, `AWS_`, etc.) when creating new containers via Docker API.

This avoids EACCES permission errors — the Docker containers run as the non-root `ghosthands` user, which cannot read host files owned by `ubuntu`.

### Updating Secrets

```bash
# 1. Update in AWS Secrets Manager
aws secretsmanager update-secret \
  --secret-id ghosthands/staging \
  --secret-string "$(cat updated-secrets.json)"

# 2. Option A: Re-pull on EC2 (restarts containers)
ssh -i ~/.ssh/valet-worker.pem ubuntu@<ip> \
  "cd /opt/ghosthands && sudo bash scripts/pull-secrets.sh staging && docker compose down && docker compose up -d"

# 3. Option B: Refresh via deploy-server API (no restart needed for deploy-server itself)
curl -X POST http://<ip>:8000/admin/refresh-secrets \
  -H "X-Deploy-Secret: $GH_DEPLOY_SECRET"
```

---

## Docker Compose Configuration

All 3 services use **host networking** (`network_mode: host`). No port mappings — services bind directly to host ports.

| Service | Port | Command |
|---------|------|---------|
| `api` | 3100 | `bun packages/ghosthands/src/api/server.ts` |
| `worker` | 3101 | `bun packages/ghosthands/src/workers/main.ts` |
| `deploy-server` | 8000 | `bun scripts/deploy-server.ts` |

### Compose Files

| File | Environment | Difference |
|------|-------------|-----------|
| `docker-compose.prod.yml` | Production | No `GH_ENVIRONMENT` override |
| `docker-compose.staging.yml` | Staging | Sets `GH_ENVIRONMENT=staging` |

### Docker Container User

The Dockerfile creates a non-root `ghosthands` user (line 102). All containers run as this user. This means:
- Containers cannot read host files with restrictive permissions (e.g., `.env` with `600 ubuntu:ubuntu`)
- Volume mounts (like `/opt/ghosthands:ro`) are accessible only if the host files are world-readable OR owned by the container user's UID

---

## Monthly Cost Breakdown

### Compute (EC2)

| Scenario | Instances | Instance Type | Hourly | Monthly |
|----------|-----------|--------------|--------|---------|
| **Minimum (idle)** | 1 | t3.large | $0.0832 | **$60** |
| **Light load** | 2-3 | t3.large | $0.17-0.25 | $120-180 |
| **Moderate load** | 5 | t3.large | $0.42 | $300 |
| **Peak (max)** | 10 | t3.large | $0.83 | $600 |

> t3.large: 2 vCPU, 8 GB RAM. Sufficient for 1 browser + 1 GH worker per instance.

### Storage

| Resource | Size | Monthly |
|----------|------|---------|
| AMI snapshot (EBS) | ~40 GB | $3.20 |
| Root volume per instance | 40 GB gp3 | $3.20/instance |
| **Total storage (1 instance)** | | **~$6.40** |

### Other

| Resource | Monthly |
|----------|---------|
| Elastic IPs (if allocated) | $3.65 each (when not attached) |
| Data transfer (outbound) | First 100 GB free, then $0.09/GB |
| CloudWatch Logs | $0.50/GB ingested |

### Total Monthly Estimates

| Scenario | Estimate |
|----------|----------|
| **Idle (min=1)** | **~$67/mo** |
| **Average (2-3 instances)** | **~$130-190/mo** |
| **Peak (10 instances)** | **~$640/mo** |

### Cost Optimization Tips

- Set `AUTOSCALE_MAX` conservatively (start with 5, not 10)
- ASG scales down automatically when queue is empty
- Consider Spot Instances for non-critical workloads (70% savings, but can be interrupted)
- Monitor with `GET /api/v1/admin/fleet-status` to see if max is ever reached

---

## Environment Variables

### VALET API (Fly.io)

| Variable | Value | Description |
|----------|-------|-------------|
| `AUTOSCALE_ASG_ENABLED` | `true` | Enable ASG auto-scaling |
| `AWS_ASG_NAME` | `ghosthands-worker-asg` | ASG name |
| `AUTOSCALE_MIN` | `1` | Minimum instances |
| `AUTOSCALE_MAX` | `10` | Maximum instances |
| `JOBS_PER_WORKER` | `1` | Jobs per worker (must match `MAX_CONCURRENT_JOBS`) |
| `AWS_ACCESS_KEY_ID` | (secret) | IAM credentials for ASG API calls |
| `AWS_SECRET_ACCESS_KEY` | (secret) | IAM credentials for ASG API calls |
| `AWS_REGION` | `us-east-1` | AWS region |

### GH Worker (.env on each EC2 — sourced from AWS Secrets Manager)

| Variable | Value | Description |
|----------|-------|-------------|
| `AWS_ASG_NAME` | `ghosthands-worker-asg` | Used by lifecycle hook |
| `AWS_LIFECYCLE_HOOK_NAME` | `ghosthands-drain-hook` | Hook name for drain signal |
| `AWS_REGION` | `us-east-1` | AWS region |
| `GH_WORKER_ID` | (auto-generated per instance) | Unique UUID for each worker (injected by UserData) |
| `EC2_INSTANCE_ID` | (auto-detected) | Instance ID (injected by UserData) |
| `EC2_IP` | (auto-detected) | Public IP (injected by UserData) |
| `JOB_DISPATCH_MODE` | `queue` | Pull from pg-boss |
| `MAX_CONCURRENT_JOBS` | `1` | Single-task-per-worker |
| `GH_DEPLOY_SECRET` | (secret) | Auth for deploy-server POST endpoints |
| `GH_CREDENTIAL_KEY` | (secret) | 64 hex chars for AES-256-GCM encryption |
| `GH_SERVICE_SECRET` | (secret) | API authentication key |
| `DATABASE_URL` | (secret) | Supabase Postgres (transaction pooler) |
| `DATABASE_DIRECT_URL` | (secret) | Supabase Postgres (direct, for migrations) |

---

## Operations

### View Fleet Status

```bash
# Via VALET API
curl -H "Authorization: Bearer $TOKEN" https://valet-api-stg.fly.dev/api/v1/admin/fleet-status

# Via AWS CLI
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ghosthands-worker-asg \
  --query 'AutoScalingGroups[0].{Desired:DesiredCapacity,Min:MinSize,Max:MaxSize,Instances:Instances[*].{ID:InstanceId,State:LifecycleState,Health:HealthStatus}}'
```

### Manually Scale

```bash
# Scale to 5 workers
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name ghosthands-worker-asg \
  --desired-capacity 5

# Scale to minimum (1)
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name ghosthands-worker-asg \
  --desired-capacity 1
```

### SSH into an ASG Instance

```bash
# Find instance IPs
aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=ghosthands-worker-asg" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].{ID:InstanceId,IP:PublicIpAddress}' --output table

# SSH
ssh -i ~/.ssh/valet-worker.pem ubuntu@<instance-ip>
```

### Update the Golden AMI

When you deploy a new GH version, you need to update the AMI:

```bash
# 1. SSH into any running ASG instance
ssh -i ~/.ssh/valet-worker.pem ubuntu@<instance-ip>

# 2. Pull latest Docker image
cd /opt/ghosthands && docker compose pull

# 3. Restart with new image
docker compose down && docker compose up -d

# 4. Verify it works
curl -s http://localhost:3100/health

# 5. Create new AMI from this instance (from your local machine)
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=ghosthands-worker-asg" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

aws ec2 create-image --instance-id $INSTANCE_ID \
  --name "ghosthands-worker-golden-$(date +%Y%m%d)" \
  --no-reboot

# 6. Update Launch Template with new AMI
aws ec2 create-launch-template-version \
  --launch-template-name ghosthands-worker-lt \
  --source-version '$Latest' \
  --launch-template-data "{\"ImageId\":\"<new-ami-id>\"}"

# 7. Set new version as default
aws ec2 modify-launch-template \
  --launch-template-name ghosthands-worker-lt \
  --default-version '$Latest'

# 8. Rolling refresh (replaces instances one by one)
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name ghosthands-worker-asg \
  --preferences '{"MinHealthyPercentage":50}'
```

### Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Instance not starting | `aws autoscaling describe-scaling-activities` | Check UserData logs: `/var/log/cloud-init-output.log` |
| Worker not registering | SSH → `docker logs ghosthands-worker-1` | Check `.env` has correct DB credentials |
| Lifecycle hook timeout | Instance stuck in `Terminating:Wait` | `aws autoscaling complete-lifecycle-action --lifecycle-action-result CONTINUE` |
| AMI snapshot failed | `aws ec2 describe-images --owners self` | Retry with `--no-reboot` |
| Scale-up not happening | Check VALET logs: `fly logs -a valet-api-stg` | Verify `AUTOSCALE_ASG_ENABLED=true` |

---

## Onboarding Checklist (New Developer)

1. **Get AWS access** — Ask team lead for IAM credentials or SSO login
2. **Get SSH key** — `~/.ssh/valet-worker.pem` (ask team lead)
3. **Read the architecture** — This doc + `ASG-SETUP-GUIDE.md`
4. **Verify CLI access:**
   ```bash
   aws sts get-caller-identity
   aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ghosthands-worker-asg
   ssh -i ~/.ssh/valet-worker.pem ubuntu@<any-instance-ip> "docker ps"
   ```
5. **Understand the dispatch flow:**
   - VALET → pg-boss queue → GH Worker polls → executes → callback to VALET
   - No SSH needed for normal operations — everything is automated
6. **Key dashboards:**
   - VALET admin: `https://valet-web-stg.fly.dev/admin/workers` (fleet status)
   - AWS Console: EC2 > Auto Scaling Groups > `ghosthands-worker-asg`
   - Supabase: `gh_worker_registry` table (worker registrations)

---

## One-Time Setup Resources

This infrastructure was created as a one-time setup. No manual infra work is needed going forward — the AutoScaleService manages capacity automatically.

| What | When to Re-do |
|------|---------------|
| AMI | When GH Docker image changes significantly (new deps, OS updates) |
| Launch Template | When instance type, disk, or SG changes |
| ASG | Never (just adjust min/max via env vars) |
| IAM Role | Never (unless new permissions needed) |
| Lifecycle Hook | Never |

---

## Disk Cleanup

EC2 instances accumulate Docker images, temp files, and logs over time. Automated cleanup prevents disk from filling up.

### What Gets Cleaned

| Target | Action | Schedule |
|--------|--------|----------|
| Dangling Docker images | `docker image prune -f` | Daily 3 AM UTC |
| Unused images >72h old | `docker image prune -a --filter "until=72h" -f` | Daily 3 AM UTC |
| Docker build cache >72h | `docker builder prune -f --filter "until=72h"` | Daily 3 AM UTC |
| Unused Docker volumes | `docker volume prune -f` | Daily 3 AM UTC |
| /tmp files >24h old | `find /tmp -type f -mtime +1 -delete` | Daily 3 AM UTC |
| GH logs >1 day | Compressed with gzip | Daily 3 AM UTC |
| GH logs >7 days | Deleted | Daily 3 AM UTC |
| journald logs >3 days | `journalctl --vacuum-time=3d` | Daily 3 AM UTC |

### Install on a New Instance

```bash
# SSH into the instance
ssh -i ~/.ssh/valet-worker.pem ubuntu@<instance-ip>

# Install the cron job
sudo bash /opt/ghosthands/scripts/setup-cleanup-cron.sh

# Or if scripts aren't on the instance yet, copy from repo:
cd /opt/ghosthands
sudo bash scripts/setup-cleanup-cron.sh
```

### Check Cleanup Logs

```bash
# View recent cleanup output
tail -50 /var/log/gh-disk-cleanup.log

# Verify cron is installed
crontab -l | grep gh-disk-cleanup

# Run manually
sudo /opt/ghosthands/scripts/disk-cleanup.sh

# Check current disk usage
df -h /
```

### Trigger Cleanup via API (All Instances)

The deploy-server exposes `POST /cleanup` (requires `X-Deploy-Secret`). Use this to trigger cleanup on any instance without SSH — works across the whole fleet:

```bash
# Single instance
curl -X POST http://<instance-ip>:8000/cleanup \
  -H "X-Deploy-Secret: $GH_DEPLOY_SECRET"

# All ASG instances (discover IPs, hit each)
aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=ghosthands-worker-asg" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text \
| tr '\t' '\n' | while read -r ip; do
    echo "Cleaning $ip..."
    curl -sf -X POST "http://${ip}:8000/cleanup" \
      -H "X-Deploy-Secret: $GH_DEPLOY_SECRET" || echo "FAILED: $ip"
  done
```

### For Golden AMI

When baking a new Golden AMI, run `setup-cleanup-cron.sh` before creating the image so all new ASG instances get the cron automatically.

---

*Last updated: 2026-02-23*
