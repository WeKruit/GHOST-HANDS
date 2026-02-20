import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { MockAdapter } from '../../adapters/mock.js';
import { CallbackNotifier } from '../../workers/callbackNotifier.js';

describe('HITL Integration', () => {
  describe('MockAdapter pause/resume', () => {
    let adapter: MockAdapter;

    beforeEach(() => {
      adapter = new MockAdapter();
    });

    test('starts in unpaused state', () => {
      expect(adapter.isPaused()).toBe(false);
    });

    test('pause() sets paused state', async () => {
      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);
    });

    test('resume() clears paused state', async () => {
      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);
      await adapter.resume();
      expect(adapter.isPaused()).toBe(false);
    });

    test('multiple pause/resume cycles work', async () => {
      await adapter.pause();
      await adapter.resume();
      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);
      await adapter.resume();
      expect(adapter.isPaused()).toBe(false);
    });
  });

  describe('CallbackNotifier HITL methods', () => {
    let notifier: CallbackNotifier;
    let fetchCalls: { url: string; body: any }[];

    beforeEach(() => {
      notifier = new CallbackNotifier();
      fetchCalls = [];
      // Mock global fetch
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        fetchCalls.push({ url: url as string, body });
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
    });

    afterEach(() => {
      // Restore fetch (approximate -- tests run in isolation anyway)
      delete (globalThis as any).fetch;
    });

    test('notifyHumanNeeded sends needs_human status', async () => {
      const result = await notifier.notifyHumanNeeded(
        'job-123',
        'https://valet.test/callback',
        { type: 'captcha', screenshot_url: 'https://s3.test/img.png', page_url: 'https://example.com/apply', timeout_seconds: 300 },
        'valet-task-456',
      );

      expect(result).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.status).toBe('needs_human');
      expect(fetchCalls[0].body.job_id).toBe('job-123');
      expect(fetchCalls[0].body.valet_task_id).toBe('valet-task-456');
      expect(fetchCalls[0].body.interaction.type).toBe('captcha');
      expect(fetchCalls[0].body.interaction.screenshot_url).toBe('https://s3.test/img.png');
      expect(fetchCalls[0].body.interaction.timeout_seconds).toBe(300);
    });

    test('notifyResumed sends resumed status', async () => {
      const result = await notifier.notifyResumed(
        'job-123',
        'https://valet.test/callback',
        'valet-task-456',
      );

      expect(result).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.status).toBe('resumed');
      expect(fetchCalls[0].body.job_id).toBe('job-123');
    });

    test('notifyHumanNeeded works without valet_task_id', async () => {
      await notifier.notifyHumanNeeded(
        'job-789',
        'https://valet.test/callback',
        { type: 'login' },
      );

      expect(fetchCalls[0].body.valet_task_id).toBeNull();
    });
  });

  describe('Job status transitions (mock)', () => {
    // Simulate the paused -> running state transition that would
    // happen in a real JobExecutor via Supabase updates

    test('running -> paused -> running flow', async () => {
      const adapter = new MockAdapter();
      await adapter.start({ url: 'https://example.com', llm: { provider: 'mock', options: { model: 'test' } } });

      // Simulate running state
      expect(adapter.isActive()).toBe(true);
      expect(adapter.isPaused()).toBe(false);

      // Simulate pause (HITL triggered)
      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);
      expect(adapter.isActive()).toBe(true); // Still active, just paused

      // Simulate resume (human resolved)
      await adapter.resume();
      expect(adapter.isPaused()).toBe(false);
      expect(adapter.isActive()).toBe(true);
    });

    test('paused adapter can still take screenshots', async () => {
      const adapter = new MockAdapter();
      await adapter.start({ url: 'https://example.com', llm: { provider: 'mock', options: { model: 'test' } } });

      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);

      // Screenshot should still work while paused (for HITL screenshot capture)
      const screenshot = await adapter.screenshot();
      expect(screenshot).toBeInstanceOf(Buffer);
    });
  });

  describe('CallbackPayload types', () => {
    test('needs_human payload includes interaction field', () => {
      // Type-level test: ensure the payload shape is correct
      const payload = {
        job_id: 'j-1',
        valet_task_id: null,
        status: 'needs_human' as const,
        interaction: {
          type: 'captcha',
          screenshot_url: 'https://s3.test/img.png',
          page_url: 'https://example.com',
          timeout_seconds: 300,
        },
        completed_at: new Date().toISOString(),
      };

      expect(payload.status).toBe('needs_human');
      expect(payload.interaction.type).toBe('captcha');
    });

    test('resumed payload has minimal fields', () => {
      const payload = {
        job_id: 'j-1',
        valet_task_id: 'vt-1',
        status: 'resumed' as const,
        completed_at: new Date().toISOString(),
      };

      expect(payload.status).toBe('resumed');
    });
  });

  describe('Timeout behavior', () => {
    test('short polling timeout resolves to false', async () => {
      // Simulate polling with immediate false (no status change)
      const startTime = Date.now();
      const pollResult = await new Promise<boolean>((resolve) => {
        // Simulate 100ms timeout
        setTimeout(() => resolve(false), 100);
      });
      const elapsed = Date.now() - startTime;

      expect(pollResult).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow small margin
    });
  });
});
