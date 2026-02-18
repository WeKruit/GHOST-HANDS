# Cheap LLM Providers for GhostHands

A practical guide to setting up affordable, vision-capable LLMs for browser automation with Magnitude.

---

## Quick Comparison

| Provider | Model | Vision? | Input $/M | Output $/M | Context | Speed | Recommendation |
|----------|-------|---------|-----------|------------|---------|-------|----------------|
| **SiliconFlow** | Qwen2.5-VL-7B | Yes | $0.05 | $0.05 | 32K | Fast | Budget pick |
| **SiliconFlow** | Qwen2.5-VL-72B | Yes | $0.25 | $0.75 | 32K | Medium | **Best overall** |
| **SiliconFlow** | Qwen3-VL-8B | Yes | $0.18 | $0.68 | 262K | Fast | Good balance |
| **SiliconFlow** | Qwen3-VL-235B (MoE) | Yes | $0.20 | $0.88 | 262K | Medium | High quality |
| **Kimi (Moonshot)** | moonshot-v1-32k-vision-preview | Yes | $0.60 | $3.00 | 32K | Medium | Alternative |
| **MiniMax** | MiniMax-VL-01 | Yes* | $0.20 | $1.10 | 1M | Medium | Unconfirmed* |
| **MiniMax** | MiniMax-M2.5 | No | $0.26 | $1.00 | 204K | Fast | Text-only fallback |
| **DeepSeek** | deepseek-chat | No | $0.28 | $0.42 | 128K | Fast | Not for vision |

> \* MiniMax-VL-01 exists but is not consistently listed in their API docs. It may or may not be available. The script includes a fallback to MiniMax-M2.5 (text-only).

### Cost Comparison (per 1M tokens, input + output average)

```
Qwen2.5-VL-7B (SiliconFlow):   $0.05   <-- 200x cheaper than Claude
Qwen3-VL-8B (SiliconFlow):     $0.43
Qwen2.5-VL-72B (SiliconFlow):  $0.50   <-- recommended
Qwen3-VL-235B (SiliconFlow):   $0.54
MiniMax-VL-01:                  $0.65
DeepSeek (text only):           $0.35
Kimi vision:                    $1.80
Claude Sonnet 4:               ~$10.00
```

---

## Provider Setup Instructions

### 1. Qwen VL via SiliconFlow (Recommended)

SiliconFlow hosts open-source Qwen vision models with an OpenAI-compatible API. This is the cheapest and most reliable option for GhostHands.

**Get your API key:**
1. Go to [https://cloud.siliconflow.com](https://cloud.siliconflow.com) (or [https://siliconflow.cn](https://siliconflow.cn) for the Chinese site)
2. Sign up for a free account
3. Navigate to API Keys in the dashboard
4. Create a new API key

**Add to your `.env`:**
```bash
SILICONFLOW_API_KEY=sk-your-siliconflow-key-here
```

**Available vision models (use these exact IDs):**
| Model ID | Best for |
|----------|----------|
| `Qwen/Qwen2.5-VL-7B-Instruct` | Quick tests, budget runs |
| `Qwen/Qwen2.5-VL-72B-Instruct` | Production use, best accuracy |
| `Qwen/Qwen3-VL-8B-Instruct` | Long context tasks (262K) |
| `Qwen/Qwen3-VL-235B-A22B-Instruct` | Highest quality available |

**Test files:**
- `test-simple.ts` -- Basic browser automation with Qwen2.5-VL-72B
- `test-e2e.ts` -- Full GhostHands E2E with Stagehand + ManualConnector

**Run it:**
```bash
# Simple test (just browser + LLM)
bun run test-simple.ts

# Full E2E test (browser + Stagehand + Supabase self-learning)
bun run test-e2e.ts
```

**Magnitude config (`magnitude.config.ts`):**
```typescript
import { type MagnitudeConfig } from 'magnitude-test';

export default {
    url: "http://localhost:5173",
    llm: {
        provider: 'openai-generic',
        options: {
            baseUrl: 'https://api.siliconflow.com/v1',
            model: 'Qwen/Qwen2.5-VL-72B-Instruct',
            apiKey: process.env.SILICONFLOW_API_KEY
        }
    }
} satisfies MagnitudeConfig;
```

> **Note:** Both `api.siliconflow.com` and `api.siliconflow.cn` work. The `.cn` endpoint may be faster if you are in Asia.

---

### 2. Kimi (Moonshot AI)

Moonshot's Kimi offers vision models via an OpenAI-compatible API. More expensive than SiliconFlow but a solid alternative.

**Get your API key:**
1. Go to [https://platform.moonshot.ai](https://platform.moonshot.ai)
2. Sign up and verify your account
3. Go to API Keys section
4. Create a new key

**Add to your `.env`:**
```bash
MOONSHOT_API_KEY=sk-your-moonshot-key-here
```

**Available vision models (use these exact IDs):**
| Model ID | Context | Notes |
|----------|---------|-------|
| `moonshot-v1-8k-vision-preview` | 8K | Cheapest, shortest context |
| `moonshot-v1-32k-vision-preview` | 32K | Good balance (recommended) |
| `moonshot-v1-128k-vision-preview` | 128K | Longest context |

**Text-only models (do NOT use for browser automation):**
- `moonshot-v1-8k`, `moonshot-v1-32k`, `moonshot-v1-128k`

**Test file:** `test-kimi.ts`

**Run it:**
```bash
bun run test-kimi.ts
```

**Magnitude config:**
```typescript
import { type MagnitudeConfig } from 'magnitude-test';

export default {
    url: "http://localhost:5173",
    llm: {
        provider: 'openai-generic',
        options: {
            baseUrl: 'https://api.moonshot.ai/v1',
            model: 'moonshot-v1-32k-vision-preview',
            apiKey: process.env.MOONSHOT_API_KEY
        }
    }
} satisfies MagnitudeConfig;
```

---

### 3. MiniMax (Experimental)

MiniMax has a vision model (VL-01) but its API availability is uncertain. The test script includes a fallback to the text-only M2.5 model.

**Get your API key:**
1. Go to [https://platform.minimax.io](https://platform.minimax.io)
2. Sign up for an account
3. Navigate to API Keys
4. Create a new key

**Add to your `.env`:**
```bash
MINIMAX_API_KEY=your-minimax-api-key-here
```

**Models:**
| Model ID | Vision? | Notes |
|----------|---------|-------|
| `MiniMax-VL-01` | Yes (maybe) | May not be available via hosted API |
| `MiniMax-M2.5` | No | Reliable text-only fallback |
| `MiniMax-M2.1` | No | Alternative text-only |

**Test file:** `test-minimax.ts`

**Run it:**
```bash
# Try the vision model first
bun run test-minimax.ts

# If VL-01 is unavailable, fall back to text-only:
MINIMAX_MODEL=MiniMax-M2.5 bun run test-minimax.ts
```

**Magnitude config:**
```typescript
import { type MagnitudeConfig } from 'magnitude-test';

export default {
    url: "http://localhost:5173",
    llm: {
        provider: 'openai-generic',
        options: {
            baseUrl: 'https://api.minimax.io/v1',
            model: 'MiniMax-VL-01',
            apiKey: process.env.MINIMAX_API_KEY
        }
    }
} satisfies MagnitudeConfig;
```

---

### 4. DeepSeek (Text Only -- NOT Recommended for Vision)

DeepSeek's official API does NOT support vision/image inputs. The models `deepseek-chat` and `deepseek-reasoner` are text-only. If you send an image to DeepSeek, you will get this error:

```
unknown variant `image_url`, expected `text`
```

DeepSeek does have open-source vision models (DeepSeek-VL2, Janus-Pro) but these are NOT available via their hosted API. You would need to self-host them or use a third-party provider.

**If you already have a DeepSeek key**, it can be used for text-only LLM tasks (planning, reasoning) but NOT for browser automation that requires screenshots.

```bash
# In .env -- only useful for text tasks, NOT for GhostHands browser automation
DEEPSEEK_API_KEY=sk-your-deepseek-key-here
```

---

## Best Practices

### Which Model for Which Use Case

| Use Case | Recommended Model | Why |
|----------|-------------------|-----|
| **Development / testing** | Qwen2.5-VL-7B via SiliconFlow | Cheapest at $0.05/M, fast iteration |
| **Production automation** | Qwen2.5-VL-72B via SiliconFlow | Best accuracy-to-cost ratio |
| **Long page interactions** | Qwen3-VL-8B via SiliconFlow | 262K context handles complex pages |
| **Maximum accuracy** | Qwen3-VL-235B via SiliconFlow | MoE architecture, highest quality |
| **If SiliconFlow is down** | Kimi moonshot-v1-32k-vision-preview | Reliable alternative |

### Cost Optimization Tips

1. **Start with 7B for development.** Use `Qwen/Qwen2.5-VL-7B-Instruct` while building and debugging your automations. Switch to 72B for production runs.

2. **Use the ManualConnector.** After the first successful run, GhostHands saves a "manual" to Supabase. Subsequent runs replay the manual directly, reducing LLM calls by ~95%.

3. **Keep tasks focused.** Instead of one large task ("sign up, fill profile, upload photo, verify email"), break it into smaller steps. Each step uses fewer tokens.

4. **Use SiliconFlow's cache.** SiliconFlow's free tier offers some models for free. Check if the "Pro/" prefix models vs. free versions meet your needs.

5. **Monitor your spending.** Check your SiliconFlow dashboard regularly. Even at $0.05/M tokens, high-volume automation can add up.

### When to Use 7B vs 72B

**Use the 7B model when:**
- Running tests during development
- The automation target is simple (few interactive elements)
- Speed matters more than accuracy
- You want to minimize cost

**Use the 72B model when:**
- Running production automations
- The target page is complex (many buttons, forms, dynamic content)
- Accuracy is critical (e.g., filling out forms with specific data)
- The automation involves multi-step reasoning

**Rule of thumb:** If the 7B model fails on a task, try the 72B before debugging your automation logic. The larger model handles ambiguous UI much better.

---

## Troubleshooting

### Common Errors

#### "unknown variant `image_url`, expected `text`"
**Cause:** You are using a text-only model (like DeepSeek) that does not support image inputs.
**Fix:** Switch to a vision-capable model. Use Qwen VL via SiliconFlow instead.

```bash
# Wrong (DeepSeek is text-only)
model: 'deepseek-chat'
baseUrl: 'https://api.deepseek.com'

# Correct (Qwen VL supports vision)
model: 'Qwen/Qwen2.5-VL-72B-Instruct'
baseUrl: 'https://api.siliconflow.com/v1'
```

#### "401 Unauthorized" or "Invalid API Key"
**Cause:** API key is missing, expired, or for the wrong provider.
**Fix:**
1. Check that the correct key is set in `.env`
2. Make sure you are using the right key for the right provider (SiliconFlow key for SiliconFlow, Moonshot key for Moonshot, etc.)
3. Regenerate the key in the provider's dashboard
4. Make sure there are no extra spaces or quotes around the key in `.env`

#### "404 Model Not Found"
**Cause:** The model ID is wrong or the model is not available on that provider.
**Fix:** Double-check the exact model ID. Common mistakes:
- Using `qwen2.5-vl-72b` instead of `Qwen/Qwen2.5-VL-72B-Instruct` (case and prefix matter)
- Using `MiniMax-VL-01` when the API only has text models available
- Using a Moonshot model ID on SiliconFlow or vice versa

#### "429 Rate Limited" or "Too Many Requests"
**Cause:** You are hitting the provider's rate limit.
**Fix:**
- Wait a few seconds and retry
- Upgrade your plan on the provider's dashboard
- Switch to a different model (smaller models often have higher rate limits)

#### "Connection Refused" or "ECONNREFUSED"
**Cause:** The API endpoint URL is wrong or the service is down.
**Fix:**
- Verify the base URL:
  - SiliconFlow: `https://api.siliconflow.com/v1` (or `https://api.siliconflow.cn/v1`)
  - Moonshot: `https://api.moonshot.ai/v1`
  - MiniMax: `https://api.minimax.io/v1`
- Check if the service is experiencing downtime

#### "Context length exceeded"
**Cause:** The page screenshot + prompt exceeds the model's context window.
**Fix:**
- Use a model with a larger context window (Qwen3-VL-8B has 262K)
- Simplify your task to reduce the number of screenshots sent
- Target a specific section of the page instead of the full page

### Vision vs Text-Only Models -- How to Tell

If you are unsure whether a model supports vision, here is a quick test:

**Vision models** accept `image_url` content in the messages array:
```json
{"role": "user", "content": [
  {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
]}
```

**Text-only models** reject `image_url` and only accept `text` content:
```json
{"role": "user", "content": "plain text only"}
```

**Quick reference -- vision-capable models:**
- `Qwen/Qwen2.5-VL-*` (any size) -- via SiliconFlow
- `Qwen/Qwen3-VL-*` (any size) -- via SiliconFlow
- `moonshot-v1-*-vision-preview` -- via Moonshot
- `MiniMax-VL-01` -- via MiniMax (unconfirmed)

**NOT vision-capable:**
- `deepseek-chat`, `deepseek-reasoner` -- DeepSeek
- `moonshot-v1-8k`, `moonshot-v1-32k`, `moonshot-v1-128k` -- Moonshot (non-vision variants)
- `MiniMax-M2.5`, `MiniMax-M2.1`, `MiniMax-M2` -- MiniMax

---

## Environment Variables Summary

Add these to your `.env` file. You only need the keys for the providers you plan to use.

```bash
# Qwen VL via SiliconFlow (recommended)
SILICONFLOW_API_KEY=sk-your-siliconflow-key-here

# Kimi via Moonshot (alternative)
MOONSHOT_API_KEY=sk-your-moonshot-key-here

# MiniMax (experimental)
MINIMAX_API_KEY=your-minimax-api-key-here

# DeepSeek (text-only, not for browser automation)
DEEPSEEK_API_KEY=sk-your-deepseek-key-here
```

## Test Files Summary

| File | Provider | Model | What it tests |
|------|----------|-------|---------------|
| `test-simple.ts` | SiliconFlow | Qwen2.5-VL-72B | Basic browser automation |
| `test-e2e.ts` | SiliconFlow | Qwen2.5-VL-72B | Full GhostHands pipeline (Stagehand + ManualConnector + Supabase) |
| `test-kimi.ts` | Moonshot | Kimi vision-preview | Browser automation via Kimi |
| `test-minimax.ts` | MiniMax | MiniMax-VL-01 | Browser automation via MiniMax (with text fallback) |
