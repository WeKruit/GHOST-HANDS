import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { models } from '../../../src/api/routes/models';

describe('GET /models', () => {
  const app = new Hono();
  app.route('/models', models);

  test('returns 200 with models array', async () => {
    const res = await app.request('/models');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.models).toBeArray();
    expect(body.models.length).toBeGreaterThan(0);
  });

  test('each model has required fields', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    for (const model of body.models) {
      expect(model.alias).toBeString();
      expect(model.model).toBeString();
      expect(model.provider).toBeString();
      expect(model.provider_name).toBeString();
      expect(typeof model.vision).toBe('boolean');
      expect(model.cost).toBeDefined();
      expect(model.cost.input).toBeNumber();
      expect(model.cost.output).toBeNumber();
      expect(model.cost.unit).toBe('$/M tokens');
    }
  });

  test('returns presets array', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    expect(body.presets).toBeArray();
    expect(body.presets.length).toBeGreaterThanOrEqual(4);

    for (const preset of body.presets) {
      expect(preset.name).toBeString();
      expect(preset.description).toBeString();
      expect(preset.model).toBeString();
    }
  });

  test('returns default model', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    expect(body.default).toBe('qwen-72b');
  });

  test('returns correct total count', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    expect(body.total).toBe(body.models.length);
    expect(body.total).toBeGreaterThanOrEqual(30);
  });

  test('includes known models', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    const aliases = body.models.map((m: any) => m.alias);
    expect(aliases).toContain('qwen3-vl-235b-thinking');
    expect(aliases).toContain('qwen-72b');
    expect(aliases).toContain('gpt-5.2');
    expect(aliases).toContain('claude-opus');
    expect(aliases).toContain('gemini-2.5-pro');
  });

  test('vision models are flagged correctly', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    const vl235b = body.models.find((m: any) => m.alias === 'qwen3-vl-235b-thinking');
    expect(vl235b.vision).toBe(true);

    const coder = body.models.find((m: any) => m.alias === 'qwen3-coder-480b');
    expect(coder.vision).toBe(false);

    const deepseek = body.models.find((m: any) => m.alias === 'deepseek-chat');
    expect(deepseek.vision).toBe(false);
  });

  test('presets reference valid model aliases', async () => {
    const res = await app.request('/models');
    const body = await res.json();

    const aliases = body.models.map((m: any) => m.alias);
    for (const preset of body.presets) {
      expect(aliases).toContain(preset.model);
    }
  });
});
