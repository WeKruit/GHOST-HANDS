import {
  inferCredentialDomainFromUrl,
  inferCredentialPlatformFromUrl,
  type AccountCreationEvent,
  type GeneratedPlatformCredential,
} from './taskHandlers/platforms/accountCredentials.js';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'platform-auth-runtime' });

export type PlatformAuthMode =
  | 'none'
  | 'sign_in'
  | 'create_account'
  | 'verification'
  | 'authenticated';

export interface RuntimeResolvedCredential {
  platform: string;
  domain?: string | null;
  loginIdentifier: string;
  secret: string;
}

export interface PlatformAuthContext {
  platform: string;
  domain: string | null;
  authMode: PlatformAuthMode;
  credentialExists: boolean;
  existingCredential: RuntimeResolvedCredential | null;
  sharedApplicationPassword: string | null;
  generatedCredential: GeneratedPlatformCredential | null;
  accountCreationConfirmed: boolean;
  forceSignIn: boolean;
  lastAuthState: string | null;
}

type ResolvePlatformAuthContextInput = {
  userId: string;
  sourceUrl: string;
  platformHint?: string | null;
  runtimeBaseUrl?: string | null;
  callbackUrl?: string | null;
};

type UpsertGeneratedPlatformAuthCredentialInput = {
  userId: string;
  sourceUrl: string;
  credential: GeneratedPlatformCredential;
  accountCreationEvent?: AccountCreationEvent | null;
  runtimeBaseUrl?: string | null;
  callbackUrl?: string | null;
};

function deriveRuntimeBaseUrl(options?: {
  runtimeBaseUrl?: string | null;
  callbackUrl?: string | null;
}): string {
  const explicitBase =
    options?.runtimeBaseUrl?.trim() ||
    process.env.VALET_API_URL?.trim() ||
    process.env.API_URL?.trim();
  if (explicitBase) {
    return explicitBase.replace(/\/+$/, '');
  }

  const callbackUrl = options?.callbackUrl?.trim();
  if (callbackUrl) {
    try {
      const parsed = new URL(callbackUrl);
      return parsed.origin.replace(/\/+$/, '');
    } catch {
      // Fall through to localhost fallback below.
    }
  }

  return 'http://localhost:8000';
}

function resolveValetRuntimeUrl(
  path: string,
  options?: {
    runtimeBaseUrl?: string | null;
    callbackUrl?: string | null;
  },
): string {
  return `${deriveRuntimeBaseUrl(options)}${path}`;
}

function authContextKey(platform: string, domain: string | null): string {
  return `${platform.toLowerCase()}::${(domain ?? 'default').toLowerCase()}`;
}

function normalizePlatform(platformHint: string | null | undefined, sourceUrl: string): string {
  const detected = inferCredentialPlatformFromUrl(sourceUrl);
  if (detected) return detected;
  const hinted = (platformHint ?? '').trim().toLowerCase();
  if (!hinted || hinted === 'generic' || hinted === 'other' || hinted === 'unknown') {
    return 'unknown';
  }
  return hinted;
}

function normalizeDomain(domainOrUrl: string | null | undefined): string | null {
  return inferCredentialDomainFromUrl(domainOrUrl) ?? (typeof domainOrUrl === 'string' && domainOrUrl.trim()
    ? domainOrUrl.trim().toLowerCase()
    : null);
}

function getAuthContextStore(profile: Record<string, any>): Record<string, PlatformAuthContext> {
  const existing = profile._platformAuthContexts;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, PlatformAuthContext>;
  }
  const created: Record<string, PlatformAuthContext> = {};
  profile._platformAuthContexts = created;
  return created;
}

export function getPlatformAuthContext(
  profile: Record<string, any>,
  input: { sourceUrl?: string | null; platform?: string | null; domain?: string | null },
): PlatformAuthContext | null {
  const platform = normalizePlatform(input.platform ?? null, input.sourceUrl ?? '');
  const domain = normalizeDomain(input.domain ?? input.sourceUrl ?? null);
  const store = getAuthContextStore(profile);
  return store[authContextKey(platform, domain)] ?? null;
}

export function setPlatformAuthContext(
  profile: Record<string, any>,
  context: PlatformAuthContext,
): PlatformAuthContext {
  const normalized: PlatformAuthContext = {
    ...context,
    platform: normalizePlatform(context.platform, context.domain ?? ''),
    domain: normalizeDomain(context.domain),
  };
  const key = authContextKey(normalized.platform, normalized.domain);
  const store = getAuthContextStore(profile);
  store[key] = normalized;
  profile._platformAuthContextKey = key;
  return normalized;
}

export function applyPlatformCredentialToProfile(
  profile: Record<string, any>,
  credential: RuntimeResolvedCredential | GeneratedPlatformCredential | null | undefined,
  sharedApplicationPassword?: string | null,
): void {
  if (sharedApplicationPassword && typeof sharedApplicationPassword === 'string' && sharedApplicationPassword.trim()) {
    profile.application_password = sharedApplicationPassword.trim();
    profile.applicationPassword = sharedApplicationPassword.trim();
  }
  if (!credential) return;

  const platformKey = credential.platform;
  const domain = normalizeDomain(credential.domain ?? null);
  const platformCredentials =
    (profile.platform_credentials && typeof profile.platform_credentials === 'object' && !Array.isArray(profile.platform_credentials)
      ? profile.platform_credentials
      : {}) as Record<string, any>;
  const existingPlatformEntry =
    (platformCredentials[platformKey] && typeof platformCredentials[platformKey] === 'object' && !Array.isArray(platformCredentials[platformKey])
      ? platformCredentials[platformKey]
      : {}) as Record<string, any>;
  const scopedByDomain =
    (existingPlatformEntry.byDomain && typeof existingPlatformEntry.byDomain === 'object' && !Array.isArray(existingPlatformEntry.byDomain)
      ? existingPlatformEntry.byDomain
      : {}) as Record<string, any>;

  if (domain) {
    scopedByDomain[domain] = {
      domain,
      email: credential.loginIdentifier,
      loginIdentifier: credential.loginIdentifier,
      password: credential.secret,
      secret: credential.secret,
    };
  }

  platformCredentials[platformKey] = {
    ...existingPlatformEntry,
    email: credential.loginIdentifier,
    loginIdentifier: credential.loginIdentifier,
    password: credential.secret,
    secret: credential.secret,
    domain,
    ...(Object.keys(scopedByDomain).length > 0 ? { byDomain: scopedByDomain } : {}),
  };

  profile.platform_credentials = platformCredentials;
  profile.platformCredentials = platformCredentials;
  profile[`${platformKey}_email`] = credential.loginIdentifier;
  profile[`${platformKey}Email`] = credential.loginIdentifier;
  profile[`${platformKey}_password`] = credential.secret;
  profile[`${platformKey}Password`] = credential.secret;
}

export async function resolvePlatformAuthContext(
  input: ResolvePlatformAuthContextInput,
): Promise<PlatformAuthContext | null> {
  const serviceSecret = process.env.GH_SERVICE_SECRET?.trim();
  if (!serviceSecret) {
    logger.warn('Skipping runtime auth resolve — GH_SERVICE_SECRET is missing', {
      userId: input.userId,
      sourceUrl: input.sourceUrl,
    });
    return null;
  }

  const runtimeUrl = resolveValetRuntimeUrl('/api/v1/ghosthands/runtime/auth-context/resolve', {
    runtimeBaseUrl: input.runtimeBaseUrl,
    callbackUrl: input.callbackUrl,
  });
  try {
    const response = await fetch(runtimeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GhostHands-RuntimeAuth/1.0',
        'X-GH-Service-Key': serviceSecret,
      },
      body: JSON.stringify({
        userId: input.userId,
        sourceUrl: input.sourceUrl,
        platformHint: input.platformHint ?? null,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('Runtime auth resolve returned non-OK status', {
        userId: input.userId,
        sourceUrl: input.sourceUrl,
        status: response.status,
        body,
      });
      return null;
    }

    const payload = await response.json() as {
      platform: string;
      domain: string | null;
      credentialExists: boolean;
      credential: RuntimeResolvedCredential | null;
      sharedApplicationPassword: string | null;
      authMode: PlatformAuthMode;
    };

    return {
      platform: normalizePlatform(payload.platform, input.sourceUrl),
      domain: normalizeDomain(payload.domain ?? input.sourceUrl),
      authMode: payload.authMode,
      credentialExists: Boolean(payload.credentialExists),
      existingCredential: payload.credential,
      sharedApplicationPassword:
        typeof payload.sharedApplicationPassword === 'string' && payload.sharedApplicationPassword.trim()
          ? payload.sharedApplicationPassword.trim()
          : null,
      generatedCredential: null,
      accountCreationConfirmed: false,
      forceSignIn: false,
      lastAuthState: null,
    };
  } catch (error) {
    logger.warn('Runtime auth resolve request failed', {
      userId: input.userId,
      sourceUrl: input.sourceUrl,
      runtimeUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function upsertGeneratedPlatformCredentialRuntime(
  input: UpsertGeneratedPlatformAuthCredentialInput,
): Promise<boolean> {
  const serviceSecret = process.env.GH_SERVICE_SECRET?.trim();
  if (!serviceSecret) {
    logger.warn('Skipping runtime generated credential upsert — GH_SERVICE_SECRET is missing', {
      userId: input.userId,
      sourceUrl: input.sourceUrl,
      platform: input.credential.platform,
    });
    return false;
  }

  const runtimeUrl = resolveValetRuntimeUrl('/api/v1/ghosthands/runtime/platform-credentials/upsert-generated', {
    runtimeBaseUrl: input.runtimeBaseUrl,
    callbackUrl: input.callbackUrl,
  });
  try {
    const response = await fetch(runtimeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GhostHands-RuntimeAuth/1.0',
        'X-GH-Service-Key': serviceSecret,
      },
      body: JSON.stringify({
        userId: input.userId,
        sourceUrl: input.sourceUrl,
        credential: {
          ...input.credential,
          domain: normalizeDomain(input.credential.domain ?? input.sourceUrl),
        },
        accountCreationEvent: input.accountCreationEvent ?? null,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('Runtime generated credential upsert returned non-OK status', {
        userId: input.userId,
        sourceUrl: input.sourceUrl,
        status: response.status,
        body,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn('Runtime generated credential upsert request failed', {
      userId: input.userId,
      sourceUrl: input.sourceUrl,
      runtimeUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
