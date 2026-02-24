#!/usr/bin/env bash
set -euo pipefail

# Refresh the Golden AMI from a healthy ASG instance
#
# Steps:
#   1. Find a healthy InService instance in the ASG
#   2. Create an AMI from that instance
#   3. Wait for the AMI to become available
#   4. Update the Launch Template with the new AMI (new version, set as default)
#   5. Start an ASG instance refresh (MinHealthyPercentage=50)
#   6. Wait for the refresh to complete
#   7. Clean up old AMIs (keep last 3)
#
# Usage:
#   ./scripts/refresh-ami.sh
#   ./scripts/refresh-ami.sh --instance-id i-abc123
#   ./scripts/refresh-ami.sh --skip-refresh   # Create AMI + update LT, skip instance refresh
#
# Required env vars:
#   AWS_ASG_NAME           - Auto Scaling Group name
#   AWS_REGION             - AWS region (default: us-east-1)
#   AWS_LAUNCH_TEMPLATE_ID - Launch Template ID (e.g., lt-0fbfe0179c502d5b9)

ASG_NAME="${AWS_ASG_NAME:?AWS_ASG_NAME is required}"
REGION="${AWS_REGION:-us-east-1}"
LAUNCH_TEMPLATE_ID="${AWS_LAUNCH_TEMPLATE_ID:?AWS_LAUNCH_TEMPLATE_ID is required}"
INSTANCE_ID=""
SKIP_REFRESH=false
MAX_REFRESH_WAIT=900  # 15 minutes

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-id)   INSTANCE_ID="$2"; shift 2 ;;
    --skip-refresh)  SKIP_REFRESH=true; shift ;;
    *)               shift ;;
  esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()   { echo -e "${GREEN}[ami-refresh]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ami-refresh]${NC} $*"; }
error() { echo -e "${RED}[ami-refresh]${NC} $*" >&2; }

# ── Step 1: Find a healthy instance ──────────────────────────────
find_healthy_instance() {
  if [ -n "$INSTANCE_ID" ]; then
    log "Using specified instance: $INSTANCE_ID"
    echo "$INSTANCE_ID"
    return
  fi

  log "Finding a healthy InService instance in ASG: $ASG_NAME..."

  local instance_id
  instance_id=$(aws autoscaling describe-auto-scaling-groups \
    --region "$REGION" \
    --auto-scaling-group-names "$ASG_NAME" \
    --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`] | [0].InstanceId' \
    --output text 2>/dev/null) || true

  if [ -z "$instance_id" ] || [ "$instance_id" = "None" ]; then
    error "No InService instances found in ASG: $ASG_NAME"
    exit 1
  fi

  log "Selected instance: $instance_id"
  echo "$instance_id"
}

# ── Step 2: Create AMI ──────────────────────────────────────────
create_ami() {
  local instance_id="$1"
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local ami_name="ghosthands-worker-${timestamp}"

  log "Creating AMI from instance $instance_id: $ami_name"

  local ami_id
  ami_id=$(aws ec2 create-image \
    --region "$REGION" \
    --instance-id "$instance_id" \
    --name "$ami_name" \
    --description "GhostHands worker AMI from $instance_id ($timestamp)" \
    --no-reboot \
    --tag-specifications \
      "ResourceType=image,Tags=[{Key=Name,Value=$ami_name},{Key=Project,Value=ghosthands},{Key=CreatedBy,Value=cd-pipeline},{Key=SourceInstance,Value=$instance_id}]" \
    --query 'ImageId' \
    --output text)

  log "AMI creation initiated: $ami_id"
  echo "$ami_id"
}

# ── Step 3: Wait for AMI ────────────────────────────────────────
wait_for_ami() {
  local ami_id="$1"
  log "Waiting for AMI $ami_id to become available (this may take a few minutes)..."

  aws ec2 wait image-available \
    --region "$REGION" \
    --image-ids "$ami_id" \
    --no-cli-pager

  log "AMI $ami_id is now available"
}

# ── Step 4: Update Launch Template ──────────────────────────────
update_launch_template() {
  local ami_id="$1"

  log "Updating Launch Template $LAUNCH_TEMPLATE_ID with AMI: $ami_id"

  # Get current default version to use as source
  local current_version
  current_version=$(aws ec2 describe-launch-template-versions \
    --region "$REGION" \
    --launch-template-id "$LAUNCH_TEMPLATE_ID" \
    --versions '$Default' \
    --query 'LaunchTemplateVersions[0].VersionNumber' \
    --output text)

  log "Current default version: $current_version"

  # Create new version with updated AMI (inherits everything else from source)
  local new_version
  new_version=$(aws ec2 create-launch-template-version \
    --region "$REGION" \
    --launch-template-id "$LAUNCH_TEMPLATE_ID" \
    --source-version "$current_version" \
    --launch-template-data "{\"ImageId\":\"$ami_id\"}" \
    --version-description "AMI update: $ami_id" \
    --query 'LaunchTemplateVersion.VersionNumber' \
    --output text)

  log "Created Launch Template version: $new_version"

  # Set as default
  aws ec2 modify-launch-template \
    --region "$REGION" \
    --launch-template-id "$LAUNCH_TEMPLATE_ID" \
    --default-version "$new_version" \
    --no-cli-pager > /dev/null

  log "Version $new_version set as default"
  echo "$new_version"
}

# ── Step 5: Start Instance Refresh ──────────────────────────────
start_instance_refresh() {
  log "Starting ASG instance refresh (MinHealthyPercentage=50, warmup=120s)..."

  local refresh_id
  refresh_id=$(aws autoscaling start-instance-refresh \
    --region "$REGION" \
    --auto-scaling-group-name "$ASG_NAME" \
    --preferences '{"MinHealthyPercentage":50,"InstanceWarmup":120}' \
    --query 'InstanceRefreshId' \
    --output text)

  log "Instance refresh started: $refresh_id"
  echo "$refresh_id"
}

# ── Step 6: Wait for refresh ────────────────────────────────────
wait_for_refresh() {
  local refresh_id="$1"
  local waited=0

  log "Waiting for instance refresh to complete (max ${MAX_REFRESH_WAIT}s)..."

  while [ "$waited" -lt "$MAX_REFRESH_WAIT" ]; do
    local status
    status=$(aws autoscaling describe-instance-refreshes \
      --region "$REGION" \
      --auto-scaling-group-name "$ASG_NAME" \
      --instance-refresh-ids "$refresh_id" \
      --query 'InstanceRefreshes[0].Status' \
      --output text 2>/dev/null) || true

    case "$status" in
      Successful)
        log "Instance refresh completed successfully!"
        return 0
        ;;
      Cancelled|Failed|RollbackSuccessful|RollbackFailed)
        error "Instance refresh ended with status: $status"
        return 1
        ;;
      *)
        echo "  Status: $status (${waited}s/${MAX_REFRESH_WAIT}s)"
        sleep 15
        waited=$((waited + 15))
        ;;
    esac
  done

  warn "Timed out waiting for instance refresh (still running — check AWS console)"
  return 1
}

# ── Step 7: Cleanup old AMIs ────────────────────────────────────
cleanup_old_amis() {
  log "Cleaning up old AMIs (keeping last 3)..."

  local ami_ids
  ami_ids=$(aws ec2 describe-images \
    --region "$REGION" \
    --owners self \
    --filters "Name=tag:Project,Values=ghosthands" \
    --query 'Images | sort_by(@, &CreationDate) | [:-3].[ImageId]' \
    --output text 2>/dev/null) || true

  if [ -z "$ami_ids" ] || [ "$ami_ids" = "None" ]; then
    log "No old AMIs to clean up"
    return
  fi

  for ami_id in $ami_ids; do
    [ -z "$ami_id" ] || [ "$ami_id" = "None" ] && continue
    log "Deregistering old AMI: $ami_id"

    # Find associated snapshots before deregistering
    local snapshot_ids
    snapshot_ids=$(aws ec2 describe-images \
      --region "$REGION" \
      --image-ids "$ami_id" \
      --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' \
      --output text 2>/dev/null) || true

    aws ec2 deregister-image --region "$REGION" --image-id "$ami_id" 2>/dev/null || true

    for snap_id in $snapshot_ids; do
      [ -z "$snap_id" ] || [ "$snap_id" = "None" ] && continue
      aws ec2 delete-snapshot --region "$REGION" --snapshot-id "$snap_id" 2>/dev/null || true
    done
  done

  log "Old AMI cleanup complete"
}

# ── Main ─────────────────────────────────────────────────────────
main() {
  log "═══════════════════════════════════════════"
  log "  GhostHands AMI Refresh Pipeline"
  log "  ASG:             $ASG_NAME"
  log "  Launch Template: $LAUNCH_TEMPLATE_ID"
  log "  Region:          $REGION"
  log "═══════════════════════════════════════════"

  local instance_id
  instance_id=$(find_healthy_instance)

  local ami_id
  ami_id=$(create_ami "$instance_id")

  wait_for_ami "$ami_id"

  local lt_version
  lt_version=$(update_launch_template "$ami_id")

  if [ "$SKIP_REFRESH" = true ]; then
    warn "Skipping instance refresh (--skip-refresh)"
  else
    local refresh_id
    refresh_id=$(start_instance_refresh)
    wait_for_refresh "$refresh_id" || true
  fi

  cleanup_old_amis

  echo ""
  log "═══════════════════════════════════════════"
  log "  AMI Refresh Complete!"
  log "  AMI:                    $ami_id"
  log "  Launch Template Version: $lt_version"
  log "  Source Instance:         $instance_id"
  log "═══════════════════════════════════════════"

  # Output for CI consumption
  echo "AMI_ID=$ami_id"
  echo "LT_VERSION=$lt_version"
}

main
