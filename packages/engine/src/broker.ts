import type {
  BrokeredLocalWorkerJob,
  SmartApplySubmission,
  WorkerBootstrapPayload,
} from './shared';

interface BrokerClientOptions {
  apiBaseUrl: string;
  accessToken: string;
}

export class GhostHandsBrokerClient {
  private readonly apiBaseUrl: string;
  private readonly accessToken: string;

  constructor(options: BrokerClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.accessToken = options.accessToken;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Broker request failed (${response.status}): ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async registerLocalWorker(input: {
    desktopWorkerId: string;
    deviceId: string;
    appVersion: string;
  }): Promise<{
    desktopWorkerId: string;
    sessionToken: string;
    expiresAt: string;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  }> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/register`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        desktopWorkerId: input.desktopWorkerId,
        deviceId: input.deviceId,
        appVersion: input.appVersion,
        capabilities: {
          mode: 'desktop_local_worker',
          supportsMastra: true,
          supportsInteractiveBrowser: true,
        },
      }),
    });
    return this.readJson(response);
  }

  async submitSmartApply(
    desktopWorkerId: string,
    input: SmartApplySubmission,
  ): Promise<{ requestId: string; jobId: string }> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/jobs/submit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        desktopWorkerId,
        ...input,
      }),
    });
    return this.readJson(response);
  }

  async claim(
    desktopWorkerId: string,
    sessionToken: string,
  ): Promise<{ leaseId: string | null; job: BrokeredLocalWorkerJob | null }> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/claim`, {
      method: 'POST',
      headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
      body: JSON.stringify({ desktopWorkerId }),
    });
    return this.readJson(response);
  }

  async heartbeat(
    desktopWorkerId: string,
    sessionToken: string,
    activeJobId?: string,
    leaseId?: string,
  ): Promise<void> {
    const response = await fetch(
      `${this.apiBaseUrl}/api/v1/local-workers/${desktopWorkerId}/heartbeat`,
      {
        method: 'POST',
        headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
        body: JSON.stringify(activeJobId && leaseId ? { activeJobId, leaseId } : {}),
      },
    );
    await this.readJson<{ ok: true }>(response);
  }

  async sendEvents(
    jobId: string,
    sessionToken: string,
    leaseId: string,
    events: Array<Record<string, unknown>>,
  ): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/jobs/${jobId}/events`, {
      method: 'POST',
      headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
      body: JSON.stringify({ leaseId, events }),
    });
    await this.readJson<{ ok: true }>(response);
  }

  async awaitingReview(
    jobId: string,
    sessionToken: string,
    payload: { leaseId: string; summary?: string },
  ): Promise<void> {
    const response = await fetch(
      `${this.apiBaseUrl}/api/v1/local-workers/jobs/${jobId}/awaiting-review`,
      {
        method: 'POST',
        headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
        body: JSON.stringify(payload),
      },
    );
    await this.readJson<{ ok: true }>(response);
  }

  async complete(
    jobId: string,
    sessionToken: string,
    payload: {
      leaseId: string;
      result?: Record<string, unknown>;
      summary?: string;
    },
  ): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
      body: JSON.stringify(payload),
    });
    await this.readJson<{ ok: true }>(response);
  }

  async fail(
    jobId: string,
    sessionToken: string,
    payload: {
      leaseId: string;
      error: string;
      code?: string;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
      body: JSON.stringify(payload),
    });
    await this.readJson<{ ok: true }>(response);
  }

  async release(
    jobId: string,
    sessionToken: string,
    payload: { leaseId: string; reason: string },
  ): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/api/v1/local-workers/jobs/${jobId}/release`, {
      method: 'POST',
      headers: this.headers({ 'X-Local-Worker-Session': sessionToken }),
      body: JSON.stringify(payload),
    });
    await this.readJson<{ ok: true }>(response);
  }
}

export type {
  BrokeredLocalWorkerJob,
  SmartApplySubmission,
  WorkerBootstrapPayload,
} from './shared';
