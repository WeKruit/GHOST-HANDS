export type PageContextSessionStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'completed'
  | 'failed';

export type LogicalPageStatus =
  | 'active'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'awaiting_review'
  | 'failed';

export type QuestionState =
  | 'empty'
  | 'planned'
  | 'attempted'
  | 'filled'
  | 'verified'
  | 'failed'
  | 'skipped'
  | 'uncertain';

export type QuestionRiskLevel =
  | 'none'
  | 'low_confidence'
  | 'ambiguous_grouping'
  | 'optional_risky'
  | 'unresolved_required';

export type QuestionSource = 'dom' | 'llm' | 'magnitude' | 'manual' | 'merged';

export type AnswerMode = 'profile_backed' | 'best_effort_guess' | 'default_decline' | 'system_attachment';

export type QuestionType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'file'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'unknown';

export type ContextEventType =
  | 'run_initialized'
  | 'page_entered'
  | 'scan_structured'
  | 'answer_planned'
  | 'fill_attempted'
  | 'fill_applied'
  | 'fill_verified'
  | 'fill_failed'
  | 'page_audited'
  | 'page_finalized'
  | 'status_marked'
  | 'flush_pending'
  | 'flush_succeeded';

export type QuestionKey = string;

export interface OptionRecord {
  optionId: string;
  orderIndex: number;
  label: string;
  normalizedLabel: string;
  selector?: string;
  role?: string;
  selected: boolean;
  disabled?: boolean;
}

export interface ActionableRecord {
  actionableId: string;
  label: string;
  selector?: string;
  type: 'button' | 'link' | 'upload' | 'submit' | 'navigation' | 'unknown';
  disabled?: boolean;
}

export interface ContextEvent {
  eventId: string;
  timestamp: string;
  type: ContextEventType;
  actor: 'system' | 'dom' | 'llm' | 'magnitude' | 'human' | 'mastra';
  targetPageId?: string;
  targetQuestionKey?: QuestionKey;
  confidence?: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  notes?: string;
}

export interface PageCoverage {
  requiredTotal: number;
  requiredResolved: number;
  requiredUnresolved: number;
  optionalRisky: number;
  lowConfidenceResolved: number;
  ambiguousGrouped: number;
}

export interface PageMergeStats {
  questionMergeCount: number;
  resumedCount: number;
  duplicateQuestionSuppressions: number;
}

export interface QuestionRecord {
  questionKey: QuestionKey;
  orderIndex: number;
  promptText: string;
  normalizedPrompt: string;
  sectionLabel?: string;
  questionType: QuestionType;
  required: boolean;
  groupingConfidence: number;
  resolutionConfidence: number;
  riskLevel: QuestionRiskLevel;
  state: QuestionState;
  source: QuestionSource;
  selectors: string[];
  options: OptionRecord[];
  currentValue?: string;
  selectedOptions: string[];
  lastAnswer?: string;
  answerMode?: AnswerMode;
  attemptCount: number;
  verificationCount: number;
  warnings: string[];
  fieldIds: string[];
  /**
   * Which actor last modified this field.
   * Added by merged observer; null for legacy flows.
   */
  lastActor?: 'dom' | 'stagehand' | 'magnitude' | 'human' | null;
  /**
   * Stable hash of the section heading + field order within that section.
   * Used to detect DOM restructuring (repeater expansion) without full navigation.
   */
  sectionFingerprint?: string | null;
  /**
   * Provenance from the merged observer (which observation systems saw this field).
   * Only present when the merged observer pipeline is active.
   */
  observerProvenance?: {
    sources: Array<'dom' | 'ax' | 'stagehand'>;
    concordant: boolean | null;
  };
  lastUpdatedAt: string;
}

export interface LogicalPageRecord {
  pageId: string;
  sequence: number;
  pageStepKey: string;
  entryFingerprint: string;
  latestFingerprint: string;
  url: string;
  pageType: string;
  pageTitle?: string;
  status: LogicalPageStatus;
  enteredAt: string;
  lastSeenAt: string;
  exitedAt?: string;
  visitCount: number;
  questions: QuestionRecord[];
  actionables: ActionableRecord[];
  history: ContextEvent[];
  coverage: PageCoverage;
  mergeStats: PageMergeStats;
  domSummary?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextReport {
  pagesVisited: number;
  requiredUnresolved: Array<{
    pageId: string;
    pageSequence: number;
    pageType: string;
    promptText: string;
    questionKey: QuestionKey;
  }>;
  riskyOptionalAnswers: Array<{
    pageId: string;
    pageSequence: number;
    promptText: string;
    questionKey: QuestionKey;
    riskLevel: QuestionRiskLevel;
    answer?: string;
  }>;
  lowConfidenceAnswers: Array<{
    pageId: string;
    pageSequence: number;
    promptText: string;
    questionKey: QuestionKey;
    confidence: number;
    answer?: string;
  }>;
  ambiguousQuestionGroups: Array<{
    pageId: string;
    pageSequence: number;
    promptText: string;
    questionKey: QuestionKey;
    warnings: string[];
  }>;
  bestEffortGuesses: Array<{
    pageId: string;
    pageSequence: number;
    questionKey: QuestionKey;
    promptText: string;
    answer?: string;
    answerMode?: AnswerMode;
  }>;
  partialPages: Array<{
    pageId: string;
    pageSequence: number;
    pageType: string;
    status: LogicalPageStatus;
    requiredUnresolved: number;
  }>;
  flushStatus: 'flushed' | 'pending';
  flushError?: string;
}

/** Lightweight counts-only snapshot for real-time streaming. */
export interface ContextReportSnapshot {
  pagesVisited: number;
  requiredUnresolvedCount: number;
  riskyOptionalCount: number;
  lowConfidenceCount: number;
  ambiguousGroupCount: number;
  bestEffortGuessCount: number;
  partialPages: Array<{
    pageId: string;
    pageSequence: number;
    status: LogicalPageStatus;
    requiredUnresolved: number;
  }>;
  flushStatus: 'pending';
}

export interface PageContextSession {
  jobId: string;
  mastraRunId: string;
  startedAt: string;
  updatedAt: string;
  status: PageContextSessionStatus;
  pages: LogicalPageRecord[];
  activePageId?: string;
  reportDraft: ContextReport;
  version: number;
}

export interface QuestionSnapshot {
  questionKey: QuestionKey;
  orderIndex: number;
  promptText: string;
  normalizedPrompt: string;
  sectionLabel?: string;
  questionType: QuestionType;
  required: boolean;
  groupingConfidence: number;
  riskLevel: QuestionRiskLevel;
  warnings: string[];
  fieldIds: string[];
  selectors: string[];
  options: Array<{
    label: string;
    selector?: string;
    selected?: boolean;
  }>;
}

export interface AnswerDecision {
  questionKey: QuestionKey;
  answer: string;
  confidence: number;
  source: Exclude<QuestionSource, 'merged'>;
  answerMode?: AnswerMode;
}

export interface QuestionOutcome {
  questionKey: QuestionKey;
  state: Extract<QuestionState, 'verified' | 'filled' | 'failed' | 'empty' | 'uncertain'>;
  currentValue?: string;
  selectedOptions?: string[];
  confidence?: number;
  source: Exclude<QuestionSource, 'merged'>;
}

export interface PageAuditResult {
  pageId?: string;
  blockNavigation: boolean;
  unresolvedRequired: number;
  riskyOptional: number;
  lowConfidenceResolved: number;
  retrySuggested: boolean;
  summary: string;
  unresolvedQuestionKeys: QuestionKey[];
  riskyQuestionKeys: QuestionKey[];
}

export interface PageEntryInput {
  pageType: string;
  pageTitle?: string;
  url: string;
  fingerprint: string;
  pageStepKey: string;
  pageSequence: number;
  domSummary?: string;
}

export interface PageFinalizeInput {
  status?: LogicalPageStatus;
}
