/**
 * WEK-92: CI/CD Pipeline Tests
 *
 * Validates the CI/CD workflow YAML structure, deploy scripts,
 * and REQUIRED_SECRETS documentation.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(__dirname, '../../../../');

// ── Helpers ─────────────────────────────────────────────────────

function readFile(relativePath: string): string {
  const fullPath = resolve(ROOT, relativePath);
  return readFileSync(fullPath, 'utf-8');
}

function fileExists(relativePath: string): boolean {
  return existsSync(resolve(ROOT, relativePath));
}

function isExecutable(relativePath: string): boolean {
  const fullPath = resolve(ROOT, relativePath);
  if (!existsSync(fullPath)) return false;
  const stat = statSync(fullPath);
  return (stat.mode & 0o111) !== 0; // any execute bit
}

// ── CI/CD Workflow Validation ────────────────────────────────────

describe('CI/CD Workflow (ci.yml)', () => {
  const ciYaml = readFile('.github/workflows/ci.yml');
  const ci = parseYaml(ciYaml);

  test('is valid YAML', () => {
    expect(ci).toBeDefined();
    expect(ci.name).toBe('CI/CD');
  });

  test('triggers on push to main and staging only', () => {
    expect(ci.on.push.branches).toContain('main');
    expect(ci.on.push.branches).toContain('staging');
    expect(ci.on.push.branches).toHaveLength(2);
  });

  test('triggers on PRs to main and staging', () => {
    expect(ci.on.pull_request.branches).toContain('main');
    expect(ci.on.pull_request.branches).toContain('staging');
  });

  test('has concurrency control', () => {
    expect(ci.concurrency).toBeDefined();
    expect(ci.concurrency['cancel-in-progress']).toBe(true);
  });

  test('has all required jobs', () => {
    const jobs = Object.keys(ci.jobs);
    expect(jobs).toContain('typecheck');
    expect(jobs).toContain('test-unit');
    expect(jobs).toContain('test-integration');
    expect(jobs).toContain('docker');
    expect(jobs).toContain('deploy-staging');
    expect(jobs).toContain('deploy-asg');
    expect(jobs).toContain('deploy-production');
  });

  test('docker job only runs on push (not PRs)', () => {
    expect(ci.jobs.docker.if).toContain("push");
  });

  test('docker job depends on typecheck and test-unit', () => {
    expect(ci.jobs.docker.needs).toContain('typecheck');
    expect(ci.jobs.docker.needs).toContain('test-unit');
  });

  test('docker job outputs image_tag and environment', () => {
    expect(ci.jobs.docker.outputs).toHaveProperty('image_tag');
    expect(ci.jobs.docker.outputs).toHaveProperty('environment');
  });

  test('deploy-asg depends on docker (runs before VALET notification)', () => {
    expect(ci.jobs['deploy-asg'].needs).toContain('docker');
  });

  test('deploy-staging depends on docker and deploy-asg (notifies VALET after EC2 update)', () => {
    expect(ci.jobs['deploy-staging'].needs).toContain('docker');
    expect(ci.jobs['deploy-staging'].needs).toContain('deploy-asg');
  });

  test('deploy-asg cleans up SSH key on failure', () => {
    const steps = ci.jobs['deploy-asg'].steps;
    const cleanupStep = steps.find((s: Record<string, unknown>) =>
      typeof s.name === 'string' && s.name.toLowerCase().includes('cleanup')
    );
    expect(cleanupStep).toBeDefined();
    expect(cleanupStep.if).toBe('always()');
  });

  test('deploy-production only triggers on main branch', () => {
    const condition = ci.jobs['deploy-production'].if;
    expect(condition).toContain('main');
    expect(condition).toContain('push');
  });

  test('deploy-production depends on deploy-asg (notifies VALET after EC2 update)', () => {
    expect(ci.jobs['deploy-production'].needs).toContain('deploy-asg');
  });
});

// ── Rollback Workflow Validation ────────────────────────────────

describe('Rollback Workflow (rollback.yml)', () => {
  test('exists', () => {
    expect(fileExists('.github/workflows/rollback.yml')).toBe(true);
  });

  test('is valid YAML with workflow_dispatch trigger', () => {
    const yaml = readFile('.github/workflows/rollback.yml');
    const rollback = parseYaml(yaml);
    expect(rollback.on.workflow_dispatch).toBeDefined();
    expect(rollback.on.workflow_dispatch.inputs.image_tag).toBeDefined();
    expect(rollback.on.workflow_dispatch.inputs.environment).toBeDefined();
  });
});

// ── Deploy Scripts ──────────────────────────────────────────────

describe('Deploy Scripts', () => {
  test('deploy-manual.sh exists and is executable', () => {
    expect(fileExists('scripts/deploy-manual.sh')).toBe(true);
    expect(isExecutable('scripts/deploy-manual.sh')).toBe(true);
  });

  test('deploy-to-asg.sh exists and is executable', () => {
    expect(fileExists('scripts/deploy-to-asg.sh')).toBe(true);
    expect(isExecutable('scripts/deploy-to-asg.sh')).toBe(true);
  });

  test('refresh-ami.sh exists and is executable', () => {
    expect(fileExists('scripts/refresh-ami.sh')).toBe(true);
    expect(isExecutable('scripts/refresh-ami.sh')).toBe(true);
  });

  describe('deploy-to-asg.sh', () => {
    const script = readFile('scripts/deploy-to-asg.sh');

    test('uses strict mode', () => {
      expect(script).toContain('set -euo pipefail');
    });

    test('requires AWS_ASG_NAME', () => {
      expect(script).toContain('AWS_ASG_NAME');
    });

    test('requires ECR_REGISTRY and ECR_REPOSITORY', () => {
      expect(script).toContain('ECR_REGISTRY');
      expect(script).toContain('ECR_REPOSITORY');
    });

    test('discovers instances via aws ec2 describe-instances', () => {
      expect(script).toContain('aws ec2 describe-instances');
    });

    test('filters by ASG tag and running state', () => {
      expect(script).toContain('aws:autoscaling:groupName');
      expect(script).toContain('instance-state-name');
      expect(script).toContain('running');
    });

    test('performs health check after deploy', () => {
      expect(script).toContain('health');
      expect(script).toContain('localhost:3100');
    });

    test('uses SSH with StrictHostKeyChecking=no', () => {
      expect(script).toContain('StrictHostKeyChecking=no');
    });

    test('supports --ssh-key argument', () => {
      expect(script).toContain('--ssh-key');
    });

    test('outputs DEPLOY_STATUS', () => {
      expect(script).toContain('DEPLOY_STATUS=success');
      expect(script).toContain('DEPLOY_STATUS=partial_failure');
    });
  });

  describe('refresh-ami.sh', () => {
    const script = readFile('scripts/refresh-ami.sh');

    test('uses strict mode', () => {
      expect(script).toContain('set -euo pipefail');
    });

    test('requires AWS_ASG_NAME and AWS_LAUNCH_TEMPLATE_ID', () => {
      expect(script).toContain('AWS_ASG_NAME');
      expect(script).toContain('AWS_LAUNCH_TEMPLATE_ID');
    });

    test('creates AMI via aws ec2 create-image', () => {
      expect(script).toContain('aws ec2 create-image');
    });

    test('waits for AMI availability', () => {
      expect(script).toContain('aws ec2 wait image-available');
    });

    test('updates Launch Template', () => {
      expect(script).toContain('create-launch-template-version');
      expect(script).toContain('modify-launch-template');
    });

    test('starts instance refresh with MinHealthyPercentage=50', () => {
      expect(script).toContain('start-instance-refresh');
      expect(script).toContain('MinHealthyPercentage');
      expect(script).toContain('50');
    });

    test('cleans up old AMIs (keeps last 3)', () => {
      expect(script).toContain('deregister-image');
      expect(script).toContain('[:-3]');
    });

    test('tags AMIs with Project=ghosthands', () => {
      expect(script).toContain('Project');
      expect(script).toContain('ghosthands');
    });

    test('supports --skip-refresh flag', () => {
      expect(script).toContain('--skip-refresh');
      expect(script).toContain('SKIP_REFRESH');
    });

    test('supports --instance-id argument', () => {
      expect(script).toContain('--instance-id');
    });

    test('outputs AMI_ID and LT_VERSION', () => {
      expect(script).toContain('AMI_ID=');
      expect(script).toContain('LT_VERSION=');
    });
  });
});

// ── Required Secrets Documentation ──────────────────────────────

describe('REQUIRED_SECRETS.md', () => {
  test('exists', () => {
    expect(fileExists('.github/REQUIRED_SECRETS.md')).toBe(true);
  });

  const secretsDoc = readFile('.github/REQUIRED_SECRETS.md');

  test('documents AWS credentials', () => {
    expect(secretsDoc).toContain('AWS_ACCESS_KEY_ID');
    expect(secretsDoc).toContain('AWS_SECRET_ACCESS_KEY');
    expect(secretsDoc).toContain('AWS_REGION');
  });

  test('documents ECR secrets', () => {
    expect(secretsDoc).toContain('ECR_REGISTRY');
    expect(secretsDoc).toContain('ECR_REPOSITORY');
  });

  test('documents SSH key', () => {
    expect(secretsDoc).toContain('SANDBOX_SSH_KEY');
  });

  test('documents Supabase secrets', () => {
    expect(secretsDoc).toContain('SUPABASE_URL');
    expect(secretsDoc).toContain('SUPABASE_SECRET_KEY');
    expect(secretsDoc).toContain('SUPABASE_PUBLISHABLE_KEY');
    expect(secretsDoc).toContain('SUPABASE_DIRECT_URL');
  });

  test('documents GH service secrets', () => {
    expect(secretsDoc).toContain('GH_SERVICE_SECRET');
    expect(secretsDoc).toContain('GH_ENCRYPTION_KEY');
  });

  test('documents deployment webhook secrets', () => {
    expect(secretsDoc).toContain('VALET_DEPLOY_WEBHOOK_URL');
    expect(secretsDoc).toContain('VALET_DEPLOY_WEBHOOK_SECRET');
  });

  test('documents Kasm secrets', () => {
    expect(secretsDoc).toContain('KASM_API_URL');
    expect(secretsDoc).toContain('KASM_API_KEY');
    expect(secretsDoc).toContain('KASM_API_SECRET');
  });

  test('includes ECR setup command', () => {
    expect(secretsDoc).toContain('aws ecr create-repository');
  });

  test('includes IAM permissions list', () => {
    expect(secretsDoc).toContain('ecr:GetAuthorizationToken');
    expect(secretsDoc).toContain('ec2:DescribeInstances');
    expect(secretsDoc).toContain('autoscaling:StartInstanceRefresh');
  });
});
