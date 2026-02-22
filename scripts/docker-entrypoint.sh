#!/bin/bash
# ──────────────────────────────────────────────────
# GhostHands Docker Entrypoint
#
# Starts the VNC stack (Xvfb + x11vnc + noVNC) in the background,
# then executes the main process (API server or worker) as PID 1.
#
# The VNC stack is only started if GH_VNC_ENABLED=true (default: true).
# Set GH_VNC_ENABLED=false to skip VNC and run headless-only.
# ──────────────────────────────────────────────────

VNC_ENABLED="${GH_VNC_ENABLED:-true}"

if [ "$VNC_ENABLED" = "true" ]; then
  echo "[entrypoint] Starting VNC stack..."
  /app/scripts/start-vnc.sh
  export DISPLAY=:99
  echo "[entrypoint] VNC stack ready. DISPLAY=$DISPLAY"
else
  echo "[entrypoint] VNC disabled (GH_VNC_ENABLED=$VNC_ENABLED)"
fi

# Execute the main process (passed as CMD arguments)
echo "[entrypoint] Starting main process: $@"
exec "$@"
