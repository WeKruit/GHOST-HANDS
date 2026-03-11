import Anthropic from '@anthropic-ai/sdk';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { AnthropicClientConfig } from '../../workers/taskHandlers/types';
import {
  buildSystemPrompt,
  buildUserMessage,
  DECISION_TOOL,
  PLATFORM_GUARDRAILS,
} from './prompts';
import type { DecisionAction, PageDecisionContext } from './types';
import { DecisionActionSchema } from './types';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_API_RETRIES = 2;
const API_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_BASE_MS = 1000;

function normalizeModel(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_MODEL;
  return trimmed.replace('@', '-');
}

function buildAnthropicClientOptions(config?: AnthropicClientConfig): ConstructorParameters<typeof Anthropic>[0] | undefined {
  if (!config) return undefined;

  const { apiKey, authToken, baseURL, defaultHeaders } = config;
  const options = {
    ...(apiKey ? { apiKey } : {}),
    ...(authToken ? { authToken } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(defaultHeaders && Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
  };

  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Cost callback type — allows the caller to report token usage
 * to the CostTracker (which uses real costs from adapter events)
 * rather than estimating locally with hardcoded rates.
 */
export type OnTokenUsage = (usage: {
  inputTokens: number;
  outputTokens: number;
  model: string;
}) => void;

export class PageDecisionEngine {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onTokenUsage?: OnTokenUsage;

  constructor(config: {
    anthropicConfig?: AnthropicClientConfig;
    model?: string;
    onTokenUsage?: OnTokenUsage;
  } = {}) {
    this.client = new Anthropic(buildAnthropicClientOptions(config.anthropicConfig));
    this.model = normalizeModel(config.model);
    this.onTokenUsage = config.onTokenUsage;
  }

  async decide(
    context: PageDecisionContext,
    profileSummary: string,
    platform: string,
  ): Promise<DecisionAction & {
    tokenUsage: { input: number; output: number };
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const system = buildSystemPrompt(
      profileSummary,
      PLATFORM_GUARDRAILS[platform] ?? PLATFORM_GUARDRAILS.other,
    );
    const userMessage = buildUserMessage(context);

    let response!: Anthropic.Messages.Message;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        response = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: 512,
            temperature: 0,
            system,
            tools: [DECISION_TOOL],
            tool_choice: {
              type: 'tool',
              name: DECISION_TOOL.name,
            },
            messages: [
              {
                role: 'user',
                content: userMessage,
              },
            ],
          },
          { signal: controller.signal },
        );

        clearTimeout(timeout);
        lastError = null;
        break;
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        const isRateLimit = err instanceof Anthropic.RateLimitError;
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const isServerError = err instanceof Anthropic.InternalServerError;

        if (attempt < MAX_API_RETRIES && (isRateLimit || isTimeout || isServerError)) {
          const backoff = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        break;
      }
    }

    if (lastError) {
      const durationMs = Date.now() - startedAt;
      return {
        action: 'wait_and_retry',
        reasoning: `Anthropic API call failed after ${MAX_API_RETRIES + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        confidence: 0.05,
        tokenUsage: { input: 0, output: 0 },
        durationMs,
      };
    }

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const durationMs = Date.now() - startedAt;

    // Report token usage to CostTracker via callback instead of estimating locally.
    // The CostTracker receives real cost data from adapter tokensUsed events for
    // adapter calls. For direct Anthropic calls (decision engine), the CostTracker
    // uses the token counts for tracking; actual billing goes through VALET proxy.
    this.onTokenUsage?.({ inputTokens, outputTokens, model: this.model });

    const toolUse = response.content.find(
      (block): block is ToolUseBlock =>
        block.type === 'tool_use' && block.name === DECISION_TOOL.name,
    );

    if (!toolUse) {
      return {
        action: 'wait_and_retry',
        reasoning: 'Decision model returned no page_decision tool payload; retrying conservatively.',
        confidence: 0.15,
        tokenUsage: {
          input: inputTokens,
          output: outputTokens,
        },
        durationMs,
      };
    }

    const parsed = DecisionActionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return {
        action: 'wait_and_retry',
        reasoning: 'Decision payload failed schema validation; retrying conservatively.',
        confidence: 0.1,
        target: typeof toolUse.input === 'object' && toolUse.input && 'target' in toolUse.input
          ? String((toolUse.input as Record<string, unknown>).target ?? '')
          : undefined,
        tokenUsage: {
          input: inputTokens,
          output: outputTokens,
        },
        durationMs,
      };
    }

    return {
      ...parsed.data,
      tokenUsage: {
        input: inputTokens,
        output: outputTokens,
      },
      durationMs,
    };
  }
}
