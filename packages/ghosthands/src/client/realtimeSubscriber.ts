import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { AutomationJob, JobStatus, JobEvent } from './types';
import { TERMINAL_STATUSES } from './types';
import type { ProgressEventData } from '../workers/progressTracker.js';

// --------------------------------------------------------------------------
// Callback types
// --------------------------------------------------------------------------
export type JobUpdateCallback = (job: AutomationJob) => void;
export type JobErrorCallback = (error: Error) => void;
export type ProgressCallback = (progress: ProgressEventData) => void;
export type JobEventCallback = (event: JobEvent) => void;

// --------------------------------------------------------------------------
// Subscription handle returned to the caller
// --------------------------------------------------------------------------
export interface JobSubscription {
  /** Stop listening and clean up the Realtime channel. */
  unsubscribe: () => Promise<void>;
}

// --------------------------------------------------------------------------
// Options for subscribeToJobStatus
// --------------------------------------------------------------------------
export interface SubscribeToJobOptions {
  /** Called on every UPDATE to the matching job row. */
  onUpdate: JobUpdateCallback;
  /** Called if the Realtime channel encounters an error. */
  onError?: JobErrorCallback;
  /**
   * If true, automatically unsubscribes when the job reaches a terminal
   * status (completed, failed, cancelled, expired). Default: true.
   */
  autoUnsubscribe?: boolean;
}

// --------------------------------------------------------------------------
// Options for subscribeToUserJobs (all jobs for a user)
// --------------------------------------------------------------------------
export interface SubscribeToUserJobsOptions {
  onUpdate: JobUpdateCallback;
  onError?: JobErrorCallback;
}

// --------------------------------------------------------------------------
// RealtimeSubscriber
// --------------------------------------------------------------------------
export class RealtimeSubscriber {
  private supabase: SupabaseClient;
  private channels: Map<string, RealtimeChannel> = new Map();

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Subscribe to status changes for a single job.
   *
   * Uses Supabase Realtime postgres_changes on gh_automation_jobs filtered by
   * job id. The gh_automation_jobs table must be added to the
   * supabase_realtime publication (see doc-12 S8 migration SQL).
   */
  subscribeToJobStatus(
    jobId: string,
    options: SubscribeToJobOptions,
  ): JobSubscription {
    const { onUpdate, onError, autoUnsubscribe = true } = options;
    const channelName = `gh-job-${jobId}`;

    const channel = this.supabase
      .channel(channelName)
      .on(
        'postgres_changes' as any,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'gh_automation_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload: { new: AutomationJob }) => {
          const job = payload.new;
          onUpdate(job);

          if (autoUnsubscribe && TERMINAL_STATUSES.has(job.status)) {
            this.removeChannel(channelName);
          }
        },
      )
      .subscribe((status: string) => {
        if (status === 'CHANNEL_ERROR' && onError) {
          onError(new Error(`Realtime channel error for job ${jobId}`));
        }
      });

    this.channels.set(channelName, channel);

    return {
      unsubscribe: () => this.removeChannel(channelName),
    };
  }

  /**
   * Subscribe to all job updates for a given user.
   *
   * Useful for dashboards that show a live list of all a user's active jobs.
   */
  subscribeToUserJobs(
    userId: string,
    options: SubscribeToUserJobsOptions,
  ): JobSubscription {
    const { onUpdate, onError } = options;
    const channelName = `gh-user-jobs-${userId}`;

    const channel = this.supabase
      .channel(channelName)
      .on(
        'postgres_changes' as any,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'gh_automation_jobs',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: AutomationJob }) => {
          onUpdate(payload.new);
        },
      )
      .subscribe((status: string) => {
        if (status === 'CHANNEL_ERROR' && onError) {
          onError(new Error(`Realtime channel error for user ${userId}`));
        }
      });

    this.channels.set(channelName, channel);

    return {
      unsubscribe: () => this.removeChannel(channelName),
    };
  }

  /**
   * Subscribe to progress updates for a single job.
   *
   * This listens for row updates on gh_automation_jobs and extracts
   * the progress data from the metadata.progress JSONB field.
   * The ProgressTracker on the worker side writes progress there on
   * every step transition and throttled action events.
   *
   * Recommended approach: Supabase Realtime (uses existing infrastructure,
   * no extra WebSocket server needed, auto-scales with Supabase).
   */
  subscribeToJobProgress(
    jobId: string,
    options: {
      onProgress: ProgressCallback;
      onUpdate?: JobUpdateCallback;
      onError?: JobErrorCallback;
      autoUnsubscribe?: boolean;
    },
  ): JobSubscription {
    const { onProgress, onUpdate, onError, autoUnsubscribe = true } = options;
    const channelName = `gh-job-progress-${jobId}`;

    const channel = this.supabase
      .channel(channelName)
      .on(
        'postgres_changes' as any,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'gh_automation_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload: { new: AutomationJob }) => {
          const job = payload.new;

          // Extract progress from metadata.progress if present
          const progressData = (job.metadata as any)?.progress as
            | ProgressEventData
            | undefined;
          if (progressData) {
            onProgress(progressData);
          }

          if (onUpdate) {
            onUpdate(job);
          }

          if (autoUnsubscribe && TERMINAL_STATUSES.has(job.status)) {
            this.removeChannel(channelName);
          }
        },
      )
      .subscribe((status: string) => {
        if (status === 'CHANNEL_ERROR' && onError) {
          onError(new Error(`Realtime progress channel error for job ${jobId}`));
        }
      });

    this.channels.set(channelName, channel);

    return {
      unsubscribe: () => this.removeChannel(channelName),
    };
  }

  /**
   * Subscribe to the real-time event stream for a single job.
   *
   * Listens for INSERT events on gh_job_events, delivering each new event as
   * it is written. This powers live UI features like:
   *  - Mode switching indicators (mode_selected, mode_switched)
   *  - Action timeline (step_started, step_completed, cookbook_step_completed)
   *  - Thinking/reasoning feed (current_action in progress_update events)
   *  - Manual discovery (manual_found, manual_created)
   *
   * Requires migration 012_gh_job_events_realtime.sql (adds gh_job_events
   * to supabase_realtime publication).
   *
   * Optionally filter by event types to reduce noise:
   *   subscribeToJobEvents(jobId, {
   *     onEvent: (e) => console.log(e),
   *     eventTypes: ['mode_selected', 'mode_switched', 'manual_found'],
   *   })
   */
  subscribeToJobEvents(
    jobId: string,
    options: {
      onEvent: JobEventCallback;
      onError?: JobErrorCallback;
      /** Only deliver events matching these types. Omit for all events. */
      eventTypes?: string[];
      autoUnsubscribe?: boolean;
    },
  ): JobSubscription {
    const { onEvent, onError, eventTypes, autoUnsubscribe = true } = options;
    const channelName = `gh-job-events-${jobId}`;

    const channel = this.supabase
      .channel(channelName)
      .on(
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'gh_job_events',
          filter: `job_id=eq.${jobId}`,
        },
        (payload: { new: JobEvent }) => {
          const event = payload.new;

          // Client-side filter by event type (if specified)
          if (eventTypes && !eventTypes.includes(event.event_type)) {
            return;
          }

          onEvent(event);
        },
      )
      .subscribe((status: string) => {
        if (status === 'CHANNEL_ERROR' && onError) {
          onError(new Error(`Realtime event channel error for job ${jobId}`));
        }
      });

    this.channels.set(channelName, channel);

    // If autoUnsubscribe, also listen for job completion via the job row
    if (autoUnsubscribe) {
      const jobChannelName = `gh-job-events-status-${jobId}`;
      const jobChannel = this.supabase
        .channel(jobChannelName)
        .on(
          'postgres_changes' as any,
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'gh_automation_jobs',
            filter: `id=eq.${jobId}`,
          },
          (payload: { new: AutomationJob }) => {
            if (TERMINAL_STATUSES.has(payload.new.status)) {
              // Small delay to let final events arrive before unsubscribing
              setTimeout(() => {
                this.removeChannel(channelName);
                this.removeChannel(jobChannelName);
              }, 2000);
            }
          },
        )
        .subscribe();

      this.channels.set(jobChannelName, jobChannel);
    }

    return {
      unsubscribe: async () => {
        await this.removeChannel(channelName);
        await this.removeChannel(`gh-job-events-status-${jobId}`);
      },
    };
  }

  /**
   * Wait for a job to reach a terminal status, resolving with the final job
   * record. Falls back to polling if Realtime is unavailable.
   */
  waitForCompletion(
    jobId: string,
    timeoutMs: number = 600_000,
  ): Promise<AutomationJob> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`));
      }, timeoutMs);

      const sub = this.subscribeToJobStatus(jobId, {
        onUpdate: (job) => {
          if (TERMINAL_STATUSES.has(job.status)) {
            clearTimeout(timer);
            resolve(job);
          }
        },
        onError: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        autoUnsubscribe: true,
      });
    });
  }

  /**
   * Tear down all active channels. Call this on client shutdown.
   */
  async dispose(): Promise<void> {
    const removals = Array.from(this.channels.keys()).map((name) =>
      this.removeChannel(name),
    );
    await Promise.all(removals);
  }

  // -- internal helpers --

  private async removeChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (channel) {
      await this.supabase.removeChannel(channel);
      this.channels.delete(name);
    }
  }
}
