import { describe, expect, it } from 'bun:test';
import { buildAnthropicClientOptions } from '../../../src/workers/taskHandlers/formFiller';

describe('formFiller Anthropic client config', () => {
  it('prefers explicit proxy-backed client config when provided', () => {
    const options = buildAnthropicClientOptions({
      apiKey: 'managed-runtime-token',
      baseURL: 'https://valet.example.com/api/v1/local-workers/anthropic',
      defaultHeaders: {
        'x-local-worker-session': 'session-token',
      },
    });

    expect(options).toEqual({
      apiKey: 'managed-runtime-token',
      baseURL: 'https://valet.example.com/api/v1/local-workers/anthropic',
      defaultHeaders: {
        'x-local-worker-session': 'session-token',
      },
    });
  });

  it('falls back to Anthropic env defaults when no explicit config is supplied', () => {
    expect(buildAnthropicClientOptions()).toBeUndefined();
  });

  it('rejects non-http Anthropic base URLs', () => {
    expect(() =>
      buildAnthropicClientOptions({
        apiKey: 'managed-runtime-token',
        baseURL: 'file:///tmp/evil',
      }),
    ).toThrow('Anthropic client baseURL must use http or https');
  });

  it('drops disallowed default headers', () => {
    const options = buildAnthropicClientOptions({
      apiKey: 'managed-runtime-token',
      baseURL: 'https://valet.example.com/api/v1/local-workers/inference',
      defaultHeaders: {
        Authorization: 'Bearer should-be-ignored',
        'x-api-key': 'should-be-ignored',
        'x-local-worker-session': 'session-token',
      },
    });

    expect(options).toEqual({
      apiKey: 'managed-runtime-token',
      baseURL: 'https://valet.example.com/api/v1/local-workers/inference',
      defaultHeaders: {
        'x-local-worker-session': 'session-token',
      },
    });
  });
});
