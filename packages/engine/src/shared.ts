export type DesktopExecutionMode = 'direct_runner' | 'local_queue_worker';

export interface NormalizedUserProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  linkedIn?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  education: Array<Record<string, unknown>>;
  experience: Array<Record<string, unknown>>;
  skills?: string[];
  qaAnswers?: Record<string, string>;
}

export interface SmartApplySubmission {
  userId: string;
  targetUrl: string;
  profile: NormalizedUserProfile;
  resumePath?: string;
  uiLabel: 'smart_apply';
}

export interface LocalWorkerState {
  status: 'stopped' | 'starting' | 'running' | 'draining' | 'error';
  desktopWorkerId?: string;
  activeJobId?: string | null;
  lastError?: string | null;
  startedAt?: number;
}

export interface CreateLocalWorkerManagerOptions {
  broker: {
    apiBaseUrl: string;
    accessToken: string;
  };
  desktopWorkerId: string;
  secrets: {
    getProviderKey(provider: 'anthropic'): Promise<string | null>;
    getWorkflowKey(): Promise<string>;
  };
  storage: {
    mastraStatePath: string;
  };
  workerBinaryPath: string;
  logger?: {
    info?: (message: string, metadata?: Record<string, unknown>) => void;
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
    error?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}

export interface WorkerBootstrapPayload {
  desktopWorkerId: string;
  sessionToken: string;
  brokerApiBaseUrl: string;
  providerSecrets: {
    anthropicApiKey: string;
  };
  workflow: {
    mode: 'mastra';
    statePath: string;
    encryptionKey: string;
  };
  runtime: {
    userId: string;
    appVersion: string;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  };
}

export interface BrokeredLocalWorkerJob {
  jobId: string;
  leaseId: string;
  targetUrl: string;
  jobType: 'apply' | string;
  executionMode: 'mastra' | string;
  profile: NormalizedUserProfile;
  resumePath?: string;
  metadata?: Record<string, unknown>;
}

export type WorkerCommand =
  | { type: 'start'; payload: WorkerBootstrapPayload }
  | { type: 'cancel_job'; jobId: string }
  | { type: 'drain' }
  | { type: 'shutdown' }
  | { type: 'refresh_secrets'; secrets: WorkerBootstrapPayload['providerSecrets'] };

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'status'; message: string }
  | { type: 'progress'; jobId: string; payload: Record<string, unknown> }
  | { type: 'job_event'; jobId: string; payload: Record<string, unknown> }
  | { type: 'job_claimed'; jobId: string }
  | { type: 'job_completed'; jobId: string }
  | { type: 'job_failed'; jobId: string; error: string }
  | { type: 'fatal'; error: string };

export interface LocalWorkerManager {
  start(input: {
    userId: string;
    appVersion: string;
  }): Promise<void>;
  stop(reason?: string): Promise<void>;
  drain(): Promise<void>;
  submitSmartApply(input: SmartApplySubmission): Promise<{ requestId: string }>;
  cancel(jobId: string): Promise<void>;
  getState(): LocalWorkerState;
  on(
    event: 'status' | 'progress' | 'job_event' | 'error',
    handler: (payload: unknown) => void,
  ): this;
}
