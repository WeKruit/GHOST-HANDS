import type { SupabaseClient } from '@supabase/supabase-js';
import { getMetrics } from './metrics.js';
import { getLogger, Logger } from './logger.js';

// --- Types ---

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  id: string;
  name: string;
  severity: AlertSeverity;
  message: string;
  triggeredAt: string;
  metadata?: Record<string, unknown>;
}

export interface AlertRule {
  name: string;
  check: () => Alert | null;
  intervalMs: number;
}

export interface AlertSinkOptions {
  /** Webhook URL to POST alerts to (Slack, Discord, PagerDuty, etc.) */
  webhookUrl?: string;
  /** Email address for alert notifications (requires configured SMTP) */
  emailTo?: string;
}

export interface AlertManagerOptions {
  supabase?: SupabaseClient;
  sinks?: AlertSinkOptions;
  /** Error rate threshold (fraction) to trigger alert. Default: 0.10 */
  errorRateThreshold?: number;
  /** Max job duration in seconds before considered stuck. Default: 300 */
  stuckJobThresholdSeconds?: number;
  /** Max cost per hour in cents before alert. Default: 1000 ($10) */
  costPerHourThresholdCents?: number;
}

// --- Alert manager ---

export class AlertManager {
  private rules: AlertRule[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private activeAlerts: Map<string, Alert> = new Map();
  private log: Logger;
  private supabase?: SupabaseClient;
  private sinks: AlertSinkOptions;

  constructor(opts: AlertManagerOptions = {}) {
    this.log = getLogger().child({ component: 'alerts' });
    this.supabase = opts.supabase;
    this.sinks = opts.sinks ?? {};

    this.registerDefaultRules(opts);
  }

  private registerDefaultRules(opts: AlertManagerOptions): void {
    const errorRateThreshold = opts.errorRateThreshold ?? 0.10;
    const stuckThresholdSeconds = opts.stuckJobThresholdSeconds ?? 300;
    const costThresholdCents = opts.costPerHourThresholdCents ?? 1000;

    // Rule 1: High error rate (>10% in 5 min window)
    this.addRule({
      name: 'high_error_rate',
      intervalMs: 30_000,
      check: () => {
        const metrics = getMetrics();
        const errorRate = metrics.getErrorRateInWindow();

        if (errorRate > errorRateThreshold) {
          return {
            id: 'high_error_rate',
            name: 'High Error Rate',
            severity: errorRate > 0.25 ? 'critical' : 'warning',
            message: `Error rate is ${(errorRate * 100).toFixed(1)}% (threshold: ${(errorRateThreshold * 100).toFixed(0)}%)`,
            triggeredAt: new Date().toISOString(),
            metadata: { errorRate, threshold: errorRateThreshold },
          };
        }
        return null;
      },
    });

    // Rule 2: Stuck jobs (>5 min in running state)
    this.addRule({
      name: 'stuck_jobs',
      intervalMs: 60_000,
      check: () => {
        if (!this.supabase) return null;

        // This is synchronous check based on metrics data.
        // The actual DB query for stuck jobs is done in the async evaluation loop.
        const metrics = getMetrics();
        const snap = metrics.snapshot();

        if (snap.worker.activeJobs > 0 && snap.jobs.avgDurationMs > stuckThresholdSeconds * 1000) {
          return {
            id: 'stuck_jobs',
            name: 'Potentially Stuck Jobs',
            severity: 'warning',
            message: `Average job duration (${Math.round(snap.jobs.avgDurationMs / 1000)}s) exceeds threshold (${stuckThresholdSeconds}s)`,
            triggeredAt: new Date().toISOString(),
            metadata: {
              avgDurationMs: snap.jobs.avgDurationMs,
              activeJobs: snap.worker.activeJobs,
              threshold: stuckThresholdSeconds,
            },
          };
        }
        return null;
      },
    });

    // Rule 3: High cost (>$10/hour)
    this.addRule({
      name: 'high_cost',
      intervalMs: 60_000,
      check: () => {
        const metrics = getMetrics();
        const snap = metrics.snapshot();
        const costPerHour = snap.llm.costPerHourCents;

        if (costPerHour > costThresholdCents) {
          return {
            id: 'high_cost',
            name: 'High LLM Cost',
            severity: costPerHour > costThresholdCents * 2 ? 'critical' : 'warning',
            message: `LLM cost rate: $${(costPerHour / 100).toFixed(2)}/hr (threshold: $${(costThresholdCents / 100).toFixed(2)}/hr)`,
            triggeredAt: new Date().toISOString(),
            metadata: { costPerHourCents: costPerHour, threshold: costThresholdCents },
          };
        }
        return null;
      },
    });
  }

  // --- Rule management ---

  addRule(rule: AlertRule): void {
    this.rules.push(rule);
  }

  // --- Lifecycle ---

  start(): void {
    this.log.info('alert_manager_started', { ruleCount: this.rules.length });

    for (const rule of this.rules) {
      const timer = setInterval(() => {
        this.evaluateRule(rule);
      }, rule.intervalMs);
      this.timers.push(timer);

      // Run the first check immediately
      this.evaluateRule(rule);
    }
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    this.log.info('alert_manager_stopped');
  }

  // --- Evaluation ---

  private evaluateRule(rule: AlertRule): void {
    try {
      const alert = rule.check();

      if (alert) {
        const existing = this.activeAlerts.get(alert.id);
        if (!existing) {
          // New alert
          this.activeAlerts.set(alert.id, alert);
          this.log.warn('alert_triggered', {
            alertId: alert.id,
            alertName: alert.name,
            severity: alert.severity,
            message: alert.message,
          });
          this.dispatch(alert);
        }
      } else {
        // Alert cleared
        const existing = this.activeAlerts.get(rule.name);
        if (existing) {
          this.activeAlerts.delete(rule.name);
          this.log.info('alert_resolved', {
            alertId: rule.name,
          });
        }
      }
    } catch (err) {
      this.log.error('alert_rule_error', {
        rule: rule.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Dispatching ---

  private async dispatch(alert: Alert): Promise<void> {
    // Log to Supabase alert history if available
    if (this.supabase) {
      try {
        await this.supabase.from('gh_alerts').insert({
          alert_id: alert.id,
          name: alert.name,
          severity: alert.severity,
          message: alert.message,
          metadata: alert.metadata ?? {},
          triggered_at: alert.triggeredAt,
        });
      } catch (err) {
        this.log.error('alert_db_write_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Webhook notification
    if (this.sinks.webhookUrl) {
      try {
        await fetch(this.sinks.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `[${alert.severity.toUpperCase()}] ${alert.name}: ${alert.message}`,
            alert,
          }),
        });
      } catch (err) {
        this.log.error('alert_webhook_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // --- Query ---

  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values());
  }

  // --- Async stuck job check (for route handler) ---

  async checkStuckJobs(): Promise<Alert | null> {
    if (!this.supabase) return null;

    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .select('id, started_at, last_heartbeat')
      .eq('status', 'running')
      .lt('last_heartbeat', cutoff);

    if (error || !data || data.length === 0) return null;

    return {
      id: 'stuck_jobs_db',
      name: 'Stuck Jobs (DB)',
      severity: data.length > 3 ? 'critical' : 'warning',
      message: `${data.length} job(s) running with stale heartbeat (>5 min)`,
      triggeredAt: new Date().toISOString(),
      metadata: { stuckJobIds: data.map((j: { id: string }) => j.id) },
    };
  }
}
