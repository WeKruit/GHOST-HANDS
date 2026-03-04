import type { SupabaseClient } from '@supabase/supabase-js';
import { buildContextReport, redactSensitiveValue } from './PageContextReducer.js';
import type { ContextReport, LogicalPageRecord, PageContextSession } from './types.js';

function redactPageForFlush(page: LogicalPageRecord): LogicalPageRecord {
  return {
    ...page,
    questions: page.questions.map((q) => ({
      ...q,
      lastAnswer: q.lastAnswer ? redactSensitiveValue(q.promptText, q.lastAnswer) : q.lastAnswer,
      currentValue: q.currentValue ? redactSensitiveValue(q.promptText, q.currentValue) : q.currentValue,
    })),
    history: page.history.map((e) => {
      if (e.after?.answer && typeof e.after.answer === 'string' && e.targetQuestionKey) {
        const question = page.questions.find((q) => q.questionKey === e.targetQuestionKey);
        if (question) {
          return { ...e, after: { ...e.after, answer: redactSensitiveValue(question.promptText, e.after.answer as string) } };
        }
      }
      return e;
    }),
  };
}

export class SupabasePageContextFlusher {
  constructor(private readonly supabase: SupabaseClient) {}

  async flush(session: PageContextSession): Promise<ContextReport> {
    const rows = session.pages.map((page) => {
      const safePage = redactPageForFlush(page);
      const coverage = safePage.coverage;
      return {
        job_id: session.jobId,
        mastra_run_id: session.mastraRunId,
        page_sequence: safePage.sequence,
        page_id: safePage.pageId,
        url: safePage.url,
        page_type: safePage.pageType,
        page_title: safePage.pageTitle || null,
        status: safePage.status,
        entry_fingerprint: safePage.entryFingerprint,
        latest_fingerprint: safePage.latestFingerprint,
        required_total: coverage.requiredTotal,
        required_resolved: coverage.requiredResolved,
        required_unresolved: coverage.requiredUnresolved,
        optional_risky: coverage.optionalRisky,
        low_confidence_resolved: coverage.lowConfidenceResolved,
        ambiguous_grouped: coverage.ambiguousGrouped,
        page_context: {
          ...safePage,
          coverage,
        },
        history: safePage.history,
        entered_at: safePage.enteredAt,
        exited_at: safePage.exitedAt || null,
        updated_at: new Date().toISOString(),
      };
    });

    if (rows.length > 0) {
      const { error } = await this.supabase
        .from('gh_job_page_contexts')
        .upsert(rows, { onConflict: 'job_id,page_sequence' });

      if (error) {
        throw new Error(`Failed to persist page context: ${error.message}`);
      }
    }

    return buildContextReport(session, 'flushed');
  }
}
