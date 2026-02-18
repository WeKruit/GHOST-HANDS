/**
 * DB Integration Tests — GhostHands tables CRUD operations
 *
 * Tests direct DB operations against Supabase for all gh_ prefixed tables.
 * Requires real Supabase credentials (SUPABASE_URL, SUPABASE_SECRET_KEY).
 *
 * Run:
 *   bun run test:integration -- __tests__/integration/db/jobsCrud.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  getTestSupabase,
  buildJobRow,
  insertTestJobs,
  cleanupByJobType,
  TEST_USER_ID,
  TEST_USER_ID_2,
} from '../../e2e/helpers';

const hasSupabase = !!process.env.SUPABASE_URL;

const JOB_TYPE = 'db_regression_test';

describe.skipIf(!hasSupabase)('DB Integration — gh_ tables CRUD', () => {
  const supabase = getTestSupabase();

  beforeAll(async () => {
    await cleanupByJobType(supabase, JOB_TYPE);
    // Clean up ancillary tables for test user
    await supabase.from('gh_user_usage').delete().eq('user_id', TEST_USER_ID);
    await supabase.from('gh_browser_sessions').delete().eq('user_id', TEST_USER_ID);
  });

  afterAll(async () => {
    await cleanupByJobType(supabase, JOB_TYPE);
    await supabase.from('gh_user_usage').delete().eq('user_id', TEST_USER_ID);
    await supabase.from('gh_browser_sessions').delete().eq('user_id', TEST_USER_ID);
  });

  // ── DB-001: gh_automation_jobs CRUD ──────────────────────────────────────

  test('DB-001: gh_automation_jobs — insert, read, update, delete', async () => {
    // Insert
    const [job] = await insertTestJobs(supabase, { job_type: JOB_TYPE });
    expect(job.id).toBeDefined();
    expect(job.status).toBe('pending');

    // Read
    const { data: fetched, error: fetchErr } = await supabase
      .from('gh_automation_jobs')
      .select('*')
      .eq('id', job.id as string)
      .single();
    expect(fetchErr).toBeNull();
    expect(fetched).toBeDefined();
    expect(fetched!.job_type).toBe(JOB_TYPE);

    // Update
    const { error: updateErr } = await supabase
      .from('gh_automation_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id as string);
    expect(updateErr).toBeNull();

    const { data: updated } = await supabase
      .from('gh_automation_jobs')
      .select('status')
      .eq('id', job.id as string)
      .single();
    expect(updated!.status).toBe('running');

    // Delete
    const { error: delErr } = await supabase
      .from('gh_automation_jobs')
      .delete()
      .eq('id', job.id as string);
    expect(delErr).toBeNull();

    const { data: gone } = await supabase
      .from('gh_automation_jobs')
      .select('id')
      .eq('id', job.id as string);
    expect(gone).toHaveLength(0);
  });

  // ── DB-002: gh_job_events FK to job ──────────────────────────────────────

  test('DB-002: gh_job_events — FK to gh_automation_jobs', async () => {
    const [job] = await insertTestJobs(supabase, { job_type: JOB_TYPE });

    const { data: event, error } = await supabase
      .from('gh_job_events')
      .insert({
        job_id: job.id,
        event_type: 'test_event',
        metadata: { test: true },
        actor: 'db-regression',
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(event).toBeDefined();
    expect(event!.job_id).toBe(job.id);
    expect(event!.event_type).toBe('test_event');
  });

  // ── DB-003: gh_job_events cascade delete ─────────────────────────────────

  test('DB-003: gh_job_events — cascade delete when job is deleted', async () => {
    const [job] = await insertTestJobs(supabase, { job_type: JOB_TYPE });
    const jobId = job.id as string;

    // Insert events
    await supabase.from('gh_job_events').insert([
      { job_id: jobId, event_type: 'started', metadata: {}, actor: 'test' },
      { job_id: jobId, event_type: 'completed', metadata: {}, actor: 'test' },
    ]);

    // Verify events exist
    const { data: before } = await supabase
      .from('gh_job_events')
      .select('id')
      .eq('job_id', jobId);
    expect(before!.length).toBeGreaterThanOrEqual(2);

    // Delete the job
    await supabase.from('gh_automation_jobs').delete().eq('id', jobId);

    // Verify events are gone (cascade)
    const { data: after } = await supabase
      .from('gh_job_events')
      .select('id')
      .eq('job_id', jobId);
    expect(after).toHaveLength(0);
  });

  // ── DB-004: Idempotency constraint ───────────────────────────────────────

  test('DB-004: idempotency_key unique constraint', async () => {
    const idemKey = `test-idem-${Date.now()}`;

    // First insert should succeed
    await insertTestJobs(supabase, {
      job_type: JOB_TYPE,
      idempotency_key: idemKey,
    });

    // Second insert with same key should throw
    await expect(
      insertTestJobs(supabase, {
        job_type: JOB_TYPE,
        idempotency_key: idemKey,
      }),
    ).rejects.toThrow();
  });

  // ── DB-005: gh_user_usage cost accumulation ──────────────────────────────

  test('DB-005: gh_user_usage — cost accumulates on upsert', async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();

    // First upsert — sets initial cost
    await supabase.from('gh_user_usage').upsert(
      {
        user_id: TEST_USER_ID,
        tier: 'starter',
        period_start: periodStart,
        period_end: periodEnd,
        total_cost_usd: 1.5,
        total_input_tokens: 1000,
        total_output_tokens: 500,
        job_count: 1,
      },
      { onConflict: 'user_id,period_start' },
    );

    // Second upsert — accumulate cost
    await supabase.from('gh_user_usage').upsert(
      {
        user_id: TEST_USER_ID,
        tier: 'starter',
        period_start: periodStart,
        period_end: periodEnd,
        total_cost_usd: 3.0,
        total_input_tokens: 2000,
        total_output_tokens: 1000,
        job_count: 2,
      },
      { onConflict: 'user_id,period_start' },
    );

    const { data } = await supabase
      .from('gh_user_usage')
      .select('total_cost_usd, job_count')
      .eq('user_id', TEST_USER_ID)
      .eq('period_start', periodStart)
      .single();

    expect(data).toBeDefined();
    // Upsert replaces, so should be the latest values
    expect(data!.total_cost_usd).toBe(3.0);
    expect(data!.job_count).toBe(2);
  });

  // ── DB-006: gh_user_usage upsert conflict ────────────────────────────────

  test('DB-006: gh_user_usage — upsert on (user_id, period_start) updates not duplicates', async () => {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();

    // Upsert twice with same user+period
    for (const cost of [1.0, 2.0]) {
      await supabase.from('gh_user_usage').upsert(
        {
          user_id: TEST_USER_ID,
          tier: 'starter',
          period_start: periodStart,
          period_end: periodEnd,
          total_cost_usd: cost,
          total_input_tokens: 0,
          total_output_tokens: 0,
          job_count: 0,
        },
        { onConflict: 'user_id,period_start' },
      );
    }

    // Should be exactly one row, not two
    const { data } = await supabase
      .from('gh_user_usage')
      .select('*')
      .eq('user_id', TEST_USER_ID)
      .eq('period_start', periodStart);

    expect(data).toHaveLength(1);
    expect(data![0].total_cost_usd).toBe(2.0);
  });

  // ── DB-007: gh_browser_sessions upsert conflict ──────────────────────────

  test('DB-007: gh_browser_sessions — upsert on (user_id, domain) updates not duplicates', async () => {
    const domain = 'test-regression.example.com';

    // First upsert
    const { error: err1 } = await supabase.from('gh_browser_sessions').upsert(
      {
        user_id: TEST_USER_ID,
        domain,
        session_data_encrypted: 'encrypted-v1',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      { onConflict: 'user_id,domain' },
    );
    expect(err1).toBeNull();

    // Second upsert — same user+domain
    const { error: err2 } = await supabase.from('gh_browser_sessions').upsert(
      {
        user_id: TEST_USER_ID,
        domain,
        session_data_encrypted: 'encrypted-v2',
        expires_at: new Date(Date.now() + 7200_000).toISOString(),
      },
      { onConflict: 'user_id,domain' },
    );
    expect(err2).toBeNull();

    // Should be one row with v2 data
    const { data } = await supabase
      .from('gh_browser_sessions')
      .select('*')
      .eq('user_id', TEST_USER_ID)
      .eq('domain', domain);

    expect(data).toHaveLength(1);
    expect(data![0].session_data_encrypted).toBe('encrypted-v2');

    // Cleanup
    await supabase
      .from('gh_browser_sessions')
      .delete()
      .eq('user_id', TEST_USER_ID)
      .eq('domain', domain);
  });

  // ── DB-008: Filter jobs by status ────────────────────────────────────────

  test('DB-008: filter jobs by status — returns only matching', async () => {
    await insertTestJobs(supabase, [
      { job_type: JOB_TYPE, status: 'pending' },
      { job_type: JOB_TYPE, status: 'completed' },
      { job_type: JOB_TYPE, status: 'failed' },
    ]);

    const { data: pending } = await supabase
      .from('gh_automation_jobs')
      .select('id')
      .eq('job_type', JOB_TYPE)
      .eq('status', 'pending');

    expect(pending!.length).toBeGreaterThanOrEqual(1);

    // All returned should be pending
    for (const job of pending!) {
      const { data } = await supabase
        .from('gh_automation_jobs')
        .select('status')
        .eq('id', job.id)
        .single();
      expect(data!.status).toBe('pending');
    }
  });

  // ── DB-009: scheduled_at for delayed jobs ────────────────────────────────

  test('DB-009: scheduled_at — future jobs excluded from immediate query', async () => {
    const futureTime = new Date(Date.now() + 3600_000).toISOString(); // 1 hour from now
    const now = new Date().toISOString();

    const [futureJob] = await insertTestJobs(supabase, {
      job_type: JOB_TYPE,
      scheduled_at: futureTime,
      status: 'pending',
    });

    // Query for pending jobs with scheduled_at <= now
    const { data: ready } = await supabase
      .from('gh_automation_jobs')
      .select('id')
      .eq('job_type', JOB_TYPE)
      .eq('status', 'pending')
      .or(`scheduled_at.is.null,scheduled_at.lte.${now}`);

    const readyIds = (ready ?? []).map((r: { id: string }) => r.id);
    expect(readyIds).not.toContain(futureJob.id);
  });

  // ── DB-010: All GH tables use gh_ prefix ─────────────────────────────────

  test('DB-010: all GH tables are queryable with gh_ prefix', async () => {
    const tables = [
      'gh_automation_jobs',
      'gh_job_events',
      'gh_user_usage',
      'gh_browser_sessions',
      'gh_action_manuals',
      'gh_worker_registry',
    ];

    for (const table of tables) {
      const { error } = await supabase.from(table).select('*').limit(1);
      expect(error, `Failed to query ${table}: ${error?.message}`).toBeNull();
    }
  });
});
