// --- Types ---

export interface MetricSnapshot {
  jobs: JobMetrics;
  llm: LLMMetrics;
  worker: WorkerMetrics;
  api: APIMetrics;
  uptime: number;
  collectedAt: string;
}

export interface JobMetrics {
  created: number;
  completed: number;
  failed: number;
  retried: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

export interface LLMMetrics {
  calls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  avgTokensPerCall: number;
  costPerHourCents: number;
}

export interface WorkerMetrics {
  activeJobs: number;
  maxConcurrent: number;
  totalProcessed: number;
  queueDepth: number;
}

export interface APIMetrics {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  avgResponseTimeMs: number;
  requestsByPath: Record<string, number>;
  requestsByStatus: Record<number, number>;
}

// --- Internal counters ---

interface Counters {
  // Jobs
  jobsCreated: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsRetried: number;
  jobDurationsMs: number[];

  // LLM
  llmCalls: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCostCents: number;

  // Worker
  activeJobs: number;
  maxConcurrent: number;
  queueDepth: number;

  // API
  apiRequests: number;
  apiErrors: number;
  apiResponseTimesMs: number[];
  apiRequestsByPath: Record<string, number>;
  apiRequestsByStatus: Record<number, number>;

  // Timing
  startedAt: number;
}

// --- Sliding window for rate calculations ---

interface TimestampedValue {
  timestamp: number;
  value: number;
}

const WINDOW_SIZE_MS = 5 * 60 * 1000; // 5 minutes

class SlidingWindow {
  private entries: TimestampedValue[] = [];

  add(value: number): void {
    this.entries.push({ timestamp: Date.now(), value });
    this.prune();
  }

  sum(): number {
    this.prune();
    return this.entries.reduce((acc, e) => acc + e.value, 0);
  }

  count(): number {
    this.prune();
    return this.entries.length;
  }

  private prune(): void {
    const cutoff = Date.now() - WINDOW_SIZE_MS;
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
  }
}

// --- Metrics collector singleton ---

export class MetricsCollector {
  private counters: Counters;
  private errorWindow = new SlidingWindow();
  private requestWindow = new SlidingWindow();
  private costWindow = new SlidingWindow();

  // Hooks for future Prometheus/StatsD integration
  private hooks: Array<(name: string, value: number, tags?: Record<string, string>) => void> = [];

  constructor() {
    this.counters = {
      jobsCreated: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsRetried: 0,
      jobDurationsMs: [],

      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostCents: 0,

      activeJobs: 0,
      maxConcurrent: 0,
      queueDepth: 0,

      apiRequests: 0,
      apiErrors: 0,
      apiResponseTimesMs: [],
      apiRequestsByPath: {},
      apiRequestsByStatus: {},

      startedAt: Date.now(),
    };
  }

  // --- Job metrics ---

  recordJobCreated(): void {
    this.counters.jobsCreated++;
    this.emit('jobs.created', 1);
  }

  recordJobCompleted(durationMs: number): void {
    this.counters.jobsCompleted++;
    this.counters.jobDurationsMs.push(durationMs);
    this.emit('jobs.completed', 1);
    this.emit('jobs.duration_ms', durationMs);
  }

  recordJobFailed(): void {
    this.counters.jobsFailed++;
    this.errorWindow.add(1);
    this.emit('jobs.failed', 1);
  }

  recordJobRetried(): void {
    this.counters.jobsRetried++;
    this.emit('jobs.retried', 1);
  }

  // --- LLM metrics ---

  recordLLMCall(inputTokens: number, outputTokens: number, costCents: number): void {
    this.counters.llmCalls++;
    this.counters.llmInputTokens += inputTokens;
    this.counters.llmOutputTokens += outputTokens;
    this.counters.llmCostCents += costCents;
    this.costWindow.add(costCents);
    this.emit('llm.calls', 1);
    this.emit('llm.input_tokens', inputTokens);
    this.emit('llm.output_tokens', outputTokens);
    this.emit('llm.cost_cents', costCents);
  }

  // --- Worker metrics ---

  setActiveJobs(count: number): void {
    this.counters.activeJobs = count;
  }

  setMaxConcurrent(count: number): void {
    this.counters.maxConcurrent = count;
  }

  setQueueDepth(depth: number): void {
    this.counters.queueDepth = depth;
  }

  // --- API metrics ---

  recordAPIRequest(path: string, status: number, durationMs: number): void {
    this.counters.apiRequests++;
    this.counters.apiResponseTimesMs.push(durationMs);
    this.requestWindow.add(1);

    this.counters.apiRequestsByPath[path] =
      (this.counters.apiRequestsByPath[path] ?? 0) + 1;
    this.counters.apiRequestsByStatus[status] =
      (this.counters.apiRequestsByStatus[status] ?? 0) + 1;

    if (status >= 500) {
      this.counters.apiErrors++;
      this.errorWindow.add(1);
    }

    this.emit('api.request', 1, { path, status: String(status) });
    this.emit('api.response_time_ms', durationMs, { path });
  }

  // --- Snapshot ---

  snapshot(): MetricSnapshot {
    const now = Date.now();
    const uptimeMs = now - this.counters.startedAt;
    const uptimeHours = uptimeMs / (1000 * 60 * 60);

    const durations = this.counters.jobDurationsMs;
    const responseTimes = this.counters.apiResponseTimesMs;

    return {
      jobs: {
        created: this.counters.jobsCreated,
        completed: this.counters.jobsCompleted,
        failed: this.counters.jobsFailed,
        retried: this.counters.jobsRetried,
        totalDurationMs: durations.reduce((a, b) => a + b, 0),
        avgDurationMs:
          durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : 0,
      },
      llm: {
        calls: this.counters.llmCalls,
        totalInputTokens: this.counters.llmInputTokens,
        totalOutputTokens: this.counters.llmOutputTokens,
        totalCostCents: this.counters.llmCostCents,
        avgTokensPerCall:
          this.counters.llmCalls > 0
            ? Math.round(
                (this.counters.llmInputTokens + this.counters.llmOutputTokens) /
                  this.counters.llmCalls
              )
            : 0,
        costPerHourCents:
          uptimeHours > 0
            ? Math.round(this.counters.llmCostCents / uptimeHours)
            : 0,
      },
      worker: {
        activeJobs: this.counters.activeJobs,
        maxConcurrent: this.counters.maxConcurrent,
        totalProcessed: this.counters.jobsCompleted + this.counters.jobsFailed,
        queueDepth: this.counters.queueDepth,
      },
      api: {
        totalRequests: this.counters.apiRequests,
        totalErrors: this.counters.apiErrors,
        errorRate:
          this.counters.apiRequests > 0
            ? this.counters.apiErrors / this.counters.apiRequests
            : 0,
        avgResponseTimeMs:
          responseTimes.length > 0
            ? Math.round(
                responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
              )
            : 0,
        requestsByPath: { ...this.counters.apiRequestsByPath },
        requestsByStatus: { ...this.counters.apiRequestsByStatus },
      },
      uptime: uptimeMs,
      collectedAt: new Date().toISOString(),
    };
  }

  // --- Sliding window accessors (for alerts) ---

  getErrorRateInWindow(): number {
    const requests = this.requestWindow.count();
    const errors = this.errorWindow.count();
    return requests > 0 ? errors / requests : 0;
  }

  getCostInWindowCents(): number {
    return this.costWindow.sum();
  }

  // --- Prometheus-compatible output ---

  toPrometheusText(): string {
    const s = this.snapshot();
    const lines: string[] = [
      '# HELP gh_jobs_total Total jobs by status',
      '# TYPE gh_jobs_total counter',
      `gh_jobs_created_total ${s.jobs.created}`,
      `gh_jobs_completed_total ${s.jobs.completed}`,
      `gh_jobs_failed_total ${s.jobs.failed}`,
      `gh_jobs_retried_total ${s.jobs.retried}`,
      '',
      '# HELP gh_job_duration_ms Job execution duration',
      '# TYPE gh_job_duration_ms gauge',
      `gh_job_duration_avg_ms ${s.jobs.avgDurationMs}`,
      '',
      '# HELP gh_llm_total LLM usage metrics',
      '# TYPE gh_llm_total counter',
      `gh_llm_calls_total ${s.llm.calls}`,
      `gh_llm_input_tokens_total ${s.llm.totalInputTokens}`,
      `gh_llm_output_tokens_total ${s.llm.totalOutputTokens}`,
      `gh_llm_cost_cents_total ${s.llm.totalCostCents}`,
      '',
      '# HELP gh_worker_active_jobs Current active jobs',
      '# TYPE gh_worker_active_jobs gauge',
      `gh_worker_active_jobs ${s.worker.activeJobs}`,
      `gh_worker_queue_depth ${s.worker.queueDepth}`,
      '',
      '# HELP gh_api_requests_total Total API requests',
      '# TYPE gh_api_requests_total counter',
      `gh_api_requests_total ${s.api.totalRequests}`,
      `gh_api_errors_total ${s.api.totalErrors}`,
      `gh_api_response_time_avg_ms ${s.api.avgResponseTimeMs}`,
      '',
      '# HELP gh_uptime_ms Process uptime in milliseconds',
      '# TYPE gh_uptime_ms gauge',
      `gh_uptime_ms ${s.uptime}`,
    ];
    return lines.join('\n');
  }

  // --- Hook registration for future backends ---

  onEmit(hook: (name: string, value: number, tags?: Record<string, string>) => void): void {
    this.hooks.push(hook);
  }

  private emit(name: string, value: number, tags?: Record<string, string>): void {
    for (const hook of this.hooks) {
      try {
        hook(name, value, tags);
      } catch {
        // Don't let metric hook errors break the application
      }
    }
  }

  // --- Reset (for testing) ---

  reset(): void {
    this.counters = {
      jobsCreated: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      jobsRetried: 0,
      jobDurationsMs: [],
      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostCents: 0,
      activeJobs: 0,
      maxConcurrent: 0,
      queueDepth: 0,
      apiRequests: 0,
      apiErrors: 0,
      apiResponseTimesMs: [],
      apiRequestsByPath: {},
      apiRequestsByStatus: {},
      startedAt: Date.now(),
    };
  }
}

// --- Singleton ---

let _metrics: MetricsCollector | null = null;

export function getMetrics(): MetricsCollector {
  if (!_metrics) {
    _metrics = new MetricsCollector();
  }
  return _metrics;
}
