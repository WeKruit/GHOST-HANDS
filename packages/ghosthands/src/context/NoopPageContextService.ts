import type {
  AnswerDecision,
  ContextReport,
  PageAuditResult,
  PageContextSession,
  PageEntryInput,
  PageFinalizeInput,
  QuestionOutcome,
  QuestionSnapshot,
} from './types.js';
import type { PageContextService } from './PageContextService.js';
import { createEmptyContextReport } from './PageContextReducer.js';

export class NoopPageContextService implements PageContextService {
  async initializeRun(_mastraRunId: string): Promise<void> {}
  async enterOrResumePage(_input: PageEntryInput): Promise<void> {}
  async syncQuestions(_snapshots: QuestionSnapshot[], _opts?: { isFullSync?: boolean }): Promise<void> {}
  async recordAnswerPlan(_decisions: AnswerDecision[]): Promise<void> {}
  async recordFieldAttempt(
    _questionKey: string,
    _actor: 'dom' | 'magnitude' | 'human',
    _notes?: string,
  ): Promise<void> {}
  async recordFieldResult(_outcome: QuestionOutcome): Promise<void> {}
  async auditBeforeAdvance(): Promise<PageAuditResult> {
    return {
      blockNavigation: false,
      unresolvedRequired: 0,
      riskyOptional: 0,
      lowConfidenceResolved: 0,
      retrySuggested: false,
      summary: 'Page context disabled.',
      unresolvedQuestionKeys: [],
      riskyQuestionKeys: [],
    };
  }
  async finalizeActivePage(_input?: PageFinalizeInput): Promise<void> {}
  async markAwaitingReview(): Promise<void> {}
  async markFailed(): Promise<void> {}
  async markFlushPending(_error: string): Promise<void> {}
  async getContextReport(flushStatus: ContextReport['flushStatus'] = 'pending'): Promise<ContextReport> {
    return createEmptyContextReport(flushStatus);
  }
  async flushToSupabase(): Promise<ContextReport> {
    return this.getContextReport('pending');
  }
  getSession(): PageContextSession | null {
    return null;
  }
}
