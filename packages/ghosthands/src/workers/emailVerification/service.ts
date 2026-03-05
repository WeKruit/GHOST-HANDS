import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import { MissingEmailConnectionError, TokenRefreshFailedError } from './errors.js';
import { GmailApiProvider } from './gmailApiProvider.js';
import { getGoogleOAuthConfigFromEnv } from './googleOAuth.js';
import { createEmailTokenEncryptionFromEnv, GmailConnectionStore } from './tokenStore.js';
import type { AutoVerifyOptions, EmailProvider, EmailVerificationService, VerificationResult } from './types.js';

export interface GmailEmailVerificationServiceOptions {
  provider: EmailProvider;
  timeoutSeconds: number;
  pollSeconds: number;
  lookbackMinutes: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_POLL_SECONDS = 5;
const DEFAULT_LOOKBACK_MINUTES = 15;

export class GmailEmailVerificationService implements EmailVerificationService {
  private readonly provider: EmailProvider;
  private readonly timeoutSeconds: number;
  private readonly pollSeconds: number;
  private readonly lookbackMinutes: number;

  constructor(options: GmailEmailVerificationServiceOptions) {
    this.provider = options.provider;
    this.timeoutSeconds = options.timeoutSeconds;
    this.pollSeconds = options.pollSeconds;
    this.lookbackMinutes = options.lookbackMinutes;
  }

  async tryAutoVerify(options: AutoVerifyOptions): Promise<VerificationResult> {
    const timeoutSeconds = options.timeoutSeconds ?? this.timeoutSeconds;
    const pollSeconds = options.pollSeconds ?? this.pollSeconds;
    const lookbackMinutes = options.lookbackMinutes ?? this.lookbackMinutes;

    await emitEvent(options, 'email_verification_auto_started', {
      page_url: options.pageUrl || '',
      timeout_seconds: timeoutSeconds,
      poll_seconds: pollSeconds,
      lookback_minutes: lookbackMinutes,
      mailbox_email: options.loginEmail,
    });

    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      try {
        const signal = await this.provider.findLatestVerificationSignal({
          loginEmail: options.loginEmail,
          lookbackMinutes,
        });

        if (signal) {
          await emitEvent(options, 'email_verification_email_found', {
            signal_kind: signal.kind,
            message_id: signal.messageId || null,
            subject: signal.subject || '',
            from: signal.from || '',
            received_at: signal.receivedAt || null,
          });

          if (signal.kind === 'link' && signal.link) {
            const redacted = redactSensitiveUrl(signal.link);
            await this.openVerificationLink(options.adapter, signal.link);

            await emitEvent(options, 'email_verification_link_clicked', {
              message_id: signal.messageId || null,
              redacted_link: redacted,
            });

            return {
              success: true,
              method: 'link',
              signal,
              redactedLink: redacted,
            };
          }

          if (signal.kind === 'otp' && signal.code) {
            const entered = await this.enterVerificationCode(options.adapter, signal.code);
            if (entered) {
              await emitEvent(options, 'email_verification_code_entered', {
                message_id: signal.messageId || null,
                code_length: signal.code.length,
              });

              return {
                success: true,
                method: 'otp',
                signal,
              };
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = classifyProviderError(err);
        await emitEvent(options, 'email_verification_auto_failed', {
          reason,
          error: message,
        });

        return {
          success: false,
          method: 'none',
          reason,
        };
      }

      await sleep(pollSeconds * 1000);
    }

    await emitEvent(options, 'email_verification_auto_failed', {
      reason: 'timeout',
      timeout_seconds: timeoutSeconds,
      elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
    });

    return {
      success: false,
      method: 'none',
      reason: 'timeout',
    };
  }

  async close(): Promise<void> {
    await this.provider.close?.();
  }

  private async openVerificationLink(adapter: BrowserAutomationAdapter, link: string): Promise<void> {
    const originalPage = adapter.page;
    const verificationPage = await originalPage.context().newPage();

    try {
      await verificationPage.goto(link, { waitUntil: 'domcontentloaded' });
      await verificationPage.waitForTimeout(3000);
      await verificationPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    } finally {
      try {
        await verificationPage.close();
      } catch {
        // Ignore close errors.
      }
      await originalPage.bringToFront().catch(() => {});
    }

    await originalPage.waitForTimeout(500);
  }

  private async enterVerificationCode(adapter: BrowserAutomationAdapter, code: string): Promise<boolean> {
    const fillResult = await adapter.page.evaluate((otp: string) => {
      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!el) return false;
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
      )).filter((input) => isVisible(input) && !input.disabled);

      const prioritized = inputs.find((input) => {
        const attrs = [
          input.name,
          input.id,
          input.getAttribute('autocomplete') || '',
          input.getAttribute('aria-label') || '',
          input.placeholder,
        ].join(' ').toLowerCase();
        return /(code|otp|verification|security|confirm|pin)/i.test(attrs);
      }) || inputs[0];

      if (!prioritized) return { filled: false, submitted: false };

      prioritized.focus();
      prioritized.value = otp;
      prioritized.dispatchEvent(new Event('input', { bubbles: true }));
      prioritized.dispatchEvent(new Event('change', { bubbles: true }));

      const submitTexts = ['verify', 'continue', 'submit', 'next', 'confirm'];
      const buttons = document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]');
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const label = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim().toLowerCase();
        if (submitTexts.some((text) => label === text || label.includes(text))) {
          btn.click();
          return { filled: true, submitted: true };
        }
      }

      const form = prioritized.closest('form');
      if (form) {
        form.requestSubmit();
        return { filled: true, submitted: true };
      }

      return { filled: true, submitted: false };
    }, code);

    if (!fillResult.filled) {
      return false;
    }

    if (!fillResult.submitted) {
      await adapter.page.keyboard.press('Enter').catch(() => {});
    }

    await adapter.page.waitForTimeout(1500);
    return true;
  }
}

export function createEmailVerificationServiceFromEnv(options: {
  supabase: SupabaseClient;
  userId: string;
}): EmailVerificationService | null {
  if (process.env.GH_EMAIL_AUTOMATION_ENABLED !== 'true') {
    return null;
  }

  const provider = (process.env.GH_EMAIL_PROVIDER || 'gmail_api').toLowerCase();
  if (provider !== 'gmail_api') {
    return null;
  }

  const timeoutSeconds = parseNumberEnv(process.env.GH_GMAIL_VERIFICATION_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS);
  const pollSeconds = parseNumberEnv(process.env.GH_GMAIL_VERIFICATION_POLL_SECONDS, DEFAULT_POLL_SECONDS);
  const lookbackMinutes = parseNumberEnv(process.env.GH_GMAIL_VERIFICATION_LOOKBACK_MINUTES, DEFAULT_LOOKBACK_MINUTES);

  const oauthConfig = getGoogleOAuthConfigFromEnv();
  const tokenEncryption = createEmailTokenEncryptionFromEnv();
  const tokenStore = new GmailConnectionStore({
    supabase: options.supabase,
    encryption: tokenEncryption,
  });
  const providerClient = new GmailApiProvider({
    userId: options.userId,
    tokenStore,
    oauthConfig: {
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
    },
  });

  return new GmailEmailVerificationService({
    provider: providerClient,
    timeoutSeconds,
    pollSeconds,
    lookbackMinutes,
  });
}

function parseNumberEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function classifyProviderError(error: unknown): string {
  if (error instanceof MissingEmailConnectionError) {
    return 'missing_connection';
  }
  if (error instanceof TokenRefreshFailedError) {
    return 'token_refresh_failed';
  }
  return 'provider_error';
}

function redactSensitiveUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (/(token|code|otp|key|sig|signature|auth|state|session|id_token|access_token|refresh_token)/i.test(key)) {
        parsed.searchParams.set(key, 'REDACTED');
      }
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function emitEvent(options: AutoVerifyOptions, eventType: string, metadata: Record<string, unknown>): Promise<void> {
  if (!options.onEvent) return;
  try {
    await options.onEvent(eventType, metadata);
  } catch {
    // Event logging is best effort.
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
