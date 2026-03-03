import { describe, expect, test } from 'vitest';
import { workflowState, blockerResumeSchema, FORBIDDEN_SCHEMA_KEYS } from '../../../../src/workflows/mastra/types.js';
import { ValetApplySchema, ValetTaskSchema } from '../../../../src/api/schemas/valet.js';

// ---------------------------------------------------------------------------
// PRD V5.2 Section 14.1: Unit Tests
// ---------------------------------------------------------------------------

describe('workflowState schema', () => {
  test('round-trips through JSON.parse(JSON.stringify(...))', () => {
    const input = {
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      targetUrl: 'https://jobs.example.com/apply',
      platform: 'greenhouse',
      qualityPreset: 'balanced' as const,
      budgetUsd: 0.5,
      cookbook: {
        attempted: true,
        success: false,
        manualId: null,
        steps: 0,
        error: 'cookbook_miss',
      },
      handler: {
        attempted: true,
        success: true,
        taskResult: {
          success: true,
          data: { pages_processed: 3 },
          keepBrowserOpen: false,
          awaitingUserReview: false,
        },
      },
      hitl: {
        blocked: false,
        blockerType: null,
        resumeNonce: null,
        checkpoint: null,
      },
      metrics: {
        costUsd: 0.15,
        pagesProcessed: 3,
      },
      status: 'completed' as const,
    };

    const parsed = workflowState.parse(input);
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    const reparsed = workflowState.parse(roundTripped);

    expect(reparsed).toEqual(parsed);
  });

  test('accepts defaults for optional fields', () => {
    const minimal = {
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      targetUrl: 'https://jobs.example.com/apply',
      qualityPreset: 'balanced',
      budgetUsd: 0.5,
      cookbook: {},
      handler: {},
      hitl: {},
      metrics: {},
    };

    const parsed = workflowState.parse(minimal);
    expect(parsed.platform).toBe('other');
    expect(parsed.status).toBe('running');
    expect(parsed.cookbook.attempted).toBe(false);
    expect(parsed.handler.taskResult).toBeNull();
    expect(parsed.hitl.blocked).toBe(false);
    expect(parsed.metrics.costUsd).toBe(0);
  });

  test('accepts all valid status values', () => {
    const statuses = ['running', 'suspended', 'awaiting_review', 'completed', 'failed'] as const;
    for (const status of statuses) {
      const input = {
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '550e8400-e29b-41d4-a716-446655440001',
        targetUrl: 'https://jobs.example.com/apply',
        qualityPreset: 'balanced',
        budgetUsd: 0.5,
        cookbook: {},
        handler: {},
        hitl: {},
        metrics: {},
        status,
      };
      expect(() => workflowState.parse(input)).not.toThrow();
    }
  });

  test('rejects invalid status values', () => {
    const input = {
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      targetUrl: 'https://jobs.example.com/apply',
      qualityPreset: 'balanced',
      budgetUsd: 0.5,
      cookbook: {},
      handler: {},
      hitl: {},
      metrics: {},
      status: 'paused', // not a valid workflow status
    };
    expect(() => workflowState.parse(input)).toThrow();
  });
});

describe('secret safety: no forbidden keys in workflow schemas', () => {
  function getSchemaKeys(schema: any): string[] {
    if (!schema?._def) return [];
    const shape = schema._def?.shape?.();
    if (!shape) return [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      keys.push(key);
      // Recurse into nested objects
      keys.push(...getSchemaKeys(value).map(k => `${key}.${k}`));
    }
    return keys;
  }

  test('workflowState contains no forbidden keys', () => {
    const allKeys = getSchemaKeys(workflowState);
    for (const forbidden of FORBIDDEN_SCHEMA_KEYS) {
      const violations = allKeys.filter(k =>
        k.toLowerCase().includes(forbidden.toLowerCase())
      );
      expect(violations, `Schema key "${violations[0]}" contains forbidden term "${forbidden}"`).toHaveLength(0);
    }
  });

  test('blockerResumeSchema contains no forbidden keys', () => {
    const allKeys = getSchemaKeys(blockerResumeSchema);
    for (const forbidden of FORBIDDEN_SCHEMA_KEYS) {
      const violations = allKeys.filter(k =>
        k.toLowerCase().includes(forbidden.toLowerCase())
      );
      expect(violations, `Resume schema key "${violations[0]}" contains forbidden term "${forbidden}"`).toHaveLength(0);
    }
  });
});

describe('execution mode enum: AD-1 backward compatibility', () => {
  const existingModes = ['auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply'];

  test('mastra is accepted in ValetApplySchema', () => {
    const input = {
      valet_task_id: 'test-task',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      target_url: 'https://jobs.example.com/apply',
      profile: { first_name: 'Test', last_name: 'User', email: 'test@example.com' },
      execution_mode: 'mastra',
    };
    expect(() => ValetApplySchema.parse(input)).not.toThrow();
  });

  test('all existing mode values still accepted in ValetApplySchema', () => {
    for (const mode of existingModes) {
      const input = {
        valet_task_id: 'test-task',
        valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
        target_url: 'https://jobs.example.com/apply',
        profile: { first_name: 'Test', last_name: 'User', email: 'test@example.com' },
        execution_mode: mode,
      };
      expect(() => ValetApplySchema.parse(input), `Mode "${mode}" should be accepted`).not.toThrow();
    }
  });

  test('mastra is accepted in ValetTaskSchema', () => {
    const input = {
      valet_task_id: 'test-task',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      job_type: 'apply',
      target_url: 'https://jobs.example.com/apply',
      task_description: 'Apply to this job',
      execution_mode: 'mastra',
    };
    expect(() => ValetTaskSchema.parse(input)).not.toThrow();
  });

  test('all existing mode values still accepted in ValetTaskSchema', () => {
    for (const mode of existingModes) {
      const input = {
        valet_task_id: 'test-task',
        valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
        job_type: 'apply',
        target_url: 'https://jobs.example.com/apply',
        task_description: 'Apply to this job',
        execution_mode: mode,
      };
      expect(() => ValetTaskSchema.parse(input), `Mode "${mode}" should be accepted`).not.toThrow();
    }
  });

  test('default execution_mode is auto', () => {
    const input = {
      valet_task_id: 'test-task',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      target_url: 'https://jobs.example.com/apply',
      profile: { first_name: 'Test', last_name: 'User', email: 'test@example.com' },
    };
    const parsed = ValetApplySchema.parse(input);
    expect(parsed.execution_mode).toBe('auto');
  });
});

describe('resume discriminator logic (Section 8.3)', () => {
  function shouldResume(job: { execution_mode?: string; metadata: Record<string, any> }): boolean {
    return (
      job.execution_mode === 'mastra' &&
      typeof job.metadata?.mastra_run_id === 'string' &&
      job.metadata?.resume_requested === true
    );
  }

  test('mastra_run_id + resume_requested = resume', () => {
    expect(shouldResume({
      execution_mode: 'mastra',
      metadata: { mastra_run_id: 'run-123', resume_requested: true },
    })).toBe(true);
  });

  test('mastra_run_id without resume_requested = fresh execution', () => {
    expect(shouldResume({
      execution_mode: 'mastra',
      metadata: { mastra_run_id: 'run-123' },
    })).toBe(false);
  });

  test('resume_requested without mastra_run_id = fresh execution', () => {
    expect(shouldResume({
      execution_mode: 'mastra',
      metadata: { resume_requested: true },
    })).toBe(false);
  });

  test('non-mastra execution_mode = not a resume', () => {
    expect(shouldResume({
      execution_mode: 'smart_apply',
      metadata: { mastra_run_id: 'run-123', resume_requested: true },
    })).toBe(false);
  });

  test('empty metadata = not a resume', () => {
    expect(shouldResume({
      execution_mode: 'mastra',
      metadata: {},
    })).toBe(false);
  });
});

describe('blocker resume schema', () => {
  test('accepts valid resolution types', () => {
    const types = ['manual', 'code_entry', 'credentials', 'skip'] as const;
    for (const type of types) {
      const result = blockerResumeSchema.parse({
        resolutionType: type,
        resumeNonce: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.resolutionType).toBe(type);
    }
  });

  test('rejects invalid resolution types', () => {
    expect(() => blockerResumeSchema.parse({
      resolutionType: 'auto_solve',
      resumeNonce: '550e8400-e29b-41d4-a716-446655440000',
    })).toThrow();
  });

  test('requires valid UUID for resumeNonce', () => {
    expect(() => blockerResumeSchema.parse({
      resolutionType: 'manual',
      resumeNonce: 'not-a-uuid',
    })).toThrow();
  });
});
