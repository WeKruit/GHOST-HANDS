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
});
