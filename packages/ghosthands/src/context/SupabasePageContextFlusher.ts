import type { SupabaseClient } from '@supabase/supabase-js';
import { buildContextReport, computeCoverage } from './PageContextReducer.js';
import type { ContextReport, PageContextSession } from './types.js';

export class SupabasePageContextFlusher {
  constructor(private readonly supabase: SupabaseClient) {}

  async flush(session: PageContextSession): Promise<ContextReport> {
    const rows = session.pages.map((page) => {
      const coverage = computeCoverage(page);
      return {
        job_id: session.jobId,
        mastra_run_id: session.mastraRunId,
        page_sequence: page.sequence,
        page_id: page.pageId,
        url: page.url,
        page_type: page.pageType,
        page_title: page.pageTitle || null,
        status: page.status,
        entry_fingerprint: page.entryFingerprint,
        latest_fingerprint: page.latestFingerprint,
        required_total: coverage.requiredTotal,
        required_resolved: coverage.requiredResolved,
        required_unresolved: coverage.requiredUnresolved,
        optional_risky: coverage.optionalRisky,
        low_confidence_resolved: coverage.lowConfidenceResolved,
        ambiguous_grouped: coverage.ambiguousGrouped,
        page_context: {
          ...page,
          coverage,
        },
        history: page.history,
        entered_at: page.enteredAt,
        exited_at: page.exitedAt || null,
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
