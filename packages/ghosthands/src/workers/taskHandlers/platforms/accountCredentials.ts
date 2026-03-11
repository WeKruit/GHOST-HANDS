import { randomBytes } from 'node:crypto';

type PasswordRequirements = {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
};

export type AccountPasswordSource =
  | 'platform_override'
  | 'shared_application_password'
  | 'profile_password'
  | 'env'
  | 'generated'
  | 'generated_platform_password';

export interface GeneratedPlatformCredential {
  platform: string;
  domain?: string | null;
  loginIdentifier: string;
  secret: string;
  source: 'generated_platform_password';
  requirements: string[];
}

export interface AccountCreationEvent {
  platform: string;
  domain?: string | null;
  loginIdentifier: string;
  action: 'generated_platform_password';
  passwordSource: AccountPasswordSource;
  requirements: string[];
  note: string;
}

const FALLBACK_PASSWORD = 'ValetApply!123';
const SPECIAL_CHARS = '!@#$%^&*';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeRequestedDomain(options?: {
  sourceUrl?: string | null;
  domain?: string | null;
}): string | null {
  if (!options) return null;
  const fromUrl = inferCredentialDomainFromUrl(options.sourceUrl);
  if (fromUrl) return fromUrl;
  if (typeof options.domain !== 'string') return null;
  const trimmed = options.domain.trim();
  if (!trimmed) return null;
  return inferCredentialDomainFromUrl(trimmed) ?? trimmed.toLowerCase();
}

function getPlatformOverride(
  profile: Record<string, unknown>,
  platform: string | null,
  options?: { sourceUrl?: string | null; domain?: string | null },
): Record<string, unknown> | null {
  if (!platform) return null;
  const snakeCaseKey = `${platform}_credentials`;
  const camelCaseKey = `${platform}Credentials`;
  const platformsRecord =
    asRecord(profile.platform_credentials) ??
    asRecord(profile.platformCredentials) ??
    asRecord(profile[snakeCaseKey]) ??
    asRecord(profile[camelCaseKey]);
  if (!platformsRecord) return null;
  const platformRecord = asRecord(platformsRecord[platform]) ?? platformsRecord;
  const normalizedDomain = normalizeRequestedDomain(options);
  if (!normalizedDomain) return platformRecord;
  const scopedByDomain = asRecord(platformRecord?.byDomain);
  const scopedOverride = scopedByDomain ? asRecord(scopedByDomain[normalizedDomain]) : null;
  if (!scopedOverride) return platformRecord;
  return {
    ...platformRecord,
    ...scopedOverride,
    domain: normalizedDomain,
  };
}

function inferDefaultRequirements(platform: string | null): PasswordRequirements {
  if (platform === 'workday') {
    return {
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSpecial: true,
    };
  }

  return {
    minLength: 10,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
  };
}

export function inferCredentialPlatformFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const normalized = url.toLowerCase();
  if (normalized.includes('myworkdayjobs.com') || normalized.includes('myworkday.com') || normalized.includes('workday.com')) {
    return 'workday';
  }
  if (normalized.includes('greenhouse.io')) return 'greenhouse';
  if (normalized.includes('lever.co')) return 'lever';
  if (normalized.includes('linkedin.com')) return 'linkedin';
  return null;
}

export function inferCredentialDomainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function hasPlatformPasswordOverride(
  profile: Record<string, unknown>,
  platform: string | null,
): boolean {
  const override = getPlatformOverride(profile, platform);
  if (override) {
    const nested = firstNonEmptyString(
      override.password,
      override.secret,
      override.workday_password,
      override.workdayPassword,
    );
    if (nested) return true;
  }

  if (!platform) return false;
  return firstNonEmptyString(
    profile[`${platform}_password`],
    profile[`${platform}Password`],
  ) != null;
}

export function resolvePlatformAccountEmail(
  profile: Record<string, unknown>,
  platform: string | null,
  options?: { sourceUrl?: string | null; domain?: string | null },
): string {
  const override = getPlatformOverride(profile, platform, options);
  return firstNonEmptyString(
    // Dev/test override — will be replaced by VALET onboarding credentials
    process.env.TEST_GMAIL_EMAIL,
    override?.email,
    override?.login_identifier,
    override?.loginIdentifier,
    override?.username,
    platform ? profile[`${platform}_email`] : undefined,
    platform ? profile[`${platform}Email`] : undefined,
    profile.email,
  ) ?? '';
}

export function inferPasswordRequirements(
  validationText: string | null | undefined,
  platform: string | null,
): PasswordRequirements {
  const rules = inferDefaultRequirements(platform);
  const text = validationText?.toLowerCase() ?? '';
  if (!text) return rules;

  const lengthMatch =
    text.match(/at least\s+(\d+)\s+characters?/) ??
    text.match(/minimum of\s+(\d+)\s+characters?/) ??
    text.match(/(\d+)\+?\s+characters?/);
  if (lengthMatch?.[1]) {
    rules.minLength = Math.max(rules.minLength, Number(lengthMatch[1]));
  }

  if (text.includes('uppercase')) rules.requireUppercase = true;
  if (text.includes('lowercase')) rules.requireLowercase = true;
  if (text.includes('number') || text.includes('digit')) rules.requireNumber = true;
  if (text.includes('special character') || text.includes('special-character') || text.includes('symbol')) {
    rules.requireSpecial = true;
  }

  return rules;
}

export function strengthenPasswordForRequirements(
  input: string | null | undefined,
  requirements: PasswordRequirements,
): string {
  let password = (typeof input === 'string' && input.trim().length > 0 ? input.trim() : FALLBACK_PASSWORD);

  if (requirements.requireLowercase && !/[a-z]/.test(password)) password += 'a';
  if (requirements.requireUppercase && !/[A-Z]/.test(password)) password += 'A';
  if (requirements.requireNumber && !/[0-9]/.test(password)) password += '1';
  if (requirements.requireSpecial && !/[!@#$%^&*]/.test(password)) password += '!';

  let padIndex = 0;
  const padChars = ['V', 'a', '1', '!'];
  while (password.length < requirements.minLength) {
    password += padChars[padIndex % padChars.length];
    padIndex += 1;
  }

  return password;
}

function pickRandom(chars: string): string {
  const index = randomBytes(1)[0] % chars.length;
  return chars[index] ?? chars[0] ?? 'A';
}

export function describePasswordRequirements(requirements: PasswordRequirements): string[] {
  const parts: string[] = [`minimum ${requirements.minLength} characters`];
  if (requirements.requireUppercase) parts.push('uppercase letter');
  if (requirements.requireLowercase) parts.push('lowercase letter');
  if (requirements.requireNumber) parts.push('number');
  if (requirements.requireSpecial) parts.push('special character');
  return parts;
}

export function generatePasswordForRequirements(requirements: PasswordRequirements): string {
  const chars: string[] = [];
  if (requirements.requireUppercase) chars.push(pickRandom('ABCDEFGHJKLMNPQRSTUVWXYZ'));
  if (requirements.requireLowercase) chars.push(pickRandom('abcdefghijkmnopqrstuvwxyz'));
  if (requirements.requireNumber) chars.push(pickRandom('23456789'));
  if (requirements.requireSpecial) chars.push(pickRandom(SPECIAL_CHARS));

  const pool =
    'ABCDEFGHJKLMNPQRSTUVWXYZ' +
    'abcdefghijkmnopqrstuvwxyz' +
    '23456789' +
    SPECIAL_CHARS;

  while (chars.length < requirements.minLength) {
    chars.push(pickRandom(pool));
  }

  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = randomBytes(1)[0] % (index + 1);
    const current = chars[index];
    chars[index] = chars[swapIndex] ?? chars[index] ?? 'A';
    chars[swapIndex] = current ?? chars[swapIndex] ?? 'A';
  }

  return strengthenPasswordForRequirements(chars.join(''), requirements);
}

export function generatePlatformCredential(
  profile: Record<string, unknown>,
  platform: string,
  loginIdentifier: string,
  options?: { validationText?: string | null; sourceUrl?: string | null },
): {
  credential: GeneratedPlatformCredential;
  event: AccountCreationEvent;
} {
  const requirements = inferPasswordRequirements(options?.validationText, platform);
  const secret = generatePasswordForRequirements(requirements);
  const describedRequirements = describePasswordRequirements(requirements);
  const domain = inferCredentialDomainFromUrl(options?.sourceUrl);
  const sourceContext = options?.sourceUrl ? ` while applying to ${options.sourceUrl}` : '';
  const scopeLabel = domain ? `${loginIdentifier || 'this application'} on ${domain}` : (loginIdentifier || 'this application');
  const note =
    `Generated a ${platform} account password for ${scopeLabel} ` +
    `${sourceContext} to satisfy: ${describedRequirements.join(', ')}.`;

  return {
    credential: {
      platform,
      domain,
      loginIdentifier,
      secret,
      source: 'generated_platform_password',
      requirements: describedRequirements,
    },
    event: {
      platform,
      domain,
      loginIdentifier,
      action: 'generated_platform_password',
      passwordSource: 'generated_platform_password',
      requirements: describedRequirements,
      note,
    },
  };
}

export function resolvePlatformAccountPassword(
  profile: Record<string, unknown>,
  platform: string | null,
  options?: { validationText?: string | null; sourceUrl?: string | null; domain?: string | null },
): { password: string; source: AccountPasswordSource } {
  // Dev/test override — will be replaced by VALET onboarding credentials
  if (process.env.TEST_GMAIL_PASSWORD?.trim()) {
    return {
      password: strengthenPasswordForRequirements(
        process.env.TEST_GMAIL_PASSWORD,
        inferPasswordRequirements(options?.validationText, platform),
      ),
      source: 'platform_override',
    };
  }

  const override = getPlatformOverride(profile, platform, options);
  const explicitPlatformPassword = firstNonEmptyString(
    override?.password,
    override?.secret,
    platform ? profile[`${platform}_password`] : undefined,
    platform ? profile[`${platform}Password`] : undefined,
  );
  if (explicitPlatformPassword) {
    const requirements = options?.validationText
      ? inferPasswordRequirements(options.validationText, platform)
      : null;
    return {
      password: requirements
        ? strengthenPasswordForRequirements(explicitPlatformPassword, requirements)
        : explicitPlatformPassword,
      source: 'platform_override',
    };
  }

  const applicationPassword = firstNonEmptyString(
    profile.applicationPassword,
    profile.application_password,
  );
  if (applicationPassword) {
    return {
      password: strengthenPasswordForRequirements(
        applicationPassword,
        inferPasswordRequirements(options?.validationText, platform),
      ),
      source: 'shared_application_password',
    };
  }

  const profilePassword = firstNonEmptyString(profile.password);
  if (profilePassword) {
    return {
      password: strengthenPasswordForRequirements(
        profilePassword,
        inferPasswordRequirements(options?.validationText, platform),
      ),
      source: 'profile_password',
    };
  }

  return {
    password: strengthenPasswordForRequirements(
      FALLBACK_PASSWORD,
      inferPasswordRequirements(options?.validationText, platform),
    ),
    source: 'generated',
  };
}
