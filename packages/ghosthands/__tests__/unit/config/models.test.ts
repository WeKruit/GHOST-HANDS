import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Load the config directly for validation tests
const configPath = path.resolve(__dirname, '../../../src/config/models.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Import the resolution logic
// loadModelConfig reads process.env so we need to control that
import { loadModelConfig } from '../../../src/config/models';

// ---------------------------------------------------------------------------
// Config structure validation
// ---------------------------------------------------------------------------

describe('models.config.json structure', () => {
  test('has version field', () => {
    expect(config.version).toBe(1);
  });

  test('has providers, models, presets, and default fields', () => {
    expect(config.providers).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.presets).toBeDefined();
    expect(config.default).toBeDefined();
  });

  test('all models reference valid providers', () => {
    const providerKeys = Object.keys(config.providers);
    for (const [alias, entry] of Object.entries(config.models) as [string, any][]) {
      expect(providerKeys).toContain(entry.provider);
    }
  });

  test('all presets reference existing models', () => {
    const modelKeys = Object.keys(config.models);
    for (const [name, preset] of Object.entries(config.presets) as [string, any][]) {
      expect(modelKeys).toContain(preset.model);
    }
  });

  test('default references an existing model', () => {
    expect(Object.keys(config.models)).toContain(config.default);
  });

  test('all models have required fields', () => {
    for (const [alias, entry] of Object.entries(config.models) as [string, any][]) {
      expect(entry.provider).toBeString();
      expect(entry.model).toBeString();
      expect(typeof entry.vision).toBe('boolean');
      expect(entry.cost).toBeDefined();
      expect(entry.cost.input).toBeNumber();
      expect(entry.cost.output).toBeNumber();
      expect(entry.cost.unit).toBe('$/M tokens');
    }
  });

  test('all providers have required fields', () => {
    for (const [key, provider] of Object.entries(config.providers) as [string, any][]) {
      expect(provider.name).toBeString();
      expect(provider.envKey).toBeString();
      expect(provider.docs).toBeString();
      // baseUrl is optional (anthropic doesn't have one)
      if (key !== 'anthropic') {
        expect(provider.baseUrl).toBeString();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// New provider: qwen-alibaba
// ---------------------------------------------------------------------------

describe('qwen-alibaba provider', () => {
  test('exists in providers', () => {
    expect(config.providers['qwen-alibaba']).toBeDefined();
  });

  test('has correct baseUrl for DashScope', () => {
    expect(config.providers['qwen-alibaba'].baseUrl).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    );
  });

  test('uses DASHSCOPE_API_KEY env key', () => {
    expect(config.providers['qwen-alibaba'].envKey).toBe('DASHSCOPE_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// New models: qwen3.5-plus, gpt-4.1, gpt-5.2
// ---------------------------------------------------------------------------

describe('qwen3.5-plus model', () => {
  test('exists in models', () => {
    expect(config.models['qwen3.5-plus']).toBeDefined();
  });

  test('uses qwen-alibaba provider', () => {
    expect(config.models['qwen3.5-plus'].provider).toBe('qwen-alibaba');
  });

  test('has vision support', () => {
    expect(config.models['qwen3.5-plus'].vision).toBe(true);
  });

  test('has correct pricing', () => {
    expect(config.models['qwen3.5-plus'].cost.input).toBe(0.40);
    expect(config.models['qwen3.5-plus'].cost.output).toBe(2.40);
  });
});

describe('gpt-4.1 model', () => {
  test('exists in models', () => {
    expect(config.models['gpt-4.1']).toBeDefined();
  });

  test('uses openai provider', () => {
    expect(config.models['gpt-4.1'].provider).toBe('openai');
  });

  test('has vision support', () => {
    expect(config.models['gpt-4.1'].vision).toBe(true);
  });

  test('has correct pricing', () => {
    expect(config.models['gpt-4.1'].cost.input).toBe(2.00);
    expect(config.models['gpt-4.1'].cost.output).toBe(8.00);
  });
});

describe('gpt-5.2 model', () => {
  test('exists in models', () => {
    expect(config.models['gpt-5.2']).toBeDefined();
  });

  test('uses openai provider', () => {
    expect(config.models['gpt-5.2'].provider).toBe('openai');
  });

  test('has vision support', () => {
    expect(config.models['gpt-5.2'].vision).toBe(true);
  });

  test('has correct pricing', () => {
    expect(config.models['gpt-5.2'].cost.input).toBe(1.75);
    expect(config.models['gpt-5.2'].cost.output).toBe(14.00);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek updated pricing (V3.2 price cut)
// ---------------------------------------------------------------------------

describe('DeepSeek updated pricing', () => {
  test('deepseek-chat has V3.2 pricing', () => {
    expect(config.models['deepseek-chat'].cost.input).toBe(0.28);
    expect(config.models['deepseek-chat'].cost.output).toBe(0.42);
  });

  test('deepseek-reasoner pricing unchanged', () => {
    expect(config.models['deepseek-reasoner'].cost.input).toBe(0.55);
    expect(config.models['deepseek-reasoner'].cost.output).toBe(2.19);
  });
});

// ---------------------------------------------------------------------------
// Updated presets (accuracy focus)
// ---------------------------------------------------------------------------

describe('updated presets', () => {
  test('speed preset is qwen-7b (unchanged)', () => {
    expect(config.presets.speed.model).toBe('qwen-7b');
  });

  test('balanced preset is qwen3-235b', () => {
    expect(config.presets.balanced.model).toBe('qwen3-235b');
  });

  test('quality preset is qwen3.5-plus', () => {
    expect(config.presets.quality.model).toBe('qwen3.5-plus');
  });

  test('premium preset is gpt-5.2', () => {
    expect(config.presets.premium.model).toBe('gpt-5.2');
  });

  test('default is still qwen-72b', () => {
    expect(config.default).toBe('qwen-72b');
  });
});

// ---------------------------------------------------------------------------
// Model resolution via loadModelConfig
// ---------------------------------------------------------------------------

describe('loadModelConfig resolution', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      GH_MODEL: process.env.GH_MODEL,
      MODEL: process.env.MODEL,
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    };
    // Clear model env vars so override parameter takes effect
    delete process.env.GH_MODEL;
    delete process.env.MODEL;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  test('resolves qwen3.5-plus by direct alias', () => {
    const resolved = loadModelConfig('qwen3.5-plus');
    expect(resolved.alias).toBe('qwen3.5-plus');
    expect(resolved.model).toBe('qwen3.5-plus');
    expect(resolved.providerKey).toBe('qwen-alibaba');
    expect(resolved.providerName).toBe('Alibaba Cloud (Qwen)');
    expect(resolved.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    expect(resolved.vision).toBe(true);
  });

  test('qwen3.5-plus resolves to openai-generic provider', () => {
    const resolved = loadModelConfig('qwen3.5-plus');
    expect(resolved.llmClient.provider).toBe('openai-generic');
    expect(resolved.llmClient.options.baseUrl).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    );
  });

  test('resolves gpt-4.1 with openai provider', () => {
    const resolved = loadModelConfig('gpt-4.1');
    expect(resolved.alias).toBe('gpt-4.1');
    expect(resolved.model).toBe('gpt-4.1');
    expect(resolved.providerKey).toBe('openai');
    expect(resolved.llmClient.provider).toBe('openai');
  });

  test('resolves gpt-5.2 with openai provider', () => {
    const resolved = loadModelConfig('gpt-5.2');
    expect(resolved.alias).toBe('gpt-5.2');
    expect(resolved.model).toBe('gpt-5.2');
    expect(resolved.providerKey).toBe('openai');
    expect(resolved.llmClient.provider).toBe('openai');
  });

  test('quality preset resolves to qwen3.5-plus', () => {
    const resolved = loadModelConfig('quality');
    expect(resolved.alias).toBe('qwen3.5-plus');
    expect(resolved.providerKey).toBe('qwen-alibaba');
  });

  test('balanced preset resolves to qwen3-235b', () => {
    const resolved = loadModelConfig('balanced');
    expect(resolved.alias).toBe('qwen3-235b');
  });

  test('premium preset resolves to gpt-5.2', () => {
    const resolved = loadModelConfig('premium');
    expect(resolved.alias).toBe('gpt-5.2');
    expect(resolved.providerKey).toBe('openai');
  });

  test('speed preset resolves to qwen-7b (unchanged)', () => {
    const resolved = loadModelConfig('speed');
    expect(resolved.alias).toBe('qwen-7b');
  });

  test('default resolves to qwen-72b', () => {
    const resolved = loadModelConfig();
    expect(resolved.alias).toBe('qwen-72b');
  });

  test('throws on unknown model', () => {
    expect(() => loadModelConfig('nonexistent-model')).toThrow(/Unknown model/);
  });
});
