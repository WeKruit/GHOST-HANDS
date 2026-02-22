#!/bin/bash
# ──────────────────────────────────────────────────
# VNC Stack Startup
#
# Starts Xvfb (virtual display), x11vnc (VNC server), and noVNC (web client).
# The browser renders on the virtual display (:99) and can be viewed
# remotely via noVNC at http://<host>:6080/vnc.html
#
# Ports:
#   :99   — X11 virtual display (Xvfb)
#   5900  — VNC protocol (x11vnc)
#   6080  — noVNC web client (HTTP/WebSocket)
# ──────────────────────────────────────────────────

set -e

# Start Xvfb (virtual display) on :99
echo "[vnc] Starting Xvfb on display :99 (1920x1080x24)..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Export DISPLAY for child processes
export DISPLAY=:99

# Wait for Xvfb to be ready
sleep 1

# Verify Xvfb started
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[vnc] ERROR: Xvfb failed to start"
  exit 1
fi

# Start x11vnc (VNC server) on display :99, listening on port 5900
echo "[vnc] Starting x11vnc on display :99, port 5900..."
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 -noxdamage &
X11VNC_PID=$!

sleep 0.5

if ! kill -0 "$X11VNC_PID" 2>/dev/null; then
  echo "[vnc] ERROR: x11vnc failed to start"
  exit 1
fi

# Start noVNC (web VNC client) — serves on port 6080, proxies to localhost:5900
# The noVNC proxy path varies by Debian package version
NOVNC_PROXY=""
if [ -f /usr/share/novnc/utils/novnc_proxy ]; then
  NOVNC_PROXY="/usr/share/novnc/utils/novnc_proxy"
elif [ -f /usr/share/novnc/utils/launch.sh ]; then
  NOVNC_PROXY="/usr/share/novnc/utils/launch.sh"
else
  # Fall back to websockify directly with noVNC web root
  echo "[vnc] noVNC proxy script not found, using websockify directly..."
  websockify --web /usr/share/novnc 6080 localhost:5900 &
  NOVNC_PID=$!
fi

if [ -n "$NOVNC_PROXY" ]; then
  echo "[vnc] Starting noVNC via $NOVNC_PROXY on port 6080..."
  $NOVNC_PROXY --vnc localhost:5900 --listen 6080 &
  NOVNC_PID=$!
fi

sleep 0.5

if ! kill -0 "$NOVNC_PID" 2>/dev/null; then
  echo "[vnc] WARNING: noVNC proxy may have failed to start (PID $NOVNC_PID)"
fi

echo "[vnc] VNC stack started: Xvfb :99 (PID $XVFB_PID), x11vnc :5900 (PID $X11VNC_PID), noVNC :6080 (PID $NOVNC_PID)"
