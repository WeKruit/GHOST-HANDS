import type { SupabaseClient } from '@supabase/supabase-js';
import { getMetrics } from './metrics.js';
import { getLogger } from './logger.js';

// --- Types ---

export type CheckStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  name: string;
  status: CheckStatus;
  message?: string;
  latencyMs?: number;
}

export interface HealthReport {
  status: CheckStatus;
  version: string;
  uptime: number;
  checks: HealthCheckResult[];
  timestamp: string;
}

export interface HealthCheckerOptions {
  supabase: SupabaseClient;
  version?: string;
  /** Maximum heartbeat age in seconds before a worker is considered stale */
  workerHeartbeatMaxAge?: number;
}

// --- Constants ---

const DEFAULT_HEARTBEAT_MAX_AGE_SECONDS = 120;
const CHECK_TIMEOUT_MS = 5_000;

// --- Health checker ---

export class HealthChecker {
  private supabase: SupabaseClient;
  private version: string;
  private heartbeatMaxAge: number;
  private startedAt = Date.now();

  constructor(opts: HealthCheckerOptions) {
    this.supabase = opts.supabase;
    this.version = opts.version ?? '0.1.0';
    this.heartbeatMaxAge = opts.workerHeartbeatMaxAge ?? DEFAULT_HEARTBEAT_MAX_AGE_SECONDS;
  }

  async check(): Promise<HealthReport> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkWorkerHeartbeat(),
      this.checkLLMProvider(),
      this.checkStorage(),
    ]);

    // Overall status is the worst individual status
    let overall: CheckStatus = 'healthy';
    for (const c of checks) {
      if (c.status === 'unhealthy') {
        overall = 'unhealthy';
        break;
      }
      if (c.status === 'degraded') {
        overall = 'degraded';
      }
    }

    return {
      status: overall,
      version: this.version,
      uptime: Date.now() - this.startedAt,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  // --- Individual checks ---

  private async checkDatabase(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await this.withTimeout(
        this.supabase.from('gh_automation_jobs').select('id', { count: 'exact', head: true }),
        CHECK_TIMEOUT_MS,
      );

      if (result.error) {
        return {
          name: 'database',
          status: 'unhealthy',
          message: `Query failed: ${result.error.message}`,
          latencyMs: Date.now() - start,
        };
      }

      const latencyMs = Date.now() - start;
      return {
        name: 'database',
        status: latencyMs > 2000 ? 'degraded' : 'healthy',
        message: latencyMs > 2000 ? `Slow response: ${latencyMs}ms` : 'Connected',
        latencyMs,
      };
    } catch (err) {
      return {
        name: 'database',
        status: 'unhealthy',
        message: err instanceof Error ? err.message : 'Unknown error',
        latencyMs: Date.now() - start,
      };
    }
  }

  private async checkWorkerHeartbeat(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const cutoff = new Date(
        Date.now() - this.heartbeatMaxAge * 1000,
      ).toISOString();

      // Check for running jobs with stale heartbeats
      const { data: stuckJobs, error } = await this.withTimeout(
        this.supabase
          .from('gh_automation_jobs')
          .select('id')
          .eq('status', 'running')
          .lt('last_heartbeat', cutoff),
        CHECK_TIMEOUT_MS,
      );

      if (error) {
        return {
          name: 'worker_heartbeat',
          status: 'degraded',
          message: `Check failed: ${error.message}`,
          latencyMs: Date.now() - start,
        };
      }

      const stuckCount = stuckJobs?.length ?? 0;
      if (stuckCount > 0) {
        return {
          name: 'worker_heartbeat',
          status: 'degraded',
          message: `${stuckCount} job(s) with stale heartbeat`,
          latencyMs: Date.now() - start,
        };
      }

      return {
        name: 'worker_heartbeat',
        status: 'healthy',
        message: 'All running jobs have recent heartbeats',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: 'worker_heartbeat',
        status: 'degraded',
        message: err instanceof Error ? err.message : 'Unknown error',
        latencyMs: Date.now() - start,
      };
    }
  }

  private async checkLLMProvider(): Promise<HealthCheckResult> {
    // Check that at least one LLM provider has credentials configured
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasGoogle = !!process.env.GOOGLE_API_KEY;

    if (!hasAnthropic && !hasOpenAI && !hasGoogle) {
      return {
        name: 'llm_provider',
        status: 'unhealthy',
        message: 'No LLM provider API keys configured',
      };
    }

    const providers: string[] = [];
    if (hasAnthropic) providers.push('anthropic');
    if (hasOpenAI) providers.push('openai');
    if (hasGoogle) providers.push('google');

    // Check recent LLM error rates from metrics
    const metrics = getMetrics();
    const snap = metrics.snapshot();
    const llmErrorRate =
      snap.jobs.completed + snap.jobs.failed > 0
        ? snap.jobs.failed / (snap.jobs.completed + snap.jobs.failed)
        : 0;

    if (llmErrorRate > 0.5) {
      return {
        name: 'llm_provider',
        status: 'degraded',
        message: `High failure rate (${Math.round(llmErrorRate * 100)}%). Providers: ${providers.join(', ')}`,
      };
    }

    return {
      name: 'llm_provider',
      status: 'healthy',
      message: `Available providers: ${providers.join(', ')}`,
    };
  }

  private async checkStorage(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const { data, error } = await this.withTimeout(
        this.supabase.storage.listBuckets(),
        CHECK_TIMEOUT_MS,
      );

      if (error) {
        return {
          name: 'storage',
          status: 'degraded',
          message: `Bucket list failed: ${error.message}`,
          latencyMs: Date.now() - start,
        };
      }

      const hasScreenshots = data?.some((b: { name: string }) => b.name === 'screenshots');

      return {
        name: 'storage',
        status: hasScreenshots ? 'healthy' : 'degraded',
        message: hasScreenshots
          ? 'Screenshots bucket accessible'
          : 'Screenshots bucket not found',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: 'storage',
        status: 'degraded',
        message: err instanceof Error ? err.message : 'Unknown error',
        latencyMs: Date.now() - start,
      };
    }
  }

  // --- Timeout wrapper ---

  private withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Health check timeout (${ms}ms)`)), ms),
      ),
    ]);
  }
}
