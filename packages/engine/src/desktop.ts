import { EventEmitter } from 'events';
import { GhostHandsBrokerClient } from './broker';
import type {
  CreateLocalWorkerManagerOptions,
  LocalWorkerManager,
  LocalWorkerState,
  SmartApplySubmission,
} from './shared';

class LocalWorkerManagerImpl extends EventEmitter implements LocalWorkerManager {
  private readonly broker: GhostHandsBrokerClient;
  private readonly options: CreateLocalWorkerManagerOptions;
  private state: LocalWorkerState;
  private sessionToken: string | null = null;

  constructor(options: CreateLocalWorkerManagerOptions) {
    super();
    this.options = options;
    this.broker = new GhostHandsBrokerClient(options.broker);
    this.state = {
      status: 'stopped',
      desktopWorkerId: options.desktopWorkerId,
      activeJobId: null,
      activeLeaseId: null,
      lastError: null,
    };
  }

  async start(input: { userId: string; appVersion: string }): Promise<void> {
    this.state = {
      ...this.state,
      status: 'starting',
      lastError: null,
      startedAt: Date.now(),
    };
    this.options.logger?.info?.('Starting local worker manager', {
      desktopWorkerId: this.options.desktopWorkerId,
      hasSecretsProvider: !!this.options.secrets,
      hasStorage: !!this.options.storage?.mastraStatePath,
      hasWorkerBinaryPath: !!this.options.workerBinaryPath,
    });

    try {
      const registration = await this.broker.registerLocalWorker({
        desktopWorkerId: this.options.desktopWorkerId,
        deviceId: this.options.desktopWorkerId,
        appVersion: input.appVersion,
      });
      this.sessionToken = registration.sessionToken;
      this.state = {
        ...this.state,
        status: 'running',
      };
      this.emit('status', {
        type: 'ready',
        desktopWorkerId: registration.desktopWorkerId,
        userId: input.userId,
      });
    } catch (error: any) {
      const message = error?.message ?? 'Failed to start local worker manager';
      this.state = {
        ...this.state,
        status: 'error',
        lastError: message,
      };
      this.options.logger?.error?.(message, {
        desktopWorkerId: this.options.desktopWorkerId,
      });
      if (this.listenerCount('error') > 0) {
        this.emit('error', { type: 'fatal', error: message });
      }
      throw error;
    }
  }

  async stop(reason?: string): Promise<void> {
    this.options.logger?.info?.('Stopping local worker manager', {
      desktopWorkerId: this.options.desktopWorkerId,
      reason: reason ?? null,
    });
    this.state = {
      ...this.state,
      status: 'stopped',
      activeJobId: null,
      activeLeaseId: null,
      lastError: reason ?? null,
    };
    this.sessionToken = null;
    this.emit('status', { type: 'stopped', reason: reason ?? null });
  }

  async drain(): Promise<void> {
    this.options.logger?.info?.('Draining local worker manager', {
      desktopWorkerId: this.options.desktopWorkerId,
    });
    this.state = {
      ...this.state,
      status: 'draining',
    };
    this.emit('status', { type: 'draining' });
  }

  async submitSmartApply(input: SmartApplySubmission): Promise<{ requestId: string }> {
    const result = await this.broker.submitSmartApply(this.options.desktopWorkerId, input);
    this.emit('job_event', {
      type: 'job_submitted',
      jobId: result.jobId,
      requestId: result.requestId,
    });
    return { requestId: result.requestId };
  }

  async cancel(input: { jobId: string; leaseId: string }): Promise<void> {
    if (!this.sessionToken) {
      throw new Error('Local worker is not started');
    }
    await this.broker.release(input.jobId, this.sessionToken, {
      leaseId: input.leaseId,
      reason: 'cancelled',
    });
    this.state = {
      ...this.state,
      activeJobId: this.state.activeJobId === input.jobId ? null : this.state.activeJobId,
      activeLeaseId: this.state.activeLeaseId === input.leaseId ? null : this.state.activeLeaseId,
    };
  }

  getState(): LocalWorkerState {
    return { ...this.state };
  }
}

export function createLocalWorkerManager(
  options: CreateLocalWorkerManagerOptions,
): LocalWorkerManager {
  return new LocalWorkerManagerImpl(options);
}

export type {
  CreateLocalWorkerManagerOptions,
  LocalWorkerManager,
  LocalWorkerState,
  SmartApplySubmission,
} from './shared';
