#!/usr/bin/env bun
/**
 * Kill all running GhostHands worker processes.
 *
 * Sends SIGTERM first (graceful), then SIGKILL after 5s if still alive.
 * Usage: bun run kill-workers
 */
import { execSync } from 'child_process';

const FORCE_KILL_DELAY_MS = 5_000;

function findWorkerPids(): number[] {
  try {
    // Find bun processes running workers/main.ts, exclude this script itself
    const output = execSync(
      `ps aux | grep '[w]orkers/main.ts' | grep -v kill-workers | awk '{print $2}'`,
      { encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((pid) => parseInt(pid, 10))
      .filter((pid) => !isNaN(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const pids = findWorkerPids();

  if (pids.length === 0) {
    console.log('[kill-workers] No worker processes found');
    return;
  }

  console.log(`[kill-workers] Found ${pids.length} worker process(es): ${pids.join(', ')}`);

  // Phase 1: SIGTERM (graceful)
  for (const pid of pids) {
    try {
      console.log(`[kill-workers] Sending SIGTERM to PID ${pid}`);
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      console.error(`[kill-workers] Failed to SIGTERM PID ${pid}:`, err);
    }
  }

  // Phase 2: Wait, then SIGKILL any survivors
  console.log(`[kill-workers] Waiting ${FORCE_KILL_DELAY_MS / 1000}s for graceful shutdown...`);
  setTimeout(() => {
    const survivors = pids.filter((pid) => isAlive(pid));
    if (survivors.length === 0) {
      console.log('[kill-workers] All workers exited gracefully');
      return;
    }

    console.log(`[kill-workers] ${survivors.length} worker(s) still alive, sending SIGKILL...`);
    for (const pid of survivors) {
      try {
        console.log(`[kill-workers] Sending SIGKILL to PID ${pid}`);
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        console.error(`[kill-workers] Failed to SIGKILL PID ${pid}:`, err);
      }
    }
    console.log('[kill-workers] Done');
  }, FORCE_KILL_DELAY_MS);
}

main();
