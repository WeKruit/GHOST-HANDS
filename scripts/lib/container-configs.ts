/**
 * Hardcoded Container Configuration Definitions
 *
 * Defines the 3 GhostHands service containers (API, Worker, Deploy Server)
 * with their Docker create configs, health checks, drain endpoints,
 * and startup/shutdown ordering.
 *
 * These definitions replace docker-compose for deploy-server managed deploys.
 * The deploy-server uses these configs to create containers via Docker API.
 *
 * Environment variables are sourced from process.env (populated by docker-compose
 * env_file and/or AWS Secrets Manager), NOT from reading .env files on disk.
 * This avoids EACCES permission errors when the container user differs from
 * the file owner.
 *
 * @module scripts/lib/container-configs
 * @see WEK-80
 */

import type { ContainerCreateConfig } from './docker-client';

/** ECR registry base URL — reads from env, falls back to account default */
const ECR_REGISTRY = process.env.ECR_REGISTRY ?? '168495702277.dkr.ecr.us-east-1.amazonaws.com';
const ECR_REPOSITORY = process.env.ECR_REPOSITORY ?? 'ghosthands';

/**
 * Defines a deployable service container with health check,
 * drain, and ordering metadata.
 */
export interface ServiceDefinition {
  /** Container name (e.g., "ghosthands-api") */
  name: string;
  /** Docker Engine API container create config */
  config: ContainerCreateConfig;
  /** HTTP health check URL (e.g., "http://localhost:3100/health") */
  healthEndpoint?: string;
  /** Max milliseconds to wait for the container to become healthy */
  healthTimeout: number;
  /** Optional HTTP endpoint to POST for graceful drain before stop */
  drainEndpoint?: string;
  /** Max milliseconds to wait for drain to complete */
  drainTimeout: number;
  /** If true, skip this container during self-update (deploy-server) */
  skipOnSelfUpdate: boolean;
  /** Startup ordering — lower numbers start first */
  startOrder: number;
  /** Shutdown ordering — lower numbers stop first */
  stopOrder: number;
}

/**
 * Prefixes of environment variable names that should be passed through
 * to spawned containers. Only matching vars are forwarded — system vars
 * like PATH, HOME, etc. are excluded.
 */
const PASSTHROUGH_PREFIXES = [
  'DATABASE_', 'SUPABASE_', 'REDIS_', 'GH_', 'ANTHROPIC_', 'DEEPSEEK_',
  'SILICONFLOW_', 'OPENAI_', 'AWS_', 'ECR_', 'CORS_', 'NODE_ENV',
  'MAX_CONCURRENT_', 'JOB_DISPATCH_', 'GHOSTHANDS_', 'KASM_',
];

/**
 * Build env vars array from process.env for passing to new containers.
 * Filters to only include known GH/infra env vars (not system vars).
 *
 * @returns Array of environment variable strings (e.g., ["FOO=bar", "BAZ=qux"])
 */
export function getEnvVarsFromProcess(): string[] {
  const envVars: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && PASSTHROUGH_PREFIXES.some(p => key.startsWith(p))) {
      envVars.push(`${key}=${value}`);
    }
  }
  return envVars;
}

/**
 * Builds the full ECR image URI from a tag.
 *
 * @param imageTag - Image tag (e.g., "staging-abc1234" or "prod-def5678")
 * @returns Full ECR image URI
 */
function buildEcrImage(imageTag: string): string {
  return `${ECR_REGISTRY}/${ECR_REPOSITORY}:${imageTag}`;
}

/**
 * Builds the API service definition.
 */
function buildApiService(ecrImage: string, envVars: string[]): ServiceDefinition {
  return {
    name: 'ghosthands-api',
    config: {
      Image: ecrImage,
      Cmd: ['bun', 'packages/ghosthands/src/api/server.ts'],
      Env: [...envVars, 'GH_API_PORT=3100'],
      HostConfig: {
        NetworkMode: 'host',
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      Labels: {
        'gh.service': 'api',
        'gh.managed': 'true',
      },
    },
    healthEndpoint: 'http://localhost:3100/health',
    healthTimeout: 90_000,
    drainEndpoint: undefined,
    drainTimeout: 0,
    skipOnSelfUpdate: false,
    startOrder: 1,
    stopOrder: 3,
  };
}

/**
 * Builds the Worker service definition.
 */
function buildWorkerService(ecrImage: string, envVars: string[]): ServiceDefinition {
  return {
    name: 'ghosthands-worker',
    config: {
      Image: ecrImage,
      Cmd: ['bun', 'packages/ghosthands/src/workers/main.ts'],
      Env: [...envVars, 'GH_WORKER_PORT=3101', 'MAX_CONCURRENT_JOBS=1', 'GH_HEADLESS=false'],
      HostConfig: {
        NetworkMode: 'host',
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      Labels: {
        'gh.service': 'worker',
        'gh.managed': 'true',
      },
    },
    healthEndpoint: 'http://localhost:3101/worker/health',
    healthTimeout: 60_000,
    drainEndpoint: 'http://localhost:3101/worker/drain',
    drainTimeout: 60_000,
    skipOnSelfUpdate: false,
    startOrder: 2,
    stopOrder: 1, // First to stop — drain jobs before shutting down other services
  };
}

/**
 * Builds the Deploy Server service definition.
 */
function buildDeployServerService(ecrImage: string, envVars: string[]): ServiceDefinition {
  return {
    name: 'ghosthands-deploy-server',
    config: {
      Image: ecrImage,
      Cmd: ['bun', 'scripts/deploy-server.ts'],
      Env: [...envVars, 'GH_DEPLOY_PORT=8000', 'DOCKER_CONFIG_PATH=/docker-config/config.json'],
      HostConfig: {
        NetworkMode: 'host',
        Binds: [
          '/opt/ghosthands:/opt/ghosthands:ro',
          '/var/run/docker.sock:/var/run/docker.sock',
          '/home/ubuntu/.docker/config.json:/docker-config/config.json:ro',
        ],
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      Labels: {
        'gh.service': 'deploy-server',
        'gh.managed': 'true',
      },
    },
    healthEndpoint: 'http://localhost:8000/health',
    healthTimeout: 10_000,
    drainEndpoint: undefined,
    drainTimeout: 0,
    skipOnSelfUpdate: true,
    startOrder: 3,
    stopOrder: 2,
  };
}

/**
 * Returns all 3 GhostHands service definitions, sorted by startOrder.
 *
 * @param imageTag - ECR image tag (e.g., "staging-abc1234")
 * @param _environment - Target environment (reserved for future environment-specific overrides)
 * @returns Array of ServiceDefinition sorted by startOrder (ascending)
 */
export function getServiceConfigs(
  imageTag: string,
  _environment: 'staging' | 'production',
): ServiceDefinition[] {
  const ecrImage = buildEcrImage(imageTag);
  const envVars = getEnvVarsFromProcess();

  const services: ServiceDefinition[] = [
    buildApiService(ecrImage, envVars),
    buildWorkerService(ecrImage, envVars),
    buildDeployServerService(ecrImage, envVars),
  ];

  return services.sort((a, b) => a.startOrder - b.startOrder);
}
