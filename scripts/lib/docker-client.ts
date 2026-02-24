/**
 * Docker Engine API Client Module
 *
 * Provides typed functions for interacting with the Docker daemon via
 * unix socket (/var/run/docker.sock). Replaces Docker CLI commands with
 * native HTTP requests using Bun's built-in unix socket support.
 *
 * @module scripts/lib/docker-client
 */

/**
 * Fetch function for making HTTP requests to Docker Engine API.
 * Can be replaced for testing purposes.
 */
let fetchImpl: typeof fetch = fetch;

/**
 * Sets a custom fetch implementation (primarily for testing).
 *
 * @param customFetch - Custom fetch function to use
 */
export function setFetchImpl(customFetch: typeof fetch): void {
  fetchImpl = customFetch;
  // Debug logging to verify the mock is being set (for tests)
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    console.log('[docker-client] setFetchImpl called, custom fetch:', typeof customFetch);
  }
}

/**
 * Configuration for creating a Docker container.
 *
 * @see https://docs.docker.com/engine/api/v1.44/#tag/Container/operation/ContainerCreate
 */
export interface ContainerCreateConfig {
  /** Image name (e.g., 'alpine:latest') */
  Image: string;
  /** Command to run in the container */
  Cmd?: string[];
  /** Environment variables (e.g., ['FOO=bar']) */
  Env?: string[];
  /** Exposed ports mapping (e.g., { '8080/tcp': {} }) */
  ExposedPorts?: Record<string, {}>;
  /** Host-specific configuration */
  HostConfig: {
    /** Network mode (must be 'host' for this deployment) */
    NetworkMode: 'host';
    /** Volume bindings (e.g., ['/host/path:/container/path']) */
    Binds?: string[];
    /** Restart policy */
    RestartPolicy?: {
      Name: string;
      MaximumRetryCount?: number;
    };
  };
  /** Container labels as key-value pairs */
  Labels?: Record<string, string>;
  /** Health check configuration */
  Healthcheck?: {
    /** Test command (e.g., ['CMD', 'curl', '-f', 'http://localhost:3000']) */
    Test: string[];
    /** Interval between checks in nanoseconds */
    Interval: number;
    /** Timeout for each check in nanoseconds */
    Timeout: number;
    /** Number of consecutive failures before unhealthy */
    Retries: number;
    /** Start period before retries count in nanoseconds */
    StartPeriod: number;
  };
}

/**
 * Container inspection result.
 *
 * @see https://docs.docker.com/engine/api/v1.44/#tag/Container/operation/ContainerInspect
 */
export interface ContainerInspect {
  /** Container ID */
  Id: string;
  /** Container name (without leading '/') */
  Name: string;
  /** Container state information */
  State: {
    /** Overall status (e.g., 'running', 'exited', 'created') */
    Status: string;
    /** Whether the container is running */
    Running: boolean;
    /** Health status if healthcheck configured */
    Health?: {
      Status: string;
    };
  };
  /** Container configuration */
  Config: {
    /** Image name */
    Image: string;
    /** Environment variables */
    Env: string[];
    /** Container labels */
    Labels: Record<string, string>;
  };
}

/**
 * Container list item.
 *
 * @see https://docs.docker.com/engine/api/v1.44/#tag/Container/operation/ContainerList
 */
export interface ContainerListItem {
  /** Container ID (full) */
  Id: string;
  /** Container names (with leading '/') */
  Names: string[];
  /** Image name */
  Image: string;
  /** Container state (e.g., 'running', 'exited') */
  State: string;
  /** Human-readable status (e.g., 'Up 2 hours') */
  Status: string;
  /** Container labels */
  Labels: Record<string, string>;
}

/**
 * Docker API error response structure.
 */
interface DockerErrorResponse {
  message: string;
}

/** Default timeout for pull operations in milliseconds */
const PULL_TIMEOUT_MS = 120_000;

/** Default timeout for stop operations in milliseconds */
const STOP_TIMEOUT_MS = 60_000;

/** Default timeout for other operations in milliseconds */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Unix socket path to Docker daemon */
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

/** Docker API base URL */
const DOCKER_API_BASE = 'http://localhost';

/**
 * Base URL for logging purposes
 */
const LOG_BASE_URL = DOCKER_API_BASE;

/**
 * Error thrown when Docker API returns an error response.
 */
export class DockerApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly dockerMessage?: string,
  ) {
    super(message);
    this.name = 'DockerApiError';
  }
}

/**
 * Makes an HTTP request to the Docker Engine API via unix socket.
 *
 * @param path - API path (e.g., '/containers/json')
 * @param options - Fetch options
 * @param timeoutMs - Request timeout in milliseconds
 * @returns Response object
 * @throws DockerApiError on API errors
 */
async function dockerFetch(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  console.log(`[docker-client] ${fetchOptions.method || 'GET'} ${LOG_BASE_URL}${path}`);

  try {
    const response = await fetchImpl(`${DOCKER_API_BASE}${path}`, {
      ...fetchOptions,
      // @ts-expect-error — Bun supports unix sockets via fetch
      unix: DOCKER_SOCKET,
      signal: AbortSignal.timeout(timeoutMs),
    });

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DockerApiError(
        `Docker API request timeout after ${timeoutMs}ms: ${fetchOptions.method || 'GET'} ${path}`,
        408,
      );
    }
    throw error;
  }
}

/**
 * Parses Docker API error response and throws a typed error.
 *
 * @param response - Response object from Docker API
 * @throws DockerApiError on error responses
 */
async function ensureSuccess(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const status = response.status;
  let dockerMessage: string | undefined;
  let message = `Docker API error: ${status}`;

  try {
    const errorBody = (await response.json()) as DockerErrorResponse;
    dockerMessage = errorBody.message;
    message += ` - ${dockerMessage}`;
  } catch {
    // Response body not JSON or empty
  }

  // Handle specific error codes
  switch (status) {
    case 304:
      // Not modified - container already in desired state
      console.log(`[docker-client] Ignoring 304: ${message}`);
      return;
    case 404:
      throw new DockerApiError(message, 404, dockerMessage);
    case 409:
      throw new DockerApiError(message, 409, dockerMessage);
    case 500:
      throw new DockerApiError(message, 500, dockerMessage);
    default:
      throw new DockerApiError(message, status, dockerMessage);
  }
}

/**
 * Pulls a Docker image from a registry.
 *
 * @param image - Image name (e.g., 'alpine')
 * @param tag - Image tag (e.g., 'latest')
 * @param auth - Base64-encoded auth config for private registries (optional)
 * @throws DockerApiError on pull failure
 */
export async function pullImage(
  image: string,
  tag: string,
  auth?: string,
): Promise<void> {
  const path = `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`;
  const headers: HeadersInit = {};
  if (auth) {
    headers['X-Registry-Auth'] = auth;
  }

  const response = await dockerFetch(path, {
    method: 'POST',
    headers,
    timeoutMs: PULL_TIMEOUT_MS,
  });

  // Consume the entire stream to ensure pull completes
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  await ensureSuccess(response);
  console.log(`[docker-client] Pulled image: ${image}:${tag}`);
}

/**
 * Stops a running container.
 *
 * @param nameOrId - Container name or ID
 * @param timeout - Timeout in seconds (default: 30)
 * @throws DockerApiError on failure (ignores 304, 404)
 */
export async function stopContainer(nameOrId: string, timeout: number = 30): Promise<void> {
  const path = `/containers/${encodeURIComponent(nameOrId)}/stop?t=${timeout}`;

  const response = await dockerFetch(path, {
    method: 'POST',
    timeoutMs: STOP_TIMEOUT_MS,
  });

  // Ignore 304 (already stopped) and 404 (doesn't exist)
  if (response.status === 304 || response.status === 404) {
    console.log(`[docker-client] Container ${nameOrId} ${response.status === 304 ? 'already stopped' : 'not found'}`);
    return;
  }

  await ensureSuccess(response);
  console.log(`[docker-client] Stopped container: ${nameOrId}`);
}

/**
 * Removes a container.
 *
 * @param nameOrId - Container name or ID
 * @throws DockerApiError on failure (ignores 404)
 */
export async function removeContainer(nameOrId: string): Promise<void> {
  const path = `/containers/${encodeURIComponent(nameOrId)}?force=true&v=true`;

  const response = await dockerFetch(path, {
    method: 'DELETE',
  });

  // Ignore 404 (doesn't exist)
  if (response.status === 404) {
    console.log(`[docker-client] Container ${nameOrId} not found, skipping removal`);
    return;
  }

  await ensureSuccess(response);
  console.log(`[docker-client] Removed container: ${nameOrId}`);
}

/**
 * Creates a new container without starting it.
 *
 * @param name - Container name
 * @param config - Container configuration
 * @returns Container ID
 * @throws DockerApiError on creation failure
 */
export async function createContainer(
  name: string,
  config: ContainerCreateConfig,
): Promise<string> {
  const path = `/containers/create?name=${encodeURIComponent(name)}`;

  const response = await dockerFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  await ensureSuccess(response);

  const body = (await response.json()) as { Id: string };
  console.log(`[docker-client] Created container: ${name} (${body.Id})`);

  return body.Id;
}

/**
 * Starts a container.
 *
 * @param nameOrId - Container name or ID
 * @throws DockerApiError on failure (ignores 304)
 */
export async function startContainer(nameOrId: string): Promise<void> {
  const path = `/containers/${encodeURIComponent(nameOrId)}/start`;

  const response = await dockerFetch(path, {
    method: 'POST',
  });

  // Ignore 304 (already running)
  if (response.status === 304) {
    console.log(`[docker-client] Container ${nameOrId} already running`);
    return;
  }

  await ensureSuccess(response);
  console.log(`[docker-client] Started container: ${nameOrId}`);
}

/**
 * Inspects a container to get detailed information.
 *
 * @param nameOrId - Container name or ID
 * @returns Container inspection data
 * @throws DockerApiError on failure
 */
export async function inspectContainer(nameOrId: string): Promise<ContainerInspect> {
  const path = `/containers/${encodeURIComponent(nameOrId)}/json`;

  const response = await dockerFetch(path, {
    method: 'GET',
  });

  await ensureSuccess(response);

  const body = (await response.json()) as ContainerInspect;
  return body;
}

/**
 * Lists containers.
 *
 * @param all - Whether to include stopped containers (default: false)
 * @returns List of containers
 * @throws DockerApiError on failure
 */
export async function listContainers(all: boolean = false): Promise<ContainerListItem[]> {
  const path = `/containers/json?all=${all ? 'true' : 'false'}`;

  const response = await dockerFetch(path, {
    method: 'GET',
  });

  await ensureSuccess(response);

  const body = (await response.json()) as ContainerListItem[];
  return body;
}

/**
 * Prunes dangling (untagged) images.
 *
 * @returns Object with space reclaimed in bytes
 * @throws DockerApiError on failure
 */
export async function pruneImages(): Promise<{ spaceReclaimed: number }> {
  const path = '/images/prune?filters=' + encodeURIComponent(JSON.stringify({ dangling: ['true'] }));

  const response = await dockerFetch(path, {
    method: 'POST',
  });

  await ensureSuccess(response);

  const body = (await response.json()) as { SpaceReclaimed?: number };
  const spaceReclaimed = body.SpaceReclaimed ?? 0;

  console.log(`[docker-client] Pruned images, reclaimed ${spaceReclaimed} bytes`);

  return { spaceReclaimed };
}

/**
 * Re-exports all functions and types for convenient imports.
 */
export const dockerClient = {
  pullImage,
  stopContainer,
  removeContainer,
  createContainer,
  startContainer,
  inspectContainer,
  listContainers,
  pruneImages,
};
