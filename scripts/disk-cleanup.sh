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
#
# Exit codes:
#   0 — cleanup completed (warnings are non-fatal)
#   1 — critical error (could not determine disk state)
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

LOG_PREFIX="[disk-cleanup]"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log() { echo "${LOG_PREFIX} ${TIMESTAMP} $*"; }
warn() { echo "${LOG_PREFIX} ${TIMESTAMP} WARNING: $*" >&2; }

log "=== Disk cleanup started ==="

# ── 1. Disk usage before cleanup ──────────────────────────────────────

DISK_BEFORE=$(df -h / | awk 'NR==2 {print $5}')
DISK_AVAIL_BEFORE=$(df -h / | awk 'NR==2 {print $4}')
log "Disk usage before: ${DISK_BEFORE} used, ${DISK_AVAIL_BEFORE} available"

# ── 2. Docker: prune dangling images ─────────────────────────────────

log "Pruning dangling Docker images..."
if command -v docker &>/dev/null; then
  DANGLING=$(docker image prune -f 2>&1) || warn "docker image prune failed: ${DANGLING}"
  log "Dangling prune result: ${DANGLING}"
else
  warn "docker not found, skipping Docker cleanup"
fi

# ── 3. Docker: prune old unused images (>72h) ────────────────────────

log "Pruning unused Docker images older than 72h..."
if command -v docker &>/dev/null; then
  OLD_IMAGES=$(docker image prune -a --filter "until=72h" -f 2>&1) || warn "docker image prune -a failed: ${OLD_IMAGES}"
  log "Old image prune result: ${OLD_IMAGES}"
fi

# ── 4. Docker: prune build cache ─────────────────────────────────────

log "Pruning Docker build cache..."
if command -v docker &>/dev/null; then
  BUILD_CACHE=$(docker builder prune -f --filter "until=72h" 2>&1) || warn "docker builder prune failed: ${BUILD_CACHE}"
  log "Build cache prune result: ${BUILD_CACHE}"
fi

# ── 5. Docker: prune unused volumes ──────────────────────────────────

log "Pruning unused Docker volumes..."
if command -v docker &>/dev/null; then
  VOLUMES=$(docker volume prune -f 2>&1) || warn "docker volume prune failed: ${VOLUMES}"
  log "Volume prune result: ${VOLUMES}"
fi

# ── 6. /tmp cleanup (files older than 24h) ────────────────────────────

log "Cleaning /tmp files older than 24 hours..."
TMP_COUNT=$(find /tmp -type f -mtime +1 2>/dev/null | wc -l || echo 0)
if [ "${TMP_COUNT}" -gt 0 ]; then
  find /tmp -type f -mtime +1 -delete 2>/dev/null || warn "Some /tmp files could not be deleted"
  log "Removed ${TMP_COUNT} files from /tmp"
else
  log "No old /tmp files to clean"
fi

# ── 7. Log rotation for GhostHands logs ──────────────────────────────

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

# ── 8. Clean journal logs older than 3 days ───────────────────────────

if command -v journalctl &>/dev/null; then
  log "Vacuuming journald logs older than 3 days..."
  journalctl --vacuum-time=3d 2>&1 || warn "journalctl vacuum failed"
fi

# ── 9. Disk usage after cleanup ───────────────────────────────────────

DISK_AFTER=$(df -h / | awk 'NR==2 {print $5}')
DISK_AVAIL_AFTER=$(df -h / | awk 'NR==2 {print $4}')
log "Disk usage after: ${DISK_AFTER} used, ${DISK_AVAIL_AFTER} available"
log "=== Disk cleanup completed ==="
