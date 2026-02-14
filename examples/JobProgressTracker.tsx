/**
 * JobProgressTracker - React component for real-time job progress display.
 *
 * Uses Supabase Realtime via RealtimeSubscriber to show live progress
 * of a GhostHands automation job. Drop this into any VALET React page.
 *
 * Dependencies: @supabase/supabase-js, react
 *
 * Usage:
 *   <JobProgressTracker jobId="abc-123" supabaseUrl="..." supabaseKey="..." />
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types (mirrored from ghosthands package for standalone use)
// ---------------------------------------------------------------------------

type ProgressStep =
  | 'queued'
  | 'initializing'
  | 'navigating'
  | 'analyzing_page'
  | 'filling_form'
  | 'uploading_resume'
  | 'answering_questions'
  | 'reviewing'
  | 'submitting'
  | 'extracting_results'
  | 'completed'
  | 'failed';

interface ProgressEventData {
  step: ProgressStep;
  progress_pct: number;
  description: string;
  action_index: number;
  total_actions_estimate: number;
  current_action?: string;
  started_at: string;
  elapsed_ms: number;
  eta_ms: number | null;
}

type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

const TERMINAL_STATUSES = new Set<JobStatus>([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

// ---------------------------------------------------------------------------
// Step configuration for visual display
// ---------------------------------------------------------------------------

const STEPS: Array<{ key: ProgressStep; label: string; icon: string }> = [
  { key: 'initializing', label: 'Starting', icon: '1' },
  { key: 'navigating', label: 'Navigating', icon: '2' },
  { key: 'filling_form', label: 'Filling Form', icon: '3' },
  { key: 'uploading_resume', label: 'Resume', icon: '4' },
  { key: 'answering_questions', label: 'Questions', icon: '5' },
  { key: 'submitting', label: 'Submitting', icon: '6' },
  { key: 'completed', label: 'Done', icon: '7' },
];

const STEP_ORDER: ProgressStep[] = STEPS.map((s) => s.key);

// ---------------------------------------------------------------------------
// Hook: useJobProgress
// ---------------------------------------------------------------------------

interface UseJobProgressOptions {
  supabaseUrl: string;
  supabaseKey: string;
  jobId: string;
}

interface UseJobProgressResult {
  progress: ProgressEventData | null;
  jobStatus: JobStatus | null;
  error: string | null;
  isTerminal: boolean;
}

function useJobProgress(opts: UseJobProgressOptions): UseJobProgressResult {
  const { supabaseUrl, supabaseKey, jobId } = opts;
  const [progress, setProgress] = useState<ProgressEventData | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    if (!supabaseUrl || !supabaseKey || !jobId) return;

    const supabase =
      supabaseRef.current ?? createClient(supabaseUrl, supabaseKey);
    supabaseRef.current = supabase;

    // Initial fetch to get current state
    supabase
      .from('gh_automation_jobs')
      .select('status, metadata, status_message')
      .eq('id', jobId)
      .single()
      .then(({ data }) => {
        if (data) {
          setJobStatus(data.status as JobStatus);
          const p = (data.metadata as any)?.progress as
            | ProgressEventData
            | undefined;
          if (p) setProgress(p);
        }
      });

    // Subscribe to realtime updates
    const channelName = `gh-job-progress-${jobId}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes' as any,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'gh_automation_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload: { new: Record<string, any> }) => {
          const job = payload.new;
          setJobStatus(job.status as JobStatus);

          const p = (job.metadata as any)?.progress as
            | ProgressEventData
            | undefined;
          if (p) setProgress(p);

          if (TERMINAL_STATUSES.has(job.status as JobStatus)) {
            supabase.removeChannel(channel);
          }
        },
      )
      .subscribe((status: string) => {
        if (status === 'CHANNEL_ERROR') {
          setError('Lost connection to progress updates');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabaseUrl, supabaseKey, jobId]);

  return {
    progress,
    jobStatus,
    error,
    isTerminal: jobStatus ? TERMINAL_STATUSES.has(jobStatus) : false,
  };
}

// ---------------------------------------------------------------------------
// Component: JobProgressTracker
// ---------------------------------------------------------------------------

interface JobProgressTrackerProps {
  jobId: string;
  supabaseUrl: string;
  supabaseKey: string;
  /** Optional: called when job reaches terminal status */
  onComplete?: (status: JobStatus) => void;
}

export function JobProgressTracker({
  jobId,
  supabaseUrl,
  supabaseKey,
  onComplete,
}: JobProgressTrackerProps) {
  const { progress, jobStatus, error, isTerminal } = useJobProgress({
    supabaseUrl,
    supabaseKey,
    jobId,
  });

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (isTerminal && jobStatus && !notifiedRef.current) {
      notifiedRef.current = true;
      onCompleteRef.current?.(jobStatus);
    }
  }, [isTerminal, jobStatus]);

  const currentStepIndex = progress
    ? STEP_ORDER.indexOf(progress.step)
    : -1;

  const pct = progress?.progress_pct ?? 0;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Application Progress</span>
        {progress && (
          <span style={styles.pct}>{pct}%</span>
        )}
      </div>

      {/* Progress bar */}
      <div style={styles.barTrack}>
        <div
          style={{
            ...styles.barFill,
            width: `${pct}%`,
            backgroundColor: isTerminal
              ? jobStatus === 'completed'
                ? '#22c55e'
                : '#ef4444'
              : '#3b82f6',
          }}
        />
      </div>

      {/* Step indicators */}
      <div style={styles.steps}>
        {STEPS.map((step, i) => {
          const isActive = step.key === progress?.step;
          const isDone = currentStepIndex > i || jobStatus === 'completed';
          const isFailed = jobStatus === 'failed' && isActive;

          return (
            <div key={step.key} style={styles.stepItem}>
              <div
                style={{
                  ...styles.stepCircle,
                  backgroundColor: isFailed
                    ? '#ef4444'
                    : isDone
                    ? '#22c55e'
                    : isActive
                    ? '#3b82f6'
                    : '#e5e7eb',
                  color: isDone || isActive || isFailed ? '#fff' : '#9ca3af',
                }}
              >
                {isDone ? '\u2713' : step.icon}
              </div>
              <span
                style={{
                  ...styles.stepLabel,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#1f2937' : '#6b7280',
                }}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Status message */}
      <div style={styles.statusRow}>
        <span style={styles.description}>
          {progress?.description ?? 'Waiting for updates...'}
        </span>
        {progress?.eta_ms != null && progress.eta_ms > 0 && !isTerminal && (
          <span style={styles.eta}>
            ~{Math.ceil(progress.eta_ms / 1000)}s remaining
          </span>
        )}
      </div>

      {/* Current action detail */}
      {progress?.current_action && !isTerminal && (
        <div style={styles.actionDetail}>
          {progress.current_action}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div style={styles.error}>{error}</div>
      )}

      {/* Terminal state */}
      {isTerminal && (
        <div
          style={{
            ...styles.terminalBanner,
            backgroundColor:
              jobStatus === 'completed' ? '#f0fdf4' : '#fef2f2',
            borderColor:
              jobStatus === 'completed' ? '#bbf7d0' : '#fecaca',
            color: jobStatus === 'completed' ? '#166534' : '#991b1b',
          }}
        >
          {jobStatus === 'completed'
            ? 'Application submitted successfully!'
            : `Job ${jobStatus}`}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (no CSS dependencies)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    maxWidth: 600,
    padding: 24,
    borderRadius: 12,
    border: '1px solid #e5e7eb',
    backgroundColor: '#fff',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: '#1f2937',
  },
  pct: {
    fontSize: 20,
    fontWeight: 700,
    color: '#3b82f6',
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#e5e7eb',
    overflow: 'hidden',
    marginBottom: 20,
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
    transition: 'width 0.5s ease, background-color 0.3s ease',
  },
  steps: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  stepItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
  },
  stepCircle: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 4,
    transition: 'background-color 0.3s ease',
  },
  stepLabel: {
    fontSize: 11,
    textAlign: 'center',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: '#4b5563',
  },
  eta: {
    fontSize: 12,
    color: '#9ca3af',
  },
  actionDetail: {
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
    marginBottom: 8,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  error: {
    fontSize: 13,
    color: '#ef4444',
    padding: '8px 12px',
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    marginTop: 8,
  },
  terminalBanner: {
    padding: '12px 16px',
    borderRadius: 8,
    border: '1px solid',
    fontSize: 14,
    fontWeight: 600,
    textAlign: 'center',
    marginTop: 12,
  },
};

// ---------------------------------------------------------------------------
// Export hook separately for custom UI implementations
// ---------------------------------------------------------------------------
export { useJobProgress };
export type { ProgressEventData, ProgressStep, UseJobProgressResult };
