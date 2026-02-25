#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# GhostHands Manual Deploy — Local → ECR → EC2
#
# Use this script when CI/CD is broken or you need to force-deploy.
# It builds the Docker image locally, pushes to ECR, then SSHs
# to EC2 to pull and restart.
#
# Required env vars (set in .env.deploy or export before running):
#   ECR_REGISTRY    — e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com
#   ECR_REPOSITORY  — e.g., ghosthands
#   AWS_REGION      — e.g., us-east-1
#   EC2_HOST        — e.g., ec2-user@1.2.3.4
#   EC2_KEY         — Path to SSH key (e.g., ~/.ssh/ghosthands-ec2.pem)
#
# Optional:
#   IMAGE_TAG       — Tag to use (default: git commit SHA)
#   GHOSTHANDS_DIR  — Remote app directory (default: /opt/ghosthands)
#
# Usage:
#   ./scripts/deploy-ec2.sh                # Build + push + deploy
#   ./scripts/deploy-ec2.sh --push-only    # Build + push to ECR only
#   ./scripts/deploy-ec2.sh --deploy-only  # SSH + restart EC2 only (image already in ECR)
#   ./scripts/deploy-ec2.sh --status       # SSH + check what's running on EC2
#   ./scripts/deploy-ec2.sh --verify       # Check EC2 /health/version endpoint
# ──────────────────────────────────────────────────────────────

# Load .env.deploy if it exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${REPO_DIR}/.env.deploy"

if [ -f "$ENV_FILE" ]; then
  echo "Loading config from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

# Defaults
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_DIR" rev-parse --short HEAD)}"
FULL_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
GHOSTHANDS_DIR="${GHOSTHANDS_DIR:-/opt/ghosthands}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[deploy-ec2]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy-ec2]${NC} $*"; }
error() { echo -e "${RED}[deploy-ec2]${NC} $*" >&2; }
info()  { echo -e "${CYAN}[deploy-ec2]${NC} $*"; }

check_required_vars() {
  local missing=0
  for var in ECR_REGISTRY ECR_REPOSITORY AWS_REGION; do
    if [ -z "${!var:-}" ]; then
      error "Missing required env var: $var"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    echo ""
    echo "Set these in .env.deploy or export them before running."
    echo "See .env.deploy.example for reference."
    exit 1
  fi
}

check_ssh_vars() {
  local missing=0
  for var in EC2_HOST EC2_KEY; do
    if [ -z "${!var:-}" ]; then
      error "Missing required env var: $var"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    echo ""
    echo "Set EC2_HOST and EC2_KEY in .env.deploy or export them."
    exit 1
  fi
  if [ ! -f "$EC2_KEY" ]; then
    error "SSH key not found: $EC2_KEY"
    exit 1
  fi
}

ssh_ec2() {
  ssh -i "$EC2_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$EC2_HOST" "$@"
}

# ── Step 1: Build Docker image locally ─────────────────────────
cmd_build() {
  log "Building Docker image..."
  info "  Tag: $IMAGE_TAG"
  info "  SHA: $FULL_SHA"

  cd "$REPO_DIR"
  docker build \
    --build-arg COMMIT_SHA="$FULL_SHA" \
    --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --build-arg IMAGE_TAG="$IMAGE_TAG" \
    -t "${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}" \
    -t "${ECR_REGISTRY}/${ECR_REPOSITORY}:latest" \
    .

  log "Build complete: ${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"
}

# ── Step 2: Push to ECR ────────────────────────────────────────
cmd_push() {
  log "Logging into ECR..."
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$ECR_REGISTRY"

  log "Pushing to ECR..."
  docker push "${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"
  docker push "${ECR_REGISTRY}/${ECR_REPOSITORY}:latest"
  log "Push complete"
}

# ── Step 3: Deploy to EC2 ──────────────────────────────────────
cmd_deploy_ec2() {
  check_ssh_vars

  log "Deploying to EC2: $EC2_HOST"
  info "  Image tag: $IMAGE_TAG"
  info "  Remote dir: $GHOSTHANDS_DIR"

  # Run deploy-manual.sh on EC2 (formerly deploy.sh)
  ssh_ec2 "cd $GHOSTHANDS_DIR && sudo ./scripts/deploy-manual.sh deploy $IMAGE_TAG"

  log "EC2 deploy complete"
}

# ── Status: Check what's running on EC2 ────────────────────────
cmd_status() {
  check_ssh_vars
  log "Checking EC2 status..."
  ssh_ec2 "cd $GHOSTHANDS_DIR && sudo ./scripts/deploy-manual.sh status"
}

# ── Verify: Check /health/version endpoint ─────────────────────
cmd_verify() {
  check_ssh_vars
  log "Checking deployed version..."

  local version_json
  version_json=$(ssh_ec2 "curl -sf http://localhost:3100/health/version 2>/dev/null") || {
    error "Could not reach /health/version on EC2"
    warn "Try: ./scripts/deploy-ec2.sh --status"
    exit 1
  }

  echo ""
  info "Deployed version:"
  echo "$version_json" | python3 -m json.tool 2>/dev/null || echo "$version_json"
  echo ""

  # Compare with local
  local remote_sha
  remote_sha=$(echo "$version_json" | grep -o '"commit_sha":"[^"]*"' | cut -d'"' -f4)
  if [ "$remote_sha" = "$FULL_SHA" ]; then
    log "EC2 is running the latest commit ($remote_sha)"
  else
    warn "EC2 is running $remote_sha — local HEAD is $FULL_SHA"
    warn "Run: ./scripts/deploy-ec2.sh   to deploy latest"
  fi
}

# ── Main ───────────────────────────────────────────────────────
case "${1:-full}" in
  --push-only)
    check_required_vars
    cmd_build
    cmd_push
    ;;
  --deploy-only)
    check_required_vars
    cmd_deploy_ec2
    ;;
  --status)
    cmd_status
    ;;
  --verify)
    cmd_verify
    ;;
  full|"")
    check_required_vars
    cmd_build
    cmd_push
    cmd_deploy_ec2
    echo ""
    log "Full deploy complete. Verifying..."
    sleep 5
    cmd_verify
    ;;
  *)
    echo "Usage: $0 [--push-only|--deploy-only|--status|--verify]"
    echo ""
    echo "  (no args)      Full pipeline: build → push → deploy → verify"
    echo "  --push-only    Build + push to ECR (no EC2 deploy)"
    echo "  --deploy-only  SSH to EC2 and restart (image must be in ECR)"
    echo "  --status       Check what's running on EC2"
    echo "  --verify       Check /health/version on EC2"
    exit 1
    ;;
esac
