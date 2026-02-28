# Kasm Workspaces Deployment Guide

**For:** DevOps, Engineering Leads
**Last Updated:** 2026-02-21

This guide documents the full process for deploying Kasm Workspaces CE with a GhostHands worker image. Follow these steps to set up a new Kasm server or register a new EC2 instance for sandbox orchestration.

---

## Architecture Overview

```
VALET (Fly.io)
  └─ KasmSandboxProvider
       └─ POST /api/public/request_kasm → Kasm CE (EC2)
            └─ Creates Docker container with:
                 ├─ KasmVNC desktop (browser visible to user)
                 ├─ GH API server (port 3100)
                 └─ GH Worker (port 3101, picks up jobs via DB)
```

Each Kasm session = isolated Docker container with a full desktop + GH worker. Environment variables are injected at session creation time by VALET.

---

## Prerequisites

- AWS account with EC2 access
- SSH key pair (e.g., `wekruit-atm-server.pem`)
- VALET deployed on Fly.io (staging or prod)
- GH source code (GHOST-HANDS repo)

---

## Step 1: Launch EC2 Instance

**Recommended spec:**
| Setting | Value |
|---------|-------|
| AMI | Ubuntu 24.04 LTS (HVM, SSD) |
| Instance type | t3.xlarge (4 vCPU, 16 GB RAM) |
| Storage | 100 GB gp3 EBS (encrypted) |
| Key pair | `valet-worker` (or create new) |

**Security group rules:**
| Port | Source | Purpose |
|------|--------|---------|
| 443 | 0.0.0.0/0 | Kasm UI + VNC sessions |
| 22 | Your IP | SSH admin |
| 3100 | 0.0.0.0/0 | GH worker API (for VALET on Fly.io) |

**After launch:**
1. Allocate an Elastic IP and associate it
2. Tag: `Name=kasm-staging`, `Project=WeKruit`, `Environment=staging`

---

## Step 2: Install Kasm Workspaces CE

```bash
ssh -i ~/.ssh/wekruit-atm-server.pem ubuntu@<KASM_IP>

# Update system
sudo apt update && sudo apt upgrade -y

# Download and install Kasm CE 1.18.1
cd /tmp
curl -O https://kasm-static-content.s3.amazonaws.com/kasm_release_1.18.1.tar.gz
tar -xf kasm_release_1.18.1.tar.gz
sudo bash kasm_release/install.sh --accept-eula --swap-size 8192
```

Installation takes ~5 minutes. Save the admin credentials printed at the end:
- Admin URL: `https://<KASM_IP>`
- Admin username: `admin@kasm.local`
- Admin password: (printed during install)

---

## Step 3: Configure Kasm Server Settings

Connect to the Kasm Postgres database and apply these settings:

```bash
# Find the Kasm Postgres container
sudo docker ps | grep kasmweb/postgres

# Connect
sudo docker exec -it <postgres_container> psql -U kasmapp -d kasm
```

```sql
-- Disable aggressive image pruning (keeps custom images)
UPDATE servers SET prune_images_mode = 'Off';

-- Allow multiple simultaneous sessions
UPDATE servers SET max_simultaneous_sessions = 5, max_simultaneous_users = 5;
```

---

## Step 4: Build the GH Worker Image

Clone the GH repo on the Kasm server and build:

```bash
cd /opt
sudo git clone https://github.com/WeKruit/GHOST-HANDS.git
cd GHOST-HANDS
git checkout staging

# Build with buildx (Docker 29+ uses containerd)
sudo docker buildx build -f Dockerfile.kasm \
  --output type=docker,dest=/tmp/ghosthands-kasm.tar \
  -t ghosthands-kasm:latest .

# Import into Docker's containerd store
sudo ctr -n moby images import --all-platforms /tmp/ghosthands-kasm.tar

# Verify
sudo docker images | grep ghosthands
```

**Important:** Docker 29+ with containerd snapshotter requires the tar export + `ctr import` workflow. `docker buildx build --load` alone does NOT properly store the image.

---

## Step 5: Register Image in Kasm

Use the Kasm admin API to register the workspace image:

```bash
# Get admin token (from Kasm Postgres)
sudo docker exec -it <postgres_container> psql -U kasmapp -d kasm \
  -c "SELECT token FROM users WHERE username = 'admin@kasm.local';"

# Register workspace image
curl -sk https://localhost/api/admin/create_image \
  -H 'Content-Type: application/json' \
  -d '{
    "token": "<admin_token>",
    "target_image": {
      "friendly_name": "GhostHands Worker",
      "image_src": "ghosthands-kasm:latest",
      "name": "ghosthands-kasm:latest",
      "description": "GH browser automation worker",
      "cores": 2,
      "memory": 3072000000,
      "available": true,
      "enabled": true,
      "image_type": "Container",
      "run_config": "{\"hostname\":\"gh-worker\"}"
    }
  }'
```

Save the returned `image.image_id` — this is `KASM_DEFAULT_IMAGE_ID`.

**Fix image name in DB** (if needed):
```sql
-- The images table `name` field MUST match the Docker tag
UPDATE images SET name = 'ghosthands-kasm:latest', available = true
  WHERE friendly_name = 'GhostHands Worker';
```

---

## Step 6: Create API Key

```bash
# Via Kasm admin API
curl -sk https://localhost/api/admin/add_api_key \
  -H 'Content-Type: application/json' \
  -d '{
    "token": "<admin_token>",
    "target_api_key": {
      "name": "valet-integration"
    }
  }'
```

Save `api_key` and `api_key_secret`.

**Add required permissions** (connect to Kasm Postgres):
```sql
-- Find the group_id for the API key
SELECT group_id FROM groups_api_keys WHERE api_id = '<api_id>';

-- Add User permission (required for session management)
INSERT INTO group_permissions (group_permission_id, permission_id, group_id, api_id)
VALUES (gen_random_uuid(), 100, '<group_id>', '<api_id>');

-- Add Users Auth Session permission (required for session auth)
INSERT INTO group_permissions (group_permission_id, permission_id, group_id, api_id)
VALUES (gen_random_uuid(), 352, '<group_id>', '<api_id>');
```

**Get User ID** (for session creation):
```sql
SELECT user_id FROM users WHERE username = 'admin@kasm.local';
```

---

## Step 7: Set VALET Environment Variables

```bash
fly secrets set -a valet-api-stg \
  KASM_API_URL="https://<KASM_IP>/api/public" \
  KASM_API_KEY="<api_key>" \
  KASM_API_KEY_SECRET="<api_key_secret>" \
  KASM_DEFAULT_IMAGE_ID="<image_id>" \
  KASM_DEFAULT_USER_ID="<user_id>" \
  AUTOSCALE_ENABLED="false"
```

---

## Step 8: Register Sandbox in VALET Database

Run in Supabase SQL Editor:

```sql
INSERT INTO sandboxes (
  id, name, environment, instance_id, instance_type,
  public_ip, status, health_status, capacity, current_load,
  browser_engine, machine_type, auto_stop_enabled,
  idle_minutes_before_stop, tags, created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'kasm-staging-01',
  'staging',
  '<ec2_instance_id>',
  'kasm',
  '<KASM_IP>',
  'active',
  'healthy',
  1,
  0,
  'chromium',
  'kasm',
  true,
  30,
  '{}',
  NOW(),
  NOW()
)
RETURNING id;
```

---

## Step 9: Verify End-to-End

Test session creation via API:

```bash
curl -sk https://<KASM_IP>/api/public/request_kasm \
  -H 'Content-Type: application/json' \
  -d '{
    "api_key": "<api_key>",
    "api_key_secret": "<api_key_secret>",
    "image_id": "<image_id>",
    "user_id": "<user_id>",
    "environment": {
      "GH_WORKER_ID": "test-001",
      "GH_API_PORT": "3100",
      "DATABASE_URL": "<database_url>",
      "GH_SERVICE_SECRET": "<gh_service_secret>",
      ...
    }
  }'
```

Verify inside the container:
```bash
# Health checks
docker exec <container_id> curl -s http://localhost:3100/health
docker exec <container_id> curl -s http://localhost:3101/worker/health

# Startup logs
docker exec <container_id> cat /tmp/gh-startup.log
docker exec <container_id> cat /tmp/gh-api.log
docker exec <container_id> cat /tmp/gh-worker.log
```

Destroy test session:
```bash
curl -sk https://<KASM_IP>/api/public/destroy_kasm \
  -H 'Content-Type: application/json' \
  -d '{
    "api_key": "<api_key>",
    "api_key_secret": "<api_key_secret>",
    "kasm_id": "<kasm_id>",
    "user_id": "<user_id>"
  }'
```

---

## Troubleshooting

### "No resources are available"
1. Check Docker image exists: `docker images | grep ghosthands`
2. Check Kasm `images` table: `name` must match Docker tag, `available` must be `true`
3. Check `prune_images_mode` is `Off` in `servers` table
4. Re-import image if pruned: `ctr -n moby images import --all-platforms /tmp/ghosthands-kasm.tar`

### "Unknown Service: custom_startup"
The startup script crashed on execution. Check:
1. Container logs: `docker logs <container_id>`
2. Startup log: `docker exec <container_id> cat /tmp/gh-startup.log`
3. Most common cause: missing env vars with `set -euo pipefail`

### "Unauthorized" on session creation
API key missing required permissions. Add permission_id 100 (User) and 352 (Users Auth Session) to `group_permissions`.

### Docker build: image not in Docker store
Docker 29 with containerd snapshotter issue. Use:
```bash
docker buildx build --output type=docker,dest=/tmp/image.tar -t tag .
ctr -n moby images import --all-platforms /tmp/image.tar
```

---

## Current Staging Infrastructure

| Resource | Value |
|----------|-------|
| EC2 Instance | `i-0ce28cc3f3cd05c36` |
| Public IP | `52.200.199.70` |
| Security Group | `sg-0f9ac2fd4877e5e04` (kasm-staging) |
| Kasm Admin | `admin@kasm.local` |
| Kasm API Key | `VEtw0g1270Yu` |
| Image ID | `3a08021231af4d6496139031be6bbe03` |
| User ID | `c67e221f425947c398a7ec9416dca787` |
| Sandbox DB ID | `94c6cb90-4b66-4056-b501-b4924e6f1ecd` |
| VALET Env Vars | Set on `valet-api-stg` via `fly secrets` |
