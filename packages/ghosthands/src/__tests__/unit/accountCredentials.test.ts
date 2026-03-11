import { describe, expect, test } from 'bun:test';
import {
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
});
