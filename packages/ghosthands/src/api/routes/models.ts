import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';

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
  providers: Record<string, { name: string; envKey: string; baseUrl?: string; docs: string }>;
  models: Record<string, ModelEntry>;
  presets: Record<string, PresetEntry>;
  default: string;
}

let _cached: ModelsConfig | null = null;

function loadConfig(): ModelsConfig {
  if (_cached) return _cached;
  const configPath = path.resolve(__dirname, '../../config/models.config.json');
  _cached = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModelsConfig;
  return _cached;
}

const models = new Hono();

/**
 * GET /models — List all available models and presets.
 *
 * Returns the full model catalog so VALET can populate
 * the apply form's model selector dynamically.
 */
models.get('/', (c) => {
  const config = loadConfig();

  const modelList = Object.entries(config.models).map(([alias, entry]) => ({
    alias,
    model: entry.model,
    provider: entry.provider,
    provider_name: config.providers[entry.provider]?.name ?? entry.provider,
    vision: entry.vision,
    cost: entry.cost,
    note: entry.note ?? null,
  }));

  const presets = Object.entries(config.presets).map(([name, preset]) => ({
    name,
    description: preset.description,
    model: preset.model,
  }));

  return c.json({
    models: modelList,
    presets,
    default: config.default,
    total: modelList.length,
  });
});

export { models };
