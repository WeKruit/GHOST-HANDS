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

function estimateAnthropicCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const normalized = normalizeModel(model).toLowerCase();

  if (normalized.includes('haiku')) {
    return (inputTokens * 1.0 + outputTokens * 5.0) / 1_000_000;
  }

  if (normalized.includes('sonnet')) {
    return (inputTokens * 3.0 + outputTokens * 15.0) / 1_000_000;
  }

  return 0;
}

export class PageDecisionEngine {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: { anthropicConfig?: AnthropicClientConfig; model?: string } = {}) {
    this.client = new Anthropic(buildAnthropicClientOptions(config.anthropicConfig));
    this.model = normalizeModel(config.model);
  }

  async decide(
    context: PageDecisionContext,
    profileSummary: string,
    platform: string,
  ): Promise<DecisionAction & {
    tokenUsage: { input: number; output: number };
    costUsd: number;
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const system = buildSystemPrompt(
      profileSummary,
      PLATFORM_GUARDRAILS[platform] ?? PLATFORM_GUARDRAILS.other,
    );
    const userMessage = buildUserMessage(context);

    const response = await this.client.messages.create({
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
    });

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const durationMs = Date.now() - startedAt;
    const costUsd = estimateAnthropicCostUsd(this.model, inputTokens, outputTokens);

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
        costUsd,
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
        costUsd,
        durationMs,
      };
    }

    return {
      ...parsed.data,
      tokenUsage: {
        input: inputTokens,
        output: outputTokens,
      },
      costUsd,
      durationMs,
    };
  }
}
