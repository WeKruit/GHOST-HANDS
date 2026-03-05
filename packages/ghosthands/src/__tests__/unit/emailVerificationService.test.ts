import { describe, expect, test } from 'bun:test';
import { GmailEmailVerificationService } from '../../workers/emailVerification/service.js';
import type { EmailProvider, VerificationSignal } from '../../workers/emailVerification/types.js';

class SequenceProvider implements EmailProvider {
  private index = 0;

  constructor(private readonly sequence: Array<VerificationSignal | null>) {}

  async findLatestVerificationSignal(_options: { loginEmail: string; lookbackMinutes: number }): Promise<VerificationSignal | null> {
    const next = this.sequence[this.index] ?? null;
    this.index += 1;
    return next;
  }
}

function createFakeAdapter() {
  const gotoCalls: string[] = [];
  let evaluateCalls = 0;

  const verificationPage = {
    goto: async (url: string) => {
      gotoCalls.push(url);
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    close: async () => {},
  };

  const page = {
    context: () => ({
      newPage: async () => verificationPage,
    }),
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => {
      evaluateCalls += 1;
      return { filled: true, submitted: true };
    },
    keyboard: {
      press: async () => {},
    },
  };

  return {
    adapter: {
      page,
    } as any,
    getGotoCalls: () => gotoCalls,
    getEvaluateCalls: () => evaluateCalls,
  };
}

describe('GmailEmailVerificationService', () => {
  test('follows verification link and redacts sensitive query params in result', async () => {
    const provider = new SequenceProvider([
      {
        kind: 'link',
        link: 'https://example.com/verify?token=abc123&foo=bar',
        messageId: 'm-1',
      },
    ]);
    const service = new GmailEmailVerificationService({
      provider,
      timeoutSeconds: 1,
      pollSeconds: 0.01,
      lookbackMinutes: 15,
    });

    const { adapter, getGotoCalls } = createFakeAdapter();
    const events: string[] = [];

    const result = await service.tryAutoVerify({
      adapter,
      loginEmail: 'test@example.com',
      onEvent: async (eventType) => {
        events.push(eventType);
      },
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('link');
    expect(result.redactedLink).toContain('token=REDACTED');
    expect(result.redactedLink).toContain('foo=bar');
    expect(getGotoCalls()[0]).toBe('https://example.com/verify?token=abc123&foo=bar');
    expect(events).toContain('email_verification_auto_started');
    expect(events).toContain('email_verification_email_found');
    expect(events).toContain('email_verification_link_clicked');
  });

  test('enters OTP code via DOM-first flow', async () => {
    const provider = new SequenceProvider([
      {
        kind: 'otp',
        code: '123456',
        messageId: 'm-2',
      },
    ]);
    const service = new GmailEmailVerificationService({
      provider,
      timeoutSeconds: 1,
      pollSeconds: 0.01,
      lookbackMinutes: 15,
    });

    const { adapter, getEvaluateCalls } = createFakeAdapter();

    const result = await service.tryAutoVerify({
      adapter,
      loginEmail: 'test@example.com',
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('otp');
    expect(getEvaluateCalls()).toBeGreaterThan(0);
  });

  test('returns timeout failure when no verification signal is found', async () => {
    const provider = new SequenceProvider([null, null, null, null]);
    const service = new GmailEmailVerificationService({
      provider,
      timeoutSeconds: 0.05,
      pollSeconds: 0.01,
      lookbackMinutes: 15,
    });

    const { adapter } = createFakeAdapter();
    const events: string[] = [];

    const result = await service.tryAutoVerify({
      adapter,
      loginEmail: 'test@example.com',
      onEvent: async (eventType) => {
        events.push(eventType);
      },
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('none');
    expect(result.reason).toBe('timeout');
    expect(events).toContain('email_verification_auto_failed');
  });
});
