import type { QuestionIntent } from './questionClassifier';

/** Shape of an answer bank entry as received from VALET dispatch */
export interface AnswerBankEntry {
  question: string;
  answer: string;
  canonicalQuestion: string | null;
  intentTag: string | null;
  usageMode: 'always_use' | 'ask_each_time' | 'decline_to_answer';
  source: 'user_input' | 'resume_inferred' | 'application_learned';
  confidence: 'exact' | 'inferred' | 'learned';
  synonyms: string[] | null;
}

export interface ResolvedAnswer {
  answer: string;
  source: 'exact_match' | 'canonical_match' | 'intent_match';
  entry: AnswerBankEntry;
  matchConfidence: number;
}

/**
 * 3-tier answer resolution:
 * 1. Exact text match (question -> entry.question)
 * 2. Canonical question match (canonicalForm -> entry.canonicalQuestion)
 * 3. Intent tag match (intentTag -> entry.intentTag)
 *
 * Returns null if no match found or if the matching entry's usageMode
 * is 'ask_each_time' or 'decline_to_answer'.
 */
export function resolveFromBank(
  questionText: string,
  classification: QuestionIntent,
  answerBank: AnswerBankEntry[],
): ResolvedAnswer | null {
  if (!answerBank || answerBank.length === 0) return null;

  const normalizedQ = questionText.trim().toLowerCase();

  // Tier 1: Exact text match
  for (const entry of answerBank) {
    if (entry.question.trim().toLowerCase() === normalizedQ) {
      if (entry.usageMode !== 'always_use') return null;
      return {
        answer: entry.answer,
        source: 'exact_match',
        entry,
        matchConfidence: 1.0,
      };
    }
  }

  // Tier 2: Canonical question match
  if (classification.canonicalForm) {
    for (const entry of answerBank) {
      if (
        entry.canonicalQuestion &&
        entry.canonicalQuestion.trim().toLowerCase() === classification.canonicalForm
      ) {
        if (entry.usageMode !== 'always_use') return null;
        return {
          answer: entry.answer,
          source: 'canonical_match',
          entry,
          matchConfidence: 0.9,
        };
      }
      // Also check synonyms
      if (entry.synonyms) {
        for (const syn of entry.synonyms) {
          if (
            syn.trim().toLowerCase() === normalizedQ ||
            syn.trim().toLowerCase() === classification.canonicalForm
          ) {
            if (entry.usageMode !== 'always_use') return null;
            return {
              answer: entry.answer,
              source: 'canonical_match',
              entry,
              matchConfidence: 0.85,
            };
          }
        }
      }
    }
  }

  // Tier 3: Intent tag match (only if classification is confident enough)
  if (classification.intentTag !== 'other' && classification.confidence >= 0.7) {
    for (const entry of answerBank) {
      if (entry.intentTag === classification.intentTag) {
        if (entry.usageMode !== 'always_use') continue; // skip non-auto-use, keep scanning for always_use entry
        return {
          answer: entry.answer,
          source: 'intent_match',
          entry,
          matchConfidence: classification.confidence * 0.8,
        };
      }
    }
  }

  return null;
}
