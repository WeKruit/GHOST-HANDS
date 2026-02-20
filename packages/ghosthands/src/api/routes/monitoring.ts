import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getMetrics } from '../../monitoring/metrics.js';
import { HealthChecker } from '../../monitoring/health.js';
import { AlertManager } from '../../monitoring/alerts.js';

export interface MonitoringRoutesOptions {
  supabase: SupabaseClient;
}

export function createMonitoringRoutes(opts: MonitoringRoutesOptions) {
  const app = new Hono();
  const healthChecker = new HealthChecker({ supabase: opts.supabase });
  const alertManager = new AlertManager({ supabase: opts.supabase });

  // Start alert evaluation
  alertManager.start();

  // --- /health (detailed) ---
  app.get('/health', async (c) => {
    const report = await healthChecker.check();
    const statusCode = report.status === 'healthy' ? 200 : report.status === 'degraded' ? 200 : 503;
    return c.json(report, statusCode as any);
  });

  // --- /metrics (Prometheus text format) ---
  app.get('/metrics', (c) => {
    const metrics = getMetrics();
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.text(metrics.toPrometheusText());
  });

  // --- /metrics/json (JSON snapshot) ---
  app.get('/metrics/json', (c) => {
    const metrics = getMetrics();
    return c.json(metrics.snapshot());
  });

  // --- /alerts (active alerts) ---
  app.get('/alerts', async (c) => {
    const active = alertManager.getActiveAlerts();
    const stuckJobAlert = await alertManager.checkStuckJobs();

    const alerts = stuckJobAlert ? [...active, stuckJobAlert] : active;

    return c.json({
      count: alerts.length,
      alerts,
      checkedAt: new Date().toISOString(),
    });
  });

  // --- /workers (fleet-wide worker list) ---
  app.get('/workers', async (c) => {
    const { data, error } = await opts.supabase
      .from('gh_worker_registry')
      .select('*')
      .order('registered_at', { ascending: false });

    if (error) {
      return c.json({ error: 'db_error', message: error.message }, 500);
    }

    const now = Date.now();
    const workers = (data || []).map((w: any) => ({
      worker_id: w.worker_id,
      status: w.status,
      target_worker_id: w.target_worker_id,
      ec2_instance_id: w.ec2_instance_id,
      ec2_ip: w.ec2_ip,
      current_job_id: w.current_job_id,
      registered_at: w.registered_at,
      last_heartbeat: w.last_heartbeat,
      jobs_completed: w.jobs_completed,
      jobs_failed: w.jobs_failed,
      uptime_seconds: Math.floor((now - new Date(w.registered_at).getTime()) / 1000),
    }));

    return c.json({
      count: workers.length,
      workers,
      timestamp: new Date().toISOString(),
    });
  });

  // --- /dashboard (aggregated data for UI) ---
  app.get('/dashboard', async (c) => {
    const metrics = getMetrics();
    const snap = metrics.snapshot();
    const report = await healthChecker.check();
    const alerts = alertManager.getActiveAlerts();

    return c.json({
      health: report,
      metrics: snap,
      activeAlerts: alerts,
      timestamp: new Date().toISOString(),
    });
  });

  return { app, alertManager };
}
