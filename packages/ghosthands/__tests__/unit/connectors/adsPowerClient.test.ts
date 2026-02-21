import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { AdsPowerClient } from '../../../src/connectors/AdsPowerClient';

// ── Mock fetch ───────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AdsPowerClient', () => {
  let client: AdsPowerClient;

  beforeEach(() => {
    client = new AdsPowerClient({
      baseUrl: 'http://local.adspower.net:50325',
    });
  });

  describe('startBrowser', () => {
    test('returns cdpUrl and debugPort on success', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            ws: {
              puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc123',
              selenium: 'http://127.0.0.1:9222',
            },
            debug_port: '9222',
          },
        }),
      );

      const result = await client.startBrowser('profile-1');

      expect(result.cdpUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc123');
      expect(result.debugPort).toBe('9222');
    });

    test('calls correct API URL with user_id', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc' },
            debug_port: '9222',
          },
        }),
      );

      await client.startBrowser('my-profile');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/v1/browser/start');
      expect(calledUrl).toContain('user_id=my-profile');
    });

    test('includes api_key when configured', async () => {
      const authClient = new AdsPowerClient({
        baseUrl: 'http://local.adspower.net:50325',
        apiKey: 'secret-key-123',
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc' },
            debug_port: '9222',
          },
        }),
      );

      await authClient.startBrowser('profile-1');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api_key=secret-key-123');
    });

    test('throws when API returns non-zero code', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: -1,
          msg: 'Profile not found',
        }),
      );

      await expect(client.startBrowser('bad-profile')).rejects.toThrow(
        'AdsPower startBrowser failed (code=-1): Profile not found',
      );
    });

    test('throws when CDP URL is missing from response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: { ws: {}, debug_port: '9222' },
        }),
      );

      await expect(client.startBrowser('profile-1')).rejects.toThrow(
        'missing CDP URL',
      );
    });

    test('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.startBrowser('profile-1')).rejects.toThrow(
        'AdsPower API HTTP error: 500',
      );
    });

    test('throws on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.startBrowser('profile-1')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('stopBrowser', () => {
    test('resolves on success', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: 'success' }),
      );

      await expect(client.stopBrowser('profile-1')).resolves.toBeUndefined();
    });

    test('calls correct API URL with user_id', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: 'success' }),
      );

      await client.stopBrowser('profile-2');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/v1/browser/stop');
      expect(calledUrl).toContain('user_id=profile-2');
    });

    test('throws when API returns non-zero code', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ code: -1, msg: 'Browser not running' }),
      );

      await expect(client.stopBrowser('profile-1')).rejects.toThrow(
        'AdsPower stopBrowser failed (code=-1): Browser not running',
      );
    });
  });

  describe('isActive', () => {
    test('returns true when browser is active', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: { status: 'Active' },
        }),
      );

      const result = await client.isActive('profile-1');
      expect(result).toBe(true);
    });

    test('returns false when browser is inactive', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: { status: 'Inactive' },
        }),
      );

      const result = await client.isActive('profile-1');
      expect(result).toBe(false);
    });

    test('returns false when API returns error code', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ code: -1, msg: 'Profile not found' }),
      );

      const result = await client.isActive('bad-profile');
      expect(result).toBe(false);
    });

    test('calls correct API URL', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ code: 0, msg: 'success', data: { status: 'Active' } }),
      );

      await client.isActive('profile-3');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/v1/browser/active');
      expect(calledUrl).toContain('user_id=profile-3');
    });
  });

  describe('URL construction', () => {
    test('strips trailing slash from baseUrl', async () => {
      const trailingSlashClient = new AdsPowerClient({
        baseUrl: 'http://localhost:50325/',
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc' },
            debug_port: '9222',
          },
        }),
      );

      await trailingSlashClient.startBrowser('p1');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('//api');
    });
  });
});
