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
  | 'generated';

const FALLBACK_PASSWORD = 'ValetApply!123';

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

function getPlatformOverride(
  profile: Record<string, unknown>,
  platform: string | null,
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
  return asRecord(platformsRecord[platform]) ?? platformsRecord;
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
): string {
  const override = getPlatformOverride(profile, platform);
  return firstNonEmptyString(
    override?.email,
    override?.login_identifier,
    override?.loginIdentifier,
    override?.username,
    platform ? profile[`${platform}_email`] : undefined,
    platform ? profile[`${platform}Email`] : undefined,
    profile.email,
    process.env.TEST_GMAIL_EMAIL,
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

export function resolvePlatformAccountPassword(
  profile: Record<string, unknown>,
  platform: string | null,
  options?: { validationText?: string | null },
): { password: string; source: AccountPasswordSource } {
  const override = getPlatformOverride(profile, platform);
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

  if (process.env.TEST_GMAIL_PASSWORD?.trim()) {
    return {
      password: strengthenPasswordForRequirements(
        process.env.TEST_GMAIL_PASSWORD,
        inferPasswordRequirements(options?.validationText, platform),
      ),
      source: 'env',
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
