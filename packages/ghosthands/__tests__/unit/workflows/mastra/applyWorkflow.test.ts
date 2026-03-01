import { describe, expect, test, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() ensures variables are available when vi.mock hoists
// ---------------------------------------------------------------------------

const { mockCommittedWorkflow, mockWorkflowBuilder } = vi.hoisted(() => {
  const mockCommittedWorkflow = { id: 'gh_apply' };
  const mockWorkflowBuilder = {
    then: vi.fn().mockReturnThis(),
    branch: vi.fn().mockReturnThis(),
    commit: vi.fn().mockReturnValue(mockCommittedWorkflow),
  };
  return { mockCommittedWorkflow, mockWorkflowBuilder };
});

vi.mock('@mastra/core/workflows', () => ({
  createWorkflow: vi.fn().mockReturnValue(mockWorkflowBuilder),
  createStep: vi.fn().mockImplementation((config: any) => config),
}));

vi.mock('../../../../src/workflows/mastra/steps/factory.js', () => ({
  buildSteps: vi.fn().mockReturnValue({
    checkBlockers: { id: 'check_blockers_checkpoint', execute: vi.fn() },
    cookbookAttempt: { id: 'cookbook_attempt', execute: vi.fn() },
    executeHandler: { id: 'execute_handler', execute: vi.fn() },
  }),
}));

vi.mock('../../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { buildApplyWorkflow } from '../../../../src/workflows/mastra/applyWorkflow.js';
import { createWorkflow } from '@mastra/core/workflows';
import { buildSteps } from '../../../../src/workflows/mastra/steps/factory.js';
import type { RuntimeContext } from '../../../../src/workflows/mastra/types.js';

// ---------------------------------------------------------------------------
// PRD V5.2 Section 14.1: Unit Tests — gh_apply workflow assembly
// ---------------------------------------------------------------------------

describe('buildApplyWorkflow', () => {
  // Minimal RuntimeContext stub — only needs to be passable to buildSteps
  const fakeRt = {} as RuntimeContext;

  beforeEach(() => {
    // Clear accumulated call counts between tests
    mockWorkflowBuilder.then.mockClear();
    mockWorkflowBuilder.branch.mockClear();
    mockWorkflowBuilder.commit.mockClear();
    vi.mocked(createWorkflow).mockClear();
    vi.mocked(buildSteps).mockClear();
  });

  // ─── Test 1 ──────────────────────────────────────────────────────────

  test('returns a workflow object (not null/undefined)', () => {
    const workflow = buildApplyWorkflow(fakeRt);

    expect(workflow).toBeDefined();
    expect(workflow).not.toBeNull();
  });

  // ─── Test 2 ──────────────────────────────────────────────────────────

  test('returned workflow has the correct id "gh_apply"', () => {
    const workflow = buildApplyWorkflow(fakeRt);

    expect(workflow).toHaveProperty('id', 'gh_apply');
  });

  // ─── Test 3 ──────────────────────────────────────────────────────────

  test('calls buildSteps with the provided RuntimeContext', () => {
    buildApplyWorkflow(fakeRt);

    expect(buildSteps).toHaveBeenCalledWith(fakeRt);
  });

  // ─── Test 4 ──────────────────────────────────────────────────────────

  test('calls createWorkflow with id "gh_apply"', () => {
    buildApplyWorkflow(fakeRt);

    expect(createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gh_apply' }),
    );
  });

  // ─── Test 5 ──────────────────────────────────────────────────────────

  test('chains .then() for checkBlockers and cookbookAttempt, then .branch(), then .commit()', () => {
    buildApplyWorkflow(fakeRt);

    // checkBlockers -> .then()
    expect(mockWorkflowBuilder.then).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'check_blockers_checkpoint' }),
    );

    // cookbookAttempt -> .then()
    expect(mockWorkflowBuilder.then).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cookbook_attempt' }),
    );

    // .branch() called with two branch conditions
    expect(mockWorkflowBuilder.branch).toHaveBeenCalledTimes(1);
    const branchArgs = mockWorkflowBuilder.branch.mock.calls[0][0];
    expect(branchArgs).toHaveLength(2);

    // .commit() finalizes the workflow
    expect(mockWorkflowBuilder.commit).toHaveBeenCalledOnce();
  });
});
