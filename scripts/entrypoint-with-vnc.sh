#!/bin/bash
# ──────────────────────────────────────────────────
# GhostHands Entrypoint Wrapper
#
# Starts the Kasm VNC/desktop stack in the background,
# then exec's into the CMD (bun + API/worker/deploy-server).
#
# The Kasm base image (kasmweb/core-ubuntu-noble) ships with:
#   /dockerstartup/kasm_default_profile.sh
#   /dockerstartup/vnc_startup.sh
#   /dockerstartup/kasm_startup.sh
#
# Its default ENTRYPOINT chains all three, ending with --wait.
# When Kamal (or any orchestrator) overrides ENTRYPOINT to this
# script, VNC would not start. This wrapper restores VNC startup
# before handing off to the main process.
#
# Usage (Dockerfile):
#   ENTRYPOINT ["/opt/ghosthands/scripts/entrypoint-with-vnc.sh"]
#   CMD ["bun", "packages/ghosthands/src/workers/main.ts"]
#
# Works for all three targets:
#   API:    CMD ["bun", "packages/ghosthands/src/api/server.ts"]
#   Worker: CMD ["bun", "packages/ghosthands/src/workers/main.ts"]
#   Deploy: CMD ["bun", "scripts/deploy-server.ts"]
# ──────────────────────────────────────────────────
set -e

VNC_LOG="/tmp/vnc-startup.log"

# ── VNC Password Setup ───────────────────────────────────────────
# KasmVNC reads VNC_PW for the desktop password. If not set,
# generate a random one (development/non-interactive mode).
# In production, set VNC_PW in the Kamal/docker-compose env config.
setup_vnc_password() {
  if [ -z "${VNC_PW:-}" ]; then
    export VNC_PW
    VNC_PW=$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)
    echo "[entrypoint] WARNING: VNC_PW not set. Generated random password (non-interactive mode)." | tee -a "$VNC_LOG"
    echo "[entrypoint] Set VNC_PW in your deploy config for predictable access." | tee -a "$VNC_LOG"
  fi
}

# ── Start VNC via Kasm Scripts ────────────────────────────────────
# The Kasm base image provides vnc_startup.sh which handles:
#   - Xvfb (virtual framebuffer)
#   - KasmVNC server
#   - noVNC/websockify on port 6901
#   - custom_startup.sh callback
#
# We run it in the background so the main bun process becomes PID 1.
start_vnc() {
  echo "[entrypoint] $(date -u +%FT%TZ) Starting VNC services..." | tee -a "$VNC_LOG"

  # Fix KasmVNC config: global config ships with protocol: https which
  # fails without TLS certs. Override in user-level config (writable).
  mkdir -p /home/kasm-user/.vnc
  if ! grep -q 'protocol' /home/kasm-user/.vnc/kasmvnc.yaml 2>/dev/null; then
    cat >> /home/kasm-user/.vnc/kasmvnc.yaml <<YAML

network:
  protocol: http
YAML
    echo "[entrypoint] Added network.protocol=http to user VNC config" | tee -a "$VNC_LOG"
  fi

  # Preferred path: use Kasm's vnc_startup.sh (ships with the base image)
  if [ -x /dockerstartup/vnc_startup.sh ]; then
    echo "[entrypoint] Using Kasm vnc_startup.sh" | tee -a "$VNC_LOG"

    # Run the Kasm startup chain in the background.
    # kasm_default_profile.sh sets up the environment, vnc_startup.sh
    # launches VNC, kasm_startup.sh runs custom_startup.sh.
    if [ -x /dockerstartup/kasm_default_profile.sh ]; then
      /dockerstartup/kasm_default_profile.sh \
        /dockerstartup/vnc_startup.sh \
        /dockerstartup/kasm_startup.sh \
        --wait >> "$VNC_LOG" 2>&1 &
    else
      # Fallback: run vnc_startup.sh directly
      /dockerstartup/vnc_startup.sh >> "$VNC_LOG" 2>&1 &
    fi

    VNC_PID=$!
    echo "[entrypoint] Kasm VNC startup PID=$VNC_PID" | tee -a "$VNC_LOG"

    # Wait briefly for VNC to bind port 6901
    local attempts=0
    local max_attempts=10
    while [ $attempts -lt $max_attempts ]; do
      if command -v ss &>/dev/null && ss -tlnp 2>/dev/null | grep -q ":6901"; then
        echo "[entrypoint] VNC port 6901 is listening (after ${attempts}s)" | tee -a "$VNC_LOG"
        return 0
      elif command -v netstat &>/dev/null && netstat -tlnp 2>/dev/null | grep -q ":6901"; then
        echo "[entrypoint] VNC port 6901 is listening (after ${attempts}s)" | tee -a "$VNC_LOG"
        return 0
      fi
      sleep 1
      attempts=$((attempts + 1))
    done

    echo "[entrypoint] WARNING: VNC port 6901 not detected after ${max_attempts}s — may still be starting" | tee -a "$VNC_LOG"
    return 0
  fi

  # Fallback: start components manually if Kasm scripts are missing
  echo "[entrypoint] WARNING: Kasm vnc_startup.sh not found — attempting manual VNC start" | tee -a "$VNC_LOG"

  local DISPLAY_NUM="${VNC_DISPLAY:-:1}"
  local NOVNC_PORT="${NOVNC_PORT:-6901}"
  local SCREEN_RESOLUTION="${VNC_RESOLUTION:-1920x1080x24}"

  export DISPLAY="$DISPLAY_NUM"

  # 1. Xvfb (virtual framebuffer)
  if command -v Xvfb &>/dev/null; then
    echo "[entrypoint] Starting Xvfb on $DISPLAY_NUM ($SCREEN_RESOLUTION)" | tee -a "$VNC_LOG"
    Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN_RESOLUTION" -ac +extension GLX +render -noreset >> "$VNC_LOG" 2>&1 &
    sleep 1
  else
    echo "[entrypoint] WARNING: Xvfb not found — cannot start display server" | tee -a "$VNC_LOG"
    return 1
  fi

  # 2. KasmVNC server
  if command -v kasmvncserver &>/dev/null; then
    echo "[entrypoint] Starting KasmVNC" | tee -a "$VNC_LOG"
    local GEOM="${SCREEN_RESOLUTION%%x*}x$(echo "$SCREEN_RESOLUTION" | cut -dx -f2)"
    local DEPTH="${SCREEN_RESOLUTION##*x}"
    kasmvncserver "$DISPLAY_NUM" \
      -geometry "$GEOM" \
      -depth "$DEPTH" \
      -websocketPort "$NOVNC_PORT" \
      -cert /etc/ssl/certs/ssl-cert-snakeoil.pem \
      -key /etc/ssl/private/ssl-cert-snakeoil.key >> "$VNC_LOG" 2>&1 &
    sleep 2
  elif command -v x11vnc &>/dev/null; then
    echo "[entrypoint] Starting x11vnc (fallback)" | tee -a "$VNC_LOG"
    local VNC_PORT="${VNC_PORT:-5901}"
    x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -shared -forever -nopw >> "$VNC_LOG" 2>&1 &
    sleep 1
    # Start websockify for web access if available
    if command -v websockify &>/dev/null; then
      websockify --web=/usr/share/novnc/ "$NOVNC_PORT" localhost:"$VNC_PORT" >> "$VNC_LOG" 2>&1 &
    fi
  else
    echo "[entrypoint] WARNING: No VNC server found (kasmvncserver or x11vnc)" | tee -a "$VNC_LOG"
    return 1
  fi

  echo "[entrypoint] Manual VNC startup complete" | tee -a "$VNC_LOG"
  return 0
}

# ── Main ──────────────────────────────────────────────────────────

setup_vnc_password

# Start VNC (non-fatal on failure — bun process must still run)
start_vnc || echo "[entrypoint] WARNING: VNC startup failed — continuing without live view" | tee -a "$VNC_LOG"

# Exec into the main command (bun + whatever CMD is passed)
echo "[entrypoint] $(date -u +%FT%TZ) Exec: $*" | tee -a "$VNC_LOG"
exec "$@"
