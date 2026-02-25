#!/bin/bash
# ──────────────────────────────────────────────────
# GhostHands Kasm Session Startup Script
#
# Kasm executes /dockerstartup/custom_startup.sh after the desktop is ready.
# This script starts the GH API server and worker process.
#
# Environment variables are injected by Kasm at session creation time
# (via the Kasm REST API's environment_override parameter).
# Required: DATABASE_URL, GH_SERVICE_SECRET, GH_CREDENTIAL_KEY, etc.
# ──────────────────────────────────────────────────

# Auto-detect public IP from EC2 IMDS if KASM_SESSION_URL not set
if [ -z "${KASM_SESSION_URL:-}" ]; then
  EC2_IP=$(curl -sf --connect-timeout 2 http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")
  if [ -n "$EC2_IP" ]; then
    export KASM_SESSION_URL="https://${EC2_IP}:6901"
  fi
fi

LOG="/tmp/gh-startup.log"
API_LOG="/tmp/gh-api.log"
WORKER_LOG="/tmp/gh-worker.log"

echo "[kasm-startup] $(date -u +%FT%TZ) Waiting for desktop..." | tee -a "$LOG"

# Wait for Kasm desktop to be fully ready
/usr/bin/desktop_ready

echo "[kasm-startup] $(date -u +%FT%TZ) Desktop ready" | tee -a "$LOG"
echo "[kasm-startup] GH_WORKER_ID=${GH_WORKER_ID:-not-set}" | tee -a "$LOG"
echo "[kasm-startup] GH_API_PORT=${GH_API_PORT:-3100}" | tee -a "$LOG"

# Validate required env vars
MISSING=""
[ -z "${DATABASE_URL:-}" ] && MISSING="$MISSING DATABASE_URL"
[ -z "${GH_SERVICE_SECRET:-}" ] && MISSING="$MISSING GH_SERVICE_SECRET"
[ -z "${GH_CREDENTIAL_KEY:-}" ] && MISSING="$MISSING GH_CREDENTIAL_KEY"
[ -z "${SUPABASE_URL:-}" ] && MISSING="$MISSING SUPABASE_URL"
[ -z "${ANTHROPIC_API_KEY:-}" ] && MISSING="$MISSING ANTHROPIC_API_KEY"

if [ -n "$MISSING" ]; then
    echo "[kasm-startup] WARNING: Missing env vars:$MISSING" | tee -a "$LOG"
    echo "[kasm-startup] Services may fail to start. Attempting anyway..." | tee -a "$LOG"
fi

cd /opt/ghosthands

# Start GH API server in background (port 3100)
echo "[kasm-startup] $(date -u +%FT%TZ) Starting API server..." | tee -a "$LOG"
bun packages/ghosthands/src/api/server.ts >> "$API_LOG" 2>&1 &
API_PID=$!
echo "[kasm-startup] API server PID=$API_PID" | tee -a "$LOG"

# Start GH worker (foreground — Kasm monitors this process)
echo "[kasm-startup] $(date -u +%FT%TZ) Starting worker..." | tee -a "$LOG"
exec bun packages/ghosthands/src/workers/main.ts 2>&1 | tee -a "$WORKER_LOG"
