# Vision Model Research: Cheap LLM Providers

## Summary

Research into affordable vision-capable LLM providers for use with Magnitude's `openai-generic` provider interface. Magnitude requires visually grounded LLMs that understand precise coordinates in images.

---

## 1. DeepSeek

### Vision Support: NO (not via official API)

| Property | Details |
|----------|---------|
| **Available API Models** | `deepseek-chat` (V3.2), `deepseek-reasoner` (V3.2 thinking) |
| **API Base URL** | `https://api.deepseek.com` |
| **Vision Models** | DeepSeek-VL2 and Janus-Pro exist as open-source but are NOT available via the official DeepSeek API |
| **Pricing** | $0.028/M (cache hit), $0.28/M (cache miss) input; $0.42/M output |
| **Auth** | `DEEPSEEK_API_KEY` |

### Notes
- The official DeepSeek API (`api.deepseek.com`) only offers `deepseek-chat` and `deepseek-reasoner` -- both are **text-only** models.
- DeepSeek-VL2 is an open-source vision model available on HuggingFace but has NO hosted API endpoint from DeepSeek.
- Janus-Pro-7B is available via third-party providers like DeepInfra but not from DeepSeek directly.
- **NOT suitable as a vision provider** unless self-hosted or accessed via a third-party hosting service (e.g., DeepInfra, SiliconFlow).

### Configuration (if using via third-party like DeepInfra)
```typescript
llm: {
    provider: 'openai-generic',
    options: {
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        model: 'deepseek-ai/Janus-Pro-7B',
        apiKey: process.env.DEEPINFRA_API_KEY
    }
}
```

---

## 2. Qwen VL via SiliconFlow

### Vision Support: YES

| Property | Details |
|----------|---------|
| **API Base URL** | `https://api.siliconflow.com/v1` |
| **Auth** | SiliconFlow API key |
| **OpenAI Compatible** | Yes |

### Available Vision Models

| Model ID | Input $/M | Output $/M | Context | Notes |
|----------|-----------|------------|---------|-------|
| `Qwen/Qwen2.5-VL-7B-Instruct` | $0.05 | $0.05 | 32K | Cheapest option, good baseline |
| `Qwen/Qwen3-VL-8B-Instruct` | $0.18 | $0.68 | 262K | Newer, better performance |
| `Qwen/Qwen3-VL-235B-A22B-Instruct` | $0.20 | $0.88 | 262K | MoE, best quality |

### Notes
- SiliconFlow has a free tier for some models (model IDs without "Pro/" prefix).
- Qwen2.5-VL-7B-Instruct at $0.05/M is extremely cheap -- among the cheapest vision models available.
- Qwen2.5-VL is confirmed grounded and works with Magnitude (already documented in compatible LLMs).
- The 72B variant is recommended by Magnitude docs but may be available on SiliconFlow as well.
- Supports OCR across 32 languages, video understanding, bounding box generation.

### Recommended Configuration
```typescript
// Cheapest option
llm: {
    provider: 'openai-generic',
    options: {
        baseUrl: 'https://api.siliconflow.com/v1',
        model: 'Qwen/Qwen2.5-VL-7B-Instruct',
        apiKey: process.env.SILICONFLOW_API_KEY
    }
}

// Best quality option
llm: {
    provider: 'openai-generic',
    options: {
        baseUrl: 'https://api.siliconflow.com/v1',
        model: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
        apiKey: process.env.SILICONFLOW_API_KEY
    }
}
```

---

## 3. MiniMax VL

### Vision Support: UNCERTAIN (VL-01 may not be on current API)

| Property | Details |
|----------|---------|
| **API Base URL** | `https://api.minimax.io/v1` (global) / `https://api.minimaxi.com/v1` (China) |
| **Auth** | MiniMax API key |
| **OpenAI/Anthropic SDK Compatible** | Yes |

### Available Models (from official docs)
| Model ID | Input $/M | Output $/M | Context | Vision? |
|----------|-----------|------------|---------|---------|
| `MiniMax-M2.5` | ~$0.26 | ~$1.00 | 196K | No |
| `MiniMax-M2.1` | ~$0.27 | ~$0.95 | 196K | No |
| `MiniMax-01` | $0.20 | $1.10 | 1M | No |

### MiniMax-VL-01
- **Exists** as a model (open source on HuggingFace: `MiniMaxAI/MiniMax-VL-01`)
- 456B parameters, 45.9B activated per inference
- Supports images with dynamic resolution (336x336 to 2016x2016)
- Claimed pricing: $0.20/M input, $1.10/M output (same as MiniMax-01 text)
- **HOWEVER**: The official MiniMax API documentation (platform.minimax.io) does NOT currently list MiniMax-VL-01 as an available API model. The current model list only shows text, audio, video, and image generation models.
- **May require contacting MiniMax** to confirm if VL-01 is still available via their API.

### Notes
- MiniMax-VL-01 is NOT listed in the current official API docs. It may have been deprecated, rolled into another model, or requires a separate endpoint.
- The text models (M2.5, M2.1) do NOT support vision input.
- **NOT recommended** until API availability of VL-01 is confirmed.

### Speculative Configuration (if VL-01 is available)
```typescript
llm: {
    provider: 'openai-generic',
    options: {
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-VL-01',  // model ID unconfirmed
        apiKey: process.env.MINIMAX_API_KEY
    }
}
```

---

## 4. Kimi (Moonshot)

### Vision Support: YES (Kimi K2.5)

| Property | Details |
|----------|---------|
| **Model Name** | `kimi-k2.5` |
| **API Base URL** | `https://api.moonshot.ai/v1` |
| **Input Pricing** | $0.60/M tokens ($0.15/M cached) |
| **Output Pricing** | $2.50/M tokens |
| **Context** | 256K |
| **Vision** | Yes -- native multimodal (text + image + video) |
| **Auth** | Moonshot API key |
| **OpenAI Compatible** | Yes |

### Notes
- Kimi K2.5 (January 2026) is a 1T parameter MoE model with 32B activated per request.
- Uses MoonViT (400M parameter vision encoder) for native vision.
- Trained on 15T tokens mixing visual and textual data together.
- More expensive than SiliconFlow Qwen options but potentially better quality.
- Supports "Agent Swarm" technology for parallel task execution.
- **Grounding capability is unconfirmed** -- the model understands images but may not output precise pixel coordinates needed for Magnitude's browser interaction.

### Configuration
```typescript
llm: {
    provider: 'openai-generic',
    options: {
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k2.5',
        apiKey: process.env.MOONSHOT_API_KEY
    }
}
```

---

## 5. SiliconFlow (Platform Overview)

### What They Host

SiliconFlow is an AI infrastructure platform that hosts multiple open-source models with an OpenAI-compatible API. They are NOT a model creator -- they host models from Qwen, DeepSeek, and others.

| Category | Available Models |
|----------|-----------------|
| **Vision/VL** | Qwen2.5-VL-7B, Qwen3-VL-8B, Qwen3-VL-235B, and likely more |
| **Text LLMs** | DeepSeek V3, Qwen3, various others |
| **Image Gen** | Stable Diffusion variants, FLUX |
| **Embeddings** | Various embedding models |

### Key Details
- **API Base URL**: `https://api.siliconflow.com/v1`
- **Free tier**: Some models available for free (without "Pro/" prefix)
- **OpenAI compatible**: Full compatibility with OpenAI SDK
- **Pricing**: Among the cheapest in the market
- **Best vision option**: Qwen2.5-VL-7B-Instruct at $0.05/M tokens

---

## Recommendations (Ranked by Cost-Effectiveness)

### Tier 1: Best Value for Vision
1. **Qwen2.5-VL-7B via SiliconFlow** -- $0.05/M input+output, confirmed grounded, already proven with Magnitude
2. **Qwen3-VL-8B via SiliconFlow** -- $0.18/$0.68, newer model with 262K context

### Tier 2: Better Quality, Higher Cost
3. **Qwen3-VL-235B via SiliconFlow** -- $0.20/$0.88, MoE architecture, best quality from Qwen
4. **Kimi K2.5 via Moonshot** -- $0.60/$2.50, strong multimodal but grounding unconfirmed

### Not Recommended
5. **DeepSeek** -- No vision model available via official API
6. **MiniMax VL-01** -- Vision model not confirmed available on current API

### Key Takeaway
**SiliconFlow hosting Qwen VL models is the clear winner** for cheap vision LLM access. The Qwen2.5-VL-7B at $0.05/M is roughly 50-100x cheaper than Claude Sonnet while still being visually grounded.
