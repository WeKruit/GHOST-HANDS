import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountCreationEvent,
  GeneratedPlatformCredential,
} from './taskHandlers/platforms/accountCredentials.js';
import { normalizeValetPlatformCredentialDomain } from '../db/valetCredentialEncryption.js';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'platform-credential-store' });

type PersistCredentialPayload = {
  job_id?: string;
  valet_task_id?: string | null;
  valet_user_id: string;
  source_url?: string | null;
  reason?: string;
  generated_platform_credentials: GeneratedPlatformCredential[];
  account_creation_events?: AccountCreationEvent[];
};

export interface PersistGeneratedCredentialInput {
  userId: string;
  credential: GeneratedPlatformCredential;
  event?: AccountCreationEvent | null;
  jobId?: string;
  supabase?: SupabaseClient;
  sourceUrl?: string | null;
  reason?: string;
}

function resolveValetWebhookUrl(): string {
  const baseUrl =
    process.env.VALET_API_URL?.trim() ||
    process.env.API_URL?.trim() ||
    'http://localhost:8000';
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/webhooks/ghosthands`;
}

function normalizeCredential(
  credential: GeneratedPlatformCredential,
  sourceUrl?: string | null,
): GeneratedPlatformCredential {
  return {
    ...credential,
    domain: normalizeValetPlatformCredentialDomain(credential.domain ?? sourceUrl ?? null),
  };
}

function normalizeEvent(event: AccountCreationEvent, sourceUrl?: string | null): AccountCreationEvent {
  return {
    ...event,
    domain: normalizeValetPlatformCredentialDomain(event.domain ?? sourceUrl ?? null),
  };
}

async function postGeneratedCredentials(payload: PersistCredentialPayload): Promise<boolean> {
  const serviceSecret = process.env.GH_SERVICE_SECRET?.trim();
  if (!serviceSecret) {
    logger.error('Skipping generated credential persistence — GH_SERVICE_SECRET is missing', {
      jobId: payload.job_id,
      userId: payload.valet_user_id,
    });
    return false;
  }

  const callbackUrl = resolveValetWebhookUrl();
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GhostHands-GeneratedCredentialSync/1.0',
        'X-GH-Service-Key': serviceSecret,
      },
      body: JSON.stringify({
        job_id: payload.job_id ?? `generated-credentials-${Date.now()}`,
        valet_task_id: payload.valet_task_id ?? null,
        valet_user_id: payload.valet_user_id,
        status: 'running',
        source_url: payload.source_url ?? null,
        reason: payload.reason ?? null,
        generated_platform_credentials: payload.generated_platform_credentials,
        account_creation_events: payload.account_creation_events ?? [],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('Generated credential sync returned non-OK status', {
        jobId: payload.job_id,
        userId: payload.valet_user_id,
        status: response.status,
        body,
      });
      return false;
    }

    logger.info('Generated credential sync sent to VALET webhook', {
      jobId: payload.job_id,
      userId: payload.valet_user_id,
      count: payload.generated_platform_credentials.length,
      callbackUrl,
    });
    return true;
  } catch (error) {
    logger.warn('Generated credential sync request failed', {
      jobId: payload.job_id,
      userId: payload.valet_user_id,
      callbackUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function persistGeneratedPlatformCredential(
  input: PersistGeneratedCredentialInput,
): Promise<boolean> {
  if (!input.userId || !input.credential.platform || !input.credential.loginIdentifier || !input.credential.secret) {
    logger.warn('Skipping generated credential persistence — incomplete credential payload', {
      jobId: input.jobId,
      userId: input.userId,
      platform: input.credential.platform,
    });
    return false;
  }

  return postGeneratedCredentials({
    job_id: input.jobId,
    valet_user_id: input.userId,
    source_url: input.sourceUrl ?? null,
    reason: input.reason,
    generated_platform_credentials: [normalizeCredential(input.credential, input.sourceUrl ?? input.event?.domain ?? null)],
    account_creation_events: input.event ? [normalizeEvent(input.event, input.sourceUrl)] : [],
  });
}

export async function persistGeneratedPlatformCredentials(
  input: {
    userId: string;
    credentials: GeneratedPlatformCredential[];
    events?: AccountCreationEvent[];
    jobId?: string;
    supabase?: SupabaseClient;
    sourceUrl?: string | null;
    reason?: string;
  },
): Promise<number> {
  const credentials = input.credentials
    .filter(
      (credential) =>
        credential &&
        typeof credential.platform === 'string' &&
        typeof credential.loginIdentifier === 'string' &&
        typeof credential.secret === 'string',
    )
    .map((credential) => normalizeCredential(credential, input.sourceUrl));

  if (credentials.length === 0) return 0;

  const events = (input.events ?? []).map((event) => normalizeEvent(event, input.sourceUrl));
  const ok = await postGeneratedCredentials({
    job_id: input.jobId,
    valet_user_id: input.userId,
    source_url: input.sourceUrl ?? null,
    reason: input.reason,
    generated_platform_credentials: credentials,
    account_creation_events: events,
  });
  return ok ? credentials.length : 0;
}
