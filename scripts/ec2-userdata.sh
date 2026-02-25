#!/bin/bash
# =============================================================================
# EC2 User Data Script — GhostHands Worker Bootstrap
# =============================================================================
#
# This script runs on every EC2 instance launch (via ASG Launch Template).
# It pulls secrets from AWS Secrets Manager and starts the GH worker.
#
# Prerequisites:
#   - AMI has: aws CLI, jq, Docker, docker-compose
#   - Instance role: ghosthands-worker-role (with Secrets Manager access)
#   - Secret exists: ghosthands/<environment> in AWS Secrets Manager
#
# The environment is determined by:
#   1. Instance tag "Environment" (set by ASG/Launch Template)
#   2. Fallback: "staging"
#
# Linear: https://linear.app/wecrew-axon/issue/WEK-159
# =============================================================================

set -euo pipefail

touch /var/log/ghosthands-userdata.log
chmod 600 /var/log/ghosthands-userdata.log
exec > >(tee /var/log/ghosthands-userdata.log | logger -t ghosthands-userdata) 2>&1

echo "[userdata] $(date -u +%FT%TZ) Starting GhostHands bootstrap..."

REGION="${AWS_REGION:-us-east-1}"
APP_DIR="/opt/ghosthands"

# ── IMDS token (v2 preferred, v1 fallback) ─────────────────────────
IMDS_TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
imds_get() {
  local path="$1"
  if [[ -n "$IMDS_TOKEN" ]]; then
    curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$path" 2>/dev/null || true
  else
    curl -sf "http://169.254.169.254/latest/meta-data/$path" 2>/dev/null || true
  fi
}

# ── Detect environment from instance tags ──────────────────────────
INSTANCE_ID=$(imds_get "instance-id")
ENVIRONMENT="staging"

if [[ -n "$INSTANCE_ID" ]]; then
  TAG_ENV=$(aws ec2 describe-tags \
    --region "$REGION" \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=Environment" \
    --query 'Tags[0].Value' --output text 2>/dev/null || true)

  if [[ -n "$TAG_ENV" ]] && [[ "$TAG_ENV" != "None" ]]; then
    ENVIRONMENT="$TAG_ENV"
  fi
fi

echo "[userdata] Environment: $ENVIRONMENT"
echo "[userdata] Instance: ${INSTANCE_ID:-unknown}"

# ── Pull secrets from AWS Secrets Manager ──────────────────────────
echo "[userdata] Pulling secrets from Secrets Manager..."

if [[ -f "${APP_DIR}/scripts/pull-secrets.sh" ]]; then
  chmod +x "${APP_DIR}/scripts/pull-secrets.sh"
  "${APP_DIR}/scripts/pull-secrets.sh" "$ENVIRONMENT"
else
  # Inline fallback if pull-secrets.sh doesn't exist yet (first boot)
  SECRET_ID="ghosthands/${ENVIRONMENT}"

  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --region "$REGION" \
    --secret-id "$SECRET_ID" \
    --query SecretString \
    --output text 2>/dev/null) || {
    echo "[userdata] ERROR: Failed to fetch secret $SECRET_ID"
    echo "[userdata] Falling back to existing .env (if any)"
  }

  if [[ -n "${SECRET_JSON:-}" ]]; then
    echo "$SECRET_JSON" | jq -r 'to_entries[] | "\(.key)=\"\(.value | gsub("\""; "\\\""))\""' > "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
    echo "[userdata] Wrote .env from Secrets Manager ($SECRET_ID)"
  fi
fi

# ── Verify .env exists and has content ────────────────────────────
if [[ ! -s "${APP_DIR}/.env" ]]; then
  echo "[userdata] FATAL: .env is empty or missing after secret pull. Aborting."
  exit 1
fi

# ── Inject runtime variables ──────────────────────────────────────
# These are instance-specific and NOT in Secrets Manager
{
  echo ""
  echo "# Runtime-injected (instance-specific)"
  echo "GH_WORKER_ID=${INSTANCE_ID:-$(hostname)}"
  echo "EC2_INSTANCE_ID=${INSTANCE_ID:-}"
  echo "EC2_IP=$(imds_get "public-ipv4")"
} >> "${APP_DIR}/.env"

echo "[userdata] Runtime vars injected"

# ── Login to ECR ──────────────────────────────────────────────────
ECR_REGISTRY=$(grep '^ECR_REGISTRY=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || true)
if [[ -n "$ECR_REGISTRY" ]]; then
  echo "[userdata] Logging into ECR: $ECR_REGISTRY"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ECR_REGISTRY" 2>/dev/null || {
    echo "[userdata] WARNING: ECR login failed"
  }
fi

# ── Start services via docker-compose ─────────────────────────────
COMPOSE_FILE="${APP_DIR}/docker-compose.${ENVIRONMENT}.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
  COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
fi

echo "[userdata] Starting services with: $COMPOSE_FILE"
cd "$APP_DIR" || { echo "[userdata] FATAL: Cannot cd to $APP_DIR"; exit 1; }
docker compose -f "$COMPOSE_FILE" pull || {
  echo "[userdata] WARNING: Docker pull failed, attempting start with cached image"
}
docker compose -f "$COMPOSE_FILE" up -d

echo "[userdata] $(date -u +%FT%TZ) Bootstrap complete."
