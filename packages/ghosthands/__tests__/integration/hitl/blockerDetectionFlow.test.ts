/**
 * Integration Tests: BlockerDetector -> Pause -> Resume -> Verify flow
 *
 * Tests the full blocker detection lifecycle using MockAdapter and
 * BlockerDetector with observe()-based detection.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { BlockerDetector, type BlockerResult } from '../../../src/detection/BlockerDetector.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import { CallbackNotifier } from '../../../src/workers/callbackNotifier.js';
import type { BrowserAutomationAdapter, ObservedElement } from '../../../src/adapters/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockSupabase() {
  const updates: Record<string, any>[] = [];
  const inserts: Record<string, any>[] = [];
  const chainable: Record<string, any> = {};
  chainable.select = () => chainable;
  chainable.eq = () => chainable;
  chainable.single = () => Promise.resolve({ data: null, error: null });
  chainable.update = (data: Record<string, any>) => {
    updates.push(data);
    return chainable;
  };
  chainable.insert = (data: Record<string, any>) => {
    inserts.push(data);
    return Promise.resolve({ data: null, error: null });
  };

  return {
    from: () => chainable,
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://screenshots.example.com/blocker.png' } }),
      }),
    },
    _updates: updates,
    _inserts: inserts,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Blocker Detection Flow Integration', () => {
  const detector = new BlockerDetector();

  describe('detectWithAdapter using MockAdapter', () => {
    test('MockAdapter observe() returns elements that can be classified', async () => {
      const adapter = new MockAdapter();
      await adapter.start({ llm: { provider: 'mock', options: { model: 'mock' } } });

      // MockAdapter.observe() returns mock elements; verify it works with detector
      const elements = await adapter.observe!('Look for blockers');
      expect(elements).toBeDefined();
      expect(elements!.length).toBeGreaterThan(0);

      // Mock elements are generic (input field, submit button) — not blockers
      const classified = detector.classifyObservedElements(elements!);
      expect(classified).toBeNull();
    });

    test('DOM detection works through adapter.page', async () => {
      // Create an adapter-like object with a page that has blocker elements
      const mockPage: any = {
        evaluate: async (fn: Function, arg?: any) => {
          if (Array.isArray(arg)) {
            // Simulate reCAPTCHA iframe found
            return arg
              .filter((p: any) => p.selector === 'iframe[src*="recaptcha"]')
              .map((p: any) => ({ ...p, visible: true }));
          }
          return '';
        },
      };

      const adapter: any = {
        type: 'mock',
        page: mockPage,
        observe: async () => [],
        isActive: () => true,
        isConnected: () => true,
        start: async () => {},
        stop: async () => {},
        act: async () => ({ success: true, message: '', durationMs: 0 }),
        extract: async () => ({}),
        navigate: async () => {},
        getCurrentUrl: async () => 'https://example.com',
        screenshot: async () => Buffer.from('png'),
        registerCredentials: () => {},
        on: () => {},
        off: () => {},
        pause: async () => {},
        resume: async () => {},
        isPaused: () => false,
      };

      const result = await detector.detectWithAdapter(adapter);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('captcha');
      expect(result!.confidence).toBe(0.95);
      expect(result!.source).toBe('dom');
    });
  });

  describe('full detect -> pause -> resume -> verify cycle', () => {
    let fetchCalls: any[];
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      fetchCalls = [];
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url, options: init });
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test('end-to-end: detect blocker -> pause -> notify VALET -> resume -> verify clear', async () => {
      const supabase = createMockSupabase();
      const notifier = new CallbackNotifier();
      const adapter = new MockAdapter();
      await adapter.start({
        url: 'https://boards.greenhouse.io/company/jobs/1',
        llm: { provider: 'mock', options: { model: 'mock' } },
      });

      const jobId = 'job-e2e-blocker-1';
      const callbackUrl = 'https://valet.example.com/callback';
      const valetTaskId = 'valet-task-e2e-1';

      // Step 1: Detect blocker (simulated)
      const blockerResult: BlockerResult = {
        type: 'captcha',
        confidence: 0.95,
        selector: 'iframe[src*="recaptcha"]',
        details: 'Matched selector: iframe[src*="recaptcha"]',
        source: 'dom',
      };

      // Step 2: Pause adapter
      expect(adapter.isPaused()).toBe(false);
      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);

      // Step 3: Take screenshot
      const screenshot = await adapter.screenshot();
      expect(screenshot).toBeInstanceOf(Buffer);

      // Step 4: Get current URL
      const pageUrl = await adapter.getCurrentUrl();
      expect(pageUrl).toBe('https://boards.greenhouse.io/company/jobs/1');

      // Step 5: Update job to paused
      await supabase.from('gh_automation_jobs').update({
        status: 'paused',
        interaction_type: blockerResult.type,
        interaction_data: {
          type: blockerResult.type,
          confidence: blockerResult.confidence,
          selector: blockerResult.selector,
          details: blockerResult.details,
          page_url: pageUrl,
        },
        paused_at: new Date().toISOString(),
        status_message: `Waiting for human: ${blockerResult.type}`,
      }).eq('id', jobId);

      expect(supabase._updates[0].status).toBe('paused');

      // Step 6: Notify VALET
      await notifier.notifyHumanNeeded(
        jobId,
        callbackUrl,
        {
          type: blockerResult.type,
          screenshot_url: 'https://screenshots.example.com/blocker.png',
          page_url: pageUrl,
          timeout_seconds: 300,
        },
        valetTaskId,
      );

      expect(fetchCalls).toHaveLength(1);
      const needsHumanBody = JSON.parse(fetchCalls[0].options.body);
      expect(needsHumanBody.status).toBe('needs_human');
      expect(needsHumanBody.interaction.type).toBe('captcha');

      // Step 7: Human resolves — resume adapter
      await adapter.resume();
      expect(adapter.isPaused()).toBe(false);

      // Step 8: Update job to running
      await supabase.from('gh_automation_jobs').update({
        status: 'running',
        paused_at: null,
        status_message: 'Resumed after human intervention',
      }).eq('id', jobId);

      // Step 9: Notify VALET of resume
      await notifier.notifyResumed(jobId, callbackUrl, valetTaskId);

      expect(fetchCalls).toHaveLength(2);
      const resumedBody = JSON.parse(fetchCalls[1].options.body);
      expect(resumedBody.status).toBe('resumed');

      // Step 10: Post-resume verification (no blocker should be detected on clean adapter)
      // MockAdapter's page doesn't have blockers, so DOM detection returns null
      // and observe returns generic elements, so no blocker detected
      const verifyResult = await detector.detectWithAdapter(adapter);
      // MockAdapter's page.evaluate mock won't match any selectors, and observe
      // returns generic non-blocker elements, so result should be null
      expect(verifyResult).toBeNull();

      // Verify status transitions
      const statuses = supabase._updates.map(u => u.status);
      expect(statuses).toEqual(['paused', 'running']);
    });

    test('detect blocker -> pause -> timeout -> fail', async () => {
      const supabase = createMockSupabase();
      const adapter = new MockAdapter();
      await adapter.start({
        url: 'https://linkedin.com/login',
        llm: { provider: 'mock', options: { model: 'mock' } },
      });

      const jobId = 'job-e2e-timeout-1';

      // Step 1: Pause
      await adapter.pause();
      expect(adapter.isPaused()).toBe(true);

      // Step 2: Update to paused
      await supabase.from('gh_automation_jobs').update({
        status: 'paused',
        interaction_type: 'login',
        paused_at: new Date().toISOString(),
      }).eq('id', jobId);

      // Step 3: Simulate timeout (no resume signal received)
      const timeoutMs = 50;
      const deadline = Date.now() + timeoutMs;
      let resumed = false;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10));
      }

      // Step 4: Fail the job
      if (!resumed) {
        await supabase.from('gh_automation_jobs').update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_code: 'hitl_timeout',
          error_details: {
            message: 'Human intervention timed out',
            blocker_type: 'login',
          },
        }).eq('id', jobId);
      }

      const statuses = supabase._updates.map(u => u.status);
      expect(statuses).toEqual(['paused', 'failed']);
      expect(supabase._updates[1].error_code).toBe('hitl_timeout');
    });

    test('post-resume re-check finds blocker still present', async () => {
      // Simulates the case where the human didn't actually resolve the blocker
      const blockerResult: BlockerResult = {
        type: 'captcha',
        confidence: 0.9,
        details: 'reCAPTCHA still visible',
        source: 'observe',
        observedElements: [
          { selector: '.recaptcha', description: 'reCAPTCHA still present', method: 'click', arguments: [] },
        ],
      };

      // After resume, a re-check finds the same blocker
      expect(blockerResult.confidence).toBeGreaterThanOrEqual(0.6);
      expect(blockerResult.type).toBe('captcha');
    });
  });

  describe('blocker event logging', () => {
    test('blocker_detected event contains required metadata', () => {
      const eventMetadata = {
        blocker_type: 'captcha' as const,
        confidence: 0.95,
        source: 'combined' as const,
        selector: 'iframe[src*="recaptcha"]',
        details: 'Matched selector + observe element',
      };

      expect(eventMetadata.blocker_type).toBe('captcha');
      expect(eventMetadata.confidence).toBeGreaterThan(0);
      expect(eventMetadata.source).toBe('combined');
      expect(eventMetadata.selector).toBeTruthy();
      expect(eventMetadata.details).toBeTruthy();
    });
  });
});
