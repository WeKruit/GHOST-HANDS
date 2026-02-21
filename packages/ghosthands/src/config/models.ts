/**
 * Model Configuration Loader
 *
 * Resolves which LLM to use based on (in priority order):
 *   1. CLI flag:    --model=qwen-7b
 *   2. Env var:     MODEL=qwen-7b
 *   3. Preset flag: --model=speed  (resolves via presets)
 *   4. Preset env:  MODEL=speed
 *   5. Default from models.config.json
 *
 * Returns an LLMClient config object ready to pass to BrowserAgent.
 *
 * Usage:
 *   import { loadModelConfig } from 'ghosthands/config';
 *   const llm = loadModelConfig();
 *   const agent = new BrowserAgent({ agentOptions: { llm }, ... });
 */

import fs from 'fs';
import path from 'path';
import { getLogger } from '../monitoring/logger.js';

// -- Types --

interface ProviderEntry {
    name: string;
    baseUrl?: string;
    envKey: string;
    docs: string;
}

interface CostInfo {
    input: number;
    output: number;
    unit: string;
}

interface ModelEntry {
    provider: string;
    model: string;
    vision: boolean;
    cost: CostInfo;
    note?: string;
}

interface PresetEntry {
    description: string;
    model: string;
}

interface ModelsConfig {
    version: number;
    providers: Record<string, ProviderEntry>;
    models: Record<string, ModelEntry>;
    presets: Record<string, PresetEntry>;
    default: string;
}

export interface ResolvedModel {
    /** Short alias used to select this model (e.g. "qwen-72b") */
    alias: string;
    /** Full model identifier sent to the API */
    model: string;
    /** Provider key from config */
    providerKey: string;
    /** Provider display name */
    providerName: string;
    /** API base URL (undefined for native providers like Anthropic) */
    baseUrl?: string;
    /** API key sourced from the environment */
    apiKey: string;
    /** Whether this model supports vision/image inputs */
    vision: boolean;
    /** Cost info */
    cost: CostInfo;
    /** The LLMClient object ready for BrowserAgent */
    llmClient: {
        provider: 'openai-generic' | 'anthropic' | 'openai';
        options: Record<string, any>;
    };
}

// -- Config Loading --

let _cachedConfig: ModelsConfig | null = null;

function loadConfig(): ModelsConfig {
    if (_cachedConfig) return _cachedConfig;

    const configPath = path.resolve(__dirname, 'models.config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error(`Model config not found: ${configPath}`);
    }
    _cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModelsConfig;
    return _cachedConfig;
}

// -- CLI Argument Parsing --

function getModelFromArgs(): string | undefined {
    for (const arg of process.argv) {
        if (arg.startsWith('--model=')) {
            return arg.slice('--model='.length);
        }
    }
    return undefined;
}

// -- Resolution --

/**
 * Resolve a model alias or preset name to a concrete model alias.
 * Returns the canonical alias (key in config.models).
 */
function resolveAlias(config: ModelsConfig, input: string): string {
    const lower = input.toLowerCase();

    // Direct model match
    if (config.models[lower]) {
        return lower;
    }

    // Preset match
    if (config.presets[lower]) {
        return config.presets[lower].model;
    }

    // Try matching by full model name (e.g. "Qwen/Qwen2.5-VL-72B-Instruct")
    for (const [alias, entry] of Object.entries(config.models)) {
        if (entry.model.toLowerCase() === lower || entry.model === input) {
            return alias;
        }
    }

    // List available options for a helpful error
    const available = [
        ...Object.keys(config.models),
        ...Object.keys(config.presets).map(p => `${p} (preset)`),
    ];
    throw new Error(
        `Unknown model "${input}". Available:\n  ${available.join('\n  ')}`
    );
}

/**
 * Build the LLMClient config for a resolved model.
 */
function buildLLMClient(config: ModelsConfig, alias: string): ResolvedModel {
    const logger = getLogger();
    const entry = config.models[alias];
    const provider = config.providers[entry.provider];

    // Get the API key from environment
    const apiKey = process.env[provider.envKey] || '';

    if (!apiKey) {
        logger.warn('API key not set', { envKey: provider.envKey, provider: provider.name, docs: provider.docs });
    }

    // Anthropic uses its native provider; everything else goes through openai-generic
    let llmClient: ResolvedModel['llmClient'];

    if (entry.provider === 'anthropic') {
        llmClient = {
            provider: 'anthropic',
            options: {
                model: entry.model,
                apiKey: apiKey || undefined,
            },
        };
    } else if (entry.provider === 'openai') {
        llmClient = {
            provider: 'openai',
            options: {
                model: entry.model,
                apiKey: apiKey || undefined,
            },
        };
    } else {
        llmClient = {
            provider: 'openai-generic',
            options: {
                model: entry.model,
                baseUrl: provider.baseUrl!,
                apiKey: apiKey || undefined,
            },
        };
    }

    return {
        alias,
        model: entry.model,
        providerKey: entry.provider,
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        apiKey,
        vision: entry.vision,
        cost: entry.cost,
        llmClient,
    };
}

// -- Public API --

/**
 * Load model configuration from CLI args, env vars, or defaults.
 *
 * Priority: --model=X > MODEL=X > config default
 */
export function loadModelConfig(override?: string): ResolvedModel {
    const config = loadConfig();
    const input = override || getModelFromArgs() || process.env.GH_MODEL || process.env.MODEL || config.default;
    const alias = resolveAlias(config, input);
    return buildLLMClient(config, alias);
}

/**
 * List all available models with their details.
 */
export function listModels(): void {
    const config = loadConfig();
    const logger = getLogger();

    const presets = Object.entries(config.presets).map(
        ([name, preset]) => `    ${name.padEnd(12)} -> ${preset.model.padEnd(14)} ${preset.description}`
    );

    const models = Object.entries(config.models).map(([alias, entry]) => {
        const provider = config.providers[entry.provider];
        const vision = entry.vision ? 'vision' : 'text  ';
        const cost = `$${entry.cost.input.toFixed(2)}/$${entry.cost.output.toFixed(2)} per M tokens`;
        return `    ${alias.padEnd(18)} ${vision}  ${provider.name.padEnd(18)} ${cost}`;
    });

    logger.info('Available models', {
        presets: presets.join('\n'),
        models: models.join('\n'),
        default: config.default,
    });
}

/**
 * Print the resolved model info to console.
 */
export function printModelInfo(resolved: ResolvedModel): void {
    const logger = getLogger();
    logger.info('Resolved model', {
        alias: resolved.alias,
        model: resolved.model,
        provider: resolved.providerName,
        baseUrl: resolved.baseUrl,
        vision: resolved.vision,
        costInputPerMTokens: resolved.cost.input,
        costOutputPerMTokens: resolved.cost.output,
        ...(resolved.vision ? {} : { note: 'No vision support; browser automation uses accessibility tree only' }),
    });
}
