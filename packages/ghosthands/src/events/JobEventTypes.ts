/**
 * JobEventTypes — Canonical event type constants for gh_job_events.
 *
 * All event types that flow into the gh_job_events table should be defined here.
 * Using typed constants prevents typo bugs and enables autocomplete.
 */

export const JOB_EVENT_TYPES = {
  // Lifecycle
  JOB_STARTED: 'job_started',
  JOB_COMPLETED: 'job_completed',
  JOB_FAILED: 'job_failed',

  // Mode
  MODE_SELECTED: 'mode_selected',
  MODE_SWITCHED: 'mode_switched',

  // Steps (Magnitude path)
  STEP_STARTED: 'step_started',
  STEP_COMPLETED: 'step_completed',

  // Thinking
  THOUGHT: 'thought',

  // Observation (Stagehand)
  OBSERVATION_STARTED: 'observation_started',
  OBSERVATION_COMPLETED: 'observation_completed',

  // Cookbook
  COOKBOOK_STEP_STARTED: 'cookbook_step_started',
  COOKBOOK_STEP_COMPLETED: 'cookbook_step_completed',
  COOKBOOK_STEP_FAILED: 'cookbook_step_failed',

  // Cost
  TOKENS_USED: 'tokens_used',

  // Manual
  MANUAL_FOUND: 'manual_found',
  MANUAL_CREATED: 'manual_created',

  // Session
  SESSION_RESTORED: 'session_restored',
  SESSION_SAVED: 'session_saved',

  // HITL
  BLOCKER_DETECTED: 'blocker_detected',
  HITL_PAUSED: 'hitl_paused',
  HITL_RESUMED: 'hitl_resumed',
  HITL_TIMEOUT: 'hitl_timeout',

  // Credential injection
  CREDENTIAL_INJECTION_ATTEMPTED: 'credential_injection_attempted',
  CREDENTIAL_INJECTION_SUCCEEDED: 'credential_injection_succeeded',
  CREDENTIAL_INJECTION_FAILED: 'credential_injection_failed',

  // URL monitoring
  URL_CHANGE_DETECTED: 'url_change_detected',

  // Browser crash
  BROWSER_CRASH_DETECTED: 'browser_crash_detected',
  BROWSER_CRASH_RECOVERED: 'browser_crash_recovered',

  // Progress
  PROGRESS_UPDATE: 'progress_update',

  // Budget
  BUDGET_PREFLIGHT_FAILED: 'budget_preflight_failed',

  // Resume
  RESUME_DOWNLOADED: 'resume_downloaded',
  RESUME_DOWNLOAD_FAILED: 'resume_download_failed',

  // Trace
  TRACE_RECORDING_STARTED: 'trace_recording_started',
  TRACE_RECORDING_COMPLETED: 'trace_recording_completed',

  // Form submission (used by recovery to detect partial applications)
  FORM_SUBMITTED: 'form_submitted',
} as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[keyof typeof JOB_EVENT_TYPES];

/**
 * ThoughtThrottle — Limits thought events to max 1 per `intervalMs`.
 *
 * Usage:
 *   const throttle = new ThoughtThrottle(2000);
 *   if (throttle.shouldEmit()) {
 *     logJobEvent(jobId, 'thought', { content });
 *   }
 */
export class ThoughtThrottle {
  private lastEmitTime = 0;
  private readonly intervalMs: number;

  constructor(intervalMs = 2000) {
    this.intervalMs = intervalMs;
  }

  /** Returns true if enough time has passed since the last emitted thought. */
  shouldEmit(): boolean {
    const now = Date.now();
    if (now - this.lastEmitTime >= this.intervalMs) {
      this.lastEmitTime = now;
      return true;
    }
    return false;
  }

  /** Reset the throttle timer (e.g. on crash recovery re-wire). */
  reset(): void {
    this.lastEmitTime = 0;
  }

  /** Get the last emit timestamp (for testing). */
  getLastEmitTime(): number {
    return this.lastEmitTime;
  }
}

/** Type for logEvent callbacks passed to subsystems like CookbookExecutor/StagehandObserver. */
export type LogEventCallback = (eventType: string, metadata: Record<string, any>) => Promise<void>;
