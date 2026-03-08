/**
 * ReportBuilder — Builds structured application reports from PageContextSession data.
 *
 * Extracts every field the worker filled (or failed to fill) into a flat array
 * suitable for storage in gh_application_reports.fields_submitted JSONB column.
 * VALET UI can query this directly to show the user what was submitted.
 *
 * Design:
 * - Primary data source: PageContextSession (all pages, all questions)
 * - Sensitive fields (passwords, SSNs) are redacted
 * - Non-sensitive user data (phone, address) is kept visible
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PageContextSession, QuestionRecord } from '../context/types.js';
import type { AutomationJob, TaskResult } from './taskHandlers/types.js';
import type { CostSnapshot } from './costControl.js';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'report-builder' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmittedField {
  prompt_text: string;
  value: string;
  question_type: string;
  source: string;
  answer_mode?: string;
  confidence: number;
  required: boolean;
  section_label?: string;
  state: string;
}

export interface ApplicationReportData {
  job_id: string;
  user_id: string;
  valet_task_id?: string | null;
  job_url: string;
  company_name?: string | null;
  job_title?: string | null;
  platform?: string | null;
  resume_ref?: string | null;
  fields_submitted: SubmittedField[];
  total_fields: number;
  fields_filled: number;
  fields_failed: number;
  fields_unresolved: number;
  status: string;
  submitted: boolean;
  result_summary?: string | null;
  llm_cost_cents?: number | null;
  action_count?: number | null;
  total_tokens?: number | null;
  screenshot_urls?: string[];
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Sensitive field redaction (passwords, SSNs — NOT phone/address)
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_RE = /password|passwd|pwd|secret|token|otp|ssn|credit.?card|cvv|pin|social.?security/i;

function redactValue(promptText: string, value: string): string {
  if (SENSITIVE_FIELD_RE.test(promptText)) {
    return '[REDACTED]';
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field extraction from PageContextSession
// ---------------------------------------------------------------------------

/**
 * Extract all filled fields from a PageContextSession into a flat array.
 * Includes verified, filled, AND failed fields so users see the full picture.
 */
export function extractFieldsFromSession(session: PageContextSession): SubmittedField[] {
  const fields: SubmittedField[] = [];

  for (const page of session.pages) {
    for (const question of page.questions) {
      // Skip retired/removed questions
      if (question.state === 'skipped' && question.warnings.includes('retired_missing_from_dom')) {
        continue;
      }

      // Skip questions that were never attempted (empty + no answer planned)
      if (question.state === 'empty' && !question.lastAnswer) {
        continue;
      }

      const rawValue = question.lastAnswer ?? question.currentValue ?? '';

      fields.push({
        prompt_text: question.promptText,
        value: redactValue(question.promptText, rawValue),
        question_type: question.questionType,
        source: question.source,
        answer_mode: question.answerMode,
        confidence: question.resolutionConfidence,
        required: question.required,
        section_label: question.sectionLabel,
        state: question.state,
      });
    }
  }

  return fields;
}

/**
 * Count field states from an extracted fields array.
 */
function countFields(fields: SubmittedField[]): {
  total: number;
  filled: number;
  failed: number;
  unresolved: number;
} {
  let filled = 0;
  let failed = 0;
  let unresolved = 0;

  for (const f of fields) {
    if (f.state === 'verified' || f.state === 'filled') {
      filled++;
    } else if (f.state === 'failed') {
      failed++;
    } else {
      unresolved++;
    }
  }

  return { total: fields.length, filled, failed, unresolved };
}

// ---------------------------------------------------------------------------
// Company/title extraction helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a company name from a URL.
 * e.g. "https://careers.google.com/apply" → "google"
 *      "https://mycompany.wd5.myworkdayjobs.com/..." → "mycompany"
 */
export function extractCompanyFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    // Workday pattern: <company>.wd<N>.myworkdayjobs.com
    const workdayMatch = hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
    if (workdayMatch) return workdayMatch[1];

    // Greenhouse pattern: boards.greenhouse.io/<company>
    if (hostname === 'boards.greenhouse.io') {
      const path = new URL(url).pathname.split('/').filter(Boolean);
      return path[0] || null;
    }

    // Lever pattern: jobs.lever.co/<company>
    if (hostname === 'jobs.lever.co') {
      const path = new URL(url).pathname.split('/').filter(Boolean);
      return path[0] || null;
    }

    // Generic: use first subdomain or second-level domain
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // Skip common prefixes and TLDs
      const skip = ['www', 'careers', 'jobs', 'apply', 'boards'];
      const tlds = ['com', 'org', 'net', 'io', 'co', 'gov', 'edu', 'info', 'biz'];
      for (const part of parts) {
        if (!skip.includes(part) && !tlds.includes(part) && part.length > 2) {
          return part;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main report builder
// ---------------------------------------------------------------------------

/**
 * Build an ApplicationReportData from a PageContextSession + job metadata.
 * Called during finalization after page context is flushed.
 */
export function buildApplicationReport(
  job: AutomationJob,
  session: PageContextSession | null,
  costSnapshot: CostSnapshot,
  taskResult: TaskResult,
  screenshotUrls: string[],
  status: 'completed' | 'failed' | 'awaiting_review',
): ApplicationReportData {
  const fields = session ? extractFieldsFromSession(session) : [];
  const counts = countFields(fields);
  const inputData = job.input_data || {};

  const resultSummary =
    taskResult.data?.success_message ||
    taskResult.data?.summary ||
    taskResult.data?.message ||
    null;

  return {
    job_id: job.id,
    user_id: job.user_id,
    valet_task_id: job.valet_task_id || null,
    job_url: job.target_url,
    company_name: extractCompanyFromUrl(job.target_url),
    job_title: inputData.job_title || null,
    platform: inputData.platform || taskResult.data?.platform || null,
    resume_ref: typeof job.resume_ref === 'string'
      ? job.resume_ref
      : (job.resume_ref as Record<string, any>)?.storage_path || (job.resume_ref as Record<string, any>)?.download_url || (job.resume_ref as Record<string, any>)?.s3_key || null,
    fields_submitted: fields,
    total_fields: counts.total,
    fields_filled: counts.filled,
    fields_failed: counts.failed,
    fields_unresolved: counts.unresolved,
    status,
    submitted: taskResult.data?.submitted === true,
    result_summary: resultSummary,
    llm_cost_cents: Math.round(costSnapshot.totalCost * 100),
    action_count: costSnapshot.actionCount,
    total_tokens: costSnapshot.inputTokens + costSnapshot.outputTokens,
    screenshot_urls: screenshotUrls,
    started_at: job.metadata?.started_at || null,
    completed_at: status === 'completed' || status === 'failed' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Database writer (best-effort)
// ---------------------------------------------------------------------------

/**
 * Write an application report to gh_application_reports. Best-effort — never
 * throws. Failures are logged and swallowed so they never block job finalization.
 */
export async function writeApplicationReport(
  supabase: SupabaseClient,
  reportData: ApplicationReportData,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('gh_application_reports')
      .upsert([reportData], { onConflict: 'job_id' });

    if (error) {
      logger.warn('Failed to write application report', {
        jobId: reportData.job_id,
        error: error.message,
      });
    } else {
      logger.info('Application report written', {
        jobId: reportData.job_id,
        fieldsFilled: reportData.fields_filled,
        totalFields: reportData.total_fields,
      });
    }
  } catch (err) {
    logger.warn('Application report write threw', {
      jobId: reportData.job_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
