#!/usr/bin/env bash
#
# GhostHands Worker Test Runner
#
# Runs the full worker test cycle in a single terminal:
#   1. Kills any existing workers
#   2. Cleans up old jobs
#   3. Starts worker in background
#   4. Submits a test job
#   5. Monitors until completion
#   6. Shows results
#   7. Cleans up
#
# Usage:
#   ./test-worker.sh                    # auto-generated worker ID
#   ./test-worker.sh --worker-id=adam   # named worker
#   ./test-worker.sh --keep             # don't kill worker after test
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Parse args ──
WORKER_ID_ARG=""
KEEP_WORKER=false
for arg in "$@"; do
  case "$arg" in
    --worker-id=*) WORKER_ID_ARG="$arg" ;;
    --keep)        KEEP_WORKER=true ;;
    --help|-h)
      echo "Usage: ./test-worker.sh [--worker-id=NAME] [--keep]"
      echo ""
      echo "Options:"
      echo "  --worker-id=NAME   Use a custom worker ID (default: auto-generated)"
      echo "  --keep             Don't kill the worker after the test finishes"
      echo ""
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Run ./test-worker.sh --help for usage"
      exit 1
      ;;
  esac
done

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log()  { echo -e "${CYAN}[test]${NC} $*"; }
ok()   { echo -e "${GREEN}[test]${NC} $*"; }
warn() { echo -e "${YELLOW}[test]${NC} $*"; }
err()  { echo -e "${RED}[test]${NC} $*"; }

WORKER_PID=""
WORKER_LOG=$(mktemp /tmp/gh-worker-XXXXXX.log)

cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    if [ "$KEEP_WORKER" = true ]; then
      ok "Worker PID $WORKER_PID still running (--keep mode)"
      ok "Worker log: $WORKER_LOG"
      ok "Kill manually: kill $WORKER_PID"
    else
      log "Stopping worker (PID $WORKER_PID)..."
      kill "$WORKER_PID" 2>/dev/null || true
      # Wait up to 5s for graceful shutdown
      for i in $(seq 1 10); do
        if ! kill -0 "$WORKER_PID" 2>/dev/null; then break; fi
        sleep 0.5
      done
      # Force kill if still alive
      if kill -0 "$WORKER_PID" 2>/dev/null; then
        warn "Force-killing worker..."
        kill -9 "$WORKER_PID" 2>/dev/null || true
      fi
      ok "Worker stopped"
    fi
  fi
  if [ "$KEEP_WORKER" = false ] && [ -f "$WORKER_LOG" ]; then
    rm -f "$WORKER_LOG"
  fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────
# Step 1: Kill existing workers
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━ GhostHands Worker Test ━━━${NC}"
echo ""

log "Step 1/6: Killing existing workers..."
EXISTING_PIDS=$(ps aux | grep '[w]orkers/main.ts' | grep -v test-worker | awk '{print $2}' || true)
if [ -n "$EXISTING_PIDS" ]; then
  for pid in $EXISTING_PIDS; do
    warn "Killing existing worker PID $pid"
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
  ok "Existing workers killed"
else
  ok "No existing workers found"
fi

# ─────────────────────────────────────────────
# Step 2: Clean up old jobs
# ─────────────────────────────────────────────
log "Step 2/6: Cleaning up old jobs..."
bun src/scripts/delete-all-jobs.ts 2>&1 | grep -E "Deleted|Done|No jobs" || true
ok "Jobs cleaned"

# ─────────────────────────────────────────────
# Step 3: Start worker in background
# ─────────────────────────────────────────────
log "Step 3/6: Starting worker..."
if [ -n "$WORKER_ID_ARG" ]; then
  bun src/workers/main.ts "$WORKER_ID_ARG" > "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
  ok "Worker started (PID $WORKER_PID) with $WORKER_ID_ARG"
else
  bun src/workers/main.ts > "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
  ok "Worker started (PID $WORKER_PID) with auto-generated ID"
fi

# Wait for worker to connect
log "Waiting for worker to connect..."
for i in $(seq 1 20); do
  if grep -q "running" "$WORKER_LOG" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    err "Worker crashed on startup!"
    echo ""
    echo -e "${RED}── Worker Log ──${NC}"
    cat "$WORKER_LOG"
    exit 1
  fi
  sleep 0.5
done

if ! grep -q "running" "$WORKER_LOG" 2>/dev/null; then
  err "Worker didn't start within 10s"
  echo ""
  echo -e "${RED}── Worker Log ──${NC}"
  cat "$WORKER_LOG"
  exit 1
fi

WORKER_NAME=$(grep -o 'Starting with ID: [^ ]*' "$WORKER_LOG" | head -1 | cut -d' ' -f4 || echo "unknown")
ok "Worker ready: $WORKER_NAME"

# ─────────────────────────────────────────────
# Step 4: Submit test job
# ─────────────────────────────────────────────
log "Step 4/6: Submitting Google search test job..."
if [ -n "$WORKER_ID_ARG" ]; then
  log "  Targeting job to worker: ${WORKER_ID_ARG#--worker-id=}"
  JOB_OUTPUT=$(bun src/scripts/submit-test-job.ts "$WORKER_ID_ARG" 2>&1)
else
  JOB_OUTPUT=$(bun src/scripts/submit-test-job.ts 2>&1)
fi
JOB_ID=$(echo "$JOB_OUTPUT" | grep "Job ID:" | awk '{print $NF}')

if [ -z "$JOB_ID" ]; then
  err "Failed to submit test job!"
  echo "$JOB_OUTPUT"
  exit 1
fi
ok "Job submitted: $JOB_ID"

# ─────────────────────────────────────────────
# Step 5: Monitor until completion
# ─────────────────────────────────────────────
log "Step 5/6: Monitoring job..."
echo ""

MAX_WAIT=180  # 3 minutes
ELAPSED=0
LAST_STATUS=""

while [ $ELAPSED -lt $MAX_WAIT ]; do
  # Query job status
  STATUS=$(bun -e "
    import { Client } from 'pg';
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query('SELECT status, error_code FROM gh_automation_jobs WHERE id = \$1', ['$JOB_ID']);
    if (r.rows[0]) {
      console.log(r.rows[0].status + '|' + (r.rows[0].error_code || ''));
    } else {
      console.log('not_found|');
    }
    await c.end();
  " 2>/dev/null || echo "query_error|")

  JOB_STATUS=$(echo "$STATUS" | cut -d'|' -f1)
  ERROR_CODE=$(echo "$STATUS" | cut -d'|' -f2)

  if [ "$JOB_STATUS" != "$LAST_STATUS" ]; then
    case "$JOB_STATUS" in
      pending)  warn "  Status: pending (waiting for pickup)..." ;;
      queued)   log  "  Status: queued (claimed by worker)..." ;;
      running)  log  "  Status: running..." ;;
      completed)
        ok "  Status: completed!"
        break
        ;;
      failed)
        err "  Status: failed (error: $ERROR_CODE)"
        break
        ;;
      cancelled)
        warn "  Status: cancelled"
        break
        ;;
      *)
        warn "  Status: $JOB_STATUS"
        ;;
    esac
    LAST_STATUS="$JOB_STATUS"
  fi

  # Print worker activity dots
  if [ "$JOB_STATUS" = "running" ]; then
    # Show latest worker thoughts
    THOUGHT=$(grep -o 'Thought:.*' "$WORKER_LOG" 2>/dev/null | tail -1 | head -c 80 || true)
    if [ -n "$THOUGHT" ]; then
      echo -e "  ${CYAN}$THOUGHT${NC}"
    fi
  fi

  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  err "Timed out after ${MAX_WAIT}s"
fi

# ─────────────────────────────────────────────
# Step 6: Show results
# ─────────────────────────────────────────────
echo ""
log "Step 6/6: Results"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

bun -e "
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query('SELECT status, error_code, error_details, result_data, started_at, completed_at FROM gh_automation_jobs WHERE id = \$1', ['$JOB_ID']);
const job = r.rows[0];
if (!job) { console.log('Job not found'); process.exit(1); }

console.log('  Status:    ' + job.status);
if (job.started_at)   console.log('  Started:   ' + job.started_at);
if (job.completed_at) console.log('  Completed: ' + job.completed_at);
if (job.started_at && job.completed_at) {
  const dur = (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000;
  console.log('  Duration:  ' + dur + 's');
}
if (job.error_code)    console.log('  Error:     ' + job.error_code);
if (job.error_details) console.log('  Details:   ' + JSON.stringify(job.error_details, null, 2));
if (job.result_data)   console.log('  Result:    ' + JSON.stringify(job.result_data, null, 2));
await c.end();
" 2>/dev/null || err "Failed to query results"

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Show last few lines of worker log
log "Worker log (last 15 lines):"
echo -e "${CYAN}──────────────────────────────${NC}"
tail -15 "$WORKER_LOG" 2>/dev/null || true
echo -e "${CYAN}──────────────────────────────${NC}"
echo ""

if [ "$KEEP_WORKER" = true ]; then
  ok "Done! Worker still running (PID $WORKER_PID)"
  ok "Full log: $WORKER_LOG"
  ok "Kill when done: kill $WORKER_PID"
else
  ok "Done! Cleaning up..."
fi
