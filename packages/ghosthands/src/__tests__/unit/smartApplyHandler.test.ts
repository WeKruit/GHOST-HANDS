import { describe, expect, test } from 'bun:test';
import {
  SmartApplyHandler,
  inferAccountCreationTransition,
  shouldStopForManualReviewAfterStableRepeat,
} from '../../workers/taskHandlers/smartApplyHandler.js';

describe('SmartApplyHandler', () => {
  const handler = new SmartApplyHandler();

  test('has type "smart_apply"', () => {
    expect(handler.type).toBe('smart_apply');
  });

  test('has a description', () => {
    expect(handler.description).toBeTruthy();
    expect(handler.description.length).toBeGreaterThan(10);
  });

  describe('validate()', () => {
    test('validates successfully with required fields', () => {
      const result = handler.validate({
        user_data: {
          first_name: 'John',
          last_name: 'Doe',
          email: 'john@example.com',
        },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test('fails when user_data is missing', () => {
      const result = handler.validate({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data is required');
    });

    test('fails when first_name is missing', () => {
      const result = handler.validate({
        user_data: {
          last_name: 'Doe',
          email: 'john@example.com',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.first_name is required');
    });

    test('fails when last_name is missing', () => {
      const result = handler.validate({
        user_data: {
          first_name: 'John',
          email: 'john@example.com',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.last_name is required');
    });

    test('fails when email is missing', () => {
      const result = handler.validate({
        user_data: {
          first_name: 'John',
          last_name: 'Doe',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.email is required');
    });

    test('collects multiple missing field errors', () => {
      const result = handler.validate({
        user_data: {},
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
    });
  });

  test('records generated tenant credentials on the in-memory profile and result metadata', () => {
    const mutableHandler = new SmartApplyHandler() as any;
    const profile: Record<string, unknown> = {
      email: 'profile@example.com',
    };

    mutableHandler.rememberGeneratedPlatformCredential(
      profile,
      {
        platform: 'workday',
        domain: 'cadence.wd1.myworkdayjobs.com',
        loginIdentifier: 'tenant@example.com',
        secret: 'TenantWorkday!234',
        source: 'generated_platform_password',
        requirements: ['minimum 12 characters'],
      },
      {
        platform: 'workday',
        domain: 'cadence.wd1.myworkdayjobs.com',
        loginIdentifier: 'tenant@example.com',
        action: 'generated_platform_password',
        passwordSource: 'generated_platform_password',
        requirements: ['minimum 12 characters'],
        note: 'Generated a tenant-scoped Workday credential.',
      },
    );

    const result = mutableHandler.withAccountCreationMetadata({
      success: true,
    });

    expect((profile as any).workday_email).toBe('tenant@example.com');
    expect((profile as any).workday_password).toBe('TenantWorkday!234');
    expect((profile as any).platform_credentials.workday.byDomain['cadence.wd1.myworkdayjobs.com']).toMatchObject({
      email: 'tenant@example.com',
      password: 'TenantWorkday!234',
    });
    expect(result.runtimeMetadata?.generatedPlatformCredentials?.[0]?.domain).toBe(
      'cadence.wd1.myworkdayjobs.com',
    );
    expect(result.runtimeMetadata?.accountCreationEvents?.[0]?.domain).toBe(
      'cadence.wd1.myworkdayjobs.com',
    );
  });

  test('infers login transition after account creation when Workday lands on sign-in', () => {
    expect(
      inferAccountCreationTransition({
        currentUrl:
          'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/login?redirect=apply',
        hasPasswordField: true,
        hasConfirmPassword: false,
        hasSignInOption: true,
        hasCreateAccountHeading: true,
        hasVerificationPrompt: false,
        validationText: '',
      }),
    ).toBe('login');
  });

  test('stops for manual review when a filled form repeats without navigation', () => {
    expect(
      shouldStopForManualReviewAfterStableRepeat({
        result: 'complete',
        samePageCount: 1,
        totalFields: 16,
        pageType: 'personal_info',
      }),
    ).toBe(true);
    expect(
      shouldStopForManualReviewAfterStableRepeat({
        result: 'complete',
        samePageCount: 0,
        totalFields: 16,
        pageType: 'personal_info',
      }),
    ).toBe(false);
  });
});
