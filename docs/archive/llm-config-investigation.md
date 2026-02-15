# LLM Configuration Investigation: DeepSeek + GLM-5 Breakdown

**Investigator:** config-investigator agent
**Date:** 2026-02-14
**Status:** Investigation complete -- multiple root causes identified

---

## Executive Summary

The DeepSeek + GLM-5 setup is broken due to **five compounding issues**:

1. **`buildLLMClient()` in JobExecutor does NOT use the models.config.json system** -- it uses a hardcoded provider-selection ladder that cannot route to DeepSeek properly
2. **DeepSeek requires `openai-generic` provider with a `baseUrl`** -- but JobExecutor passes `provider: 'openai'` (no baseUrl), which sends requests to OpenAI's endpoint instead of DeepSeek's
3. **GLM-5 is not configured anywhere** -- no model entry, no provider entry, no env var
4. **The DEEPSEEK_API_KEY is duplicated into OPENAI_API_KEY in packages/ghosthands/.env** -- causing the DeepSeek key to be sent to OpenAI's servers
5. **The `LLMConfig` type in adapters/types.ts does not include `baseUrl`** -- so even if JobExecutor tried to set a baseUrl, TypeScript would not pass it through

---

## Detailed Findings

### Issue 1: Two Separate LLM Config Systems (Disconnected)

There are **two independent LLM configuration systems** that do not talk to each other:

| System | Location | Used by |
|--------|----------|---------|
| **models.config.json + loadModelConfig()** | `src/config/models.ts` + `src/config/models.config.json` | Nothing in production (CLI/manual use only) |
| **Hardcoded buildLLMClient()** | `src/workers/JobExecutor.ts:486-520` | The actual job worker |

The `models.config.json` correctly defines DeepSeek with `openai-generic` provider and `baseUrl: "https://api.deepseek.com/v1"`. The `loadModelConfig()` function in `src/config/models.ts` correctly builds an `openai-generic` LLMClient with baseUrl for non-OpenAI/non-Anthropic providers.

**But none of this is used.** The `JobExecutor.buildLLMClient()` method (line 486) has its own hardcoded logic that ignores the config system entirely:

```typescript
// JobExecutor.ts:486-520
private buildLLMClient(job: AutomationJob): LLMConfig {
    const tier = job.input_data.tier || 'starter';

    // Only checks: anthropic (premium) -> openai (if OPENAI_API_KEY set) -> google-ai fallback
    if (tier === 'premium' && process.env.ANTHROPIC_API_KEY) {
      return { provider: 'anthropic', options: { model: 'claude-sonnet-4-5-20250929', apiKey: ... } };
    }

    if (process.env.OPENAI_API_KEY) {
      return { provider: 'openai', options: { model: process.env.GH_DEFAULT_MODEL || 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY } };
    }

    return { provider: 'google-ai', options: { model: 'gemini-2.5-pro-preview-05-06', apiKey: process.env.GOOGLE_API_KEY } };
}
```

**Problems:**
- No `deepseek` branch
- No `siliconflow` branch
- No `openai-generic` provider support at all
- No `baseUrl` in any return path
- No reference to `DEEPSEEK_API_KEY` or `SILICONFLOW_API_KEY`

### Issue 2: DeepSeek Key Misrouted as OpenAI

In `packages/ghosthands/.env`:

```bash
OPENAI_API_KEY=sk-8dd8c7a9bea943d090638df4f271d4cc    # <-- This is the DeepSeek key!
GH_DEFAULT_MODEL=deepseek-chat
DEEPSEEK_API_KEY=sk-8dd8c7a9bea943d090638df4f271d4cc   # <-- Same key, correct var name
```

Because `buildLLMClient()` checks `process.env.OPENAI_API_KEY` and finds it set, it returns:

```typescript
{
  provider: 'openai',          // <-- WRONG: sends to api.openai.com
  options: {
    model: 'deepseek-chat',    // <-- DeepSeek model name
    apiKey: 'sk-8dd8c...'      // <-- DeepSeek API key
  }
}
```

This config is then passed to magnitude-core's `startBrowserAgent()`, which tries to call OpenAI's API with a DeepSeek key and a DeepSeek model name. This will fail with an authentication error or a "model not found" error from OpenAI.

**What it should be:**
```typescript
{
  provider: 'openai-generic',
  options: {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-8dd8c...'
  }
}
```

### Issue 3: GLM-5 Is Completely Missing

There is zero configuration for GLM-5 (Zhipu AI's ChatGLM-5 model) anywhere in the codebase:

- Not in `models.config.json`
- Not in any `.env` file
- Not in `JobExecutor.buildLLMClient()`
- Not in any documentation
- No `ZHIPU_API_KEY` or `GLM_API_KEY` env var defined
- No provider entry for Zhipu AI

GLM-5 would need to be added as:
- A new provider in models.config.json (Zhipu AI uses an OpenAI-compatible API at `https://open.bigmodel.cn/api/paas/v4/`)
- A new env var (`ZHIPU_API_KEY`)
- A new model entry
- A branch in `buildLLMClient()` (or better, integrate with the existing config system)

### Issue 4: LLMConfig Type Missing baseUrl

The `LLMConfig` interface in `src/adapters/types.ts:135-143`:

```typescript
export interface LLMConfig {
  provider: string;
  options: {
    model: string;
    apiKey?: string;
  };
  roles?: ('act' | 'extract' | 'query')[];
}
```

This type does **not include `baseUrl`**, `temperature`, or `headers` -- all of which are required by magnitude-core's `OpenAIGenericClient` interface.

The `MagnitudeAdapter.start()` method casts the llm config with `as any` (line 31), so the missing type wouldn't cause a runtime error if the data were correct. But it means:
- TypeScript won't catch missing baseUrl at compile time
- The `buildLLMClient()` return type doesn't allow baseUrl

### Issue 5: DeepSeek Is Text-Only (No Vision)

Even if the routing were fixed, DeepSeek's `deepseek-chat` model does **not support vision/image inputs**. From the project's own `docs/CHEAP-PROVIDERS.md`:

> DeepSeek's official API does NOT support vision/image inputs. The models `deepseek-chat` and `deepseek-reasoner` are text-only. If you send an image to DeepSeek, you will get this error:
> ```
> unknown variant `image_url`, expected `text`
> ```

Magnitude-core's browser automation relies on screenshots for visual understanding. A text-only model will fail unless magnitude-core falls back to accessibility tree only (which it does annotate in the models.config.json as `"vision": false`).

This means DeepSeek can work for simple form-filling via accessibility tree, but will fail on visually complex pages.

---

## Root .env vs packages/ghosthands/.env

There are two `.env` files with different contents:

| File | Contents |
|------|----------|
| `/.env` | Only `DEEPSEEK_API_KEY=sk-8dd8c...` (1 line) |
| `/packages/ghosthands/.env` | Full config with Supabase, S3, LLM keys, etc. |

The root `.env` is minimal and only contains the DeepSeek key. The worker likely loads from `packages/ghosthands/.env`. The `verify-setup.ts` script loads from `../../../../.env` (root), which would miss most config.

---

## What "Previously Working" Likely Means

Based on the codebase evidence, the "previously working" setup was likely:

1. Using `loadModelConfig()` from `src/config/models.ts` directly (CLI/test scripts)
2. Running test scripts that manually configured the LLM client with `openai-generic` + DeepSeek baseUrl
3. NOT going through the `JobExecutor` worker path

The `JobExecutor.buildLLMClient()` method appears to have been written later as a simplified version that only supports 3 providers (anthropic, openai, google-ai) and broke compatibility with the flexible config system.

---

## Recommended Fixes

### Fix 1: Connect JobExecutor to models.config.json (Critical)

Replace the hardcoded `buildLLMClient()` in `JobExecutor.ts` with a call to `loadModelConfig()`:

```typescript
import { loadModelConfig } from '../config/models.js';

private buildLLMClient(job: AutomationJob): LLMConfig {
    const tier = job.input_data.tier || 'starter';

    // Premium tier uses Anthropic Claude
    if (tier === 'premium') {
        const resolved = loadModelConfig('claude-sonnet');
        return resolved.llmClient as LLMConfig;
    }

    // Use MODEL env var or job-specific override or config default
    const modelOverride = job.metadata?.model || process.env.MODEL;
    const resolved = loadModelConfig(modelOverride);
    return resolved.llmClient as LLMConfig;
}
```

### Fix 2: Update LLMConfig Type (Critical)

Add `baseUrl` and `headers` to `LLMConfig` in `src/adapters/types.ts`:

```typescript
export interface LLMConfig {
  provider: string;
  options: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    headers?: Record<string, string>;
  };
  roles?: ('act' | 'extract' | 'query')[];
}
```

### Fix 3: Fix .env Configuration (Critical)

In `packages/ghosthands/.env`, remove the DeepSeek key from `OPENAI_API_KEY`:

```bash
# WRONG: DeepSeek key masquerading as OpenAI
OPENAI_API_KEY=sk-8dd8c7a9bea943d090638df4f271d4cc

# RIGHT: Remove OPENAI_API_KEY, keep DEEPSEEK_API_KEY
# OPENAI_API_KEY=
DEEPSEEK_API_KEY=sk-8dd8c7a9bea943d090638df4f271d4cc
```

And set the MODEL env var to select the default:
```bash
MODEL=deepseek-chat
```

### Fix 4: Add GLM-5 Configuration (New Feature)

Add to `models.config.json`:

```json
{
  "providers": {
    "zhipu": {
      "name": "Zhipu AI (ChatGLM)",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4/",
      "envKey": "ZHIPU_API_KEY",
      "docs": "https://open.bigmodel.cn/dev/api/thirdparty-frame/openai-sdk"
    }
  },
  "models": {
    "glm-5": {
      "provider": "zhipu",
      "model": "glm-5",
      "vision": true,
      "cost": { "input": 0.50, "output": 0.50, "unit": "$/M tokens" },
      "note": "Zhipu AI GLM-5, supports vision via OpenAI-compatible API"
    }
  }
}
```

Add to `.env`:
```bash
ZHIPU_API_KEY=your-zhipu-api-key-here
```

### Fix 5: Consider Vision Fallback Strategy

Since DeepSeek is text-only, configure a dual-model setup where:
- DeepSeek handles `act` and `extract` roles (text reasoning)
- A cheap vision model (Qwen VL 7B via SiliconFlow) handles screenshot analysis

magnitude-core supports multi-model configs via the `LLMClient[]` array:

```typescript
const llm: LLMClient[] = [
  {
    provider: 'openai-generic',
    options: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: '...' },
    roles: ['act', 'extract'],
  },
  {
    provider: 'openai-generic',
    options: { model: 'Qwen/Qwen2.5-VL-7B-Instruct', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '...' },
    roles: ['query'],  // vision-based observation
  },
];
```

---

## Files That Need Changes

| File | Change | Priority |
|------|--------|----------|
| `src/workers/JobExecutor.ts` | Replace `buildLLMClient()` to use config system | P0 |
| `src/adapters/types.ts` | Add `baseUrl`, `headers`, `temperature` to LLMConfig | P0 |
| `packages/ghosthands/.env` | Remove DeepSeek key from OPENAI_API_KEY; add MODEL var | P0 |
| `src/config/models.config.json` | Add GLM-5/Zhipu provider+model entries | P1 |
| `.env.example` | Add DEEPSEEK_API_KEY, SILICONFLOW_API_KEY, ZHIPU_API_KEY, MODEL | P1 |
| `src/adapters/magnitude.ts` | Support LLMClient[] array for multi-model | P2 |

---

## Summary of Root Causes

```
Root cause tree:

DeepSeek broken:
  +-- JobExecutor.buildLLMClient() ignores models.config.json
  +-- OPENAI_API_KEY set to DeepSeek key -> routes to OpenAI servers
  +-- provider: 'openai' used instead of 'openai-generic' -> no baseUrl
  +-- LLMConfig type missing baseUrl field
  +-- DeepSeek is text-only -> will fail on vision-dependent pages

GLM-5 broken:
  +-- No provider entry for Zhipu AI
  +-- No model entry for GLM-5
  +-- No ZHIPU_API_KEY env var
  +-- No code path to select GLM-5
```
