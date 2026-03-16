import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPlatformCredentialToProfile,
  getPlatformAuthContext,
  resolvePlatformAuthContext,
  setPlatformAuthContext,
  upsertGeneratedPlatformCredentialRuntime,
} from "../../workers/platformAuthRuntime.js";

describe("platformAuthRuntime", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.GH_SERVICE_SECRET;
    delete process.env.VALET_API_URL;
  });

  it("stores and retrieves auth context by platform and normalized domain", () => {
    const profile: Record<string, unknown> = {};
    setPlatformAuthContext(profile as Record<string, any>, {
      platform: "workday",
      domain: "https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/123",
      authMode: "create_account",
      credentialExists: false,
      existingCredential: null,
      sharedApplicationPassword: "SharedApply!123",
      generatedCredential: null,
      accountCreationConfirmed: false,
      forceSignIn: false,
      lastAuthState: null,
    });

    const context = getPlatformAuthContext(profile as Record<string, any>, {
      sourceUrl: "https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/999",
      platform: "generic",
    });

    expect(context).toMatchObject({
      platform: "workday",
      domain: "cadence.wd1.myworkdayjobs.com",
      authMode: "create_account",
    });
  });

  it("applies platform credential and shared application password to profile", () => {
    const profile: Record<string, any> = {};
    applyPlatformCredentialToProfile(
      profile,
      {
        platform: "workday",
        domain: "cadence.wd1.myworkdayjobs.com",
        loginIdentifier: "user@example.com",
        secret: "generated-secret",
      },
      "SharedApply!123",
    );

    expect(profile.application_password).toBe("SharedApply!123");
    expect(profile.workday_email).toBe("user@example.com");
    expect(profile.workday_password).toBe("generated-secret");
    expect(profile.platform_credentials.workday.byDomain["cadence.wd1.myworkdayjobs.com"]).toMatchObject({
      loginIdentifier: "user@example.com",
      secret: "generated-secret",
    });
  });

  it("resolves runtime auth context and upserts generated credential through VALET runtime endpoints", async () => {
    process.env.GH_SERVICE_SECRET = "service-secret";
    process.env.VALET_API_URL = "https://valet-api-stg.fly.dev";
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          platform: "workday",
          domain: "cadence.wd1.myworkdayjobs.com",
          credentialExists: true,
          credential: {
            platform: "workday",
            domain: "cadence.wd1.myworkdayjobs.com",
            loginIdentifier: "user@example.com",
            secret: "existing-secret",
          },
          sharedApplicationPassword: "SharedApply!123",
          authMode: "sign_in",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
      });
    globalThis.fetch = fetch as any;

    const context = await resolvePlatformAuthContext({
      userId: "user-1",
      sourceUrl: "https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/123",
      platformHint: "generic",
    });
    const persisted = await upsertGeneratedPlatformCredentialRuntime({
      userId: "user-1",
      sourceUrl: "https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/123",
      credential: {
        platform: "workday",
        loginIdentifier: "user@example.com",
        secret: "generated-secret",
        source: "generated_platform_password",
        domain: null,
        requirements: [],
      },
    });

    expect(context).toMatchObject({
      platform: "workday",
      authMode: "sign_in",
      credentialExists: true,
    });
    expect(persisted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://valet-api-stg.fly.dev/api/v1/ghosthands/runtime/auth-context/resolve",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://valet-api-stg.fly.dev/api/v1/ghosthands/runtime/platform-credentials/upsert-generated",
    );
  });
});
