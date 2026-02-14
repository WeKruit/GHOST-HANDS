/**
 * GhostHands + Gmail MCP Integration Demo
 *
 * Shows how the agent can use Gmail alongside browser automation
 */

import { BrowserAgent } from '@magnitude/core';
import { GmailConnector } from '@magnitude/core/connectors/gmailConnector';
import { ManualConnector } from '@magnitude/core/connectors/manualConnector';

async function main() {
    const agent = new BrowserAgent({
        llm: {
            provider: 'google-ai',
            options: {
                model: 'gemini-2.5-flash',
                apiKey: process.env.GOOGLE_API_KEY!
            }
        },
        connectors: [
            new ManualConnector({ dbPath: './data/manuals.db' }),
            new GmailConnector({
                mcpServerUrl: process.env.GMAIL_MCP_SERVER!
            })
        ]
    });

    console.log('\n📧 GhostHands + Gmail Integration Demo\n');

    // Navigate to job posting
    await agent.nav('https://jobs.lever.co/example-company/software-engineer');

    // Fill out application (will use manual if available)
    await agent.act('Fill out the job application form and submit it', {
        data: {
            firstName: 'John',
            lastName: 'Doe',
            email: 'john.doe@example.com',
            phone: '555-0123',
            resume: './resume.pdf'
        }
    });

    console.log('✅ Application submitted!\n');

    // Now send a follow-up email via Gmail
    console.log('📤 Sending follow-up email via Gmail...\n');

    await agent.act('Send a follow-up email to the hiring manager', {
        data: {
            to: 'hiring@example-company.com',
            subject: 'Application Follow-up - Software Engineer Position',
            body: `Dear Hiring Team,

I wanted to follow up on my application for the Software Engineer position
that I just submitted through your portal.

I'm very excited about the opportunity to contribute to your team and would
love to discuss how my experience aligns with your needs.

Best regards,
John Doe`
        }
    });

    console.log('✅ Follow-up email sent!\n');

    await agent.stop();

    console.log('\n🎉 Complete workflow automation:');
    console.log('   1. Filled job application (browser)');
    console.log('   2. Sent follow-up email (Gmail MCP)');
    console.log('   All in one agent.act() chain!\n');
}

main().catch(console.error);
