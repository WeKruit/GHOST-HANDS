#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# pull-secrets.sh — Pull .env from AWS Secrets Manager
# =============================================================================
#
# Fetches environment variables from AWS Secrets Manager and writes them to
# /opt/ghosthands/.env. Designed to run:
#   1. On EC2 boot (via userdata or systemd)
#   2. Manually when secrets are updated
#
# Prerequisites:
#   - aws CLI installed
#   - jq installed
#   - EC2 instance role has secretsmanager:GetSecretValue permission
#     for arn:aws:secretsmanager:us-east-1:*:secret:ghosthands/*
#
# Usage:
#   sudo /opt/ghosthands/scripts/pull-secrets.sh              # Auto-detect env
#   sudo /opt/ghosthands/scripts/pull-secrets.sh staging       # Force staging
#   sudo /opt/ghosthands/scripts/pull-secrets.sh production    # Force production
#
# Linear: https://linear.app/wecrew-axon/issue/WEK-159
# =============================================================================

ENV_FILE="/opt/ghosthands/.env"
ENV_BACKUP="/opt/ghosthands/.env.bak"
SECRET_PREFIX="ghosthands"
REGION="${AWS_REGION:-us-east-1}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[pull-secrets]${NC} $*"; }
warn()  { echo -e "${YELLOW}[pull-secrets]${NC} $*"; }
error() { echo -e "${RED}[pull-secrets]${NC} $*" >&2; }

# Detect environment from existing .env or instance tags
detect_environment() {
  # 1. Check argument
  if [[ -n "${1:-}" ]]; then
    echo "$1"
    return
  fi

  # 2. Check existing .env
  if [[ -f "$ENV_FILE" ]]; then
    local env_val
    env_val=$(grep -E '^GH_ENVIRONMENT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
    if [[ -n "$env_val" ]]; then
      echo "$env_val"
      return
    fi
  fi

  # 3. Check EC2 instance tags (IMDSv2 preferred)
  local imds_token instance_id
  imds_token=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
  if [[ -n "$imds_token" ]]; then
    instance_id=$(curl -sf -H "X-aws-ec2-metadata-token: $imds_token" \
      http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
  else
    instance_id=$(curl -sf http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
  fi
  if [[ -n "$instance_id" ]]; then
    local env_tag
    env_tag=$(aws ec2 describe-tags \
      --region "$REGION" \
      --filters "Name=resource-id,Values=$instance_id" "Name=key,Values=Environment" \
      --query 'Tags[0].Value' --output text 2>/dev/null || true)
    if [[ -n "$env_tag" ]] && [[ "$env_tag" != "None" ]]; then
      echo "$env_tag"
      return
    fi
  fi

  # 4. Default to staging
  warn "Could not detect environment, defaulting to staging"
  echo "staging"
}

main() {
  local environment
  environment=$(detect_environment "${1:-}")

  local secret_id="${SECRET_PREFIX}/${environment}"

  log "Pulling secrets from AWS Secrets Manager"
  log "  Secret: $secret_id"
  log "  Region: $REGION"
  log "  Target: $ENV_FILE"

  # Fetch secret
  local secret_json
  secret_json=$(aws secretsmanager get-secret-value \
    --region "$REGION" \
    --secret-id "$secret_id" \
    --query SecretString \
    --output text 2>&1) || {
    error "Failed to fetch secret '$secret_id'"
    error "$secret_json"
    exit 1
  }

  # Validate it's valid JSON
  if ! echo "$secret_json" | jq empty 2>/dev/null; then
    error "Secret '$secret_id' is not valid JSON"
    exit 1
  fi

  # Backup existing .env
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$ENV_BACKUP"
    log "  Backed up existing .env to .env.bak"
  fi

  # Convert JSON to .env format (values quoted to handle special chars)
  local env_content
  env_content=$(echo "$secret_json" | jq -r 'to_entries[] | "\(.key)=\"\(.value | gsub("\""; "\\\""))\""')

  # Add header
  {
    echo "# ═══════════════════════════════════════════════════════════"
    echo "# GhostHands Environment Variables"
    echo "# Pulled from AWS Secrets Manager: $secret_id"
    echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# DO NOT EDIT MANUALLY — use sync-secrets.sh to update"
    echo "# ═══════════════════════════════════════════════════════════"
    echo ""
    echo "$env_content"
  } > "$ENV_FILE"

  # Secure permissions
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE" 2>/dev/null || true

  local count
  count=$(echo "$env_content" | grep -c . 2>/dev/null || echo 0)

  log "  Written $count variables to $ENV_FILE"
  log "  Permissions: 600"
  log "Done."

  # Verify critical vars exist
  local missing=""
  for var in DATABASE_URL GH_SERVICE_SECRET NODE_ENV; do
    if ! grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
      missing="$missing $var"
    fi
  done

  if [[ -n "$missing" ]]; then
    warn "Missing critical vars:$missing"
    warn "The service may not start correctly."
  fi
}

main "$@"
