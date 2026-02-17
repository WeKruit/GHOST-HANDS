# VALET Integration Changes — Sprint 5

**Date:** 2026-02-17
**Status:** Deployed to main
**Breaking Changes:** None (all additive, backward compatible)

---

## Summary

Sprint 5 is a **model + events mega-update**:
- 13 new models (including Qwen3-VL Thinking, Qwen3-Coder-480B, GPT-5.2, Claude Opus, Gemini family)
- Accuracy-focused preset rebalancing (quality → VL-235B-Thinking with chain-of-thought)
- Unified event system — ALL events now flow to `gh_job_events`
- All new Qwen3 models run via existing SiliconFlow API key — no new API keys needed
- 678 tests passing, 0 failures

---

## 1. New Models

### Accuracy-First Models (SiliconFlow)

| Alias | Model ID | Vision | Input $/M | Output $/M | Notes |
|-------|----------|--------|-----------|------------|-------|
| **qwen3-vl-235b-thinking** | Qwen3-VL-235B-A22B-Thinking | Yes | $0.45 | $3.50 | Frontier VL reasoning. Chain-of-thought + vision. Best for complex GUI. |
| **qwen3-vl-30b-thinking** | Qwen3-VL-30B-A3B-Thinking | Yes | $0.29 | $1.00 | MoE 30B/3B. Vision + thinking at fraction of 235B cost. |
| **qwen3-vl-30b** | Qwen3-VL-30B-A3B-Instruct | Yes | $0.29 | $1.00 | Fast vision without thinking overhead. |
| **qwen3-235b-thinking** | Qwen3-235B-A22B-Thinking-2507 | No | $0.35 | $1.42 | Text-only reasoning. 256K context. |
| **qwen3-coder-480b** | Qwen3-Coder-480B-A35B-Instruct | No | $0.25 | $1.00 | 480B code model. Best for form-fill scripting. |
| **qwen3-next-80b** | Qwen3-Next-80B-A3B-Thinking | No | $0.14 | $0.57 | Ultra-fast reasoning. 10x throughput. |

### Premium Models (External Providers)

| Alias | Provider | Vision | Input $/M | Output $/M | Notes |
|-------|----------|--------|-----------|------------|-------|
| **gpt-5.2** | OpenAI | Yes | $1.75 | $14.00 | Frontier reasoning, multimodal |
| **gpt-4.1** | OpenAI | Yes | $2.00 | $8.00 | Good vision (OCR, VQA), 1M context |
| **claude-opus** | Anthropic | Yes | $5.00 | $25.00 | #1 on intelligence leaderboards. Best for complex flows. |
| **gemini-2.5-pro** | Google | Yes | $1.25 | $10.00 | Strong vision and reasoning, 1M context |
| **gemini-2.5-flash** | Google | Yes | $0.15 | $0.60 | Fast, cheap, decent accuracy |
| **gemini-2.0-flash** | Google | Yes | $0.10 | $0.40 | Ultra-fast Gemini |

**Updated pricing:**
- `deepseek-chat`: output $1.10 → $0.42 (V3.2 price cut)

**Total models available: 31** (was 18)

---

## 2. Updated Presets (Accuracy Focus)

| Preset | Previous Model | New Model | Why |
|--------|---------------|-----------|-----|
| `speed` | qwen-7b | qwen-7b (unchanged) | Still cheapest |
| `balanced` | qwen-72b | **qwen3-235b** | Better accuracy, similar cost |
| `quality` | qwen3-235b | **qwen3-vl-235b-thinking** | Frontier VL reasoning with chain-of-thought |
| `premium` | gpt-4o | **gpt-5.2** | Newer, better, cheaper input |

**Default** remains `qwen-72b` (safest choice for existing VALET integrations).

To use the new presets, pass the preset name as the `model` field:
```json
{ "model": "quality" }
```

Or specify the alias directly:
```json
{ "model": "qwen3.5-plus" }
```

---

## 3. Unified Event System

**All execution events now flow to `gh_job_events`** — Stagehand observations, cookbook steps, AI thinking, token usage, and trace recording.

### New Event Types

| Event | Description | Key metadata |
|-------|-------------|--------------|
| `thought` | AI reasoning/thinking (throttled: max 1/2s) | `content` (truncated 500 chars) |
| `tokens_used` | LLM token usage per step | `model`, `input_tokens`, `output_tokens`, `cost_usd` |
| `observation_started` | Stagehand observe() call started | `instruction` |
| `observation_completed` | Stagehand observe() returned | `instruction`, `elements_found` |
| `cookbook_step_started` | Cookbook replaying a step | `step_index`, `action`, `selector` |
| `cookbook_step_completed` | Cookbook step succeeded | `step_index`, `action` |
| `cookbook_step_failed` | Cookbook step failed | `step_index`, `action`, `error` |
| `trace_recording_started` | TraceRecorder started | — |
| `trace_recording_completed` | TraceRecorder finished | `steps` |

### VALET UI Integration

Subscribe to `gh_job_events` and add these cases to your event handler:

```typescript
case 'thought':
  // Show AI reasoning in a "thinking" feed
  showThinkingBubble(event.metadata.content);
  break;

case 'tokens_used':
  // Update real-time cost counter
  updateLiveCost(event.metadata.cost_usd);
  showModelBadge(event.metadata.model);
  break;

case 'observation_started':
  showStatus('Observing page elements...');
  break;

case 'cookbook_step_started':
  appendToTimeline({
    icon: '🟢',
    text: `${event.metadata.action} (step ${event.metadata.step_index + 1})`,
  });
  break;

case 'cookbook_step_failed':
  appendToTimeline({
    icon: '🟠',
    text: `Cookbook step failed: ${event.metadata.error}`,
  });
  break;
```

---

## 4. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` | For Gemini models | Google AI API key |

**No new API keys needed for Qwen3 models** — all 6 new Qwen3 models (VL-Thinking, Coder-480B, Next-80B) run via SiliconFlow using your existing `SILICONFLOW_API_KEY`. The `DASHSCOPE_API_KEY` is optional (only if you want to use the Alibaba DashScope endpoint directly).

---

## 5. Test Status

| Suite | Tests | Failures |
|-------|-------|----------|
| Unit | 485 | 0 |
| Integration | 87 | 0 |
| E2E | 106 | 0 |
| **Total** | **678** | **0** |

---

## 6. No Breaking Changes

All changes are additive:
- New models don't affect existing `model` field usage
- New event types are INSERT-only — existing event handlers won't see them unless subscribed
- Updated presets only affect jobs that explicitly use preset names
- Default model (`qwen-72b`) unchanged

---

## 7. Files Changed

### New Files
- `packages/ghosthands/src/events/JobEventTypes.ts` — 25 typed event constants + ThoughtThrottle
- `packages/ghosthands/__tests__/unit/events/jobEventTypes.test.ts` — 23 tests
- `packages/ghosthands/__tests__/integration/events/eventLogging.test.ts` — 12 tests
- `packages/ghosthands/__tests__/unit/config/models.test.ts` — 39 tests

### Modified Files
- `packages/ghosthands/src/config/models.config.json` — 7 new models, Google provider, preset updates
- `packages/ghosthands/src/workers/JobExecutor.ts` — thought/token event wiring
- `packages/ghosthands/src/engine/StagehandObserver.ts` — observation events
- `packages/ghosthands/src/engine/CookbookExecutor.ts` — cookbook step events
- `docs/VALET-INTEGRATION-CONTRACT.md` — updated to Sprints 1-5

---

## 8. Full Contract Reference

See `docs/VALET-INTEGRATION-CONTRACT.md` (18 sections, Sprints 1-5).

Key sections updated:
- **4.1.1** — Model Reference (25 models, accuracy + budget tiers)
- **6.4** — Event Types Reference (10 new event types)
- **16** — Migration Checklist (new env vars)
- **18** — Known Limitations (updated #10)
