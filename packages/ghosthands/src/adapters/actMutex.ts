/**
 * ActMutex — prevents concurrent act() calls on adapters that don't support cancellation.
 *
 * When act() times out, the SDK call keeps running (neither Magnitude nor Stagehand
 * expose abort/cancel APIs). The mutex tracks this "poisoned" state and rejects new
 * act() calls until the old one settles, forcing the caller (SectionOrchestrator)
 * to escalate to a different adapter layer.
 */

export interface ActMutexState {
  actInFlight: boolean;
  poisoned: boolean;
  pendingAct: Promise<unknown> | null;
}

export function createActMutex(): ActMutexState {
  return {
    actInFlight: false,
    poisoned: false,
    pendingAct: null,
  };
}

/**
 * Check if the mutex allows a new act() call to proceed.
 * Returns null if OK to proceed, or an error message if blocked.
 */
export async function acquireActMutex(state: ActMutexState): Promise<string | null> {
  if (state.poisoned) {
    // Quick 500ms check if old promise finally settled
    if (state.pendingAct) {
      const settled = await Promise.race([
        state.pendingAct.then(() => true, () => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (settled) {
        state.poisoned = false;
        state.actInFlight = false;
        state.pendingAct = null;
      } else {
        return 'adapter busy: previous act() still running';
      }
    } else {
      // Poisoned but no pending promise — shouldn't happen, clear state
      state.poisoned = false;
      state.actInFlight = false;
    }
  }

  if (state.actInFlight) {
    return 'adapter busy: act() already in flight';
  }

  state.actInFlight = true;
  return null;
}

/**
 * Check if a poisoned mutex can be recovered (timed-out act() settled).
 * Call before checking mutex flags in non-act() code paths (like exec())
 * so that a settled act() clears the poison instead of permanently blocking.
 */
export async function refreshActMutex(state: ActMutexState): Promise<void> {
  if (!state.poisoned || !state.pendingAct) return;

  const settled = await Promise.race([
    state.pendingAct.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  if (settled) {
    state.poisoned = false;
    state.actInFlight = false;
    state.pendingAct = null;
  }
}

/**
 * Called when act() completes normally (success or failure, but not timeout).
 */
export function releaseActMutex(state: ActMutexState): void {
  state.actInFlight = false;
  state.pendingAct = null;
}

/**
 * Called when act() times out. The old promise is still running.
 * actInFlight stays true — the old call is still running.
 */
export function poisonActMutex(state: ActMutexState, pending: Promise<unknown>): void {
  state.poisoned = true;
  state.pendingAct = pending;
}
