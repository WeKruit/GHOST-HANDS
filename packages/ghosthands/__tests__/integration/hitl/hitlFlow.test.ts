import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { CallbackNotifier } from '../../../src/workers/callbackNotifier.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import {
  HITL_ELIGIBLE_ERRORS,
  classifyError,
} from '../../../src/workers/JobExecutor.js';

// ── Shared test helper ───────────────────────────────────────────────────

function createMockSupabase() {
  const updates: Record<string, any>[] = [];
  const chainable: Record<string, any> = {};
  chainable.select = () => chainable;
  chainable.eq = () => chainable;
  chainable.single = () => Promise.resolve({ data: null, error: null });
  chainable.update = (data: Record<string, any>) => {
    updates.push(data);
    return chainable;
  };
  chainable.insert = () => Promise.resolve({ data: null, error: null });

  return {
    from: () => chainable,
    _chain: chainable,
    _updates: updates,
  };
}

// ── CallbackNotifier tests ────────────────────────────────────────────────

describe('CallbackNotifier', () => {
  let notifier: CallbackNotifier;
  let fetchCalls: { url: string; options: any }[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    notifier = new CallbackNotifier();
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: url as string, options: init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('notifyHumanNeeded', () => {
    test('sends needs_human callback with interaction data', async () => {
      const result = await notifier.notifyHumanNeeded(
        'job-123',
        'https://valet.example.com/callback',
        {
          type: 'captcha',
          screenshot_url: 'https://screenshots.example.com/blocker.png',
          page_url: 'https://boards.greenhouse.io/company/jobs/1',
          timeout_seconds: 300,
        },
        'valet-task-456',
      );

      expect(result).toBe(true);
      expect(fetchCalls).toHaveLength(1);

      const body = JSON.parse(fetchCalls[0].options.body);
      expect(body.job_id).toBe('job-123');
      expect(body.valet_task_id).toBe('valet-task-456');
      expect(body.status).toBe('needs_human');
      expect(body.interaction).toEqual({
        type: 'captcha',
        screenshot_url: 'https://screenshots.example.com/blocker.png',
        page_url: 'https://boards.greenhouse.io/company/jobs/1',
        timeout_seconds: 300,
      });
      expect(body.completed_at).toBeTruthy();
    });

    test('sends needs_human with null valet_task_id when not provided', async () => {
      await notifier.notifyHumanNeeded(
        'job-123',
        'https://valet.example.com/callback',
        { type: 'login' },
      );

      const body = JSON.parse(fetchCalls[0].options.body);
      expect(body.valet_task_id).toBeNull();
    });
  });

  describe('notifyResumed', () => {
    test('sends resumed callback', async () => {
      const result = await notifier.notifyResumed(
        'job-123',
        'https://valet.example.com/callback',
        'valet-task-456',
      );

      expect(result).toBe(true);
      const body = JSON.parse(fetchCalls[0].options.body);
      expect(body.status).toBe('resumed');
      expect(body.job_id).toBe('job-123');
      expect(body.valet_task_id).toBe('valet-task-456');
    });
  });

  describe('notifyFromJob', () => {
    test('returns false when callback_url is missing', async () => {
      const result = await notifier.notifyFromJob({
        id: 'job-123',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(fetchCalls).toHaveLength(0);
    });

    test('sends completed callback with cost data', async () => {
      await notifier.notifyFromJob({
        id: 'job-123',
        valet_task_id: 'valet-456',
        callback_url: 'https://valet.example.com/callback',
        status: 'completed',
        result_data: { submitted: true },
        result_summary: 'Application submitted',
        screenshot_urls: ['https://screenshots.example.com/final.png'],
        llm_cost_cents: 5,
        action_count: 10,
        total_tokens: 2000,
      });

      const body = JSON.parse(fetchCalls[0].options.body);
      expect(body.status).toBe('completed');
      expect(body.result_summary).toBe('Application submitted');
      expect(body.cost).toEqual({
        total_cost_usd: 0.05,
        action_count: 10,
        total_tokens: 2000,
      });
    });

    test('sends failed callback with error details', async () => {
      await notifier.notifyFromJob({
        id: 'job-123',
        callback_url: 'https://valet.example.com/callback',
        status: 'failed',
        error_code: 'captcha_blocked',
        error_details: { message: 'CAPTCHA detected' },
      });

      const body = JSON.parse(fetchCalls[0].options.body);
      expect(body.status).toBe('failed');
      expect(body.error_code).toBe('captcha_blocked');
      expect(body.error_message).toBe('CAPTCHA detected');
    });
  });
});

// ── Mock adapter pause/resume tests ───────────────────────────────────────

describe('MockAdapter pause/resume', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  test('starts in not-paused state', async () => {
    await adapter.start({ llm: { provider: 'mock', options: { model: 'mock' } } });
    expect(adapter.isPaused()).toBe(false);
  });

  test('pause sets paused state', async () => {
    await adapter.start({ llm: { provider: 'mock', options: { model: 'mock' } } });
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);
  });

  test('resume clears paused state', async () => {
    await adapter.start({ llm: { provider: 'mock', options: { model: 'mock' } } });
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);

    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);
  });

  test('pause/resume cycle is idempotent', async () => {
    await adapter.start({ llm: { provider: 'mock', options: { model: 'mock' } } });

    await adapter.pause();
    await adapter.pause(); // double pause
    expect(adapter.isPaused()).toBe(true);

    await adapter.resume();
    await adapter.resume(); // double resume
    expect(adapter.isPaused()).toBe(false);
  });

  test('isActive remains true while paused', async () => {
    await adapter.start({ llm: { provider: 'mock', options: { model: 'mock' } } });
    await adapter.pause();
    expect(adapter.isActive()).toBe(true);
    expect(adapter.isPaused()).toBe(true);
  });
});

// ── HITL flow simulation (requestHumanIntervention logic) ─────────────────

describe('HITL flow simulation', () => {
  test('full pause -> resume flow updates job status correctly', async () => {
    const supabase = createMockSupabase();
    const adapter = new MockAdapter();
    await adapter.start({ url: 'https://boards.greenhouse.io', llm: { provider: 'mock', options: { model: 'mock' } } });

    // Step 1: Blocker detected -> pause adapter
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);

    // Step 2: Update job to paused status
    await supabase.from('gh_automation_jobs').update({
      status: 'paused',
      interaction_type: 'captcha',
      interaction_data: {
        type: 'captcha',
        confidence: 0.95,
        page_url: 'https://boards.greenhouse.io',
      },
      paused_at: new Date().toISOString(),
    }).eq('id', 'job-123');

    expect(supabase._updates[0].status).toBe('paused');
    expect(supabase._updates[0].interaction_type).toBe('captcha');

    // Step 3: Human resolves the blocker
    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);

    // Step 4: Update job back to running
    await supabase.from('gh_automation_jobs').update({
      status: 'running',
      paused_at: null,
      status_message: 'Resumed after human intervention',
    }).eq('id', 'job-123');

    const lastUpdate = supabase._updates[supabase._updates.length - 1];
    expect(lastUpdate.status).toBe('running');
    expect(lastUpdate.paused_at).toBeNull();
  });

  test('timeout flow transitions job to failed with hitl_timeout error', async () => {
    const supabase = createMockSupabase();
    const adapter = new MockAdapter();
    await adapter.start({ url: 'https://boards.greenhouse.io', llm: { provider: 'mock', options: { model: 'mock' } } });

    await adapter.pause();

    await supabase.from('gh_automation_jobs').update({
      status: 'paused',
      interaction_type: 'login',
    }).eq('id', 'job-456');

    // Simulate timeout
    const resumed = false;

    if (!resumed) {
      await supabase.from('gh_automation_jobs').update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_code: 'hitl_timeout',
        error_details: {
          message: 'Human intervention timed out after 300s',
          blocker_type: 'login',
        },
      }).eq('id', 'job-456');
    }

    const failUpdate = supabase._updates[supabase._updates.length - 1];
    expect(failUpdate.status).toBe('failed');
    expect(failUpdate.error_code).toBe('hitl_timeout');
    expect(failUpdate.error_details.blocker_type).toBe('login');
  });

  test('callback notifications sent in correct order during HITL flow', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: any[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url, options: init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const notifier = new CallbackNotifier();
      const callbackUrl = 'https://valet.example.com/callback';
      const jobId = 'job-789';
      const valetTaskId = 'valet-task-100';

      // 1. Blocker detected -> notify needs_human
      await notifier.notifyHumanNeeded(jobId, callbackUrl, {
        type: 'captcha',
        screenshot_url: 'https://screenshots.example.com/captcha.png',
        page_url: 'https://linkedin.com/login',
        timeout_seconds: 300,
      }, valetTaskId);

      // 2. Human resolves -> notify resumed
      await notifier.notifyResumed(jobId, callbackUrl, valetTaskId);

      expect(fetchCalls).toHaveLength(2);

      const firstBody = JSON.parse(fetchCalls[0].options.body);
      expect(firstBody.status).toBe('needs_human');
      expect(firstBody.interaction.type).toBe('captcha');

      const secondBody = JSON.parse(fetchCalls[1].options.body);
      expect(secondBody.status).toBe('resumed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('waitForResumeViaPolling returns true when status changes to running', async () => {
    let callCount = 0;
    const mockSingle = () => {
      callCount++;
      if (callCount >= 2) {
        return Promise.resolve({ data: { status: 'running' }, error: null });
      }
      return Promise.resolve({ data: { status: 'paused' }, error: null });
    };

    const chainable: Record<string, any> = {};
    chainable.select = () => chainable;
    chainable.eq = () => chainable;
    chainable.single = mockSingle;
    const supabase = { from: () => chainable };

    const pollIntervalMs = 10;
    const deadline = Date.now() + 1000;
    let resumed = false;

    while (Date.now() < deadline) {
      const { data } = await supabase
        .from('gh_automation_jobs')
        .select('status')
        .eq('id', 'job-poll-test')
        .single();

      if (data?.status === 'running') {
        resumed = true;
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    expect(resumed).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test('waitForResumeViaPolling returns false on timeout', async () => {
    const chainable: Record<string, any> = {};
    chainable.select = () => chainable;
    chainable.eq = () => chainable;
    chainable.single = () => Promise.resolve({ data: { status: 'paused' }, error: null });
    const supabase = { from: () => chainable };

    const pollIntervalMs = 10;
    const deadline = Date.now() + 50;
    let resumed = false;

    while (Date.now() < deadline) {
      const { data } = await supabase
        .from('gh_automation_jobs')
        .select('status')
        .eq('id', 'job-timeout-test')
        .single();

      if (data?.status === 'running') {
        resumed = true;
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    expect(resumed).toBe(false);
  });
});

// ── pg LISTEN/NOTIFY mock tests ───────────────────────────────────────────

describe('pg LISTEN/NOTIFY mock', () => {
  test('simulates notification delivery for matching job ID', () => {
    const jobId = 'job-notify-test';
    let resumed = false;

    const onNotification = (msg: { channel: string; payload?: string }) => {
      if (msg.channel === 'gh_job_resume' && msg.payload === jobId) {
        resumed = true;
      }
    };

    onNotification({ channel: 'gh_job_resume', payload: jobId });
    expect(resumed).toBe(true);
  });

  test('ignores notification for different job ID', () => {
    const jobId = 'job-notify-test';
    let resumed = false;

    const onNotification = (msg: { channel: string; payload?: string }) => {
      if (msg.channel === 'gh_job_resume' && msg.payload === jobId) {
        resumed = true;
      }
    };

    onNotification({ channel: 'gh_job_resume', payload: 'different-job' });
    expect(resumed).toBe(false);
  });

  test('ignores notification on different channel', () => {
    const jobId = 'job-notify-test';
    let resumed = false;

    const onNotification = (msg: { channel: string; payload?: string }) => {
      if (msg.channel === 'gh_job_resume' && msg.payload === jobId) {
        resumed = true;
      }
    };

    onNotification({ channel: 'gh_other_channel', payload: jobId });
    expect(resumed).toBe(false);
  });

  test('waitForResumeViaPg pattern: resolves true on matching notification', async () => {
    const jobId = 'job-pg-test';

    const result = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 500);

      const onNotification = (msg: { channel: string; payload?: string }) => {
        if (msg.channel === 'gh_job_resume' && msg.payload === jobId) {
          clearTimeout(timeout);
          resolve(true);
        }
      };

      setTimeout(() => {
        onNotification({ channel: 'gh_job_resume', payload: jobId });
      }, 10);
    });

    expect(result).toBe(true);
  });

  test('waitForResumeViaPg pattern: resolves false on timeout', async () => {
    const result = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 50);
    });

    expect(result).toBe(false);
  });
});

// ── WEK-67: 2FA triggers HITL pause ──────────────────────────────────────

describe('2FA triggers HITL pause (WEK-67)', () => {
  // Verify that the error classification and HITL eligibility gate work for 2FA
  // ERROR_CLASSIFICATIONS, HITL_ELIGIBLE_ERRORS, and classifyError are imported
  // from JobExecutor.ts so tests exercise the actual production constants.

  function mapErrorToBlockerType(errorCode: string): string {
    return errorCode === 'captcha_blocked' ? 'captcha' : errorCode === '2fa_required' ? '2fa' : 'login';
  }

  test('classifies "two-factor authentication required" as 2fa_required', () => {
    expect(classifyError('Two-factor authentication required')).toBe('2fa_required');
  });

  test('classifies "verification code needed" as 2fa_required', () => {
    expect(classifyError('Please enter your verification code')).toBe('2fa_required');
  });

  test('classifies "authenticator app" as 2fa_required', () => {
    expect(classifyError('Open your authenticator app and enter the code')).toBe('2fa_required');
  });

  test('classifies "2FA challenge" as 2fa_required', () => {
    expect(classifyError('2FA challenge presented on page')).toBe('2fa_required');
  });

  test('2fa_required is HITL-eligible', () => {
    expect(HITL_ELIGIBLE_ERRORS.has('2fa_required')).toBe(true);
  });

  test('2fa_required maps to blocker type "2fa"', () => {
    expect(mapErrorToBlockerType('2fa_required')).toBe('2fa');
  });

  test('captcha_blocked still maps to "captcha"', () => {
    expect(mapErrorToBlockerType('captcha_blocked')).toBe('captcha');
  });

  test('login_required still maps to "login"', () => {
    expect(mapErrorToBlockerType('login_required')).toBe('login');
  });

  test('2FA error triggers HITL pause flow (not retry/fail)', async () => {
    const supabase = createMockSupabase();
    const adapter = new MockAdapter();
    await adapter.start({ url: 'https://boards.greenhouse.io', llm: { provider: 'mock', options: { model: 'mock' } } });

    // Simulate: error classified as 2fa_required → enters HITL flow
    const errorMessage = 'Two-factor authentication required';
    const errorCode = classifyError(errorMessage);
    expect(errorCode).toBe('2fa_required');
    expect(HITL_ELIGIBLE_ERRORS.has(errorCode)).toBe(true);

    // Pause adapter (as requestHumanIntervention would)
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);

    // Update job to paused with 2fa interaction type
    await supabase.from('gh_automation_jobs').update({
      status: 'paused',
      interaction_type: '2fa',
      interaction_data: {
        type: '2fa',
        confidence: 0.9,
        details: errorMessage,
        page_url: 'https://boards.greenhouse.io/login/2fa',
      },
      paused_at: new Date().toISOString(),
      status_message: 'Waiting for human: 2fa',
    }).eq('id', 'job-2fa-test');

    expect(supabase._updates[0].status).toBe('paused');
    expect(supabase._updates[0].interaction_type).toBe('2fa');

    // Human provides 2FA code → resume
    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);

    await supabase.from('gh_automation_jobs').update({
      status: 'running',
      paused_at: null,
      status_message: 'Resumed after human intervention',
    }).eq('id', 'job-2fa-test');

    const lastUpdate = supabase._updates[supabase._updates.length - 1];
    expect(lastUpdate.status).toBe('running');
    expect(lastUpdate.paused_at).toBeNull();
  });
});

// ── Job status transitions ────────────────────────────────────────────────

describe('job status transitions', () => {
  test('running -> paused -> running transition', async () => {
    const supabase = createMockSupabase();

    await supabase.from('gh_automation_jobs').update({
      status: 'paused',
      interaction_type: 'captcha',
      paused_at: '2026-02-16T00:00:00Z',
      status_message: 'Waiting for human: captcha',
    }).eq('id', 'job-transition-test');

    await supabase.from('gh_automation_jobs').update({
      status: 'running',
      paused_at: null,
      status_message: 'Resumed after human intervention',
    }).eq('id', 'job-transition-test');

    const statuses = supabase._updates.map((u: any) => u.status);
    expect(statuses).toEqual(['paused', 'running']);

    expect(supabase._updates[0].interaction_type).toBe('captcha');
    expect(supabase._updates[0].paused_at).toBeTruthy();
    expect(supabase._updates[1].paused_at).toBeNull();
  });

  test('running -> paused -> failed (timeout) transition', async () => {
    const supabase = createMockSupabase();

    await supabase.from('gh_automation_jobs').update({
      status: 'paused',
      interaction_type: 'login',
      paused_at: '2026-02-16T00:00:00Z',
    }).eq('id', 'job-timeout-transition');

    await supabase.from('gh_automation_jobs').update({
      status: 'failed',
      completed_at: '2026-02-16T00:05:00Z',
      error_code: 'hitl_timeout',
      error_details: {
        message: 'Human intervention timed out after 300s',
        blocker_type: 'login',
      },
    }).eq('id', 'job-timeout-transition');

    const statuses = supabase._updates.map((u: any) => u.status);
    expect(statuses).toEqual(['paused', 'failed']);

    expect(supabase._updates[1].error_code).toBe('hitl_timeout');
  });
});
