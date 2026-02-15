import { describe, expect, test } from 'vitest';
import {
  ValetApplySchema,
  ValetTaskSchema,
  ProfileSchema,
  ResumeRefSchema,
  LocationSchema,
  EducationSchema,
  WorkHistorySchema,
} from '../../../src/api/schemas/valet.js';

describe('VALET Schemas', () => {
  // ─── ProfileSchema ─────────────────────────────────────────────
  describe('ProfileSchema', () => {
    test('accepts minimal valid profile', () => {
      const result = ProfileSchema.safeParse({
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@example.com',
      });
      expect(result.success).toBe(true);
    });

    test('accepts full profile', () => {
      const result = ProfileSchema.safeParse({
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@example.com',
        phone: '+1234567890',
        linkedin_url: 'https://linkedin.com/in/janedoe',
        portfolio_url: 'https://janedoe.dev',
        location: { city: 'SF', state: 'CA', country: 'US', zip: '94102' },
        work_authorization: 'US Citizen',
        salary_expectation: '$120k-$150k',
        years_of_experience: 5,
        education: [{ institution: 'MIT', degree: 'BS', field: 'CS', graduation_year: 2019 }],
        work_history: [{ company: 'Acme', title: 'Engineer', start_date: '2019-01', end_date: '2023-06' }],
        skills: ['TypeScript', 'React', 'Node.js'],
      });
      expect(result.success).toBe(true);
    });

    test('rejects missing required fields', () => {
      const result = ProfileSchema.safeParse({ first_name: 'Jane' });
      expect(result.success).toBe(false);
    });

    test('rejects invalid email', () => {
      const result = ProfileSchema.safeParse({
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'not-an-email',
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── ResumeRefSchema ───────────────────────────────────────────
  describe('ResumeRefSchema', () => {
    test('accepts storage_path', () => {
      const result = ResumeRefSchema.safeParse({ storage_path: 'resumes/jane-doe.pdf' });
      expect(result.success).toBe(true);
    });

    test('accepts s3_key', () => {
      const result = ResumeRefSchema.safeParse({ s3_key: 'user-123/resume.pdf' });
      expect(result.success).toBe(true);
    });

    test('accepts download_url', () => {
      const result = ResumeRefSchema.safeParse({ download_url: 'https://example.com/resume.pdf' });
      expect(result.success).toBe(true);
    });

    test('rejects empty object — needs at least one source', () => {
      const result = ResumeRefSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  // ─── ValetApplySchema ──────────────────────────────────────────
  describe('ValetApplySchema', () => {
    const minimalValid = {
      valet_task_id: 'vtask-001',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      target_url: 'https://boards.greenhouse.io/company/jobs/123',
      profile: {
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@example.com',
      },
    };

    test('accepts minimal valid apply request', () => {
      const result = ValetApplySchema.safeParse(minimalValid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quality).toBe('balanced'); // default
        expect(result.data.priority).toBe(5); // default
        expect(result.data.timeout_seconds).toBe(300); // default
      }
    });

    test('accepts full apply request', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalValid,
        platform: 'greenhouse',
        resume: { download_url: 'https://example.com/resume.pdf' },
        qa_answers: { 'Are you authorized?': 'Yes' },
        callback_url: 'https://valet.wekruit.com/hooks/gh',
        quality: 'quality',
        priority: 8,
        timeout_seconds: 600,
        idempotency_key: 'idem-123',
        metadata: { source_campaign: 'batch-feb' },
      });
      expect(result.success).toBe(true);
    });

    test('rejects missing valet_task_id', () => {
      const { valet_task_id, ...rest } = minimalValid;
      const result = ValetApplySchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    test('rejects invalid valet_user_id (not UUID)', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalValid,
        valet_user_id: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid target_url', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalValid,
        target_url: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid quality preset', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalValid,
        quality: 'ultra',
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid platform', () => {
      const result = ValetApplySchema.safeParse({
        ...minimalValid,
        platform: 'unknown_ats',
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── ValetTaskSchema ───────────────────────────────────────────
  describe('ValetTaskSchema', () => {
    const minimalValid = {
      valet_task_id: 'vtask-002',
      valet_user_id: '550e8400-e29b-41d4-a716-446655440000',
      job_type: 'scrape',
      target_url: 'https://example.com/page',
      task_description: 'Extract all job listings from this page',
    };

    test('accepts minimal valid task request', () => {
      const result = ValetTaskSchema.safeParse(minimalValid);
      expect(result.success).toBe(true);
    });

    test('rejects missing task_description', () => {
      const { task_description, ...rest } = minimalValid;
      const result = ValetTaskSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    test('rejects empty job_type', () => {
      const result = ValetTaskSchema.safeParse({ ...minimalValid, job_type: '' });
      expect(result.success).toBe(false);
    });

    test('rejects oversized job_type', () => {
      const result = ValetTaskSchema.safeParse({ ...minimalValid, job_type: 'x'.repeat(51) });
      expect(result.success).toBe(false);
    });
  });
});
