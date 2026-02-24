/**
 * ECR Authentication Module
 *
 * Reads Docker registry auth from the host's Docker config.json file
 * (mounted into the container). This avoids the @aws-sdk/client-ecr
 * dependency which is not available in the runtime Docker image.
 *
 * The host must run `aws ecr get-login-password | docker login` periodically
 * (cron every 6h) to keep the token fresh. ECR tokens are valid for 12 hours.
 *
 * @module scripts/lib/ecr-auth
 */

import { readFileSync } from 'node:fs';

/**
 * ECR authorization token for Docker registry authentication.
 *
 * The token is base64-encoded JSON compatible with Docker Engine API's
 * X-Registry-Auth header format.
 */
export interface EcrAuthToken {
  /** Base64-encoded Docker auth config for X-Registry-Auth header */
  token: string;
  /** Token expiration timestamp (estimated — config.json has no expiry field) */
  expiresAt: Date;
  /** Registry URL without protocol (e.g., "168495702277.dkr.ecr.us-east-1.amazonaws.com") */
  registryUrl: string;
}

/**
 * Default ECR registry URL (read from ECR_REGISTRY env or auto-detected from config.json)
 */
const DEFAULT_REGISTRY = process.env.ECR_REGISTRY ?? '';

/**
 * Path to Docker config.json inside the container (mounted from host).
 * Override with DOCKER_CONFIG_PATH env var.
 */
const DOCKER_CONFIG_PATH = process.env.DOCKER_CONFIG_PATH ?? '/docker-config/config.json';

/**
 * In-memory cached token
 */
let cachedToken: EcrAuthToken | null = null;

/**
 * Cache TTL — re-read config.json every 30 minutes to pick up refreshed tokens.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

interface DockerConfig {
  auths?: Record<string, { auth?: string }>;
}

/**
 * Retrieves an ECR authorization token by reading Docker's config.json.
 *
 * The host must have a valid ECR login (via `aws ecr get-login-password | docker login`).
 * A cron job refreshes this every 6 hours.
 *
 * @returns ECR authorization token
 * @throws Error if config.json is missing, unreadable, or has no ECR auth entry
 */
export async function getEcrAuth(): Promise<EcrAuthToken> {
  // Return cached token if still fresh
  if (cachedToken && cachedToken.expiresAt.getTime() - Date.now() > 0) {
    return cachedToken;
  }

  try {
    const configRaw = readFileSync(DOCKER_CONFIG_PATH, 'utf-8');
    const config: DockerConfig = JSON.parse(configRaw);

    if (!config.auths) {
      throw new Error(`No 'auths' section in ${DOCKER_CONFIG_PATH}`);
    }

    // Find the ECR registry entry (matches *.dkr.ecr.*.amazonaws.com)
    let registryUrl = '';
    let authB64 = '';

    for (const [registry, entry] of Object.entries(config.auths)) {
      if (registry.includes('.dkr.ecr.') && registry.includes('.amazonaws.com') && entry.auth) {
        registryUrl = registry;
        authB64 = entry.auth;
        break;
      }
    }

    if (!registryUrl || !authB64) {
      throw new Error(`No ECR auth entry found in ${DOCKER_CONFIG_PATH}`);
    }

    // config.json stores base64("AWS:<token>") — Docker Engine API needs
    // base64(JSON({ username, password, serveraddress }))
    const decoded = Buffer.from(authB64, 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      throw new Error('Invalid Docker auth format: expected "username:password"');
    }

    const username = decoded.substring(0, colonIdx);
    const password = decoded.substring(colonIdx + 1);

    const dockerAuth = Buffer.from(
      JSON.stringify({
        username,
        password,
        serveraddress: `https://${registryUrl}`,
      }),
    ).toString('base64');

    cachedToken = {
      token: dockerAuth,
      // Re-read from config.json after CACHE_TTL_MS (actual ECR token lasts 12h)
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
      registryUrl,
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
 * Forces the next call to `getEcrAuth()` to re-read config.json.
 */
export function clearEcrAuthCache(): void {
  cachedToken = null;
}

/**
 * Gets the full ECR image reference for the GhostHands image.
 *
 * @param tag - Image tag (e.g., 'staging-abc1234', 'latest')
 * @returns Full image reference (e.g., '168495702277.dkr.ecr.us-east-1.amazonaws.com/ghosthands:staging-abc1234')
 */
export function getEcrImageRef(tag: string): string {
  const repository = process.env.ECR_REPOSITORY ?? 'ghosthands';
  const registry = DEFAULT_REGISTRY;
  if (!registry) {
    // If ECR_REGISTRY not set, try to discover from cached auth
    if (cachedToken?.registryUrl) {
      return `${cachedToken.registryUrl}/${repository}:${tag}`;
    }
    throw new Error('ECR_REGISTRY env var not set and no cached auth available. Call getEcrAuth() first.');
  }
  return `${registry}/${repository}:${tag}`;
}
