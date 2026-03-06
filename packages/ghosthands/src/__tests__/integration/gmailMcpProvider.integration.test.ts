import { afterEach, describe, expect, test } from 'bun:test';
import { GmailMcpClient } from '../../workers/emailVerification/gmailMcpClient.js';
import { GmailMcpProvider } from '../../workers/emailVerification/gmailMcpProvider.js';

describe('Gmail MCP integration (HTTP transport)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('discovers tools and extracts verification signal from search results', async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || '{}'));
      const id = payload.id;

      if (payload.method === 'initialize') {
        return Response.json(
          { jsonrpc: '2.0', id, result: { capabilities: {} } },
          { headers: { 'mcp-session-id': 'session-1' } },
        );
      }

      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }

      if (payload.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              { name: 'gmail.search', description: 'Search Gmail messages' },
              { name: 'gmail.read', description: 'Read Gmail message' },
            ],
          },
        });
      }

      if (payload.method === 'tools/call' && payload.params?.name === 'gmail.search') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            structuredContent: {
              messages: [
                {
                  id: 'msg-1',
                  subject: 'Please verify your account',
                  snippet: 'Click https://example.com/verify?token=abc123 to continue',
                  receivedAt: new Date().toISOString(),
                },
              ],
            },
          },
        });
      }

      if (payload.method === 'tools/call' && payload.params?.name === 'gmail.read') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: 'Your verification code is 123456',
              },
            ],
          },
        });
      }

      return Response.json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    }) as typeof fetch;

    const client = new GmailMcpClient({
      transport: {
        type: 'http',
        url: 'https://mcp.example.test',
      },
      timeoutMs: 3000,
    });

    const provider = new GmailMcpProvider({ client });

    const signal = await provider.findLatestVerificationSignal({
      loginEmail: 'test@example.com',
      lookbackMinutes: 15,
    });

    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe('link');
    expect(signal?.link).toContain('https://example.com/verify');

    await provider.close();
  });
});
