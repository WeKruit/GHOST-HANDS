import { AutoScalingClient, CompleteLifecycleActionCommand } from '@aws-sdk/client-auto-scaling';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'ASGLifecycle' });

/**
 * Fetch the EC2 instance ID from the Instance Metadata Service (IMDSv2).
 * Returns the instance ID string, or falls back to EC2_INSTANCE_ID env var / 'unknown'.
 */
export async function fetchEc2InstanceId(): Promise<string> {
  try {
    // IMDSv2: get token first
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(1000),
    });
    const token = await tokenRes.text();

    const idRes = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
    });
    return await idRes.text();
  } catch {
    return process.env.EC2_INSTANCE_ID || 'unknown';
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
