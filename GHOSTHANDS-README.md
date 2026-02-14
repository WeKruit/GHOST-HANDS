# GhostHands 👻🙌

> A fork of Magnitude Browser Agent with self-learning capabilities

GhostHands extends [Magnitude Browser Agent](https://github.com/magnitudedev/browser-agent) with three powerful capabilities:

## 🎯 Key Features

### 1. **Stagehand-Powered Semantic Observation**
- CSS selector-based page analysis (not just screenshots)
- Direct DOM manipulation for reliable interactions
- Fallback to Computer Use AI (CUA) mode when needed

### 2. **ActionBook Self-Learning Manual System**
- **First run**: Agent explores the page and completes the task (uses LLM)
- **Second run**: Zero LLM calls! Replays recorded successful sequences
- Tracks success/failure rates and health scores for each manual
- Automatic degradation to exploration mode if manual becomes stale

### 3. **MCP Connector Support**
- Starting with Gmail integration
- Extensible architecture for any MCP server
- Actions available to the agent like native browser actions

## 🏗️ Architecture

GhostHands follows Magnitude's clean connector/action architecture:

```
Agent._act() loop (unchanged)
    └── Connectors extend action space
        ├── StagehandConnector
        │   ├── page:observe → returns CSS selectors
        │   └── page:act_by_selector → precise DOM interactions
        ├── ManualConnector
        │   ├── manual:lookup → check for existing manual
        │   ├── manual:execute → replay with 0 LLM calls
        │   └── manual:save → record successful sequence
        └── GmailConnector (MCP)
            ├── gmail:send
            └── gmail:read
```

## 💡 The Self-Learning Loop

```typescript
// User task
await agent.act("Apply to the SWE position at Tesla on Greenhouse");

// First time (no manual exists)
Agent LLM:
  1. manual:lookup(url, task) → not found
  2. page:observe("find all form fields") → get selectors
  3. page:act_by_selector(selector, 'fill', value) × N
  4. Task complete → manual:save(url_pattern, steps)

// Second time (manual exists!)
Agent LLM:
  1. manual:lookup(url, task) → found (health_score: 95)
  2. manual:execute(manual_id, user_data) → DONE! Zero LLM calls
```

## 💰 Cost Comparison

**Single Greenhouse application:**

| Scenario | LLM Calls | Cost |
|----------|-----------|------|
| First application (no manual) | ~5-10 calls | ~$0.02 |
| Subsequent applications (using manual) | 1 call (lookup only) | ~$0.0005 |
| **Savings after 10 applications** | **90% reduction** | **~$0.18 saved** |

At scale (100 applications/month): **~$1.80/month vs ~$0.20/month**

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Add your API keys:
# - GOOGLE_API_KEY (for Gemini - default)
# - DEEPSEEK_API_KEY (optional, for tests)
# - SILICONFLOW_API_KEY (optional, for Qwen VL tests)
# - GMAIL_MCP_SERVER (optional, for Gmail connector)

# Run tests
pnpm test

# Run example
pnpm dev:example
```

## 📦 Project Structure

```
magnitude-source/                    # Forked Magnitude repo
├── packages/
│   └── magnitude-core/
│       └── src/
│           ├── connectors/
│           │   ├── stagehandConnector.ts   # NEW
│           │   ├── manualConnector.ts      # NEW
│           │   └── gmailConnector.ts       # NEW
│           └── actions/
│               └── (Magnitude core - unchanged)
├── test/
│   ├── providers/                  # NEW: Provider tests
│   ├── error-handling/             # NEW: Error tests
│   └── connectors/                 # NEW: Connector tests
└── docs/                           # GhostHands documentation
```

## 🧪 Phase 1 Success Criteria

- [x] Fork Magnitude Browser Agent
- [ ] All provider tests pass (DeepSeek, Qwen VL, Minimax)
- [ ] StagehandConnector can observe a page and return valid selectors
- [ ] ManualConnector can save, lookup, and execute a manual
- [ ] Full loop test: act → save manual → act again (0 LLM calls on run 2)

## 🔑 Key Constraints

1. **DO NOT** modify the core Agent loop (`_act` method)
2. **DO NOT** remove any existing Magnitude functionality
3. **ALL** new code must have tests written FIRST (TDD)
4. Use Zod schemas for all Action inputs
5. ManualConnector's `getInstructions()` is CRITICAL — shapes LLM behavior

## 📚 Learn More

- [GhostHands Execution Plan](docs/GhostHands_Execution_Plan.md)
- [Magnitude Documentation](https://docs.magnitude.run)
- [Stagehand Documentation](https://docs.stagehand.dev)

## 🤝 Contributing

Built with ❤️ by the GhostHands team as part of the WeKruit hiring process.

## 📄 License

Apache 2.0 (same as Magnitude)
