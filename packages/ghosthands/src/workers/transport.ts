export interface ClaimedJob {
  jobId: string;
  leaseId: string;
  payload: Record<string, unknown>;
}

export interface JobEventInput {
  type: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ProgressPayload {
  type?: string;
  message?: string;
  step?: number;
  totalSteps?: number;
  timestamp?: number;
  [key: string]: unknown;
}

export interface JobCompletionPayload {
  result?: Record<string, unknown>;
  summary?: string;
}

export interface JobFailurePayload {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface JobSource {
  claimNext(signal?: AbortSignal): Promise<ClaimedJob | null>;
  heartbeat(jobId: string, leaseId: string): Promise<void>;
  release(jobId: string, leaseId: string, reason: string): Promise<void>;
}

export interface JobSink {
  emitEvent(jobId: string, leaseId: string, event: JobEventInput): Promise<void>;
  emitProgress(jobId: string, leaseId: string, progress: ProgressPayload): Promise<void>;
  awaitingReview(jobId: string, leaseId: string, result: JobCompletionPayload): Promise<void>;
  complete(jobId: string, leaseId: string, result: JobCompletionPayload): Promise<void>;
  fail(jobId: string, leaseId: string, error: JobFailurePayload): Promise<void>;
}
