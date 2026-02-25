# Required GitHub Secrets

All secrets used by the CI/CD workflows (`.github/workflows/ci.yml`, `rollback.yml`).

## AWS Credentials (Required)

| Secret | Description | Example |
|--------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | IAM access key with ECR push + EC2 describe + ASG permissions | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key | (40-char string) |
| `AWS_REGION` | AWS region | `us-east-1` |

**Required IAM permissions:**
- `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, etc.
- `ec2:DescribeInstances`, `ec2:CreateImage`, `ec2:DescribeImages`, `ec2:DeregisterImage`
- `ec2:CreateLaunchTemplateVersion`, `ec2:ModifyLaunchTemplate`, `ec2:DescribeLaunchTemplateVersions`
- `autoscaling:DescribeAutoScalingGroups`, `autoscaling:StartInstanceRefresh`, `autoscaling:DescribeInstanceRefreshes`

## ECR (Required for Docker Build & Push)

| Secret | Description | Example |
|--------|-------------|---------|
| `ECR_REGISTRY` | Full ECR registry URL | `123456789012.dkr.ecr.us-east-1.amazonaws.com` |
| `ECR_REPOSITORY` | ECR repository name | `ghosthands` |

**Setup:** If the ECR repo doesn't exist yet:
```bash
aws ecr create-repository \
  --repository-name ghosthands \
  --region us-east-1 \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
```

## SSH (Required for ASG Deploy)

| Secret | Description | Notes |
|--------|-------------|-------|
| `SANDBOX_SSH_KEY` | Private SSH key (PEM format) for EC2 access | Contents of `valet-worker.pem` |

The key must be authorized on all ASG instances (via Launch Template user-data or AMI).
Default SSH user: `ubuntu`.

## Supabase (Required for Integration Tests)

| Secret | Description | Example |
|--------|-------------|---------|
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SECRET_KEY` | Service role key | `sb_secret_...` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable/anon key | `sb_publishable_...` |
| `SUPABASE_DIRECT_URL` | Direct Postgres connection string | `postgresql://postgres:...@db.xxx.supabase.co:5432/postgres` |

## GhostHands Service (Required for Integration Tests)

| Secret | Description | How to Generate |
|--------|-------------|-----------------|
| `GH_SERVICE_SECRET` | Service-to-service auth key (shared with VALET) | `openssl rand -hex 32` |
| `GH_ENCRYPTION_KEY` | AES-256-GCM key for credential encryption | `openssl rand -base64 32` |

## Deployment Notifications (Optional)

| Secret | Description | Notes |
|--------|-------------|-------|
| `VALET_DEPLOY_WEBHOOK_URL` | VALET's deploy webhook endpoint | Set in VALET's Fly.io config |
| `VALET_DEPLOY_WEBHOOK_SECRET` | HMAC-SHA256 signing key for webhook payloads | Shared between GH Actions and VALET |

## Kasm Workspaces (Optional)

| Secret | Description | Notes |
|--------|-------------|-------|
| `KASM_API_URL` | Kasm CE API base URL | `https://52.200.199.70` |
| `KASM_API_KEY` | Kasm API key ID | From Kasm admin panel |
| `KASM_API_SECRET` | Kasm API key secret | From Kasm admin panel |
| `KASM_IMAGE_ID` | Workspace image UUID to update | From Kasm `images` table |

## ASG Deploy (Optional — for deploy-to-asg job)

| Secret | Description | Default |
|--------|-------------|---------|
| `AWS_ASG_NAME` | Auto Scaling Group name | `ghosthands-worker-asg` |
| `AWS_LAUNCH_TEMPLATE_ID` | Launch Template ID | `lt-0fbfe0179c502d5b9` |

These can also be hardcoded in the workflow if they don't change.

## How to Set Secrets

```bash
# Via GitHub CLI
gh secret set AWS_ACCESS_KEY_ID --body "AKIA..."
gh secret set AWS_SECRET_ACCESS_KEY --body "..."

# For multi-line secrets (SSH key)
gh secret set SANDBOX_SSH_KEY < ~/.ssh/valet-worker.pem
```

Or via GitHub UI: **Settings > Secrets and variables > Actions > New repository secret**
