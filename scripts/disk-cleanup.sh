#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# GhostHands EC2 Disk Cleanup
#
# Prunes Docker images, temp files, and old logs to prevent disk fill.
# Safe to run on a live system — only removes unused/old resources.
#
# Usage:
#   sudo bash scripts/disk-cleanup.sh          # manual run
#   # or via cron (installed by setup-cleanup-cron.sh)
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

LOG_PREFIX="[disk-cleanup]"

log()  { echo "${LOG_PREFIX} $(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"; }
warn() { echo "${LOG_PREFIX} $(date -u +'%Y-%m-%dT%H:%M:%SZ') WARNING: $*" >&2; }

log "=== Disk cleanup started ==="

# ── 1. Disk usage before cleanup ──────────────────────────────────────

if ! DISK_BEFORE=$(df -h / | awk 'NR==2 {print $5}') || [ -z "${DISK_BEFORE}" ]; then
  log "ERROR: Could not determine disk state"
  exit 1
fi
DISK_AVAIL_BEFORE=$(df -h / | awk 'NR==2 {print $4}')
log "Disk usage before: ${DISK_BEFORE} used, ${DISK_AVAIL_BEFORE} available"

# ── 2. Docker cleanup ────────────────────────────────────────────────

HAS_DOCKER=false
if command -v docker &>/dev/null; then
  HAS_DOCKER=true
fi

if [ "${HAS_DOCKER}" = true ]; then
  log "Pruning dangling Docker images..."
  DANGLING=$(docker image prune -f 2>&1) || warn "docker image prune failed: ${DANGLING}"
  log "Dangling prune result: ${DANGLING}"

  log "Pruning unused Docker images older than 72h..."
  OLD_IMAGES=$(docker image prune -a --filter "until=72h" -f 2>&1) || warn "docker image prune -a failed: ${OLD_IMAGES}"
  log "Old image prune result: ${OLD_IMAGES}"

  log "Pruning Docker build cache..."
  BUILD_CACHE=$(docker builder prune -f --filter "until=72h" 2>&1) || warn "docker builder prune failed: ${BUILD_CACHE}"
  log "Build cache prune result: ${BUILD_CACHE}"

  log "Pruning unused Docker volumes..."
  VOLUMES=$(docker volume prune -f 2>&1) || warn "docker volume prune failed: ${VOLUMES}"
  log "Volume prune result: ${VOLUMES}"
else
  warn "docker not found, skipping Docker cleanup"
fi

# ── 3. /tmp cleanup (files older than 24h) ────────────────────────────

log "Cleaning /tmp files older than 24 hours..."
TMP_COUNT=$(find /tmp -type f -mtime +1 2>/dev/null | wc -l || echo 0)
if [ "${TMP_COUNT}" -gt 0 ]; then
  find /tmp -type f -mtime +1 -delete 2>/dev/null || warn "Some /tmp files could not be deleted"
  log "Removed ${TMP_COUNT} files from /tmp"
else
  log "No old /tmp files to clean"
fi

# ── 4. Log rotation for GhostHands logs ──────────────────────────────

GH_LOG_DIR="/opt/ghosthands/logs"
if [ -d "${GH_LOG_DIR}" ]; then
  log "Rotating logs in ${GH_LOG_DIR}..."
  # Compress logs older than 1 day
  find "${GH_LOG_DIR}" -name "*.log" -mtime +1 -exec gzip -q {} \; 2>/dev/null || true
  # Delete compressed logs older than 7 days
  ROTATED_COUNT=$(find "${GH_LOG_DIR}" -name "*.log.gz" -mtime +7 2>/dev/null | wc -l || echo 0)
  if [ "${ROTATED_COUNT}" -gt 0 ]; then
    find "${GH_LOG_DIR}" -name "*.log.gz" -mtime +7 -delete 2>/dev/null || true
    log "Removed ${ROTATED_COUNT} old compressed logs"
  fi
else
  log "No GH log directory at ${GH_LOG_DIR}, skipping log rotation"
fi

# ── 5. Clean journal logs older than 3 days ───────────────────────────

if command -v journalctl &>/dev/null; then
  log "Vacuuming journald logs older than 3 days..."
  journalctl --vacuum-time=3d 2>&1 || warn "journalctl vacuum failed"
fi

# ── 6. Disk usage after cleanup ───────────────────────────────────────

DISK_AFTER=$(df -h / | awk 'NR==2 {print $5}')
DISK_AVAIL_AFTER=$(df -h / | awk 'NR==2 {print $4}')
log "Disk usage after: ${DISK_AFTER} used, ${DISK_AVAIL_AFTER} available"
log "=== Disk cleanup completed ==="
