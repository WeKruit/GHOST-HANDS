#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# pull-secrets-mac.sh — Pull .env from ATM API (no AWS/SSH required)
# =============================================================================
#
# Fetches GHOST-HANDS secrets from ATM's /secrets/ghosthands endpoint and
# writes them to .env. Designed for Mac workers that don't have EC2 IAM
# roles or SSH access to the deploy infrastructure.
#
# Prerequisites:
#   - curl installed (macOS built-in)
#   - jq installed (brew install jq)
#   - GH_DEPLOY_SECRET set (shared deploy auth secret)
#   - ATM_HOST set (ATM API address, e.g., http://44.223.180.11:8080)
#
# Usage:
#   GH_DEPLOY_SECRET=xxx ATM_HOST=http://host:8080 ./scripts/pull-secrets-mac.sh
#   GH_DEPLOY_SECRET=xxx ATM_HOST=http://host:8080 ./scripts/pull-secrets-mac.sh staging
#   GH_DEPLOY_SECRET=xxx ATM_HOST=http://host:8080 ./scripts/pull-secrets-mac.sh production
#
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${GH_ENV_FILE:-$PROJECT_DIR/packages/ghosthands/.env}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[pull-secrets-mac]${NC} $*"; }
warn()  { echo -e "${YELLOW}[pull-secrets-mac]${NC} $*"; }
error() { echo -e "${RED}[pull-secrets-mac]${NC} $*" >&2; }

# Validate prerequisites
if ! command -v jq &>/dev/null; then
  error "jq is required but not installed. Run: brew install jq"
  exit 1
fi

if [[ -z "${GH_DEPLOY_SECRET:-}" ]]; then
  error "GH_DEPLOY_SECRET is not set"
  exit 1
fi

if [[ -z "${ATM_HOST:-}" ]]; then
  error "ATM_HOST is not set (e.g., http://44.223.180.11:8080)"
  exit 1
fi

main() {
  local environment="${1:-staging}"
  local url="${ATM_HOST}/secrets/ghosthands?environment=${environment}"

  log "Pulling secrets from ATM API"
  log "  URL: ${ATM_HOST}/secrets/ghosthands"
  log "  Environment: $environment"
  log "  Target: $ENV_FILE"

  # Fetch secrets
  local response http_code body
  response=$(curl -sf -w "\n%{http_code}" \
    -H "X-Deploy-Secret: ${GH_DEPLOY_SECRET}" \
    "$url" 2>&1) || {
    error "Failed to reach ATM API at $url"
    error "Check ATM_HOST and network connectivity"
    exit 1
  }

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" != "200" ]]; then
    local err_msg
    err_msg=$(echo "$body" | jq -r '.error // "unknown error"' 2>/dev/null || echo "$body")
    error "ATM API returned HTTP $http_code: $err_msg"
    exit 1
  fi

  # Validate response
  if ! echo "$body" | jq -e '.secrets' &>/dev/null; then
    error "Invalid response from ATM API (missing .secrets)"
    exit 1
  fi

  local count
  count=$(echo "$body" | jq -r '.count')

  if [[ "$count" == "0" ]]; then
    warn "ATM returned 0 secrets — .env will be empty"
  fi

  # Backup existing .env
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak"
    log "  Backed up existing .env to .env.bak"
  fi

  # Convert to .env format (values quoted to handle special chars)
  local env_content
  env_content=$(echo "$body" | jq -r '.secrets | to_entries[] | "\(.key)=\"\(.value | gsub("\""; "\\\""))\""')

  # Write .env with header
  {
    echo "# ═══════════════════════════════════════════════════════════"
    echo "# GhostHands Environment Variables (Mac)"
    echo "# Pulled from ATM API: ${ATM_HOST}/secrets/ghosthands"
    echo "# Environment: $environment"
    echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# DO NOT EDIT MANUALLY — re-run pull-secrets-mac.sh to update"
    echo "# ═══════════════════════════════════════════════════════════"
    echo ""
    echo "$env_content"
  } > "$ENV_FILE"

  chmod 600 "$ENV_FILE"

  log "  Written $count secrets to $ENV_FILE"
  log "  Permissions: 600"

  # Verify critical vars exist
  local missing=""
  for var in DATABASE_URL GH_SERVICE_SECRET; do
    if ! grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
      missing="$missing $var"
    fi
  done

  if [[ -n "$missing" ]]; then
    warn "Missing critical vars:$missing"
    warn "The service may not start correctly."
  fi

  log "Done. Start GH with: bun run dev"
}

main "$@"
