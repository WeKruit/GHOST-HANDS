/**
 * ECR Authentication Module
 *
 * Provides programmatic authentication to Amazon ECR using the AWS SDK.
 * Replaces `aws ecr get-login-password` CLI calls with native SDK calls.
 * Uses IAM instance profile credentials (no hardcoded secrets).
 *
 * @module scripts/lib/ecr-auth
 */

import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';

/**
 * ECR authorization token for Docker registry authentication.
 *
 * The token is base64-encoded JSON compatible with Docker Engine API's
 * X-Registry-Auth header format.
 */
export interface EcrAuthToken {
  /** Base64-encoded Docker auth config for X-Registry-Auth header */
  token: string;
  /** Token expiration timestamp (from ECR API) */
  expiresAt: Date;
  /** Registry URL without protocol (e.g., "471112621974.dkr.ecr.us-east-1.amazonaws.com") */
  registryUrl: string;
}

/**
 * Default AWS region for ECR
 */
const DEFAULT_REGION = 'us-east-1';

/**
 * Default ECR registry URL
 * Account: 471112621974, Region: us-east-1
 */
const DEFAULT_REGISTRY = '471112621974.dkr.ecr.us-east-1.amazonaws.com';

/**
 * Token buffer before expiry (30 minutes)
 * Tokens from ECR are valid for 12 hours; we refresh when less than this buffer remains.
 */
const EXPIRY_BUFFER_MS = 30 * 60 * 1000;

/**
 * In-memory cached token
 */
let cachedToken: EcrAuthToken | null = null;

/**
 * Retrieves an ECR authorization token for Docker registry authentication.
 *
 * Uses IAM instance profile credentials (discovered from IMDS) - no explicit
 * credentials needed. Tokens are cached in-memory with a 30-minute pre-expiry buffer.
 *
 * @param region - AWS region override (defaults to AWS_REGION env var or us-east-1)
 * @returns ECR authorization token
 * @throws Error if ECR API call fails or returns invalid data
 *
 * @example
 * ```ts
 * import { getEcrAuth } from './scripts/lib/ecr-auth';
 * import { pullImage } from './scripts/lib/docker-client';
 *
 * const auth = await getEcrAuth();
 * await pullImage('471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands', 'v1.2.3', auth.token);
 * ```
 */
export async function getEcrAuth(region?: string): Promise<EcrAuthToken> {
  // Return cached token if still valid (30-min buffer before 12-hour expiry)
  if (cachedToken && cachedToken.expiresAt.getTime() - Date.now() > EXPIRY_BUFFER_MS) {
    return cachedToken;
  }

  const resolvedRegion = region ?? process.env.AWS_REGION ?? DEFAULT_REGION;
  const client = new ECRClient({ region: resolvedRegion });
  const cmd = new GetAuthorizationTokenCommand({});

  try {
    const response = await client.send(cmd);

    const authData = response.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData.proxyEndpoint) {
      throw new Error('Failed to get ECR authorization token: invalid response from ECR API');
    }

    // ECR returns base64("AWS:<password>") — Docker API needs base64 JSON config
    // Format: base64 JSON with username, password, serveraddress
    const decoded = Buffer.from(authData.authorizationToken, 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');

    if (!password) {
      throw new Error('Failed to parse ECR authorization token: invalid format');
    }

    const dockerAuth = Buffer.from(
      JSON.stringify({
        username,
        password,
        serveraddress: authData.proxyEndpoint,
      }),
    ).toString('base64');

    cachedToken = {
      token: dockerAuth,
      expiresAt: authData.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000),
      registryUrl: authData.proxyEndpoint.replace('https://', ''),
    };

    return cachedToken;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`ECR authentication failed: ${error.message}`);
    }
    throw new Error('ECR authentication failed: unknown error');
  }
}

/**
 * Clears the in-memory ECR token cache.
 *
 * Primarily used for testing - forces the next call to `getEcrAuth()`
 * to fetch a fresh token from ECR.
 *
 * @example
 * ```ts
 * import { clearEcrAuthCache, getEcrAuth } from './scripts/lib/ecr-auth';
 *
 * clearEcrAuthCache();
 * const freshAuth = await getEcrAuth(); // Fetches new token
 * ```
 */
export function clearEcrAuthCache(): void {
  cachedToken = null;
}

/**
 * Gets the full ECR image reference for the GhostHands image.
 *
 * @param tag - Image tag (e.g., 'v1.2.3', 'latest')
 * @returns Full image reference (e.g., '471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands:v1.2.3')
 *
 * @example
 * ```ts
 * import { getEcrImageRef } from './scripts/lib/ecr-auth';
 *
 * const imageRef = getEcrImageRef('v1.2.3');
 * // => '471112621974.dkr.ecr.us-east-1.amazonaws.com/wekruit/ghosthands:v1.2.3'
 * ```
 */
export function getEcrImageRef(tag: string): string {
  const registry = process.env.ECR_REGISTRY ?? DEFAULT_REGISTRY;
  return `${registry}/wekruit/ghosthands:${tag}`;
}
