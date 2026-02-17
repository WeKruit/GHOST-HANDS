import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { JOB_EVENT_TYPES, ThoughtThrottle } from '../../../src/events/JobEventTypes';
import type { TokenUsage } from '../../../src/adapters/types';

/**
 * Integration tests for event logging — verifies that adapter events
 * (thought, tokensUsed, actionStarted, actionDone) result in correct
 * gh_job_events inserts via the logJobEvent pattern.
 *
 * Uses a mock adapter with EventEmitter-style on/off and a mock supabase
 * that captures all inserts to gh_job_events.
 */

// ── Mock adapter with EventEmitter ──────────────────────────────────────

class MockAdapter {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter((h) => h !== handler));
  }

  emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event) || [];
    for (const handler of list) {
      handler(...args);
    }
  }
}

// ── Mock supabase that captures inserts ─────────────────────────────────

function createMockSupabase() {
  const inserted: Array<{ table: string; data: any }> = [];

  const insertMock = mock((data: any) => {
    inserted.push({ table: 'gh_job_events', data });
    return Promise.resolve({ error: null });
  });

  return {
    inserted,
    from: (table: string) => ({
      insert: (data: any) => {
        inserted.push({ table, data });
        return Promise.resolve({ error: null });
      },
    }),
  };
}

// ── Test: adapter events → logJobEvent → gh_job_events ──────────────────

describe('Event logging integration', () => {
  let adapter: MockAdapter;
  let supabase: ReturnType<typeof createMockSupabase>;
  let thoughtThrottle: ThoughtThrottle;

  // Simulate the logJobEvent function from JobExecutor
  const workerId = 'test-worker-1';
  const jobId = 'job-abc-123';

  async function logJobEvent(
    jobId: string,
    eventType: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await supabase.from('gh_job_events').insert({
        job_id: jobId,
        event_type: eventType,
        metadata: metadata || {},
        actor: workerId,
      });
    } catch {
      // Matches JobExecutor behavior: swallow errors
    }
  }

  beforeEach(() => {
    adapter = new MockAdapter();
    supabase = createMockSupabase();
    thoughtThrottle = new ThoughtThrottle(2000);

    // Wire handlers exactly as JobExecutor does
    adapter.on('thought', (thought: string) => {
      if (thoughtThrottle.shouldEmit()) {
        logJobEvent(jobId, JOB_EVENT_TYPES.THOUGHT, {
          content: thought.slice(0, 500),
        });
      }
    });

    adapter.on('actionStarted', (action: { variant: string }) => {
      logJobEvent(jobId, JOB_EVENT_TYPES.STEP_STARTED, {
        action: action.variant,
      });
    });

    adapter.on('actionDone', (action: { variant: string }) => {
      logJobEvent(jobId, JOB_EVENT_TYPES.STEP_COMPLETED, {
        action: action.variant,
      });
    });

    adapter.on('tokensUsed', (usage: TokenUsage) => {
      logJobEvent(jobId, JOB_EVENT_TYPES.TOKENS_USED, {
        model: (usage as any).model || 'unknown',
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cost_usd: usage.inputCost + usage.outputCost,
      });
    });
  });

  test('thought event is logged to gh_job_events', () => {
    adapter.emit('thought', 'I need to click the submit button');

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.THOUGHT,
    );
    expect(events).toHaveLength(1);
    expect(events[0].data.job_id).toBe(jobId);
    expect(events[0].data.metadata.content).toBe('I need to click the submit button');
    expect(events[0].data.actor).toBe(workerId);
  });

  test('thought content is truncated to 500 chars', () => {
    const longThought = 'x'.repeat(1000);
    adapter.emit('thought', longThought);

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.THOUGHT,
    );
    expect(events).toHaveLength(1);
    expect(events[0].data.metadata.content.length).toBe(500);
  });

  test('thought events are throttled — only 1 per interval', () => {
    adapter.emit('thought', 'thought 1');
    adapter.emit('thought', 'thought 2');
    adapter.emit('thought', 'thought 3');

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.THOUGHT,
    );
    // Only the first should get through (all within same tick)
    expect(events).toHaveLength(1);
    expect(events[0].data.metadata.content).toBe('thought 1');
  });

  test('thought events emit again after throttle interval', async () => {
    // Use a short throttle for this test
    thoughtThrottle = new ThoughtThrottle(30);
    // Re-wire with new throttle
    adapter = new MockAdapter();
    supabase = createMockSupabase();

    adapter.on('thought', (thought: string) => {
      if (thoughtThrottle.shouldEmit()) {
        logJobEvent(jobId, JOB_EVENT_TYPES.THOUGHT, {
          content: thought.slice(0, 500),
        });
      }
    });

    adapter.emit('thought', 'thought A');
    await new Promise((r) => setTimeout(r, 50));
    adapter.emit('thought', 'thought B');

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.THOUGHT,
    );
    expect(events).toHaveLength(2);
    expect(events[0].data.metadata.content).toBe('thought A');
    expect(events[1].data.metadata.content).toBe('thought B');
  });

  test('actionStarted event is logged as step_started', () => {
    adapter.emit('actionStarted', { variant: 'click' });

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.STEP_STARTED,
    );
    expect(events).toHaveLength(1);
    expect(events[0].data.metadata.action).toBe('click');
    expect(events[0].table).toBe('gh_job_events');
  });

  test('actionDone event is logged as step_completed', () => {
    adapter.emit('actionDone', { variant: 'type' });

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.STEP_COMPLETED,
    );
    expect(events).toHaveLength(1);
    expect(events[0].data.metadata.action).toBe('type');
  });

  test('tokensUsed event is logged with model and cost', () => {
    const usage: TokenUsage & { model: string } = {
      inputTokens: 1000,
      outputTokens: 200,
      inputCost: 0.003,
      outputCost: 0.006,
      model: 'deepseek-chat',
    };

    adapter.emit('tokensUsed', usage);

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.TOKENS_USED,
    );
    expect(events).toHaveLength(1);

    const meta = events[0].data.metadata;
    expect(meta.model).toBe('deepseek-chat');
    expect(meta.input_tokens).toBe(1000);
    expect(meta.output_tokens).toBe(200);
    expect(meta.cost_usd).toBeCloseTo(0.009, 6);
  });

  test('tokensUsed with no model defaults to unknown', () => {
    const usage: TokenUsage = {
      inputTokens: 500,
      outputTokens: 100,
      inputCost: 0.001,
      outputCost: 0.002,
    };

    adapter.emit('tokensUsed', usage);

    const events = supabase.inserted.filter(
      (e) => e.data.event_type === JOB_EVENT_TYPES.TOKENS_USED,
    );
    expect(events).toHaveLength(1);
    expect(events[0].data.metadata.model).toBe('unknown');
  });

  test('multiple event types are all logged independently', () => {
    adapter.emit('thought', 'analyzing page');
    adapter.emit('actionStarted', { variant: 'click' });
    adapter.emit('actionDone', { variant: 'click' });
    adapter.emit('tokensUsed', {
      inputTokens: 100,
      outputTokens: 50,
      inputCost: 0.001,
      outputCost: 0.002,
    });

    // 1 thought + 1 step_started + 1 step_completed + 1 tokens_used = 4
    expect(supabase.inserted).toHaveLength(4);

    const eventTypes = supabase.inserted.map((e) => e.data.event_type);
    expect(eventTypes).toContain(JOB_EVENT_TYPES.THOUGHT);
    expect(eventTypes).toContain(JOB_EVENT_TYPES.STEP_STARTED);
    expect(eventTypes).toContain(JOB_EVENT_TYPES.STEP_COMPLETED);
    expect(eventTypes).toContain(JOB_EVENT_TYPES.TOKENS_USED);
  });

  test('all events have correct job_id and actor', () => {
    adapter.emit('thought', 'checking form');
    adapter.emit('actionStarted', { variant: 'type' });

    for (const entry of supabase.inserted) {
      expect(entry.data.job_id).toBe(jobId);
      expect(entry.data.actor).toBe(workerId);
    }
  });
});

// ── CookbookExecutor step events ────────────────────────────────────────

describe('CookbookExecutor event logging', () => {
  test('logEvent callback receives cookbook step events', async () => {
    const { CookbookExecutor } = await import('../../../src/engine/CookbookExecutor');

    const events: Array<{ type: string; meta: any }> = [];
    const logEvent = mock(async (eventType: string, metadata: Record<string, any>) => {
      events.push({ type: eventType, meta: metadata });
    });

    const executor = new CookbookExecutor({ logEvent });

    // Create a mock page that will fail on locator resolution
    // (we just want to verify events are emitted, not full Playwright execution)
    const mockPage = {
      goto: mock(() => Promise.resolve()),
    } as any;

    const manual = {
      id: 'manual-1',
      steps: [
        { order: 0, action: 'navigate', value: 'https://example.com', locator: { css: 'body' }, healthScore: 1.0 },
      ],
      url_pattern: '*.example.com',
      task_pattern: 'test',
      platform: 'other',
      health_score: 0.9,
      source: 'recorded' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await executor.executeAll(mockPage, manual, {});

    expect(result.success).toBe(true);

    // Should have cookbook_step_started and cookbook_step_completed
    const stepStarted = events.filter((e) => e.type === 'cookbook_step_started');
    const stepCompleted = events.filter((e) => e.type === 'cookbook_step_completed');

    expect(stepStarted).toHaveLength(1);
    expect(stepCompleted).toHaveLength(1);

    expect(stepStarted[0].meta.step_index).toBe(0);
    expect(stepStarted[0].meta.action).toBe('navigate');
    expect(stepCompleted[0].meta.step_index).toBe(0);
  });
});

// ── StagehandObserver event logging ─────────────────────────────────────

describe('StagehandObserver logEvent config', () => {
  test('StagehandObserverConfig accepts logEvent callback', async () => {
    // Verify the type is accepted at construction (import check)
    const { StagehandObserver } = await import('../../../src/engine/StagehandObserver');

    const logEvent = mock(async (_type: string, _meta: Record<string, any>) => {});

    // Should not throw — logEvent is an optional config field
    const observer = new StagehandObserver({
      cdpUrl: 'ws://localhost:9222',
      model: 'test/model',
      logEvent,
    });

    expect(observer).toBeDefined();
    expect(observer.isInitialized()).toBe(false);
  });
});
