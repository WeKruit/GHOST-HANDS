import type { BrowserAutomationAdapter } from '../../adapters/types.js';

export type VerificationSignalKind = 'link' | 'otp';

export interface VerificationSignal {
  kind: VerificationSignalKind;
  messageId?: string;
  subject?: string;
  from?: string;
  receivedAt?: string;
  link?: string;
  code?: string;
  rawText?: string;
}

export interface VerificationResult {
  success: boolean;
  method: 'link' | 'otp' | 'none';
  reason?: string;
  signal?: VerificationSignal;
  redactedLink?: string;
}

export interface EmailSearchOptions {
  loginEmail: string;
  lookbackMinutes: number;
}

export interface EmailProvider {
  findLatestVerificationSignal(options: EmailSearchOptions): Promise<VerificationSignal | null>;
  close?(): Promise<void>;
}

export interface AutoVerifyOptions {
  adapter: BrowserAutomationAdapter;
  loginEmail: string;
  pageUrl?: string;
  timeoutSeconds?: number;
  pollSeconds?: number;
  lookbackMinutes?: number;
  onEvent?: (eventType: string, metadata: Record<string, unknown>) => Promise<void> | void;
}

export interface EmailVerificationService {
  tryAutoVerify(options: AutoVerifyOptions): Promise<VerificationResult>;
  close?(): Promise<void>;
}
