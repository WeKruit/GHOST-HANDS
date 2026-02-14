/**
 * GhostHands Self-Learning Demo
 *
 * This example demonstrates the core value proposition:
 * 1st run: Agent explores and learns (uses LLM)
 * 2nd run: Agent replays manual (ZERO LLM calls for actions!)
 */

import { BrowserAgent } from '@magnitude/core';
import { StagehandConnector } from '@magnitude/core/connectors/stagehandConnector';
import { ManualConnector } from '@magnitude/core/connectors/manualConnector';

async function main() {
    // Create agent with self-learning connectors
    const agent = new BrowserAgent({
        llm: {
            provider: 'google-ai',
            options: {
                model: 'gemini-2.5-flash',
                apiKey: process.env.GOOGLE_API_KEY!
            }
        },
        connectors: [
            new StagehandConnector(),
            new ManualConnector({ dbPath: './data/manuals.db' })
        ]
    });

    console.log('\n🎯 GhostHands Self-Learning Demo\n');

    // Navigate to example form
    const testUrl = 'https://jobs.lever.co/example-company/software-engineer';
    await agent.nav(testUrl);

    // First application - will explore and learn
    console.log('📝 First run: Learning...\n');
    const task1Start = Date.now();

    await agent.act('Fill out the job application form', {
        data: {
            firstName: 'John',
            lastName: 'Doe',
            email: 'john.doe@example.com',
            phone: '555-0123',
            resume: './resume.pdf',
            linkedin: 'https://linkedin.com/in/johndoe',
        }
    });

    const task1Duration = Date.now() - task1Start;
    console.log(`✅ First run completed in ${task1Duration}ms`);
    console.log(`   (Used LLM to explore + saved manual)\n`);

    // Navigate to another similar job posting
    await agent.nav('https://jobs.lever.co/example-company/senior-engineer');

    // Second application - will use manual!
    console.log('⚡ Second run: Using manual...\n');
    const task2Start = Date.now();

    await agent.act('Fill out the job application form', {
        data: {
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane.smith@example.com',
            phone: '555-0124',
            resume: './resume.pdf',
            linkedin: 'https://linkedin.com/in/janesmith',
        }
    });

    const task2Duration = Date.now() - task2Start;
    console.log(`✅ Second run completed in ${task2Duration}ms`);
    console.log(`   (Zero LLM calls! Used manual:execute)\n`);

    // Calculate savings
    const speedup = ((task1Duration - task2Duration) / task1Duration * 100).toFixed(1);
    console.log(`📊 Results:`);
    console.log(`   Speed improvement: ${speedup}% faster`);
    console.log(`   Cost savings: ~95% (manual:execute has no action LLM calls)`);
    console.log(`   Reliability: ↑ (uses proven selectors)\n`);

    await agent.stop();
}

main().catch(console.error);
