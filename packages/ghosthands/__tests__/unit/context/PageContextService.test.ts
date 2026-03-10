import { describe, expect, it } from 'bun:test';
import { LivePageContextService } from '../../../src/context/PageContextService';
import { RedisPageContextStore } from '../../../src/context/RedisPageContextStore';
import type { ContextReport, PageContextSession } from '../../../src/context/types';

function createService() {
  const store = new RedisPageContextStore(null, 'job-service');
  const flusher = {
    async flush(session: PageContextSession): Promise<ContextReport> {
      return session.reportDraft;
    },
  } as any;

  return {
    store,
    service: new LivePageContextService('job-service', store, flusher),
  };
}

describe('LivePageContextService', () => {
  it('exposes the current session synchronously via getSessionSync()', async () => {
    const { service } = createService();
    expect(service.getSessionSync()).toBeNull();

    await service.initializeRun('run-service-0');

    const initialized = service.getSessionSync();
    expect(initialized).not.toBeNull();
    expect(initialized?.jobId).toBe('job-service');

    await service.enterOrResumePage({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'eligibility sponsorship visa',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    const session = service.getSessionSync();
    expect(session?.pages).toHaveLength(1);
    expect(session?.activePageId).toBe(session?.pages[0]?.pageId);
  });

  it('resumes the active page when the step key and fingerprint are similar', async () => {
    const { service, store } = createService();
    await service.initializeRun('run-service-1');

    await service.enterOrResumePage({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'eligibility sponsorship visa',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    await service.enterOrResumePage({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'eligibility visa sponsorship',
      pageStepKey: 'questions::eligibility',
      pageSequence: 2,
    });

    const session = await store.read('run-service-1');
    expect(session?.pages).toHaveLength(1);
    expect(session?.pages[0].visitCount).toBe(2);
    expect(session?.activePageId).toBe(session?.pages[0].pageId);
  });

  it('creates a new page when the same step key reappears with a dissimilar fingerprint', async () => {
    const { service, store } = createService();
    await service.initializeRun('run-service-2');

    await service.enterOrResumePage({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'eligibility sponsorship visa',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    await service.enterOrResumePage({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'portfolio github website links',
      pageStepKey: 'questions::eligibility',
      pageSequence: 2,
    });

    const session = await store.read('run-service-2');
    expect(session?.pages).toHaveLength(2);
    expect(session?.pages[0].status).toBe('completed');
    expect(session?.pages[1].status).toBe('active');
  });

  it('retains the flush error when markFlushPending is called', async () => {
    const { service } = createService();
    await service.initializeRun('run-service-3');

    await service.markFlushPending('redis timeout');

    const report = await service.getContextReport('pending');
    expect(report.flushError).toBe('redis timeout');
  });
});
