#!/usr/bin/env bash
set -euo pipefail

# GhostHands Deploy Script
#
# Called by VALET's deployment controller on each EC2 instance.
# VALET manages the rolling update strategy across its fleet.
#
# Usage:
#   ./scripts/deploy.sh deploy <image-tag>   # Deploy specific ECR image tag
#   ./scripts/deploy.sh deploy               # Deploy 'latest' tag
#   ./scripts/deploy.sh rollback             # Rollback to previous image
#   ./scripts/deploy.sh status               # Show current status
#   ./scripts/deploy.sh drain                # Stop worker, keep API running
#   ./scripts/deploy.sh health               # Exit 0 if healthy, 1 if not
#
# Required env vars (set by VALET before calling):
#   ECR_REGISTRY    — e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com
#   ECR_REPOSITORY  — e.g., ghosthands
#   AWS_REGION      — e.g., us-east-1

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE_DIR="${GHOSTHANDS_DIR:-/opt/ghosthands}"
HEALTH_URL="http://localhost:3100/health"
MAX_HEALTH_ATTEMPTS=30
HEALTH_INTERVAL=2

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

health_check() {
  log "Running health check..."
  for i in $(seq 1 "$MAX_HEALTH_ATTEMPTS"); do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
      log "Health check passed!"
      return 0
    fi
    echo "  Attempt $i/$MAX_HEALTH_ATTEMPTS..."
    sleep "$HEALTH_INTERVAL"
  done
  error "Health check failed after $MAX_HEALTH_ATTEMPTS attempts"
  return 1
}

ecr_login() {
  local region="${AWS_REGION:-us-east-1}"
  log "Logging into ECR (region: $region)..."
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "${ECR_REGISTRY}" 2>/dev/null
}

cmd_deploy() {
  local tag="${1:-latest}"
  log "Deploying image tag: $tag"

  cd "$COMPOSE_DIR"

  # Login to ECR
  ecr_login

  # Save current image for rollback
  if docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null | head -1 > /dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" images --format json 2>/dev/null | head -1 > .last-deploy-image || true
  fi

  # Set the image
  export ECR_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:${tag}"
  log "Image: $ECR_IMAGE"

  # Pull new images
  docker compose -f "$COMPOSE_FILE" pull

  # Stop worker first to drain active jobs gracefully (SIGTERM → 30s drain)
  log "Draining worker..."
  docker compose -f "$COMPOSE_FILE" stop -t 35 worker 2>/dev/null || true

  # Restart all services with new image
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

  if health_check; then
    log "Deploy successful! Tag: $tag"
    # Clean up old images
    docker image prune -f --filter "until=24h" 2>/dev/null || true

    # Report success (VALET can parse this output)
    echo "DEPLOY_STATUS=success"
    echo "DEPLOY_TAG=$tag"
    echo "DEPLOY_IMAGE=$ECR_IMAGE"
  else
    error "Deploy failed! Rolling back..."
    cmd_rollback
    echo "DEPLOY_STATUS=rollback"
    exit 1
  fi
}

cmd_rollback() {
  warn "Rolling back to previous deployment..."

  cd "$COMPOSE_DIR"

  ecr_login

  # Use 'latest' tag as rollback target
  export ECR_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:latest"
  log "Rollback image: $ECR_IMAGE"

  docker compose -f "$COMPOSE_FILE" pull
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

  if health_check; then
    log "Rollback successful!"
    echo "DEPLOY_STATUS=rollback_success"
  else
    error "Rollback also failed! Manual intervention required."
    echo "DEPLOY_STATUS=rollback_failed"
    exit 1
  fi
}

cmd_drain() {
  log "Draining worker (stopping job pickup, waiting for active jobs)..."
  cd "$COMPOSE_DIR"

  # Stop worker with 60s timeout for graceful drain
  docker compose -f "$COMPOSE_FILE" stop -t 60 worker
  log "Worker drained. API still running."
  echo "DRAIN_STATUS=success"
}

cmd_status() {
  cd "$COMPOSE_DIR"

  log "Current containers:"
  docker compose -f "$COMPOSE_FILE" ps
  echo ""

  log "Images:"
  docker compose -f "$COMPOSE_FILE" images 2>/dev/null || true
  echo ""

  log "Health check:"
  if curl -sf "$HEALTH_URL" 2>/dev/null; then
    echo ""
    log "API is healthy"
    echo "HEALTH_STATUS=healthy"
  else
    warn "API is not responding"
    echo "HEALTH_STATUS=unhealthy"
  fi
}

cmd_health() {
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    exit 0
  else
    exit 1
  fi
}

# Main
case "${1:-help}" in
  deploy)
    cmd_deploy "${2:-latest}"
    ;;
  rollback)
    cmd_rollback
    ;;
  drain)
    cmd_drain
    ;;
  status)
    cmd_status
    ;;
  health)
    cmd_health
    ;;
  *)
    echo "Usage: $0 {deploy [tag]|rollback|drain|status|health}"
    exit 1
    ;;
esac
