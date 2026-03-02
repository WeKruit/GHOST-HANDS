import { AutoScalingClient, CompleteLifecycleActionCommand } from '@aws-sdk/client-auto-scaling';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'ASGLifecycle' });

/**
 * Fetch an IMDSv2 token with a 6-hour TTL.
 * Reused by both fetchEc2InstanceId and fetchEc2Ip.
 */
async function getImdsToken(): Promise<string> {
  const res = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
    signal: AbortSignal.timeout(1000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`IMDS token request failed: ${res.status}`);
  return (await res.text()).trim();
}

/**
 * Fetch the EC2 instance ID from the Instance Metadata Service (IMDSv2).
 * Returns the instance ID string, or falls back to EC2_INSTANCE_ID env var / 'unknown'.
 */
export async function fetchEc2InstanceId(): Promise<string> {
  try {
    const token = await getImdsToken();
    const idRes = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    if (!idRes.ok) return process.env.EC2_INSTANCE_ID || 'unknown';
    const instanceId = (await idRes.text()).trim();

    if (!/^i-[0-9a-f]{8,17}$/.test(instanceId)) {
      logger.warn('IMDS returned unexpected instance ID format', { instanceId });
      return process.env.EC2_INSTANCE_ID || 'unknown';
    }

    return instanceId;
  } catch {
    return process.env.EC2_INSTANCE_ID || 'unknown';
  }
}

/**
 * Fetch the EC2 public IPv4 address from the Instance Metadata Service (IMDSv2).
 * Returns the IP string, or falls back to EC2_IP env var / 'local'.
 */
export async function fetchEc2Ip(): Promise<string> {
  try {
    const token = await getImdsToken();
    const ipRes = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    if (!ipRes.ok) return process.env.EC2_IP || 'local';
    return (await ipRes.text()).trim();
  } catch {
    return process.env.EC2_IP || 'local';
  }
}

/**
 * Strict IMDS-only instance ID discovery for worker ID resolution.
 * Returns null on any failure — NO env var fallback.
 * This prevents stale/incorrect EC2_INSTANCE_ID env from polluting worker identity.
 */
export async function discoverImdsInstanceId(): Promise<string | null> {
  try {
    const token = await getImdsToken();
    const idRes = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    if (!idRes.ok) return null;
    const instanceId = (await idRes.text()).trim();

    if (!/^i-[0-9a-f]{8,17}$/.test(instanceId)) {
      logger.warn('IMDS returned unexpected instance ID format', { instanceId });
      return null;
    }

    return instanceId;
  } catch {
    return null;
  }
}

/**
 * Complete an ASG lifecycle action to signal that this instance is ready
 * to be terminated. Called during graceful shutdown when ASG_NAME is set.
 */
export async function completeLifecycleAction(instanceId: string): Promise<void> {
  const asgName = process.env.AWS_ASG_NAME;
  const hookName = process.env.AWS_LIFECYCLE_HOOK_NAME || 'ghosthands-drain-hook';

  if (!asgName || instanceId === 'unknown') return;

  try {
    const client = new AutoScalingClient({ region: process.env.AWS_REGION || 'us-east-1' });
    await client.send(new CompleteLifecycleActionCommand({
      AutoScalingGroupName: asgName,
      LifecycleHookName: hookName,
      InstanceId: instanceId,
      LifecycleActionResult: 'CONTINUE',
    }));
    logger.info('Completed lifecycle action', { instanceId });
  } catch (err) {
    logger.warn('Failed to complete lifecycle action', { error: err instanceof Error ? err.message : String(err) });
  }
}
