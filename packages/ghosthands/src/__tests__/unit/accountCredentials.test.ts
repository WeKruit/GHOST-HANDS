import { describe, expect, test } from 'bun:test';
import {
  describePasswordRequirements,
  generatePlatformCredential,
  inferCredentialDomainFromUrl,
  inferCredentialPlatformFromUrl,
  inferPasswordRequirements,
  resolvePlatformAccountEmail,
  resolvePlatformAccountPassword,
  strengthenPasswordForRequirements,
} from '../../workers/taskHandlers/platforms/accountCredentials.js';

describe('accountCredentials', () => {
  test('detects workday URLs for platform credential routing', () => {
    expect(
      inferCredentialPlatformFromUrl(
        'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/SAN-JOSE/apply/applyManually',
      ),
    ).toBe('workday');
  });

  test('extracts host affinity for generated account credentials', () => {
    expect(
      inferCredentialDomainFromUrl(
        'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/SAN-JOSE/apply/applyManually',
      ),
    ).toBe('cadence.wd1.myworkdayjobs.com');
  });

  test('prefers explicit workday email/password overrides when present', () => {
    const profile = {
      email: 'profile@example.com',
      workday_email: 'ats@example.com',
      workday_password: 'SavedWorkday!123',
      application_password: 'Shared!1234',
    };

    expect(resolvePlatformAccountEmail(profile, 'workday')).toBe('ats@example.com');
    expect(resolvePlatformAccountPassword(profile, 'workday')).toEqual({
      password: 'SavedWorkday!123',
      source: 'platform_override',
    });
  });

  test('prefers tenant-specific Workday credentials over shared password for the active host', () => {
    const profile = {
      email: 'profile@example.com',
      application_password: 'SharedPassword!234',
      platform_credentials: {
        workday: {
          email: 'default@example.com',
          password: 'DefaultWorkday!234',
          byDomain: {
            'cadence.wd1.myworkdayjobs.com': {
              email: 'tenant@example.com',
              password: 'TenantWorkday!234',
            },
          },
        },
      },
    };

    expect(
      resolvePlatformAccountEmail(profile, 'workday', {
        sourceUrl:
          'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/SAN-JOSE/apply/applyManually',
      }),
    ).toBe('tenant@example.com');
    expect(
      resolvePlatformAccountPassword(profile, 'workday', {
        sourceUrl:
          'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/SAN-JOSE/apply/applyManually',
      }),
    ).toEqual({
      password: 'TenantWorkday!234',
      source: 'platform_override',
    });
  });

  test('strengthens shared application password for workday fallback requirements', () => {
    const profile = {
      email: 'profile@example.com',
      application_password: 'sharedpassword123',
    };

    const resolved = resolvePlatformAccountPassword(profile, 'workday');
    expect(resolved.source).toBe('shared_application_password');
    expect(resolved.password).toContain('!');
    expect(/[A-Z]/.test(resolved.password)).toBe(true);
  });

  test('derives requirements from validation text and patches missing classes', () => {
    const requirements = inferPasswordRequirements(
      'Password must include: an uppercase letter, a special character, and at least 14 characters.',
      'workday',
    );
    const strengthened = strengthenPasswordForRequirements('simplepass1', requirements);

    expect(requirements.minLength).toBeGreaterThanOrEqual(14);
    expect(/[A-Z]/.test(strengthened)).toBe(true);
    expect(/[!@#$%^&*]/.test(strengthened)).toBe(true);
    expect(strengthened.length).toBeGreaterThanOrEqual(14);
  });

  test('generates a workday credential that satisfies inferred requirements', () => {
    const generated = generatePlatformCredential(
      { email: 'profile@example.com' },
      'workday',
      'profile@example.com',
      {
        validationText:
          'Password must include: an uppercase letter, a lowercase letter, a number, a special character, and at least 14 characters.',
        sourceUrl:
          'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/SAN-JOSE/apply/applyManually',
      },
    );

    expect(generated.credential.platform).toBe('workday');
    expect(generated.credential.domain).toBe('cadence.wd1.myworkdayjobs.com');
    expect(generated.credential.loginIdentifier).toBe('profile@example.com');
    expect(generated.credential.source).toBe('generated_platform_password');
    expect(generated.event.passwordSource).toBe('generated_platform_password');
    expect(generated.credential.secret.length).toBeGreaterThanOrEqual(14);
    expect(/[A-Z]/.test(generated.credential.secret)).toBe(true);
    expect(/[a-z]/.test(generated.credential.secret)).toBe(true);
    expect(/[0-9]/.test(generated.credential.secret)).toBe(true);
    expect(/[!@#$%^&*]/.test(generated.credential.secret)).toBe(true);
    expect(generated.event.note).toContain('cadence.wd1.myworkdayjobs.com');
    expect(generated.event.note).toContain('apply/applyManually');
  });

  test('describes password requirements for reporting', () => {
    expect(
      describePasswordRequirements({
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSpecial: true,
      }),
    ).toEqual([
      'minimum 12 characters',
      'uppercase letter',
      'lowercase letter',
      'number',
      'special character',
    ]);
  });
});
