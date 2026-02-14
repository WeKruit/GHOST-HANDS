# GhostHands 执行计划：先跑通底座，再叠加能力

**作者:** Manus AI
**日期:** 2026年2月13日
**版本:** 3.0 — 基于 Magnitude 源码深度分析

---

## 0. Executive Summary

GhostHands 的开发策略是"**先确保有个能 work 的底，再在上面叠加能力**"。具体来说：

1. **先跑通 Magnitude 底座**：确认它能正常执行浏览器任务
2. **测试错误处理和返回机制**：当 Agent 遇到问题时的行为
3. **测试换 Provider**：用 `openai-generic` 接入 Minimax/DeepSeek 等便宜模型
4. **测试 Gmail MCP**：验证 Connector 扩展机制
5. **同时集成 Stagehand 观察能力 + ActionBook 手册思维**

三条线并行推进，互不阻塞。

---

## 1. Magnitude 源码架构真相（基于源码分析）

通过阅读 Magnitude 的完整源码，以下是它的真实架构：

### 1.1 核心循环

```
Agent._act(task, memory)
  └── while (true):
        1. _buildContext(memory) → AgentContext
        2. models.partialAct(context, task, data, actions) → { reasoning, actions[] }
           └── BAML 调用 LLM，返回结构化的 Action 列表
        3. for action in actions:
             exec(action, memory)
             └── actionDefinition.resolver({ input, agent })
             └── _recordConnectorObservations(memory)
        4. if doneActing → break
```

### 1.2 关键发现

| 模块 | 文件 | 发现 |
|------|------|------|
| **Provider 切换** | `ai/types.ts` | 已原生支持 `openai-generic`，有 `baseUrl` + `apiKey` + `headers` |
| **多模型** | `ai/multiModelHarness.ts` | 支持按 role（act/extract/query）分配不同模型 |
| **错误处理** | `agent/errors.ts` + `common/failure.ts` | 有 `AgentError`（adaptable 标志）+ 7 种 FailureDescriptor |
| **重试** | `common/retry.ts` | 指数退避重试，支持 `retryIf` 条件 |
| **Action 扩展** | `actions/index.ts` | `createAction()` 工厂函数，Zod schema + resolver |
| **Connector 扩展** | `connectors/index.ts` | 接口：`onStart/onStop/getActionSpace/collectObservations/getInstructions` |
| **浏览器连接** | `web/browserProvider.ts` | 支持外部传入 Browser 实例或自动 launch |

### 1.3 Provider 切换的具体实现

Magnitude 的 `openai-generic` provider 已经完美支持任何 OpenAI 兼容 API：

```typescript
// ai/util.ts 第 88-99 行
} else if (client.provider === 'openai-generic') {
    options = {
        base_url: client.options.baseUrl,
        api_key: client.options.apiKey,
        model: client.options.model,
        temperature: temp,
        headers: {
            "HTTP-Referer": "https://magnitude.run",
            "X-Title": "Magnitude",
            ...client.options.headers
        }
    };
}
```

这意味着接入 Minimax/DeepSeek/Qwen 只需要：

```typescript
const agent = await startBrowserAgent({
    llm: {
        provider: 'openai-generic',
        options: {
            model: 'deepseek-chat-v3',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: process.env.DEEPSEEK_API_KEY,
        }
    }
});
```

### 1.4 多模型分层的具体实现

`MultiModelHarness` 支持按 role 分配不同模型。这意味着我们可以：

```typescript
const agent = await startBrowserAgent({
    llm: [
        // 便宜模型做规划（act）
        {
            provider: 'openai-generic',
            options: {
                model: 'qwen2.5-vl-72b-instruct',
                baseUrl: 'https://api.siliconflow.cn/v1',
                apiKey: process.env.SILICONFLOW_API_KEY,
            },
            roles: ['act']  // 只负责规划和执行
        },
        // 更便宜的模型做提取（extract）
        {
            provider: 'openai-generic',
            options: {
                model: 'qwen2.5-vl-7b-instruct',
                baseUrl: 'https://api.siliconflow.cn/v1',
                apiKey: process.env.SILICONFLOW_API_KEY,
            },
            roles: ['extract', 'query']
        }
    ]
});
```

### 1.5 错误处理机制

Magnitude 的错误处理分两层：

**第一层：LLM 调用重试**（`_act` 方法第 346-369 行）

```typescript
await retryOnError(
    async () => {
        ({ reasoning, actions } = await this.models.partialAct(...));
        if (actions.length === 0) {
            throw new AgentError(`No actions generated`);
        }
    },
    {
        mode: 'retry_on_partial_message',
        errorSubstrings: ['HTTP body is not JSON', '401 Unauthorized', 'No actions generated'],
        retryLimit: 3,
        delayMs: 1000,
    }
);
```

**第二层：Action 执行失败**

当 action resolver 抛出异常时，`AgentError` 的 `adaptable` 标志告诉 Agent 是否可以尝试其他方法。但目前这个机制**还不完善**——`adaptable` 标志被定义了但没有在主循环中被使用。

**第三层：任务级别失败**

`task:fail` action 让 LLM 自己决定任务不可行时主动放弃。

---

## 2. 三条并行开发线

### 线路 A：底座验证（Week 1）

**目标**：确认 Magnitude 能跑通，测试错误处理和 Provider 切换。

#### A1. 跑通 Magnitude 基础示例

```typescript
// test/basic_smoke.test.ts
import { startBrowserAgent } from 'magnitude-core';

test('basic navigation and click', async () => {
    const agent = await startBrowserAgent({
        llm: {
            provider: 'google-ai',
            options: {
                model: 'gemini-2.5-flash',
                apiKey: process.env.GOOGLE_API_KEY
            }
        },
        url: 'https://example.com'
    });

    await agent.act('Find and click the "More information" link');
    // 验证导航成功
    const page = agent.page;
    expect(page.url()).toContain('iana.org');
    await agent.stop();
});
```

#### A2. 测试错误处理和返回

```typescript
// test/error_handling.test.ts

test('agent handles non-existent element gracefully', async () => {
    const agent = await startBrowserAgent({ /* ... */ });
    await agent.nav('https://example.com');

    // 监听事件
    const errors: string[] = [];
    agent.events.on('thought', (thought) => {
        errors.push(thought);
    });

    // 给一个不可能的任务
    try {
        await agent.act('Click the "Buy Now" button');  // example.com 没有这个按钮
    } catch (e) {
        // 预期 AgentError，variant 应该是 'misalignment' 或 task:fail
        expect(e).toBeInstanceOf(AgentError);
    }

    await agent.stop();
});

test('agent retries on transient LLM errors', async () => {
    // 用一个会间歇性失败的 mock provider 测试重试机制
    // ...
});
```

#### A3. 测试换 Provider（关键！）

```typescript
// test/provider_switch.test.ts

// 测试 1: DeepSeek
test('works with DeepSeek', async () => {
    const agent = await startBrowserAgent({
        llm: {
            provider: 'openai-generic',
            options: {
                model: 'deepseek-chat',
                baseUrl: 'https://api.deepseek.com/v1',
                apiKey: process.env.DEEPSEEK_API_KEY,
            }
        },
        url: 'https://example.com'
    });
    await agent.act('Click the "More information" link');
    await agent.stop();
});

// 测试 2: Qwen VL (视觉模型)
test('works with Qwen VL via SiliconFlow', async () => {
    const agent = await startBrowserAgent({
        llm: {
            provider: 'openai-generic',
            options: {
                model: 'Qwen/Qwen2.5-VL-72B-Instruct',
                baseUrl: 'https://api.siliconflow.cn/v1',
                apiKey: process.env.SILICONFLOW_API_KEY,
            }
        },
        url: 'https://example.com'
    });
    await agent.act('Click the "More information" link');
    await agent.stop();
});

// 测试 3: Minimax
test('works with Minimax', async () => {
    const agent = await startBrowserAgent({
        llm: {
            provider: 'openai-generic',
            options: {
                model: 'MiniMax-VL-01',
                baseUrl: 'https://api.minimax.chat/v1',
                apiKey: process.env.MINIMAX_API_KEY,
            }
        },
        url: 'https://example.com'
    });
    await agent.act('Click the "More information" link');
    await agent.stop();
});

// 测试 4: 多模型分层
test('multi-model: cheap for act, cheaper for extract', async () => {
    const agent = await startBrowserAgent({
        llm: [
            {
                provider: 'openai-generic',
                options: {
                    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
                    baseUrl: 'https://api.siliconflow.cn/v1',
                    apiKey: process.env.SILICONFLOW_API_KEY,
                },
                roles: ['act'] as BrowserAgentRole[]
            },
            {
                provider: 'openai-generic',
                options: {
                    model: 'Qwen/Qwen2.5-VL-7B-Instruct',
                    baseUrl: 'https://api.siliconflow.cn/v1',
                    apiKey: process.env.SILICONFLOW_API_KEY,
                },
                roles: ['extract', 'query'] as BrowserAgentRole[]
            }
        ]
    });
    // ...
});
```

**潜在问题**：Magnitude 使用 BAML 来结构化 LLM 输出。BAML 对不同模型的兼容性可能不同。如果某个便宜模型不能正确生成 BAML 期望的 JSON 格式，就会失败。这是需要重点测试的。

#### A4. 成本追踪

Magnitude 已经内建了 token 追踪（`ModelHarness._reportUsage()`），但 `knownCostMap` 里没有 Minimax/DeepSeek 的价格。我们需要扩展：

```typescript
// 在 modelHarness.ts 的 knownCostMap 中添加
'deepseek-chat': { inputTokens: 0.27, outputTokens: 1.10 },
'deepseek-chat-v3': { inputTokens: 0.27, outputTokens: 1.10 },
'MiniMax-VL-01': { inputTokens: 0.20, outputTokens: 0.80 },
'Qwen2.5-VL-72B-Instruct': { inputTokens: 0.25, outputTokens: 0.75 },
'Qwen2.5-VL-7B-Instruct': { inputTokens: 0.05, outputTokens: 0.15 },
```

---

### 线路 B：Gmail MCP Connector（Week 1-2）

**目标**：验证 Magnitude 的 Connector 扩展机制，同时获得 Gmail 能力。

Magnitude 的 `AgentConnector` 接口非常干净：

```typescript
export interface AgentConnector {
    id: string;
    onStart?(): Promise<void>;
    onStop?(): Promise<void>;
    getActionSpace?(): ActionDefinition<any>[];
    collectObservations?(): Promise<Observation[]>;
    getInstructions?(): Promise<void | string>;
}
```

#### B1. Gmail MCP Connector 设计

```typescript
// connectors/gmailConnector.ts
import { AgentConnector } from 'magnitude-core/connectors';
import { createAction, ActionDefinition } from 'magnitude-core/actions';
import { z } from 'zod';

export class GmailConnector implements AgentConnector {
    id = 'gmail';
    private mcpClient: any; // MCP client instance

    constructor(private config: { mcpServerUrl: string }) {}

    async onStart(): Promise<void> {
        // 连接到 Gmail MCP server
        this.mcpClient = await connectToMCPServer(this.config.mcpServerUrl);
    }

    async onStop(): Promise<void> {
        await this.mcpClient?.disconnect();
    }

    getActionSpace(): ActionDefinition<any>[] {
        return [
            createAction({
                name: 'gmail:send',
                description: 'Send an email via Gmail',
                schema: z.object({
                    to: z.string().describe('Recipient email address'),
                    subject: z.string().describe('Email subject'),
                    body: z.string().describe('Email body content'),
                }),
                resolver: async ({ input }) => {
                    await this.mcpClient.call('gmail.send', input);
                    return `Email sent to ${input.to}`;
                },
                render: ({ to, subject }) => `📧 send email to ${to}: "${subject}"`
            }),
            createAction({
                name: 'gmail:read',
                description: 'Read recent emails from Gmail inbox',
                schema: z.object({
                    query: z.string().optional().describe('Search query'),
                    limit: z.number().optional().describe('Max emails to return'),
                }),
                resolver: async ({ input }) => {
                    const emails = await this.mcpClient.call('gmail.search', input);
                    return JSON.stringify(emails);
                },
                render: ({ query }) => `📬 read emails${query ? ` matching "${query}"` : ''}`
            }),
        ];
    }

    async getInstructions(): Promise<string> {
        return 'You have access to Gmail. You can send emails and read the inbox.';
    }
}
```

#### B2. 使用方式

```typescript
const agent = await startBrowserAgent({
    llm: { /* ... */ },
    connectors: [new GmailConnector({ mcpServerUrl: 'stdio://gmail-mcp-server' })],
    url: 'https://jobs.lever.co/some-company'
});

await agent.act([
    'Fill out the job application form with my resume data',
    'After submitting, send a confirmation email to myself via Gmail'
]);
```

**关键洞察**：Magnitude 的 Connector 机制天然支持 MCP！每个 MCP tool 可以被包装成一个 `ActionDefinition`，Agent 的 LLM 会自动决定什么时候调用它。

---

### 线路 C：Stagehand 观察 + ActionBook 手册（Week 2-4）

**目标**：给 Agent 加上语义理解能力和自学习记忆。

#### C1. StagehandObserver Connector

```typescript
// connectors/stagehandConnector.ts
import { AgentConnector } from 'magnitude-core/connectors';
import { createAction, ActionDefinition } from 'magnitude-core/actions';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

export class StagehandConnector implements AgentConnector {
    id = 'stagehand-observer';
    private stagehand: Stagehand | null = null;

    getActionSpace(): ActionDefinition<any>[] {
        return [
            createAction({
                name: 'page:observe',
                description: 'Deeply analyze the current page to find interactive elements. ' +
                    'Returns a list of elements with their CSS selectors, allowed methods, ' +
                    'and descriptions. Use this BEFORE clicking when you need to find ' +
                    'specific elements reliably.',
                schema: z.object({
                    instruction: z.string().describe(
                        'What to look for on the page, e.g. "find the submit button" or "find all form fields"'
                    ),
                }),
                resolver: async ({ input, agent }) => {
                    // 获取当前页面
                    const page = agent.require(BrowserConnector).getHarness().page;

                    // 用 Stagehand 的 observe 方法分析页面
                    const stagehand = new Stagehand({ /* config */ });
                    const elements = await stagehand.page.observe(input.instruction);

                    // 返回结构化的元素信息
                    return JSON.stringify(elements.map(el => ({
                        selector: el.selector,
                        description: el.description,
                        method: el.method,
                        arguments: el.arguments,
                    })));
                },
                render: ({ instruction }) => `🔍 observe: "${instruction}"`
            }),

            createAction({
                name: 'page:act_by_selector',
                description: 'Execute an action using a CSS selector from a previous observe result. ' +
                    'More reliable than clicking by coordinates.',
                schema: z.object({
                    selector: z.string().describe('CSS selector from observe result'),
                    method: z.enum(['click', 'fill', 'select']).describe('Action method'),
                    value: z.string().optional().describe('Value for fill/select'),
                }),
                resolver: async ({ input, agent }) => {
                    const page = agent.require(BrowserConnector).getHarness().page;
                    const element = page.locator(input.selector).first();

                    switch (input.method) {
                        case 'click':
                            await element.click();
                            break;
                        case 'fill':
                            await element.fill(input.value || '');
                            break;
                        case 'select':
                            await element.selectOption(input.value || '');
                            break;
                    }
                },
                render: ({ selector, method, value }) =>
                    `🎯 ${method} on ${selector}${value ? ` with "${value}"` : ''}`
            }),
        ];
    }
}
```

#### C2. ManualManager（ActionBook 思维）

```typescript
// connectors/manualConnector.ts
import { AgentConnector } from 'magnitude-core/connectors';
import { createAction, ActionDefinition } from 'magnitude-core/actions';
import { z } from 'zod';

interface ManualStep {
    selector: string;
    method: 'click' | 'fill' | 'select';
    description: string;
    value_template?: string; // e.g. "{{user.firstName}}"
}

interface ActionManual {
    id: string;
    url_pattern: string;       // e.g. "*.greenhouse.io/*/application"
    task_pattern: string;      // e.g. "fill application form"
    steps: ManualStep[];
    success_count: number;
    failure_count: number;
    health_score: number;      // 0-100
    last_verified: Date;
}

export class ManualConnector implements AgentConnector {
    id = 'manual-manager';
    private db: any; // Prisma client or similar

    getActionSpace(): ActionDefinition<any>[] {
        return [
            createAction({
                name: 'manual:lookup',
                description: 'Check if there is a known manual (pre-recorded steps) for the current page. ' +
                    'If found, you can use manual:execute to run it without needing to figure out the steps yourself. ' +
                    'ALWAYS check for a manual before attempting complex multi-step tasks.',
                schema: z.object({
                    url: z.string().describe('Current page URL'),
                    task: z.string().describe('What you are trying to do'),
                }),
                resolver: async ({ input }) => {
                    const manual = await this.findManual(input.url, input.task);
                    if (manual) {
                        return JSON.stringify({
                            found: true,
                            manual_id: manual.id,
                            steps_count: manual.steps.length,
                            health_score: manual.health_score,
                            description: manual.steps.map(s => s.description).join(' → '),
                        });
                    }
                    return JSON.stringify({ found: false });
                },
                render: ({ url, task }) => `📖 lookup manual for "${task}" on ${url}`
            }),

            createAction({
                name: 'manual:execute',
                description: 'Execute a previously found manual. This runs pre-recorded steps without LLM calls.',
                schema: z.object({
                    manual_id: z.string(),
                    data: z.record(z.string()).optional().describe('Data to fill in templates'),
                }),
                resolver: async ({ input, agent }) => {
                    const manual = await this.getManual(input.manual_id);
                    if (!manual) throw new Error('Manual not found');

                    const page = agent.require(BrowserConnector).getHarness().page;

                    for (const step of manual.steps) {
                        const value = step.value_template
                            ? this.interpolate(step.value_template, input.data || {})
                            : undefined;

                        const element = page.locator(step.selector).first();
                        switch (step.method) {
                            case 'click': await element.click(); break;
                            case 'fill': await element.fill(value || ''); break;
                            case 'select': await element.selectOption(value || ''); break;
                        }
                        // 随机延迟（拟人化预留）
                        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
                    }

                    // 更新成功计数
                    await this.recordSuccess(manual.id);
                    return `Manual executed successfully: ${manual.steps.length} steps`;
                },
                render: ({ manual_id }) => `⚡ execute manual ${manual_id}`
            }),

            createAction({
                name: 'manual:save',
                description: 'Save the current successful action sequence as a manual for future reuse. ' +
                    'Call this after successfully completing a task that you think will be repeated.',
                schema: z.object({
                    url_pattern: z.string().describe('URL pattern this manual applies to'),
                    task_pattern: z.string().describe('Task description pattern'),
                    steps: z.array(z.object({
                        selector: z.string(),
                        method: z.enum(['click', 'fill', 'select']),
                        description: z.string(),
                        value_template: z.string().optional(),
                    })),
                }),
                resolver: async ({ input }) => {
                    const manual = await this.saveManual(input);
                    return `Manual saved with ID: ${manual.id}`;
                },
                render: ({ task_pattern }) => `💾 save manual for "${task_pattern}"`
            }),
        ];
    }

    async getInstructions(): Promise<string> {
        return `You have access to a manual system that stores pre-recorded action sequences.
ALWAYS use manual:lookup before attempting complex tasks.
If a manual is found with health_score > 70, use manual:execute instead of figuring out steps yourself.
After successfully completing a new task, use manual:save to record it for future reuse.
This saves time and money on future executions.`;
    }

    // ... private helper methods
}
```

#### C3. 自学习循环的完整流程

```
用户: agent.act("Apply to the SWE position at Tesla on Greenhouse")

Agent LLM 思考:
  1. "我应该先查手册" → manual:lookup(url, task)
  2a. 如果找到手册 (health > 70):
      → manual:execute(manual_id, user_data) → 完成！零额外 LLM 调用
  2b. 如果没找到手册:
      → page:observe("find all form fields")  ← Stagehand 语义理解
      → 获得 selector 列表
      → page:act_by_selector(selector, 'fill', value) × N
      → 任务完成后
      → manual:save(url_pattern, task_pattern, steps) ← 自动保存手册
  
下次同样的任务:
  → manual:lookup → 命中 → manual:execute → 零 LLM 调用
```

---

## 3. 完整的 Claude Code Prompt

以下是一个可以直接丢给 Claude Code 的 prompt，用于启动 GhostHands 开发：

---

### Prompt: GhostHands Phase 1 — 底座验证 + 能力叠加

```
# GhostHands: Browser Agent with Self-Learning Capabilities

## Project Overview

GhostHands is a fork of Magnitude Browser Agent (github.com/magnitudedev/browser-agent)
that adds three key capabilities:
1. Stagehand-powered semantic page observation (CSS selector-based, not just screenshots)
2. ActionBook-inspired self-learning manual system (record and replay successful action sequences)
3. MCP connector support (starting with Gmail)

## Repository Setup

1. Fork https://github.com/magnitudedev/browser-agent into ghost-hands
2. Keep the existing Magnitude architecture intact — we are EXTENDING, not replacing
3. The project uses pnpm workspaces, BAML for structured LLM output, and Playwright

## Architecture (DO NOT CHANGE)

Magnitude's architecture is clean and extensible:
- `Agent` class has a main loop in `_act()` that calls `models.partialAct()` → gets actions → executes them
- `AgentConnector` interface provides: `getActionSpace()`, `collectObservations()`, `getInstructions()`
- `ActionDefinition` = { name, description, schema (Zod), resolver, render }
- `MultiModelHarness` supports multiple LLMs assigned to different roles (act/extract/query)
- `openai-generic` provider already supports any OpenAI-compatible API (baseUrl + apiKey)

## Phase 1 Tasks (TDD — write tests FIRST)

### Task 1: Provider Compatibility Tests
Create `test/providers/` directory with tests for:
- DeepSeek via openai-generic (baseUrl: https://api.deepseek.com/v1)
- Qwen VL via SiliconFlow (baseUrl: https://api.siliconflow.cn/v1)
- Multi-model setup: Qwen-72B for act, Qwen-7B for extract/query
- Add these models to knownCostMap in modelHarness.ts

### Task 2: Error Handling Verification Tests
Create `test/error-handling/` with tests for:
- Agent behavior when given impossible tasks (should call task:fail)
- Agent behavior when page elements don't exist
- LLM transient error retry (mock provider that fails intermittently)
- Network timeout handling

### Task 3: StagehandConnector
Create `packages/magnitude-core/src/connectors/stagehandConnector.ts`:
- Implement AgentConnector interface
- Actions: page:observe (returns ParsedElement[]), page:act_by_selector (click/fill/select by CSS selector)
- Install @browserbasehq/stagehand as dependency
- The observe action should use Stagehand's observe() on the current Playwright page
- The act_by_selector action should use Playwright's locator API directly
- Write tests in test/connectors/stagehand.test.ts

### Task 4: ManualConnector
Create `packages/magnitude-core/src/connectors/manualConnector.ts`:
- Implement AgentConnector interface
- Actions: manual:lookup, manual:execute, manual:save
- Use SQLite (via better-sqlite3) for storage initially — can upgrade to Postgres later
- Schema: ActionManual { id, url_pattern, task_pattern, steps[], success_count, failure_count, health_score, created_at, last_verified }
- The getInstructions() method MUST tell the LLM to always check for manuals first
- Write tests in test/connectors/manual.test.ts

### Task 5: GmailConnector (MCP)
Create `packages/magnitude-core/src/connectors/gmailConnector.ts`:
- Implement AgentConnector interface
- Actions: gmail:send, gmail:read
- Use @anthropic-ai/mcp or similar MCP client library
- Write tests in test/connectors/gmail.test.ts

## Key Constraints

1. DO NOT modify the core Agent loop (_act method) — only extend via Connectors and Actions
2. DO NOT remove any existing Magnitude functionality
3. ALL new code must have tests written FIRST (TDD)
4. Use Zod schemas for all Action inputs
5. The ManualConnector's getInstructions() is CRITICAL — it shapes the LLM's behavior to prefer manuals

## Environment Variables Expected

GOOGLE_API_KEY=...          # For Gemini (default)
DEEPSEEK_API_KEY=...        # For DeepSeek tests
SILICONFLOW_API_KEY=...     # For Qwen VL tests
MINIMAX_API_KEY=...         # For Minimax tests
GMAIL_MCP_SERVER=...        # For Gmail MCP

## Success Criteria

1. All provider tests pass with at least DeepSeek and Qwen
2. StagehandConnector can observe a page and return valid selectors
3. ManualConnector can save, lookup, and execute a manual
4. A full loop test: act on a page → save manual → act again using manual (zero LLM calls on second run)
```

---

## 4. 潜在风险和应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| **BAML 不兼容便宜模型** | 高 | 阻塞 | 测试时如果 BAML 解析失败，可能需要调整 BAML prompt 或降低输出复杂度 |
| **Stagehand 和 Magnitude 的 Playwright 实例冲突** | 中 | 中 | Stagehand 需要自己的 Page 实例，可能需要共享 BrowserContext |
| **便宜模型的视觉理解不够好** | 中 | 中 | 多模型分层：用好模型做 act（需要视觉），用便宜模型做 extract/query |
| **Manual 的 selector 过期** | 低 | 低 | health_score 机制 + 自动降级到探索模式 |

---

## 5. 成本估算（单次 Greenhouse 投递）

| 场景 | 模型 | 预估 Token | 预估成本 |
|------|------|-----------|---------|
| **首次投递（无手册）** | Qwen2.5-VL-72B (act) + 7B (extract) | ~50K input + 5K output | **~$0.02** |
| **后续投递（有手册）** | 仅 manual:lookup 的 LLM 调用 | ~2K input + 0.5K output | **~$0.0005** |
| **对比：Claude Sonnet 全程** | Claude 3.7 Sonnet | ~50K input + 5K output | **~$0.23** |

**首次投递比 Claude 便宜 10x，后续投递便宜 460x。**

---

## 6. 时间线

| 周 | 线路 A (底座) | 线路 B (MCP) | 线路 C (能力叠加) |
|----|--------------|-------------|------------------|
| **Week 1** | Fork + Provider 测试 + 错误处理测试 | Gmail MCP Connector 设计 | Stagehand Connector 设计 |
| **Week 2** | 多模型分层验证 | Gmail MCP 实现 + 测试 | ManualConnector 实现 |
| **Week 3** | 成本追踪 + 监控 | 集成测试 | 自学习循环集成测试 |
| **Week 4** | — | — | Greenhouse POC 端到端测试 |
