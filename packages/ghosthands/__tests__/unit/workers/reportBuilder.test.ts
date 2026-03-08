import { describe, expect, test } from 'vitest';
import {
  extractFieldsFromSession,
  extractCompanyFromUrl,
  buildApplicationReport,
} from '../../../src/workers/reportBuilder';
import type { PageContextSession } from '../../../src/context/types';
import type { AutomationJob, TaskResult } from '../../../src/workers/taskHandlers/types';
import type { CostSnapshot } from '../../../src/workers/costControl';

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Record<string, any> = {}) {
  return {
    questionKey: 'q-1',
    orderIndex: 0,
    promptText: 'First Name',
    normalizedPrompt: 'first name',
    questionType: 'text' as const,
    required: true,
    groupingConfidence: 1,
    resolutionConfidence: 0.95,
    riskLevel: 'none' as const,
    state: 'verified' as const,
    source: 'dom' as const,
    selectors: [],
    options: [],
    currentValue: 'John',
    selectedOptions: [],
    lastAnswer: 'John',
    answerMode: 'profile_backed' as const,
    attemptCount: 1,
    verificationCount: 1,
    warnings: [],
    fieldIds: [],
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePage(questions: any[] = [], overrides: Record<string, any> = {}) {
  return {
    pageId: 'page-1',
    sequence: 0,
    pageStepKey: 'step-1',
    entryFingerprint: 'fp-1',
    latestFingerprint: 'fp-1',
    url: 'https://example.com/apply',
    pageType: 'application_form',
    pageTitle: 'Apply',
    status: 'completed' as const,
    enteredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    visitCount: 1,
    questions,
    actionables: [],
    history: [],
    coverage: {
      requiredTotal: questions.length,
      requiredResolved: questions.length,
      requiredUnresolved: 0,
      optionalRisky: 0,
      lowConfidenceResolved: 0,
      ambiguousGrouped: 0,
    },
    mergeStats: { questionMergeCount: 0, resumedCount: 0, duplicateQuestionSuppressions: 0 },
    ...overrides,
  };
}

function makeSession(pages: any[] = []): PageContextSession {
  return {
    jobId: 'job-123',
    mastraRunId: 'run-1',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'completed',
    pages,
    reportDraft: {
      pagesVisited: pages.length,
      requiredUnresolved: [],
      riskyOptionalAnswers: [],
      lowConfidenceAnswers: [],
      ambiguousQuestionGroups: [],
      bestEffortGuesses: [],
      partialPages: [],
      flushStatus: 'flushed',
    },
    version: 1,
  };
}

function makeJob(overrides: Record<string, any> = {}): AutomationJob {
  return {
    id: 'job-123',
    job_type: 'smart_apply',
    target_url: 'https://mycompany.wd5.myworkdayjobs.com/en-US/External/job/apply',
    task_description: 'Apply to job',
    input_data: { user_data: { first_name: 'John' } },
    user_id: 'user-456',
    timeout_seconds: 300,
    max_retries: 2,
    retry_count: 0,
    metadata: {},
    priority: 0,
    tags: [],
    valet_task_id: 'vt-789',
    resume_ref: 'resumes/resume-abc.pdf',
    ...overrides,
  } as AutomationJob;
}

function makeCostSnapshot(): CostSnapshot {
  return {
    totalCost: 0.05,
    inputTokens: 1000,
    outputTokens: 500,
    actionCount: 10,
    imageCost: 0.01,
    reasoningCost: 0.02,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractFieldsFromSession', () => {
  test('extracts verified/filled fields', () => {
    const session = makeSession([
      makePage([
        makeQuestion({ state: 'verified', promptText: 'First Name', lastAnswer: 'John' }),
        makeQuestion({ state: 'filled', promptText: 'Email', lastAnswer: 'john@example.com', questionKey: 'q-2' }),
      ]),
    ]);

    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(2);
    expect(fields[0].prompt_text).toBe('First Name');
    expect(fields[0].value).toBe('John');
    expect(fields[0].state).toBe('verified');
    expect(fields[1].prompt_text).toBe('Email');
    expect(fields[1].value).toBe('john@example.com');
  });

  test('includes failed fields with empty value', () => {
    const session = makeSession([
      makePage([
        makeQuestion({ state: 'failed', promptText: 'Cover Letter', lastAnswer: undefined, currentValue: undefined, questionKey: 'q-3' }),
      ]),
    ]);

    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(1);
    expect(fields[0].state).toBe('failed');
    expect(fields[0].value).toBe('');
  });

  test('skips retired questions', () => {
    const session = makeSession([
      makePage([
        makeQuestion({
          state: 'skipped',
          warnings: ['retired_missing_from_dom'],
          questionKey: 'q-retired',
        }),
        makeQuestion({ state: 'verified', promptText: 'Name', questionKey: 'q-keep' }),
      ]),
    ]);

    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(1);
    expect(fields[0].prompt_text).toBe('Name');
  });

  test('skips empty questions with no answer', () => {
    const session = makeSession([
      makePage([
        makeQuestion({ state: 'empty', lastAnswer: undefined, currentValue: undefined, questionKey: 'q-empty' }),
      ]),
    ]);

    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(0);
  });

  test('redacts sensitive fields (password, SSN)', () => {
    const session = makeSession([
      makePage([
        makeQuestion({ promptText: 'Password', lastAnswer: 'secret123', questionKey: 'q-pwd' }),
        makeQuestion({ promptText: 'Social Security Number', lastAnswer: '123-45-6789', questionKey: 'q-ssn' }),
        makeQuestion({ promptText: 'Phone', lastAnswer: '555-1234', questionKey: 'q-phone' }),
      ]),
    ]);

    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(3);
    expect(fields[0].value).toBe('[REDACTED]');
    expect(fields[1].value).toBe('[REDACTED]');
    expect(fields[2].value).toBe('555-1234'); // Phone NOT redacted
  });

  test('handles empty session', () => {
    const session = makeSession([]);
    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(0);
  });

  test('extracts across multiple pages', () => {
    const session = makeSession([
      makePage([makeQuestion({ promptText: 'Page 1 Field', questionKey: 'q-p1' })]),
      makePage([makeQuestion({ promptText: 'Page 2 Field', questionKey: 'q-p2' })], { pageId: 'page-2', sequence: 1 }),
    ]);

    const fields = extractFieldsFromSession(session);
    expect(fields).toHaveLength(2);
    expect(fields[0].prompt_text).toBe('Page 1 Field');
    expect(fields[1].prompt_text).toBe('Page 2 Field');
  });
});

describe('extractCompanyFromUrl', () => {
  test('extracts from Workday URL', () => {
    expect(extractCompanyFromUrl('https://mycompany.wd5.myworkdayjobs.com/en-US/External')).toBe('mycompany');
  });

  test('extracts from Greenhouse URL', () => {
    expect(extractCompanyFromUrl('https://boards.greenhouse.io/acmecorp/jobs/123')).toBe('acmecorp');
  });

  test('extracts from Lever URL', () => {
    expect(extractCompanyFromUrl('https://jobs.lever.co/coolstartup/abc-123')).toBe('coolstartup');
  });

  test('extracts from generic careers URL', () => {
    const result = extractCompanyFromUrl('https://careers.google.com/apply/123');
    expect(result).toBe('google');
  });

  test('returns null for invalid URL', () => {
    expect(extractCompanyFromUrl('not-a-url')).toBeNull();
  });
});

describe('buildApplicationReport', () => {
  test('builds complete report from session + job', () => {
    const session = makeSession([
      makePage([
        makeQuestion({ state: 'verified', promptText: 'First Name', lastAnswer: 'John' }),
        makeQuestion({ state: 'failed', promptText: 'Cover Letter', lastAnswer: '', questionKey: 'q-fail' }),
      ]),
    ]);
    const job = makeJob();
    const cost = makeCostSnapshot();
    const taskResult: TaskResult = { success: true, data: { submitted: true, platform: 'workday' } };

    const report = buildApplicationReport(job, session, cost, taskResult, ['https://s3/screenshot.png'], 'completed');

    expect(report.job_id).toBe('job-123');
    expect(report.user_id).toBe('user-456');
    expect(report.valet_task_id).toBe('vt-789');
    expect(report.company_name).toBe('mycompany');
    expect(report.platform).toBe('workday');
    expect(report.resume_ref).toBe('resumes/resume-abc.pdf');
    expect(report.fields_submitted).toHaveLength(2);
    expect(report.total_fields).toBe(2);
    expect(report.fields_filled).toBe(1);
    expect(report.fields_failed).toBe(1);
    expect(report.submitted).toBe(true);
    expect(report.status).toBe('completed');
    expect(report.llm_cost_cents).toBe(5);
    expect(report.action_count).toBe(10);
    expect(report.screenshot_urls).toEqual(['https://s3/screenshot.png']);
  });

  test('handles null session gracefully', () => {
    const job = makeJob();
    const cost = makeCostSnapshot();
    const taskResult: TaskResult = { success: false, error: 'timeout' };

    const report = buildApplicationReport(job, null, cost, taskResult, [], 'failed');

    expect(report.fields_submitted).toEqual([]);
    expect(report.total_fields).toBe(0);
    expect(report.fields_filled).toBe(0);
    expect(report.status).toBe('failed');
    expect(report.submitted).toBe(false);
  });

  test('extracts resume_ref from object', () => {
    const job = makeJob({ resume_ref: { path: 'resumes/my-resume.pdf', url: 'https://storage/...' } });
    const report = buildApplicationReport(job, null, makeCostSnapshot(), { success: true }, [], 'completed');
    expect(report.resume_ref).toBe('resumes/my-resume.pdf');
  });
});
