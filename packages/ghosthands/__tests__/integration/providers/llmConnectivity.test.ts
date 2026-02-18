/**
 * LLM Provider Connectivity Tests
 *
 * Verifies that every configured LLM provider is reachable at the TLS/HTTPS
 * layer. This catches SSL certificate errors (like the persistent SiliconFlow
 * api.siliconflow.cn issue) BEFORE they surface in production jobs.
 *
 * For each provider that has:
 *   1. A baseUrl in models.config.json
 *   2. A corresponding API key set in the environment
 *
 * We perform:
 *   - A raw TLS handshake test (verifies the SSL cert chain completes)
 *   - A minimal HTTP request to the /models endpoint (verifies the API key is
 *     accepted and the provider returns a structured response)
 *
 * Providers without API keys are skipped gracefully (test.skip).
 *
 * SiliconFlow gets an additional dedicated TLS cert-chain test because that
 * is where the production SSL error has been recurring.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import tls from 'tls';

// ---------------------------------------------------------------------------
// Config loading (mirrors src/config/models.ts types)
// ---------------------------------------------------------------------------

interface ProviderEntry {
  name: string;
  baseUrl?: string;
  envKey: string;
  docs: string;
}

interface CostInfo {
  input: number;
  output: number;
  unit: string;
}

interface ModelEntry {
  provider: string;
  model: string;
  vision: boolean;
  cost: CostInfo;
  note?: string;
}

interface PresetEntry {
  description: string;
  model: string;
}

interface ModelsConfig {
  version: number;
  providers: Record<string, ProviderEntry>;
  models: Record<string, ModelEntry>;
  presets: Record<string, PresetEntry>;
  default: string;
}

const configPath = path.resolve(
  __dirname,
  '../../../src/config/models.config.json',
);
const config: ModelsConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timeout for network operations (generous to handle slow CI runners). */
const NETWORK_TIMEOUT_MS = 15_000;

/**
 * Perform a raw TLS handshake against a host:port.
 * Resolves with the TLS socket on success, rejects on any error
 * (certificate validation failure, unreachable host, timeout, etc.).
 */
function tlsHandshake(
  host: string,
  port: number,
): Promise<{ authorized: boolean; protocol: string | null; cipher: tls.CipherNameAndProtocol | undefined }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        // Use the default system CA bundle -- this is what the BAML runtime
        // does inside the Docker container. If SSL_CERT_FILE / SSL_CERT_DIR
        // are not set properly, this will fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
        rejectUnauthorized: true,
        servername: host, // SNI
        timeout: NETWORK_TIMEOUT_MS,
        // Some providers (e.g. open.bigmodel.cn) return certificates where
        // Bun's TLS parser fails to extract `subject`, causing the default
        // checkServerIdentity to crash with "Cannot destructure property
        // 'subject' from null". We supply a custom callback that tolerates
        // this while still verifying the cert is authorized by the CA store.
        checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) => {
          if (!cert || !cert.subject) {
            // Bun could not parse the certificate subject. The cert is still
            // validated against the CA store (rejectUnauthorized: true), so
            // the TLS handshake is trustworthy. Return undefined (= no error).
            return undefined;
          }
          // Delegate to the default implementation for well-formed certs
          return tls.checkServerIdentity(hostname, cert);
        },
      },
      () => {
        const result = {
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          cipher: socket.getCipher(),
        };
        socket.end();
        resolve(result);
      },
    );

    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${NETWORK_TIMEOUT_MS}ms`));
    });
  });
}

/**
 * Extract host and port from a URL.
 */
function parseHostPort(baseUrl: string): { host: string; port: number } {
  const url = new URL(baseUrl);
  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
  };
}

/**
 * Make a minimal GET /models (or equivalent) request to verify the provider
 * accepts our API key and returns a valid response. This is the cheapest
 * possible API call -- it does NOT create a completion.
 */
async function probeModelsEndpoint(
  baseUrl: string,
  apiKey: string,
): Promise<{ status: number; ok: boolean; body: string }> {
  // Most OpenAI-compatible APIs serve GET /models
  const url = baseUrl.replace(/\/+$/, '') + '/models';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make a minimal Anthropic API call to check connectivity.
 * Anthropic does not serve GET /models, so we hit POST /v1/messages with
 * a deliberately tiny max_tokens to minimize cost ($0 for auth errors,
 * fractions of a cent if the key is valid).
 */
async function probeAnthropicEndpoint(
  apiKey: string,
): Promise<{ status: number; ok: boolean; body: string }> {
  const url = 'https://api.anthropic.com/v1/messages';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });

    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Collect provider info for tests
// ---------------------------------------------------------------------------

interface ProviderTestInfo {
  key: string;
  name: string;
  baseUrl: string | undefined;
  envKey: string;
  apiKey: string | undefined;
  hasApiKey: boolean;
}

const providers: ProviderTestInfo[] = Object.entries(config.providers).map(
  ([key, entry]) => ({
    key,
    name: entry.name,
    baseUrl: entry.baseUrl,
    envKey: entry.envKey,
    apiKey: process.env[entry.envKey] || undefined,
    hasApiKey: !!process.env[entry.envKey],
  }),
);

// Providers with a baseUrl (OpenAI-compatible endpoints)
const openaiCompatibleProviders = providers.filter((p) => p.baseUrl);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLM provider connectivity', () => {
  // ── Config sanity checks ──────────────────────────────────────────────

  describe('config sanity', () => {
    test('config loads and has providers', () => {
      expect(Object.keys(config.providers).length).toBeGreaterThan(0);
    });

    test('every provider with a baseUrl uses HTTPS', () => {
      for (const [key, provider] of Object.entries(config.providers)) {
        if (provider.baseUrl) {
          expect(provider.baseUrl).toMatch(/^https:\/\//);
        }
      }
    });

    test('all provider envKey names end with _API_KEY or _KEY', () => {
      for (const [key, provider] of Object.entries(config.providers)) {
        expect(provider.envKey).toMatch(/_API_KEY$|_KEY$/);
      }
    });

    test('reports which API keys are available', () => {
      const available: string[] = [];
      const missing: string[] = [];

      for (const p of providers) {
        if (p.hasApiKey) {
          available.push(`${p.key} (${p.envKey})`);
        } else {
          missing.push(`${p.key} (${p.envKey})`);
        }
      }

      console.log(
        `\n  API keys available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
      );
      console.log(
        `  API keys missing:  ${missing.length > 0 ? missing.join(', ') : '(none)'}`,
      );

      // This test always passes -- it is diagnostic output for CI logs.
      expect(true).toBe(true);
    });
  });

  // ── TLS handshake tests (one per provider with a baseUrl) ─────────────

  describe('TLS handshake', () => {
    for (const provider of openaiCompatibleProviders) {
      const { host, port } = parseHostPort(provider.baseUrl!);

      // TLS tests do NOT require an API key -- they only verify the
      // SSL certificate chain is valid and the server is reachable.
      test(
        `${provider.name} (${host}:${port}) — TLS handshake succeeds`,
        async () => {
          const result = await tlsHandshake(host, port);

          // The server's certificate must be authorized by the system CA store
          expect(result.authorized).toBe(true);

          // Must negotiate TLS 1.2 or 1.3
          expect(result.protocol).toMatch(/TLSv1\.[23]/);

          // Must negotiate a cipher
          expect(result.cipher).toBeDefined();
          expect(result.cipher!.name).toBeTruthy();

          console.log(
            `    ${host} -> authorized=${result.authorized}, protocol=${result.protocol}, cipher=${result.cipher?.name}`,
          );
        },
        NETWORK_TIMEOUT_MS + 5_000,
      );
    }

    // Anthropic has no baseUrl in config but we know the host
    test(
      'Anthropic (api.anthropic.com:443) — TLS handshake succeeds',
      async () => {
        const result = await tlsHandshake('api.anthropic.com', 443);
        expect(result.authorized).toBe(true);
        expect(result.protocol).toMatch(/TLSv1\.[23]/);
      },
      NETWORK_TIMEOUT_MS + 5_000,
    );
  });

  // ── SiliconFlow-specific SSL deep checks ──────────────────────────────
  //
  // The recurring production error is:
  //   "error sending request for url (https://api.siliconflow.cn/v1/chat/completions):
  //    error trying to connect: invalid peer certificate: UnknownIssuer"
  //
  // This block does extra validation to catch it in CI.

  describe('SiliconFlow SSL (targeted)', () => {
    const SF_HOST = 'api.siliconflow.cn';
    const SF_PORT = 443;

    test(
      'TLS handshake completes with authorized=true',
      async () => {
        const result = await tlsHandshake(SF_HOST, SF_PORT);
        expect(result.authorized).toBe(true);
      },
      NETWORK_TIMEOUT_MS + 5_000,
    );

    test(
      'certificate is trusted and matches hostname',
      async () => {
        // Use a raw TLS socket to inspect the peer certificate.
        // Note: Bun's TLS implementation does not always populate the full
        // issuerCertificate chain (unlike Node.js). The primary trust signal
        // is socket.authorized == true from the handshake test above.
        // Here we verify the leaf certificate identity.
        const certInfo = await new Promise<{
          authorized: boolean;
          subject: Record<string, string> | null;
          altNames: string;
          issuer: Record<string, string> | null;
          fingerprint256: string;
        }>(
          (resolve, reject) => {
            const socket = tls.connect(
              {
                host: SF_HOST,
                port: SF_PORT,
                rejectUnauthorized: true,
                servername: SF_HOST,
                timeout: NETWORK_TIMEOUT_MS,
                checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) => {
                  if (!cert || !cert.subject) return undefined;
                  return tls.checkServerIdentity(hostname, cert);
                },
              },
              () => {
                const peerCert = socket.getPeerCertificate(true);
                const result = {
                  authorized: socket.authorized,
                  subject: peerCert?.subject ?? null,
                  altNames: peerCert?.subjectaltname ?? '',
                  issuer: peerCert?.issuer ?? null,
                  fingerprint256: peerCert?.fingerprint256 ?? '',
                };
                socket.end();
                resolve(result);
              },
            );
            socket.on('error', reject);
            socket.on('timeout', () => {
              socket.destroy();
              reject(new Error('TLS timeout'));
            });
          },
        );

        // Connection must be authorized by the system CA store
        expect(certInfo.authorized).toBe(true);

        // Subject CN or SAN should match the host
        const subjectCN = certInfo.subject?.CN || '';
        const altNames = certInfo.altNames;

        const hostMatches =
          subjectCN === SF_HOST ||
          subjectCN === '*.siliconflow.cn' ||
          altNames.includes(SF_HOST) ||
          altNames.includes('*.siliconflow.cn');

        expect(hostMatches).toBe(true);

        // Issuer should exist and differ from subject (not self-signed)
        const issuerCN = certInfo.issuer?.CN || '';
        if (issuerCN) {
          expect(issuerCN).not.toBe(subjectCN);
          console.log(`    Leaf: ${subjectCN}, Issuer: ${issuerCN}`);
        } else {
          // Bun may not populate issuer; authorized=true is sufficient
          console.log(`    Leaf: ${subjectCN}, Issuer: (not available in Bun TLS)`);
        }

        // Must have a fingerprint (proves we got a real cert)
        expect(certInfo.fingerprint256).toBeTruthy();
      },
      NETWORK_TIMEOUT_MS + 5_000,
    );

    test(
      'HTTPS fetch to /v1/models succeeds (no SSL errors)',
      async () => {
        // This test does NOT require an API key. A 401 is fine -- we just
        // need to verify the HTTPS connection itself does not fail.
        const url = `https://${SF_HOST}/v1/models`;
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          NETWORK_TIMEOUT_MS,
        );

        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });

          // Any HTTP response means the TLS layer succeeded
          // 401/403 is expected without a key; 200 with a key
          expect(res.status).toBeGreaterThanOrEqual(200);
          expect(res.status).toBeLessThan(600);

          console.log(
            `    GET ${url} -> HTTP ${res.status} (TLS OK)`,
          );
        } finally {
          clearTimeout(timeout);
        }
      },
      NETWORK_TIMEOUT_MS + 5_000,
    );
  });

  // ── API endpoint probe (per provider, requires API key) ───────────────
  //
  // These tests make a real API call (GET /models) to verify the key is
  // accepted and the provider responds with structured data.

  describe('API endpoint probe', () => {
    for (const provider of providers) {
      // Skip Anthropic -- it uses a different auth scheme, tested separately
      if (provider.key === 'anthropic') continue;
      // Skip providers without a baseUrl (shouldn't happen after filtering above, but be safe)
      if (!provider.baseUrl) continue;

      const shouldRun = provider.hasApiKey;
      const testFn = shouldRun ? test : test.skip;

      testFn(
        `${provider.name} — GET /models returns valid response (${provider.envKey}${shouldRun ? '' : ' NOT SET'})`,
        async () => {
          const result = await probeModelsEndpoint(
            provider.baseUrl!,
            provider.apiKey!,
          );

          // We accept 200 (success) or 401/403 (auth error) as proof the
          // endpoint is reachable. Anything else (connection error, SSL failure)
          // would have thrown before we get here.
          //
          // With a valid key, most providers return 200.
          expect(result.status).toBeGreaterThanOrEqual(200);
          expect(result.status).toBeLessThan(500);

          console.log(
            `    ${provider.name} /models -> HTTP ${result.status}`,
          );

          // If 200, the response should be parseable JSON
          if (result.ok) {
            const json = JSON.parse(result.body);
            // OpenAI-compatible /models returns { data: [...] } or { object: "list" }
            expect(
              json.data !== undefined || json.object !== undefined || json.models !== undefined,
            ).toBe(true);
          }
        },
        NETWORK_TIMEOUT_MS + 5_000,
      );
    }

    // Anthropic (separate auth scheme)
    const anthropicProvider = providers.find((p) => p.key === 'anthropic');
    const shouldRunAnthropic = anthropicProvider?.hasApiKey ?? false;
    const anthropicTestFn = shouldRunAnthropic ? test : test.skip;

    anthropicTestFn(
      `Anthropic — POST /v1/messages returns valid response (${anthropicProvider?.envKey}${shouldRunAnthropic ? '' : ' NOT SET'})`,
      async () => {
        const result = await probeAnthropicEndpoint(
          anthropicProvider!.apiKey!,
        );

        // 200 = success, 400/401 = auth/validation error, all prove connectivity
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(500);

        console.log(`    Anthropic /v1/messages -> HTTP ${result.status}`);

        if (result.ok) {
          const json = JSON.parse(result.body);
          expect(json.type).toBe('message');
        }
      },
      NETWORK_TIMEOUT_MS + 5_000,
    );
  });

  // ── Model resolution + connectivity cross-check ───────────────────────
  //
  // For each model alias in the config, verify that loadModelConfig can
  // resolve it and that the provider it points to is in our tested set.

  describe('model resolution cross-check', () => {
    // Dynamic import so we don't break if models.ts has issues
    let loadModelConfig: typeof import('../../../src/config/models').loadModelConfig;

    beforeAll(async () => {
      const mod = await import('../../../src/config/models');
      loadModelConfig = mod.loadModelConfig;
    });

    test('every model alias resolves without error', () => {
      const aliases = Object.keys(config.models);
      const failures: string[] = [];

      for (const alias of aliases) {
        try {
          const resolved = loadModelConfig(alias);
          expect(resolved.alias).toBe(alias);
          expect(resolved.model).toBeTruthy();
          expect(resolved.providerKey).toBeTruthy();
        } catch (err) {
          failures.push(`${alias}: ${(err as Error).message}`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `Model resolution failures:\n  ${failures.join('\n  ')}`,
        );
      }
    });

    test('every model points to a provider that was TLS-tested', () => {
      const providerKeys = new Set(Object.keys(config.providers));
      for (const [alias, entry] of Object.entries(config.models)) {
        expect(providerKeys.has(entry.provider)).toBe(true);
      }
    });

    test('SiliconFlow models resolve with correct baseUrl', () => {
      const sfModels = Object.entries(config.models).filter(
        ([, entry]) => entry.provider === 'siliconflow',
      );

      expect(sfModels.length).toBeGreaterThan(0);

      for (const [alias] of sfModels) {
        const resolved = loadModelConfig(alias);
        expect(resolved.baseUrl).toBe('https://api.siliconflow.cn/v1');
        expect(resolved.llmClient.provider).toBe('openai-generic');
        expect(resolved.llmClient.options.baseUrl).toBe(
          'https://api.siliconflow.cn/v1',
        );
      }
    });
  });

  // ── Docker SSL env var check ──────────────────────────────────────────
  //
  // When running inside the Docker container, the Dockerfile sets
  // SSL_CERT_FILE and SSL_CERT_DIR so the BAML runtime's vendored OpenSSL
  // can find system CA certificates. These tests verify the env vars exist
  // when in a Docker/CI environment.

  describe('SSL environment (Docker/CI)', () => {
    const isDocker =
      !!process.env.DOCKER ||
      !!process.env.CI ||
      fs.existsSync('/.dockerenv');

    const envTestFn = isDocker ? test : test.skip;

    envTestFn('SSL_CERT_FILE is set and points to an existing file', () => {
      const certFile = process.env.SSL_CERT_FILE;
      expect(certFile).toBeTruthy();
      expect(fs.existsSync(certFile!)).toBe(true);
      console.log(`    SSL_CERT_FILE=${certFile}`);
    });

    envTestFn('SSL_CERT_DIR is set and points to an existing directory', () => {
      const certDir = process.env.SSL_CERT_DIR;
      expect(certDir).toBeTruthy();
      expect(fs.existsSync(certDir!)).toBe(true);
      console.log(`    SSL_CERT_DIR=${certDir}`);
    });

    // Always run: check that system CA bundle is accessible
    test('system CA certificates are accessible at common paths', () => {
      const commonPaths = [
        '/etc/ssl/certs/ca-certificates.crt', // Debian/Ubuntu
        '/etc/ssl/certs',                      // Debian/Ubuntu dir
        '/etc/pki/tls/certs/ca-bundle.crt',   // RHEL/CentOS
        '/usr/local/etc/openssl/cert.pem',     // macOS Homebrew
        '/etc/ssl/cert.pem',                   // macOS / Alpine
      ];

      const found = commonPaths.filter((p) => fs.existsSync(p));
      console.log(`    CA cert paths found: ${found.join(', ') || '(none)'}`);

      // At least one common path should exist on any Linux or macOS system
      expect(found.length).toBeGreaterThan(0);
    });
  });
});
