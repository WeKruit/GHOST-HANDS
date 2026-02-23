#!/usr/bin/env bash
set -euo pipefail

# Deploy GhostHands to all running ASG instances
#
# Discovers running instances in the ASG via AWS API, SSHes to each,
# pulls the new Docker image from ECR, and restarts services using
# the existing deploy.sh script (graceful drain + health check).
#
# Usage:
#   ./scripts/deploy-to-asg.sh <image-tag>
#   ./scripts/deploy-to-asg.sh staging-abc1234 --ssh-key ~/.ssh/valet-worker.pem
#
# Required env vars:
#   AWS_ASG_NAME    - Auto Scaling Group name
#   AWS_REGION      - AWS region (default: us-east-1)
#   ECR_REGISTRY    - ECR registry URL
#   ECR_REPOSITORY  - ECR repository name
#
# Optional env vars:
#   SSH_KEY_PATH    - Path to SSH private key (default: ~/.ssh/valet-worker.pem)
#   SSH_USER        - SSH user (default: ubuntu)
#   GHOSTHANDS_DIR  - Remote GH directory (default: /opt/ghosthands)

IMAGE_TAG="${1:-staging}"
ASG_NAME="${AWS_ASG_NAME:?AWS_ASG_NAME is required}"
REGION="${AWS_REGION:-us-east-1}"
ECR_REG="${ECR_REGISTRY:?ECR_REGISTRY is required}"
ECR_REPO="${ECR_REPOSITORY:?ECR_REPOSITORY is required}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/valet-worker.pem}"
SSH_USER="${SSH_USER:-ubuntu}"
REMOTE_DIR="${GHOSTHANDS_DIR:-/opt/ghosthands}"

# Parse optional arguments (skip $1 which is image tag)
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-key) SSH_KEY_PATH="$2"; shift 2 ;;
    --user)    SSH_USER="$2"; shift 2 ;;
    *)         shift ;;
  esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()   { echo -e "${GREEN}[asg-deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[asg-deploy]${NC} $*"; }
error() { echo -e "${RED}[asg-deploy]${NC} $*" >&2; }

# ── Discover running ASG instances ───────────────────────────────
discover_instances() {
  log "Discovering instances in ASG: $ASG_NAME (region: $REGION)..."

  local instances
  instances=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters \
      "Name=tag:aws:autoscaling:groupName,Values=$ASG_NAME" \
      "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress]' \
    --output text 2>/dev/null) || true

  if [ -z "$instances" ]; then
    error "No running instances found in ASG: $ASG_NAME"
    exit 1
  fi

  local count
  count=$(echo "$instances" | wc -l | tr -d ' ')
  log "Found $count running instance(s)"
  echo "$instances"
}

# ── Deploy to a single instance via SSH ──────────────────────────
deploy_to_instance() {
  local instance_id="$1"
  local public_ip="$2"

  log "Deploying to $instance_id ($public_ip)..."

  # shellcheck disable=SC2087
  ssh -o StrictHostKeyChecking=no \
      -o ConnectTimeout=10 \
      -o ServerAliveInterval=30 \
      -o BatchMode=yes \
      -i "$SSH_KEY_PATH" \
      "${SSH_USER}@${public_ip}" bash -s <<REMOTE_SCRIPT
set -euo pipefail

cd "${REMOTE_DIR}"

# Pull latest compose/deploy scripts so on-disk files stay in sync
# Detect branch from image tag: staging-<sha> → staging, <sha> → main
GIT_BRANCH="staging"
case "${IMAGE_TAG}" in staging-*) GIT_BRANCH="staging" ;; *) GIT_BRANCH="main" ;; esac
echo "[remote] Pulling latest scripts from \$GIT_BRANCH..."
git pull origin "\$GIT_BRANCH" --ff-only 2>/dev/null || echo "[remote] Git pull skipped (conflicts or not a git repo)"

# ECR login
echo "[remote] Logging into ECR..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REG}" 2>/dev/null

export ECR_IMAGE="${ECR_REG}/${ECR_REPO}:${IMAGE_TAG}"
export ECR_REGISTRY="${ECR_REG}"
export ECR_REPOSITORY="${ECR_REPO}"
export AWS_REGION="${REGION}"

echo "[remote] Pulling image: \$ECR_IMAGE"
docker pull "\$ECR_IMAGE"

# Use deploy.sh for graceful drain + restart
if [ -f scripts/deploy.sh ]; then
  echo "[remote] Running deploy.sh deploy ${IMAGE_TAG}"
  bash scripts/deploy.sh deploy "${IMAGE_TAG}"
else
  echo "[remote] deploy.sh not found — using docker compose directly"
  COMPOSE_FILE="docker-compose.staging.yml"
  [ "\${GH_ENVIRONMENT:-staging}" = "production" ] && COMPOSE_FILE="docker-compose.prod.yml"
  docker compose -f "\$COMPOSE_FILE" up -d --remove-orphans
fi

# Final health check
echo "[remote] Running health check..."
for i in \$(seq 1 30); do
  if curl -sf http://localhost:3100/health > /dev/null 2>&1; then
    echo "[remote] Health check passed!"
    exit 0
  fi
  sleep 2
done
echo "[remote] Health check FAILED after 60s"
exit 1
REMOTE_SCRIPT
}

# ── Main ─────────────────────────────────────────────────────────
main() {
  log "═══════════════════════════════════════════"
  log "  GhostHands ASG Deployment"
  log "  ASG:   $ASG_NAME"
  log "  Image: ${ECR_REG}/${ECR_REPO}:${IMAGE_TAG}"
  log "═══════════════════════════════════════════"

  # Validate SSH key exists
  if [ ! -f "$SSH_KEY_PATH" ]; then
    error "SSH key not found: $SSH_KEY_PATH"
    error "Set SSH_KEY_PATH or pass --ssh-key <path>"
    exit 1
  fi

  local instances
  instances=$(discover_instances)

  local total=0
  local succeeded=0
  local failed=0
  local failed_list=""

  while IFS=$'\t' read -r instance_id public_ip; do
    [ -z "$instance_id" ] && continue

    if [ -z "$public_ip" ] || [ "$public_ip" = "None" ]; then
      warn "Instance $instance_id has no public IP — skipping"
      continue
    fi

    total=$((total + 1))

    if deploy_to_instance "$instance_id" "$public_ip"; then
      succeeded=$((succeeded + 1))
    else
      failed=$((failed + 1))
      failed_list="$failed_list $instance_id($public_ip)"
    fi
  done <<< "$instances"

  echo ""
  log "═══════════════════════════════════════════"
  log "  Deployment Summary"
  log "  Total:     $total"
  log "  Succeeded: $succeeded"
  log "  Failed:    $failed"
  log "═══════════════════════════════════════════"

  if [ "$failed" -gt 0 ]; then
    error "Failed instances:$failed_list"
    echo "DEPLOY_STATUS=partial_failure"
    exit 1
  fi

  log "All instances deployed successfully!"
  echo "DEPLOY_STATUS=success"
  echo "DEPLOY_TAG=$IMAGE_TAG"
}

main
