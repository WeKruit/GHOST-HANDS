/**
 * WEK-78: Docker Engine API Client Tests
 *
 * Unit tests for the Docker Engine API client module.
 * All tests use mocked fetch to avoid requiring an actual Docker daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pullImage,
  stopContainer,
  removeContainer,
  createContainer,
  startContainer,
  inspectContainer,
  listContainers,
  pruneImages,
  dockerClient,
  DockerApiError,
  setFetchImpl,
  type ContainerCreateConfig,
  type ContainerInspect,
  type ContainerListItem,
} from '../../../../scripts/lib/docker-client';

/**
 * Mock Response object that mimics a standard Fetch Response.
 */
class MockResponse implements Partial<Response> {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream | null;
  private _body: string | null;
  private _jsonBody: unknown;

  constructor(
    options: { ok: boolean; status: number; body?: string | unknown; streamBody?: ReadableStream },
  ) {
    this.ok = options.ok;
    this.status = options.status;
    this.headers = new Headers();
    this.body = options.streamBody ?? null;

    if (options.streamBody === undefined && typeof options.body === 'string') {
      this._body = options.body;
      this._jsonBody = null;
    } else if (options.streamBody === undefined && options.body !== undefined) {
      this._body = JSON.stringify(options.body);
      this._jsonBody = options.body;
    } else {
      this._body = null;
      this._jsonBody = null;
    }
  }

  async text(): Promise<string> {
    return this._body ?? '';
  }

  async json(): Promise<unknown> {
    return this._jsonBody ?? JSON.parse(this._body ?? '{}');
  }
}

// Track all fetch calls
const fetchCalls: Array<{ url: string; options: RequestInit }> = [];

// Mock global fetch — default implementation tracks calls and returns 200 OK
const mockFetch = vi.fn<typeof fetch>(async (input, init = {}) => {
  const url = input.toString();
  fetchCalls.push({ url, options: init });
  return new MockResponse({ ok: true, status: 200, body: '{}' }) as unknown as Response;
});

/**
 * Queue a specific response for the next fetch call.
 * Uses mockImplementationOnce (not mockResolvedValueOnce) so that
 * fetchCalls tracking still works.
 */
function queueResponse(response: MockResponse): void {
  mockFetch.mockImplementationOnce(async (input: any, init: any = {}) => {
    fetchCalls.push({ url: input.toString(), options: init });
    return response as unknown as Response;
  });
}

beforeEach(() => {
  fetchCalls.length = 0;
  mockFetch.mockClear();
  setFetchImpl(mockFetch);
});

afterEach(() => {
  setFetchImpl(fetch);
});

describe('pullImage', () => {
  test('requests image pull from Docker API', async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"Pulling"}'));
        controller.close();
      },
    });

    queueResponse(new MockResponse({ ok: true, status: 200, streamBody: mockStream }));

    await pullImage('alpine', 'latest');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/images/create?fromImage=alpine&tag=latest');
    expect(fetchCalls[0].options.method).toBe('POST');
  });

  test('includes auth header when provided', async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    queueResponse(new MockResponse({ ok: true, status: 200, streamBody: mockStream }));

    const auth = btoa(JSON.stringify({ username: 'user', password: 'pass' }));
    await pullImage('myimage', 'v1.0', auth);

    expect(fetchCalls[0].options.headers).toEqual({
      'X-Registry-Auth': auth,
    });
  });

  test('consumes entire stream before resolving', async () => {
    const chunks = ['{"status":"pulling"}', '{"status":"done"}', '{}'];
    const mockStream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    queueResponse(new MockResponse({ ok: true, status: 200, streamBody: mockStream }));

    await pullImage('alpine', 'latest'); // should not throw
  });

  test('throws DockerApiError on failure', async () => {
    queueResponse(new MockResponse({ ok: false, status: 500, body: { message: 'Internal server error' } }));

    await expect(pullImage('alpine', 'latest')).rejects.toThrow(DockerApiError);
  });

  test('encodes image and tag correctly', async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    queueResponse(new MockResponse({ ok: true, status: 200, streamBody: mockStream }));

    await pullImage('my.registry.com/my-image', 'special/tag');

    expect(fetchCalls[0].url).toContain('fromImage=my.registry.com%2Fmy-image');
    expect(fetchCalls[0].url).toContain('tag=special%2Ftag');
  });
});

describe('stopContainer', () => {
  test('requests container stop', async () => {
    queueResponse(new MockResponse({ ok: true, status: 204, body: '' }));

    await stopContainer('my-container', 30);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/containers/my-container/stop?t=30');
    expect(fetchCalls[0].options.method).toBe('POST');
  });

  test('uses default timeout of 30 seconds', async () => {
    queueResponse(new MockResponse({ ok: true, status: 204, body: '' }));

    await stopContainer('my-container');

    expect(fetchCalls[0].url).toContain('t=30');
  });

  test('ignores 304 (already stopped)', async () => {
    queueResponse(new MockResponse({ ok: false, status: 304, body: '' }));

    await stopContainer('my-container'); // should not throw
  });

  test('ignores 404 (container not found)', async () => {
    queueResponse(new MockResponse({ ok: false, status: 404, body: { message: 'No such container' } }));

    await stopContainer('my-container'); // should not throw
  });

  test('throws DockerApiError on other errors', async () => {
    queueResponse(new MockResponse({ ok: false, status: 500, body: { message: 'Server error' } }));

    await expect(stopContainer('my-container')).rejects.toThrow(DockerApiError);
  });

  test('encodes container name correctly', async () => {
    queueResponse(new MockResponse({ ok: true, status: 204, body: '' }));

    await stopContainer('my/special-container');

    expect(fetchCalls[0].url).toContain('/containers/my%2Fspecial-container/stop');
  });
});

describe('removeContainer', () => {
  test('requests container removal with force', async () => {
    queueResponse(new MockResponse({ ok: true, status: 204, body: '' }));

    await removeContainer('my-container');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/containers/my-container?force=true&v=true');
    expect(fetchCalls[0].options.method).toBe('POST');
  });

  test('ignores 404 (container not found)', async () => {
    queueResponse(new MockResponse({ ok: false, status: 404, body: { message: 'No such container' } }));

    await removeContainer('my-container'); // should not throw
  });

  test('throws DockerApiError on other errors', async () => {
    queueResponse(new MockResponse({ ok: false, status: 409, body: { message: 'Conflict' } }));

    await expect(removeContainer('my-container')).rejects.toThrow(DockerApiError);
  });
});

describe('createContainer', () => {
  const mockConfig: ContainerCreateConfig = {
    Image: 'alpine:latest',
    Cmd: ['/bin/sh'],
    Env: ['FOO=bar'],
    HostConfig: {
      NetworkMode: 'host',
      Binds: ['/host/path:/container/path'],
      RestartPolicy: { Name: 'always' },
    },
    Labels: { 'app': 'test' },
    Healthcheck: {
      Test: ['CMD-SHELL', 'true'],
      Interval: 5_000_000_000,
      Timeout: 3_000_000_000,
      Retries: 3,
      StartPeriod: 10_000_000_000,
    },
  };

  test('requests container creation', async () => {
    queueResponse(new MockResponse({ ok: true, status: 201, body: { Id: 'abc123def456' } }));

    const containerId = await createContainer('test-container', mockConfig);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/containers/create?name=test-container');
    expect(fetchCalls[0].options.method).toBe('POST');
    expect(fetchCalls[0].options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(containerId).toBe('abc123def456');
  });

  test('sends config as JSON body', async () => {
    queueResponse(new MockResponse({ ok: true, status: 201, body: { Id: 'container-id' } }));

    await createContainer('test-container', mockConfig);

    const bodyStr = fetchCalls[0].options.body as string;
    const body = JSON.parse(bodyStr);

    expect(body.Image).toBe('alpine:latest');
    expect(body.Cmd).toEqual(['/bin/sh']);
    expect(body.HostConfig.NetworkMode).toBe('host');
  });

  test('throws DockerApiError on failure', async () => {
    queueResponse(new MockResponse({ ok: false, status: 500, body: { message: 'Create failed' } }));

    await expect(createContainer('test-container', mockConfig)).rejects.toThrow(DockerApiError);
  });

  test('handles minimal config', async () => {
    const minimalConfig: ContainerCreateConfig = {
      Image: 'alpine:latest',
      HostConfig: { NetworkMode: 'host' },
    };

    queueResponse(new MockResponse({ ok: true, status: 201, body: { Id: 'minimal-id' } }));

    const id = await createContainer('minimal', minimalConfig);
    expect(id).toBe('minimal-id');
  });
});

describe('startContainer', () => {
  test('requests container start', async () => {
    queueResponse(new MockResponse({ ok: true, status: 204, body: '' }));

    await startContainer('my-container');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/containers/my-container/start');
    expect(fetchCalls[0].options.method).toBe('POST');
  });

  test('ignores 304 (already running)', async () => {
    queueResponse(new MockResponse({ ok: false, status: 304, body: '' }));

    await startContainer('my-container'); // should not throw
  });

  test('throws DockerApiError on failure', async () => {
    queueResponse(new MockResponse({ ok: false, status: 500, body: { message: 'Start failed' } }));

    await expect(startContainer('my-container')).rejects.toThrow(DockerApiError);
  });
});

describe('inspectContainer', () => {
  const mockInspect: ContainerInspect = {
    Id: 'abc123def456',
    Name: 'test-container',
    State: {
      Status: 'running',
      Running: true,
      Health: { Status: 'healthy' },
    },
    Config: {
      Image: 'alpine:latest',
      Env: ['PATH=/'],
      Labels: { 'app': 'test' },
    },
  };

  test('requests container inspection', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: mockInspect }));

    const result = await inspectContainer('my-container');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/containers/my-container/json');
    expect(fetchCalls[0].options.method).toBe('GET');
    expect(result).toEqual(mockInspect);
  });

  test('throws DockerApiError on 404', async () => {
    queueResponse(new MockResponse({ ok: false, status: 404, body: { message: 'No such container' } }));

    await expect(inspectContainer('nonexistent')).rejects.toThrow(DockerApiError);
  });

  test('returns typed ContainerInspect', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: mockInspect }));

    const result = await inspectContainer('my-container');

    expect(result.Id).toBe('abc123def456');
    expect(result.State.Running).toBe(true);
    expect(result.State.Health?.Status).toBe('healthy');
    expect(result.Config.Image).toBe('alpine:latest');
  });
});

describe('listContainers', () => {
  const mockContainers: ContainerListItem[] = [
    {
      Id: 'abc123',
      Names: ['/container1'],
      Image: 'alpine:latest',
      State: 'running',
      Status: 'Up 2 hours',
      Labels: { 'app': 'test' },
    },
    {
      Id: 'def456',
      Names: ['/container2'],
      Image: 'nginx:latest',
      State: 'exited',
      Status: 'Exited (0) 1 hour ago',
      Labels: {},
    },
  ];

  test('requests container list', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: mockContainers }));

    const result = await listContainers();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/containers/json?all=false');
    expect(fetchCalls[0].options.method).toBe('GET');
    expect(result).toEqual(mockContainers);
  });

  test('includes stopped containers when all=true', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: mockContainers }));

    await listContainers(true);

    expect(fetchCalls[0].url).toContain('all=true');
  });

  test('excludes stopped containers by default', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: [] }));

    await listContainers();

    expect(fetchCalls[0].url).toContain('all=false');
  });

  test('returns empty array when no containers', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: [] }));

    const result = await listContainers();
    expect(result).toEqual([]);
  });
});

describe('pruneImages', () => {
  test('requests image prune', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: { SpaceReclaimed: 1024 * 1024 } }));

    const result = await pruneImages();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/images/prune?filters=');
    expect(fetchCalls[0].url).toContain('dangling');
    expect(fetchCalls[0].options.method).toBe('POST');
    expect(result.spaceReclaimed).toBe(1024 * 1024);
  });

  test('handles missing SpaceReclaimed', async () => {
    queueResponse(new MockResponse({ ok: true, status: 200, body: {} }));

    const result = await pruneImages();
    expect(result.spaceReclaimed).toBe(0);
  });

  test('throws DockerApiError on failure', async () => {
    queueResponse(new MockResponse({ ok: false, status: 500, body: { message: 'Prune failed' } }));

    await expect(pruneImages()).rejects.toThrow(DockerApiError);
  });
});

describe('dockerClient export', () => {
  test('exports all functions as a single object', () => {
    expect(dockerClient.pullImage).toBe(pullImage);
    expect(dockerClient.stopContainer).toBe(stopContainer);
    expect(dockerClient.removeContainer).toBe(removeContainer);
    expect(dockerClient.createContainer).toBe(createContainer);
    expect(dockerClient.startContainer).toBe(startContainer);
    expect(dockerClient.inspectContainer).toBe(inspectContainer);
    expect(dockerClient.listContainers).toBe(listContainers);
    expect(dockerClient.pruneImages).toBe(pruneImages);
  });
});

describe('DockerApiError', () => {
  test('creates error with status code', () => {
    const error = new DockerApiError('Test error', 404);
    expect(error.name).toBe('DockerApiError');
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(404);
    expect(error.dockerMessage).toBeUndefined();
  });

  test('includes Docker message when provided', () => {
    const error = new DockerApiError('Test error', 500, 'Internal server error');
    expect(error.dockerMessage).toBe('Internal server error');
  });
});

describe('error handling for various status codes', () => {
  const setupMock = (status: number, body: unknown = { message: 'Error' }) => {
    queueResponse(new MockResponse({ ok: status < 300, status, body }));
  };

  test('handles 404 correctly', async () => {
    setupMock(404, { message: 'Not found' });
    await expect(listContainers()).rejects.toThrow(/404/);
  });

  test('handles 409 correctly', async () => {
    setupMock(409, { message: 'Conflict' });
    await expect(listContainers()).rejects.toThrow(DockerApiError);
  });

  test('handles 500 correctly', async () => {
    setupMock(500, { message: 'Internal error' });
    await expect(listContainers()).rejects.toThrow(DockerApiError);
  });

  test('handles non-JSON error response', async () => {
    queueResponse(new MockResponse({ ok: false, status: 500, body: 'Plain text error' }));

    await expect(listContainers()).rejects.toThrow(DockerApiError);
  });
});
