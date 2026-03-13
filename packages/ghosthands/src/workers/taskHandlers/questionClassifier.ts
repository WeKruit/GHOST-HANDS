import { z } from 'zod';

// Intent enum matching VALET's qaIntentTag
export const QuestionIntentSchema = z.object({
  intentTag: z.enum([
    'relocation_willingness',
    'salary_expectation',
    'start_date',
    'work_authorization',
    'sponsorship_need',
    'referral_source',
    'why_this_role',
    'why_this_company',
    'career_goals',
    'relevant_experience',
    'biggest_strength',
    'biggest_weakness',
    'leadership_example',
    'conflict_resolution',
    'project_highlight',
    'availability',
    'notice_period',
    'remote_preference',
    'other',
  ]),
  canonicalForm: z.string().describe('Normalized version of the question'),
  confidence: z.number().min(0).max(1),
});

export type QuestionIntent = z.infer<typeof QuestionIntentSchema>;

// Session-scoped cache to avoid re-classifying the same question
const classificationCache = new Map<string, QuestionIntent>();

export function clearClassificationCache(): void {
  classificationCache.clear();
}

/**
 * Classify a form question into an intent category.
 * Uses LLM structured output with session-scoped caching.
 */
export async function classifyQuestion(
  questionText: string,
  options?: { choices?: string[]; fieldType?: string },
): Promise<QuestionIntent> {
  const cacheKey = questionText.trim().toLowerCase();
  const cached = classificationCache.get(cacheKey);
  if (cached) return cached;

  // For now, use heuristic classification (fast, no LLM cost)
  // Phase 3b will add LLM-based classification for ambiguous cases
  const result = classifyByHeuristic(questionText, options);
  classificationCache.set(cacheKey, result);
  return result;
}

function classifyByHeuristic(
  questionText: string,
  _options?: { choices?: string[]; fieldType?: string },
): QuestionIntent {
  const q = questionText.toLowerCase().trim();

  const patterns: Array<[RegExp, QuestionIntent['intentTag']]> = [
    [/relocat/i, 'relocation_willingness'],
    [/salary|compensation|pay|wage|desired.?(?:pay|rate)/i, 'salary_expectation'],
    [/start.?date|when.?(?:can|could|would).?(?:you)?.?(?:start|begin|join)/i, 'start_date'],
    [
      /(?:work|employment).?auth|(?:legally|authorized).?(?:to)?.?work|right.?to.?work/i,
      'work_authorization',
    ],
    [/sponsor|visa/i, 'sponsorship_need'],
    [/(?:how|where).?(?:did)?.?(?:you)?.?(?:hear|find|learn|discover)|refer|referral|(?:source|channel).?(?:of|for).?(?:application|interest)/i, 'referral_source'],
    [/why.?(?:this|the|our).?(?:role|position|job|opportunity)|why.?(?:do)?.?(?:you)?.?(?:want|interested|apply|joining)|tell.?us.?why.?(?:you)?.?(?:want)?.?(?:to)?.?join/i, 'why_this_role'],
    [/why.?(?:this|the|our).?(?:company|organization|firm|team)|why.?(?:do)?.?(?:you)?.?(?:want).?(?:to)?.?(?:work|join).?(?:here|us|at)/i, 'why_this_company'],
    [/career.?goal|where.?(?:do)?.?(?:you)?.?see.?yourself/i, 'career_goals'],
    [
      /(?:relevant|related).?experience|experience.?(?:with|in|related)/i,
      'relevant_experience',
    ],
    [/(?:greatest|biggest|key).?strength/i, 'biggest_strength'],
    [/(?:greatest|biggest|key).?weakness/i, 'biggest_weakness'],
    [/leader|led.?a.?team|managed.?a/i, 'leadership_example'],
    [
      /conflict|disagree|difficult.?(?:situation|coworker|colleague)/i,
      'conflict_resolution',
    ],
    [/project.?(?:highlight|proud|accomplished|significant)/i, 'project_highlight'],
    [/availab|earliest/i, 'availability'],
    [/notice.?period|(?:how|when).?(?:much|long).?notice/i, 'notice_period'],
    [
      /remote|hybrid|(?:in|on).?(?:site|office)|work.?(?:from|location|arrangement)/i,
      'remote_preference',
    ],
  ];

  for (const [pattern, tag] of patterns) {
    if (pattern.test(q)) {
      return {
        intentTag: tag,
        canonicalForm: q.replace(/[?.,!]+$/g, '').trim(),
        confidence: 0.85,
      };
    }
  }

  return {
    intentTag: 'other',
    canonicalForm: q.replace(/[?.,!]+$/g, '').trim(),
    confidence: 0.5,
  };
}
