import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { CallbackNotifier } from '../../../src/workers/callbackNotifier.js';

describe('VALET Status API — mode/cost fields', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('CallbackNotifier.notifyFromJob — mode fields', () => {
    let capturedPayload: any = null;
    let notifier: CallbackNotifier;

    beforeEach(() => {
      capturedPayload = null;
      notifier = new CallbackNotifier();
      globalThis.fetch = async (_url: string | URL | Request, init?: any) => {
        capturedPayload = JSON.parse(init.body);
        return new Response('OK', { status: 200 });
      };
    });

    test('includes execution_mode, browser_mode, final_mode when present', async () => {
      const result = await notifier.notifyFromJob({
        id: 'job-123',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: { applied: true },
        execution_mode: 'cookbook',
        browser_mode: 'local',
        final_mode: 'cookbook',
      });

      expect(result).toBe(true);
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.execution_mode).toBe('cookbook');
      expect(capturedPayload.browser_mode).toBe('local');
      expect(capturedPayload.final_mode).toBe('cookbook');
    });

    test('omits mode fields when not present (backward compatibility)', async () => {
      const result = await notifier.notifyFromJob({
        id: 'job-456',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: { applied: true },
      });

      expect(result).toBe(true);
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.execution_mode).toBeUndefined();
      expect(capturedPayload.browser_mode).toBeUndefined();
      expect(capturedPayload.final_mode).toBeUndefined();
      expect(capturedPayload.manual).toBeUndefined();
    });

    test('includes manual info when engine metadata has manual_id', async () => {
      const result = await notifier.notifyFromJob({
        id: 'job-789',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: { applied: true },
        execution_mode: 'hybrid',
        metadata: {
          engine: {
            manual_id: 'manual-abc',
            manual_status: 'cookbook_success',
            health_score: 95,
          },
        },
      });

      expect(result).toBe(true);
      expect(capturedPayload.manual).toEqual({
        id: 'manual-abc',
        status: 'cookbook_success',
        health_score: 95,
        fallback_reason: null,
      });
    });

    test('omits manual when engine metadata has no manual_id', async () => {
      const result = await notifier.notifyFromJob({
        id: 'job-no-manual',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: { applied: true },
        metadata: { engine: {} },
      });

      expect(result).toBe(true);
      expect(capturedPayload.manual).toBeUndefined();
    });

    test('includes manual with fallback_reason when present', async () => {
      await notifier.notifyFromJob({
        id: 'job-fallback',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: { applied: true },
        metadata: {
          engine: {
            manual_id: 'manual-def',
            manual_status: 'fallback_to_ai',
            health_score: 30,
            fallback_reason: 'health_score_below_threshold',
          },
        },
      });

      expect(capturedPayload.manual).toEqual({
        id: 'manual-def',
        status: 'fallback_to_ai',
        health_score: 30,
        fallback_reason: 'health_score_below_threshold',
      });
    });

    test('preserves existing cost field alongside new mode fields', async () => {
      await notifier.notifyFromJob({
        id: 'job-cost',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: { applied: true },
        llm_cost_cents: 250,
        action_count: 12,
        total_tokens: 5000,
        execution_mode: 'magnitude',
        browser_mode: 'server',
        final_mode: 'magnitude',
      });

      expect(capturedPayload.cost).toEqual({
        total_cost_usd: 2.5,
        action_count: 12,
        total_tokens: 5000,
      });
      expect(capturedPayload.execution_mode).toBe('magnitude');
      expect(capturedPayload.browser_mode).toBe('server');
      expect(capturedPayload.final_mode).toBe('magnitude');
    });

    test('returns false when no callback_url', async () => {
      const result = await notifier.notifyFromJob({
        id: 'job-no-cb',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(capturedPayload).toBeNull();
    });

    test('handles metadata without engine key gracefully', async () => {
      await notifier.notifyFromJob({
        id: 'job-no-engine',
        callback_url: 'https://example.com/callback',
        status: 'completed',
        result_data: {},
        metadata: { source: 'valet' },
      });

      expect(capturedPayload.manual).toBeUndefined();
    });
  });
});
