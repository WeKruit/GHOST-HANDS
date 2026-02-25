#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Install GhostHands disk cleanup cron job
#
# Must be run as root (sudo) on each EC2 instance.
# Idempotent — safe to re-run.
#
# What it does:
#   1. Copies disk-cleanup.sh to /opt/ghosthands/scripts/
#   2. Installs a cron job to run daily at 3 AM UTC
#   3. Sets up logrotate for the cleanup log file
#
# Usage:
#   sudo bash scripts/setup-cleanup-cron.sh
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/ghosthands/scripts"
LOG_FILE="/var/log/gh-disk-cleanup.log"
CRON_MARKER="# gh-disk-cleanup"
SOURCE_SCRIPT="${SCRIPT_DIR}/disk-cleanup.sh"

echo "[setup] Installing GhostHands disk cleanup cron..."

# ── 1. Verify source script exists ────────────────────────────────────

if [ ! -f "${SOURCE_SCRIPT}" ]; then
  echo "[setup] ERROR: ${SOURCE_SCRIPT} not found" >&2
  echo "[setup] Make sure disk-cleanup.sh is in the same directory as this script" >&2
  exit 1
fi

# ── 2. Create install directory ───────────────────────────────────────

mkdir -p "${INSTALL_DIR}"

# ── 3. Copy cleanup script ───────────────────────────────────────────

cp "${SOURCE_SCRIPT}" "${INSTALL_DIR}/disk-cleanup.sh"
chmod +x "${INSTALL_DIR}/disk-cleanup.sh"
echo "[setup] Installed ${INSTALL_DIR}/disk-cleanup.sh"

# ── 4. Install cron job (idempotent) ──────────────────────────────────

CRON_LINE="0 3 * * * ${INSTALL_DIR}/disk-cleanup.sh >> ${LOG_FILE} 2>&1 ${CRON_MARKER}"

# Remove any existing gh-disk-cleanup cron entry, then add the new one
(crontab -l 2>/dev/null | grep -v "${CRON_MARKER}" || true; echo "${CRON_LINE}") | crontab -
echo "[setup] Cron job installed: daily at 3 AM UTC"
echo "[setup] Cron entry: ${CRON_LINE}"

# ── 5. Set up logrotate ──────────────────────────────────────────────

cat > /etc/logrotate.d/gh-disk-cleanup <<EOF
${LOG_FILE} {
    weekly
    rotate 4
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}
EOF
echo "[setup] Logrotate config installed at /etc/logrotate.d/gh-disk-cleanup"

# ── 6. Create initial log file ────────────────────────────────────────

touch "${LOG_FILE}"
chmod 644 "${LOG_FILE}"

# ── 7. Verify ─────────────────────────────────────────────────────────

echo ""
echo "[setup] Installation complete!"
echo "[setup] Cleanup script: ${INSTALL_DIR}/disk-cleanup.sh"
echo "[setup] Log file:       ${LOG_FILE}"
echo "[setup] Schedule:       Daily at 3:00 AM UTC"
echo ""
echo "[setup] To test immediately: sudo ${INSTALL_DIR}/disk-cleanup.sh"
echo "[setup] To check cron:       crontab -l | grep gh-disk-cleanup"
echo "[setup] To check logs:       tail -50 ${LOG_FILE}"
