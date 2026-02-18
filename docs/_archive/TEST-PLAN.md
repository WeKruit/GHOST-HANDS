# GhostHands Test Plan

## Phase 1: Unit Tests (TDD - Write First!)

### 1. Provider Compatibility Tests (`test/providers/`)
**Status:** In Progress (provider-tester)

- [ ] DeepSeek provider test
  - Connect via openai-generic
  - Verify model costs in knownCostMap
  - Basic act() call succeeds
- [ ] Qwen VL provider test
  - Connect via SiliconFlow
  - Vision model test (screenshot input)
  - Multi-model setup (72B for act, 7B for extract)
- [ ] Minimax provider test
  - Connect via openai-generic
  - Vision model test
- [ ] Multi-model harness test
  - Qwen-72B assigned to 'act' role
  - Qwen-7B assigned to 'extract' and 'query' roles
  - Verify correct model called for each operation

### 2. Error Handling Tests (`test/error-handling/`)
**Status:** In Progress (error-handler-tester)

- [ ] Impossible task handling
  - Agent calls task:fail when task is clearly impossible
  - Graceful failure with meaningful error message
- [ ] Missing element handling
  - Agent retries with alternative strategies
  - Eventually fails gracefully if element never appears
- [ ] LLM transient errors
  - Mock provider that fails intermittently
  - Verify exponential backoff retry
  - Eventually succeeds after retries
- [ ] Network timeout handling
  - Mock slow/hanging LLM calls
  - Verify timeout triggers
  - Cleanup resources properly

### 3. StagehandConnector Tests (`test/connectors/stagehand.test.ts`)
**Status:** In Progress (stagehand-dev)

- [ ] page:observe action
  - Returns ParsedElement[] array
  - Elements have valid CSS selectors
  - Elements have descriptions
  - Elements have method + arguments
- [ ] page:act_by_selector action
  - Click by selector succeeds
  - Fill by selector with value
  - Select dropdown option
  - Handles element not found gracefully
- [ ] Integration with Stagehand
  - Connects to Playwright page
  - Uses Stagehand's observe() under the hood
  - Selector returned works with Playwright locator API

### 4. ManualConnector Tests (`test/connectors/manual.test.ts`)
**Status:** In Progress (manual-dev)

- [ ] manual:lookup action
  - Finds manual by URL pattern match
  - Finds manual by task pattern match
  - Returns null when no manual exists
  - Returns health_score in result
- [ ] manual:execute action
  - Executes all steps in order
  - Interpolates value templates with data
  - Increments success_count after completion
  - Handles step failure gracefully
- [ ] manual:save action
  - Creates new manual in SQLite
  - Saves all steps with selectors
  - Sets initial health_score to 100
  - Returns manual ID
- [ ] getInstructions() behavior
  - Instruction text tells LLM to check manuals first
  - Mentions using manual:execute for high-health manuals
  - Explains manual:save for successful new tasks
- [ ] SQLite schema
  - ActionManual table created
  - All required fields present
  - Indexes on url_pattern and task_pattern

### 5. GmailConnector Tests (`test/connectors/gmail.test.ts`)
**Status:** In Progress (gmail-dev)

- [ ] gmail:send action
  - Sends email via MCP server
  - Required fields: to, subject, body
  - Returns success confirmation
- [ ] gmail:read action
  - Reads emails from inbox
  - Optional query parameter filters results
  - Optional limit parameter caps results
  - Returns array of email objects
- [ ] MCP connection
  - Connects to MCP server from env var
  - Handles connection failure gracefully
  - Reconnects if connection drops

## Phase 2: Integration Tests

### 6. Full Self-Learning Loop (`test/integration/self-learning-loop.test.ts`)
**Status:** Pending (Task #7)

```typescript
/**
 * THE CORE TEST - Validates GhostHands value proposition
 *
 * Success Criteria:
 * 1. First run: Agent completes task using observe + act_by_selector
 * 2. Manual saved to SQLite with all steps
 * 3. Second run: Agent uses manual:execute (ZERO LLM calls for actions)
 * 4. Second run is significantly faster
 * 5. Both runs produce same result
 */
test('self-learning loop: first run saves manual, second run uses it', async () => {
    // Setup
    const agent = new BrowserAgent({
        llm: testLLMConfig,
        connectors: [
            new StagehandConnector(),
            new ManualConnector({ dbPath: ':memory:' }) // In-memory for test
        ]
    });

    // Test form URL
    const testUrl = 'http://localhost:3000/test-form';
    await agent.nav(testUrl);

    // FIRST RUN - Should explore and save manual
    const run1Start = Date.now();
    const run1LLMCalls = agent.models.getUsage(); // Track LLM calls

    await agent.act('Fill the contact form', {
        data: {
            name: 'Test User',
            email: 'test@example.com',
            message: 'Test message'
        }
    });

    const run1Duration = Date.now() - run1Start;
    const run1Calls = agent.models.getUsage() - run1LLMCalls;

    // Verify manual was saved
    const manualDb = // access SQLite db
    const manuals = await manualDb.query('SELECT * FROM action_manuals WHERE url_pattern LIKE ?', ['%test-form%']);
    expect(manuals).toHaveLength(1);
    expect(manuals[0].steps).toHaveLength(3); // name, email, message
    expect(manuals[0].health_score).toBe(100);

    // Reset page
    await agent.nav(testUrl);

    // SECOND RUN - Should use manual
    const run2Start = Date.now();
    const run2LLMCalls = agent.models.getUsage();

    await agent.act('Fill the contact form', {
        data: {
            name: 'Test User 2',
            email: 'test2@example.com',
            message: 'Second test'
        }
    });

    const run2Duration = Date.now() - run2Start;
    const run2Calls = agent.models.getUsage() - run2LLMCalls;

    // ASSERTIONS
    expect(run2Calls).toBe(1); // Only manual:lookup call
    expect(run2Duration).toBeLessThan(run1Duration * 0.5); // At least 50% faster
    expect(run2Calls).toBeLessThan(run1Calls * 0.2); // At least 80% fewer LLM calls

    // Verify manual was used (success_count incremented)
    const updatedManual = await manualDb.query('SELECT * FROM action_manuals WHERE id = ?', [manuals[0].id]);
    expect(updatedManual[0].success_count).toBe(1);

    await agent.stop();
});
```

### 7. Cross-Connector Integration
**Status:** Pending

- [ ] Stagehand + Manual combo
  - First run uses Stagehand observe
  - Manual saves Stagehand selectors
  - Second run uses manual with saved selectors
- [ ] Manual + Gmail combo
  - Fill form using manual
  - Send confirmation email via Gmail
  - All in one agent.act() call

## Phase 3: End-to-End Scenarios

### 8. Real-World Job Application
**Status:** Pending

- [ ] Greenhouse application flow
  - Navigate to real Greenhouse job posting
  - Fill multi-page form
  - Upload resume
  - Submit application
  - Save manual
  - Repeat on different Greenhouse job (uses manual)

### 9. Cost Validation
**Status:** Pending

- [ ] Track actual LLM costs
  - First run: measure token usage
  - Second run: verify ~95% reduction
  - Compare to expected cost savings

## Success Metrics

### Must Pass (P0)
- ✅ All unit tests pass
- ⬜ Self-learning loop test passes
- ⬜ Second run has <20% LLM calls of first run
- ⬜ Second run is >50% faster than first run
- ⬜ Manual health score tracked correctly

### Should Pass (P1)
- ⬜ All provider tests pass
- ⬜ Error handling tests pass
- ⬜ Real Greenhouse form works end-to-end

### Nice to Have (P2)
- ⬜ Cost validation matches projections
- ⬜ Manual degradation on selector changes
- ⬜ Gmail MCP integration works

## Test Environment

```bash
# Setup
pnpm install
pnpm build

# Run all tests
pnpm test

# Run specific test suite
pnpm test test/providers
pnpm test test/connectors
pnpm test test/integration

# Run with coverage
pnpm test:coverage

# Run integration tests only
pnpm test:integration
```

## Environment Variables for Tests

```bash
# .env.test
GOOGLE_API_KEY=...          # For Gemini (default)
DEEPSEEK_API_KEY=...        # For provider tests
SILICONFLOW_API_KEY=...     # For Qwen tests
MINIMAX_API_KEY=...         # For Minimax tests
GMAIL_MCP_SERVER=...        # For Gmail connector tests (optional)

# Test server
TEST_SERVER_PORT=3000       # Local server for test forms
```

## Test Data

Mock test forms will be created in `test/fixtures/`:
- `simple-form.html` - Basic contact form (3 fields)
- `multi-page-form.html` - Multi-step form (Greenhouse-like)
- `complex-form.html` - Shadow DOM + iframes

## CI/CD Integration

```yaml
# .github/workflows/test.yml
name: GhostHands Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm test
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          # Other API keys from secrets
```

## Coverage Goals

- Unit tests: >80% coverage
- Integration tests: Cover all critical paths
- E2E tests: At least 1 per connector

---

**Last Updated:** 2026-02-14
**Status:** Tests in progress, integration tests pending
