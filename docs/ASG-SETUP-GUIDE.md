# AWS Auto Scaling Group (ASG) Setup Guide

**For:** WeKruit infrastructure operators
**Last Updated:** 2026-02-21
**Status:** Runbook (manual setup — not automated)

---

## Overview

This guide covers setting up an AWS Auto Scaling Group (ASG) for the GhostHands worker fleet. The ASG automatically manages EC2 instances running GH workers, scaling up when the job queue grows and scaling down when workers are idle.

### Architecture

```
VALET API (AutoScaleService)
    │
    │  DescribeAutoScalingGroups / UpdateAutoScalingGroup
    ▼
AWS Auto Scaling Group
    │
    │  Launch Template → Golden AMI
    ▼
EC2 Instances (1..N)
    │
    │  User Data script → docker-compose up
    ▼
GH Worker Containers
    │
    │  pg-boss queue consumption
    ▼
Job Execution
```

---

## 1. Prerequisites

Before starting, ensure you have:

| Prerequisite | Details |
|---|---|
| **AWS Account** | With permissions to create EC2, ASG, IAM, ECR, Secrets Manager resources |
| **AWS CLI v2** | Configured locally with `aws configure` |
| **VPC** | Existing VPC with at least 2 subnets across availability zones |
| **Security Groups** | Will be created in this guide (section 7) |
| **IAM Role** | Will be created in this guide (section 6) |
| **ECR Repository** | For GH Docker images (e.g. `ghosthands`) |
| **Supabase Project** | Connection string accessible from EC2 (public or VPC-peered) |
| **SSH Key Pair** | `valet-worker` key pair in AWS for instance access |
| **Secrets Manager Secret** | `ghosthands/worker/env` — stores all worker env vars (section 9) |

---

## 2. Golden AMI Creation

The Golden AMI is a pre-configured Amazon Machine Image with Docker, docker-compose, AWS CLI, and Xvfb (for headed browser mode). Pre-baking these into the AMI reduces instance startup time.

### Option A: Manual AMI Creation (Amazon Linux 2023)

1. Launch a base Amazon Linux 2023 instance:

```bash
aws ec2 run-instances \
  --image-id ami-0c101f26f147fa7fd \
  --instance-type t3.large \
  --key-name valet-worker \
  --security-group-ids sg-XXXXXXXX \
  --subnet-id subnet-XXXXXXXX \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=gh-golden-ami-builder}]'
```

2. SSH in and install dependencies:

```bash
ssh -i ~/.ssh/valet-worker.pem ec2-user@<instance-ip>

# Update system
sudo dnf update -y

# Install Docker
sudo dnf install -y docker
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user

# Install docker-compose v2
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# AWS CLI v2 is pre-installed on Amazon Linux 2023
aws --version

# Install Xvfb for headed browser mode (Patchright/Chromium)
sudo dnf install -y xorg-x11-server-Xvfb

# Create systemd service for auto-start on boot
sudo tee /etc/systemd/system/ghosthands.service > /dev/null << 'UNIT'
[Unit]
Description=GhostHands Worker
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/ghosthands
ExecStartPre=/usr/bin/bash /opt/ghosthands/user-data.sh
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
TimeoutStartSec=120
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable ghosthands.service

# Pre-pull the ECR image (speeds up first boot)
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
docker pull <account-id>.dkr.ecr.us-east-1.amazonaws.com/ghosthands:latest

# Create app directory
sudo mkdir -p /opt/ghosthands
sudo chown ec2-user:ec2-user /opt/ghosthands

# Copy docker-compose.prod.yml to /opt/ghosthands
# (Fetched from the repo or baked into the AMI)
```

3. Create the AMI:

```bash
aws ec2 create-image \
  --instance-id i-XXXXXXXXXXXXXXXXX \
  --name "gh-worker-golden-$(date +%Y%m%d)" \
  --description "GhostHands worker AMI - AL2023, Docker, Xvfb, AWS CLI" \
  --no-reboot

# Note the AMI ID from the output: ami-XXXXXXXXXXXXXXXXX
```

4. Terminate the builder instance:

```bash
aws ec2 terminate-instances --instance-ids i-XXXXXXXXXXXXXXXXX
```

### Option B: Packer Template (Recommended for CI)

Create `packer/gh-worker.pkr.hcl`:

```hcl
packer {
  required_plugins {
    amazon = {
      version = ">= 1.0.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

source "amazon-ebs" "gh-worker" {
  ami_name      = "gh-worker-{{timestamp}}"
  instance_type = "t3.large"
  region        = "us-east-1"

  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["137112412989"]  # Amazon
  }

  ssh_username = "ec2-user"

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 40
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name    = "gh-worker-golden"
    Project = "wekruit"
  }
}

build {
  sources = ["source.amazon-ebs.gh-worker"]

  provisioner "shell" {
    scripts = [
      "packer/scripts/install-docker.sh",
      "packer/scripts/install-xvfb.sh",
      "packer/scripts/setup-ghosthands.sh",
    ]
  }
}
```

Build with: `packer build packer/gh-worker.pkr.hcl`

---

## 3. Launch Template

The Launch Template defines the instance configuration that ASG uses when launching new workers.

```bash
aws ec2 create-launch-template \
  --launch-template-name gh-worker-lt \
  --version-description "GhostHands worker v1" \
  --launch-template-data '{
    "ImageId": "ami-XXXXXXXXXXXXXXXXX",
    "InstanceType": "t3.medium",
    "KeyName": "valet-worker",
    "SecurityGroupIds": ["sg-XXXXXXXX"],
    "IamInstanceProfile": {
      "Name": "gh-worker-instance-profile"
    },
    "BlockDeviceMappings": [
      {
        "DeviceName": "/dev/xvda",
        "Ebs": {
          "VolumeSize": 40,
          "VolumeType": "gp3",
          "DeleteOnTermination": true
        }
      }
    ],
    "UserData": "'$(base64 -w 0 user-data.sh)'",
    "TagSpecifications": [
      {
        "ResourceType": "instance",
        "Tags": [
          {"Key": "Name", "Value": "gh-worker"},
          {"Key": "Project", "Value": "wekruit"},
          {"Key": "Role", "Value": "gh-worker"}
        ]
      }
    ],
    "MetadataOptions": {
      "HttpTokens": "required",
      "HttpPutResponseHopLimit": 2,
      "HttpEndpoint": "enabled"
    }
  }'
```

### Recommended Instance Type

| Size | Instance | vCPU | RAM | Use Case |
|------|----------|------|-----|----------|
| Default | `t3.medium` | 2 | 4 GB | 1 concurrent browser session |
| Heavy | `t3.large` | 2 | 8 GB | Complex multi-tab jobs or future multi-session |

`t3.medium` is sufficient for single-job workers. The worker runs one browser session at a time (hardcoded `maxConcurrent = 1` in `main.ts`).

---

## 4. Auto Scaling Group

```bash
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name gh-worker-asg \
  --launch-template LaunchTemplateName=gh-worker-lt,Version='$Latest' \
  --min-size 1 \
  --max-size 10 \
  --desired-capacity 1 \
  --vpc-zone-identifier "subnet-XXXXXXXX,subnet-YYYYYYYY" \
  --health-check-type EC2 \
  --health-check-grace-period 300 \
  --default-cooldown 300 \
  --tags \
    "Key=Name,Value=gh-worker,PropagateAtLaunch=true" \
    "Key=Project,Value=wekruit,PropagateAtLaunch=true"
```

### Key Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `min-size` | 1 | Always have at least one warm worker |
| `max-size` | 10 | Cost ceiling, adjustable via VALET AutoScaleService |
| `desired-capacity` | 1 | Starting fleet size |
| `health-check-type` | EC2 | Instance-level health only (no ALB) |
| `health-check-grace-period` | 300s | Time for Docker + worker to boot and register |
| `default-cooldown` | 300s | Prevent scale flapping |

VALET's `AutoScaleService` controls scaling by calling `UpdateAutoScalingGroup` to change `desired-capacity` based on job queue depth.

---

## 5. Lifecycle Hook

The lifecycle hook gives the worker time to drain in-flight jobs before the instance is terminated during scale-in events.

```bash
aws autoscaling put-lifecycle-hook \
  --auto-scaling-group-name gh-worker-asg \
  --lifecycle-hook-name gh-worker-termination \
  --lifecycle-transition autoscaling:EC2_INSTANCE_TERMINATING \
  --heartbeat-timeout 300 \
  --default-result ABANDON
```

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `lifecycle-hook-name` | `gh-worker-termination` | Matches `AWS_LIFECYCLE_HOOK_NAME` env var in worker |
| `lifecycle-transition` | `autoscaling:EC2_INSTANCE_TERMINATING` | Fires before instance termination |
| `heartbeat-timeout` | 300s | Max time to wait for worker to drain |
| `default-result` | `ABANDON` | If worker fails to signal, cancel termination to avoid data loss |

### How It Works

The GH worker handles the lifecycle hook in `packages/ghosthands/src/workers/main.ts`:

1. ASG decides to terminate an instance (scale-down or replacement)
2. Docker receives SIGTERM signal
3. Worker's `shutdown()` handler fires (line 220 of `main.ts`)
4. Worker stops accepting new jobs via `stopJobProcessor()`
5. Active jobs drain (up to job timeout)
6. Worker deregisters from `gh_worker_registry` (sets status to `offline`)
7. Worker calls `completeLifecycleAction()` via AWS CLI (line 253 of `main.ts`)
8. ASG receives `CONTINUE` result and proceeds with termination

If the worker fails to call `complete-lifecycle-action` within 300s (e.g. crash), ASG aborts the termination (`default-result: ABANDON`). This prevents terminating instances that may still be processing jobs.

### Important: Hook Name Must Match

The env var `AWS_LIFECYCLE_HOOK_NAME` on the worker must match the `--lifecycle-hook-name` used here. The code defaults to `gh-worker-termination` if the env var is not set:

```typescript
// main.ts line 317
const asgLifecycleHookName = process.env.AWS_LIFECYCLE_HOOK_NAME || 'gh-worker-termination';
```

---

## 6. IAM Role and Instance Profile

### Create the IAM Role

```bash
# Trust policy — allows EC2 instances to assume this role
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name gh-worker-role \
  --assume-role-policy-document file://trust-policy.json
```

### Worker Permissions Policy

The EC2 instance role needs:
- **Outbound HTTPS** — Supabase, LLM APIs, ATS sites (handled by security group, not IAM)
- **ECR pull** — to pull the GH worker Docker image
- **ASG lifecycle** — `completeLifecycleAction` for graceful shutdown
- **Secrets Manager** — to fetch worker environment variables
- **CloudWatch Logs** — for centralized logging

```bash
cat > worker-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ASGLifecycle",
      "Effect": "Allow",
      "Action": [
        "autoscaling:CompleteLifecycleAction",
        "autoscaling:RecordLifecycleActionHeartbeat"
      ],
      "Resource": "arn:aws:autoscaling:us-east-1:<account-id>:autoScalingGroup:*:autoScalingGroupName/gh-worker-asg"
    },
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECRPull",
      "Effect": "Allow",
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability"
      ],
      "Resource": "arn:aws:ecr:us-east-1:<account-id>:repository/ghosthands"
    },
    {
      "Sid": "SecretsAccess",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:ghosthands/worker/*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:<account-id>:log-group:/wekruit/gh-worker:*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name gh-worker-role \
  --policy-name gh-worker-permissions \
  --policy-document file://worker-policy.json
```

### Create Instance Profile

```bash
aws iam create-instance-profile \
  --instance-profile-name gh-worker-instance-profile

aws iam add-role-to-instance-profile \
  --instance-profile-name gh-worker-instance-profile \
  --role-name gh-worker-role
```

---

## 7. Security Group

GH workers pull jobs from a Supabase queue and connect outbound to ATS sites, LLM APIs, and Supabase. No inbound traffic is required for core functionality — workers are pull-based.

```bash
# Create security group
aws ec2 create-security-group \
  --group-name gh-worker-sg \
  --description "GhostHands worker instances" \
  --vpc-id vpc-XXXXXXXX

SG_ID=sg-XXXXXXXX  # From output above

# ── Inbound: none required for core worker functionality ──
# Workers pull from queue (no inbound needed for job processing)
#
# Optional inbound rules for management and deploy orchestration:

# SSH from management IP (restrict to your IP or bastion)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 22 \
  --cidr <your-ip>/32

# Worker status port (3101) from VALET — for health checks during deploy
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 3101 \
  --source-group sg-VALET_SG_ID

# Deploy server (8000) from VALET — for rolling deploy orchestration
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 8000 \
  --source-group sg-VALET_SG_ID

# GH API (3100) from VALET — for direct API calls
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 3100 \
  --source-group sg-VALET_SG_ID

# ── Outbound: all traffic (workers need internet access) ──
# Workers connect to: Supabase (HTTPS), LLM APIs, ATS websites (browser automation)
aws ec2 authorize-security-group-egress \
  --group-id $SG_ID \
  --protocol -1 \
  --cidr 0.0.0.0/0
```

### Summary

| Direction | Port | Source/Dest | Purpose |
|-----------|------|-------------|---------|
| **Inbound** | 22 | Management IP | SSH access |
| **Inbound** | 3100 | VALET SG | GH API server |
| **Inbound** | 3101 | VALET SG | Worker status/health |
| **Inbound** | 8000 | VALET SG | Deploy server |
| **Outbound** | All | 0.0.0.0/0 | Supabase, LLM APIs, ATS sites |

---

## 8. UserData Script Template

This script runs on every instance boot. It fetches secrets from AWS Secrets Manager, configures instance-specific environment variables, and starts the worker containers.

Create `user-data.sh`:

```bash
#!/bin/bash
set -euo pipefail

REGION="us-east-1"
SECRET_ID="ghosthands/worker/env"
APP_DIR="/opt/ghosthands"
LOG_FILE="/var/log/gh-worker-userdata.log"

exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== GH Worker UserData started at $(date -u) ==="

# ── Fetch secrets from AWS Secrets Manager ──────────────────
echo "Fetching secrets from Secrets Manager: $SECRET_ID"
aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" \
  --region "$REGION" \
  --query SecretString \
  --output text > "$APP_DIR/.env"

# ── Set instance-specific env vars from IMDSv2 ──────────────
# The worker also auto-detects these via fetchEc2Metadata() in main.ts,
# but setting them in .env ensures docker-compose and other scripts see them.
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")

INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)

LOCAL_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/local-ipv4)

{
  echo ""
  echo "# ── Instance-specific (set by user-data.sh) ──"
  echo "EC2_INSTANCE_ID=${INSTANCE_ID}"
  echo "EC2_IP=${LOCAL_IP}"
  echo "AWS_ASG_NAME=gh-worker-asg"
  echo "AWS_LIFECYCLE_HOOK_NAME=gh-worker-termination"
  echo "AWS_REGION=${REGION}"
} >> "$APP_DIR/.env"

# Secure .env file
chmod 600 "$APP_DIR/.env"
echo "Environment configured for instance $INSTANCE_ID ($LOCAL_IP)"

# ── Start Xvfb (virtual framebuffer for headed browser) ─────
if ! pgrep -x Xvfb > /dev/null; then
  Xvfb :99 -screen 0 1920x1080x24 &
  echo "Xvfb started on :99"
fi
export DISPLAY=:99

# ── Pull latest image from ECR ──────────────────────────────
echo "Authenticating with ECR..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin \
  "<account-id>.dkr.ecr.${REGION}.amazonaws.com"

echo "Pulling latest GH worker image..."
docker pull "<account-id>.dkr.ecr.${REGION}.amazonaws.com/ghosthands:latest"

# Tag for docker-compose (uses ECR_IMAGE env var)
echo "ECR_IMAGE=<account-id>.dkr.ecr.${REGION}.amazonaws.com/ghosthands:latest" >> "$APP_DIR/.env"

# ── Start containers ────────────────────────────────────────
echo "Starting GH worker containers..."
cd "$APP_DIR"
docker compose -f docker-compose.prod.yml up -d

echo "=== GH Worker UserData completed at $(date -u) ==="
```

**Note:** Replace `<account-id>` with your AWS account ID (12-digit number).

---

## 9. Environment Variables

The worker needs the following environment variables. These are stored in AWS Secrets Manager at `ghosthands/worker/env` and fetched by the UserData script.

### Core Variables (from Secrets Manager)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL (e.g. `https://xxxx.supabase.co`) |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key for DB access |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase anon/publishable key |
| `DATABASE_URL` | Yes | Pooled Postgres connection string (port 6543) |
| `DATABASE_DIRECT_URL` | Yes | Direct Postgres connection string (port 5432, for LISTEN/NOTIFY) |
| `GH_SERVICE_SECRET` | Yes | Service-to-service auth key (shared with VALET) |
| `GH_ENCRYPTION_KEY` | Yes | AES-256-GCM key for stored credentials |
| `GH_DEPLOY_SECRET` | Yes | Shared secret for VALET deploy server auth |
| `GH_ENVIRONMENT` | Yes | `staging` or `production` |
| `GH_API_PORT` | No | API server port (default: `3100`) |
| `GH_WORKER_PORT` | No | Worker status port (default: `3101`) |
| `GH_WORKER_ID` | No | Worker identity for registry (auto-generated if unset) |
| `MAX_CONCURRENT_JOBS` | No | Max browser sessions per worker (default: `1`) |
| `JOB_DISPATCH_MODE` | No | `queue` (pg-boss) or `legacy` (LISTEN/NOTIFY, default) |
| `NODE_ENV` | No | Set to `production` for deployed workers |
| `REDIS_URL` | No | Redis connection for real-time progress streaming |

### LLM Provider Keys (at least one required)

| Variable | Provider |
|----------|----------|
| `SILICONFLOW_API_KEY` | SiliconFlow (Qwen vision models) |
| `OPENAI_API_KEY` | OpenAI (GPT-4o) |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `GOOGLE_API_KEY` | Google AI (Gemini) |
| `DEEPSEEK_API_KEY` | DeepSeek (text-only) |
| `GH_DEFAULT_MODEL` | Default model alias (e.g. `gpt-4o-mini`) |

### Instance-Specific Variables (set by UserData script)

These are appended to `.env` automatically by `user-data.sh` and should NOT be in Secrets Manager:

| Variable | Source | Description |
|----------|--------|-------------|
| `EC2_INSTANCE_ID` | IMDSv2 | EC2 instance ID (e.g. `i-0abc123def456`) |
| `EC2_IP` | IMDSv2 | Instance private IP |
| `AWS_ASG_NAME` | UserData | ASG name (`gh-worker-asg`) |
| `AWS_LIFECYCLE_HOOK_NAME` | UserData | Lifecycle hook name (`gh-worker-termination`) |
| `AWS_REGION` | UserData | AWS region (e.g. `us-east-1`) |
| `ECR_IMAGE` | UserData | Full ECR image URI for docker-compose |

Reference: `packages/ghosthands/.env.example` and root `.env.example`

---

## 10. VALET Configuration

Set these environment variables on the VALET API (Fly.io secrets) to enable ASG auto-scaling:

```bash
fly secrets set -a valet-api-stg \
  AUTOSCALE_ASG_ENABLED=true \
  AWS_ASG_NAME=gh-worker-asg \
  AUTOSCALE_ASG_MIN=1 \
  AUTOSCALE_ASG_MAX=10 \
  JOBS_PER_WORKER=1
```

VALET's `AutoScaleService` periodically checks job queue depth and calls `UpdateAutoScalingGroup` to adjust `desired-capacity`.

---

## 11. Validation Checklist

After completing the setup, verify each component end-to-end:

### Instance Launch

- [ ] ASG launches an instance successfully (check EC2 console)
- [ ] UserData script completes without errors: `sudo cat /var/log/gh-worker-userdata.log`
- [ ] Docker containers are running: `docker ps` shows api, worker, deploy-server
- [ ] `.env` file exists with correct values: `ls -la /opt/ghosthands/.env`

### Worker Registration

- [ ] Worker registers in `gh_worker_registry` table with status `active`
- [ ] `ec2_instance_id` and `ec2_ip` columns are populated (not `unknown`)
- [ ] Heartbeat updates every 30s (`last_heartbeat` column advances)

### Job Processing

- [ ] Worker picks up jobs from queue (check worker logs: `docker logs gh-worker`)
- [ ] Job completes successfully and `gh_automation_jobs.status` updates
- [ ] Browser automation runs (Xvfb is active: `pgrep Xvfb`)

### Scale-In and Graceful Shutdown

- [ ] Manually terminate an instance via AWS console or CLI
- [ ] Worker receives SIGTERM (check logs for `Starting graceful shutdown`)
- [ ] Worker stops accepting new jobs
- [ ] Active job drains to completion (if one was running)
- [ ] Worker deregisters from `gh_worker_registry` (status becomes `offline`)
- [ ] `completeLifecycleAction` is called (logs: `ASG lifecycle action completed`)
- [ ] Instance terminates cleanly after lifecycle hook completes

### VALET Integration

- [ ] VALET `AutoScaleService` can call `DescribeAutoScalingGroups` (check IAM)
- [ ] VALET `AutoScaleService` can call `UpdateAutoScalingGroup` (check IAM)
- [ ] Scale-up: submit 5 jobs -> ASG increases desired capacity
- [ ] Scale-down: queue empties -> ASG decreases to min capacity

### Verification Commands

```bash
# Check ASG status
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names gh-worker-asg \
  --query 'AutoScalingGroups[0].{Min:MinSize,Max:MaxSize,Desired:DesiredCapacity,Instances:Instances[*].{Id:InstanceId,State:LifecycleState}}' \
  --output table

# Check lifecycle hooks
aws autoscaling describe-lifecycle-hooks \
  --auto-scaling-group-name gh-worker-asg

# Check worker registry (from psql or Supabase SQL editor)
SELECT worker_id, status, ec2_instance_id, ec2_ip, last_heartbeat, current_job_id
FROM gh_worker_registry
WHERE status != 'offline'
ORDER BY last_heartbeat DESC;

# Check cloud-init logs on an instance
ssh -i ~/.ssh/valet-worker.pem ec2-user@<instance-ip> \
  "sudo cat /var/log/cloud-init-output.log | tail -50"
```

---

## Troubleshooting

### Instances not joining fleet

1. Check UserData output: `sudo cat /var/log/gh-worker-userdata.log`
2. Check cloud-init: `sudo cat /var/log/cloud-init-output.log`
3. Verify Docker is running: `docker ps`
4. Check `.env` file exists and has correct values: `ls -la /opt/ghosthands/.env`
5. Check worker logs: `docker logs gh-worker`

### ASG not scaling

1. Check VALET logs for `ASG auto-scale evaluation`
2. Verify `AUTOSCALE_ASG_ENABLED=true` is set on VALET
3. Verify VALET's IAM user has `autoscaling:DescribeAutoScalingGroups` and `autoscaling:UpdateAutoScalingGroup`
4. Check job queue: `SELECT * FROM pgboss.job WHERE name = 'gh_apply_job' AND state = 'created'`

### Lifecycle hook timeout

1. Check worker shutdown logs: `docker logs gh-worker | grep -i shutdown`
2. Verify `AWS_ASG_NAME` and `AWS_LIFECYCLE_HOOK_NAME` are set in `.env`
3. Verify IAM role has `autoscaling:CompleteLifecycleAction`
4. Increase `heartbeat-timeout` if workers need more drain time:
   ```bash
   aws autoscaling put-lifecycle-hook \
     --auto-scaling-group-name gh-worker-asg \
     --lifecycle-hook-name gh-worker-termination \
     --heartbeat-timeout 600
   ```

### Worker not calling completeLifecycleAction

The worker uses the AWS CLI (not SDK) to call `complete-lifecycle-action`. Verify:
1. AWS CLI is installed: `aws --version`
2. Instance has IAM role attached (not relying on env var credentials)
3. Role has `autoscaling:CompleteLifecycleAction` permission scoped to the ASG

### Secrets Manager access denied

1. Verify the instance profile is attached: `curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/`
2. Verify the role has `secretsmanager:GetSecretValue` for `ghosthands/worker/*`
3. Test from the instance: `aws secretsmanager get-secret-value --secret-id ghosthands/worker/env --region us-east-1`

---

*This is a manual infrastructure runbook. Do NOT execute these commands from automated CI without review.*
