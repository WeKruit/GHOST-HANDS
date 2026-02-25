/**
 * Smart scroll-and-fill logic for the desktop app.
 *
 * Replaces the naive single `agent.act(bigPrompt)` call — which lets the LLM
 * attempt mouse-wheel scrolling (broken in nested scroll containers like Workday)
 * — with the staging server's proven pattern:
 *
 *   1. Scroll to top via `page.evaluate(window.scrollTo)`
 *   2. LLM fills only the currently VISIBLE fields (ZERO SCROLLING rule)
 *   3. Programmatic JS scroll down 65% of viewport
 *   4. Repeat until bottom reached (max 10 rounds)
 *   5. Scroll to bottom and click "Save and Continue" / "Next"
 *
 * The LLM never scrolls — the system controls viewport position.
 */

import type { UserProfile, ProgressEvent } from '../../shared/types';

type EmitFn = (type: ProgressEvent['type'], message?: string, extra?: Partial<ProgressEvent>) => void;

interface AgentHandle {
  page: any; // Playwright Page
  act: (prompt: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Base rules — ported from staging workdayPrompts.ts
// ---------------------------------------------------------------------------

const BASE_RULES = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. The system handles all scrolling.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: Before interacting with ANY field, check that you can see the ENTIRE perimeter of its input box — all four edges must be fully visible on screen. If even one edge is cut off, that field is OFF LIMITS. Do not click it, do not type in it. When you run out of fully visible fields, STOP immediately. The system will scroll for you.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any navigation button. When you are done filling visible fields, simply STOP. The system handles navigation.`;

const FIELD_FILL_RULES = `1. If the field already has ANY value (even if formatted differently), SKIP IT entirely.
2. If the field is truly empty: CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.
3. DROPDOWNS: CLICK the dropdown to open it, TYPE your desired answer to filter, WAIT for options to appear, then CLICK the matching option. Fill ONE dropdown at a time.
4. DATE FIELDS (MM/DD/YYYY): Click on the date field, type the full date as continuous digits with NO slashes (e.g. "02242026" for 02/24/2026).
5. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildFillPrompt(profile: UserProfile, resumePath?: string): string {
  const lines: string[] = [
    `Name: ${profile.firstName} ${profile.lastName}`,
    `Email: ${profile.email}`,
    `Phone: ${profile.phone}`,
  ];

  if (profile.address) {
    const parts = [profile.address, profile.city, profile.state, profile.zipCode].filter(Boolean);
    lines.push(`Address: ${parts.join(', ')}`);
  }
  if (profile.linkedIn) lines.push(`LinkedIn: ${profile.linkedIn}`);

  if (profile.education.length > 0) {
    lines.push('', 'Education:');
    for (const edu of profile.education) {
      const years = edu.endYear ? `${edu.startYear}-${edu.endYear}` : `${edu.startYear}-present`;
      lines.push(`- ${edu.degree} in ${edu.field} from ${edu.school} (${years})`);
    }
  }

  if (profile.experience.length > 0) {
    lines.push('', 'Work Experience:');
    for (const exp of profile.experience) {
      const dates = exp.endDate ? `${exp.startDate} - ${exp.endDate}` : `${exp.startDate} - present`;
      lines.push(`- ${exp.title} at ${exp.company} (${dates})`);
      lines.push(`  ${exp.description}`);
    }
  }

  if (resumePath) lines.push('', `Resume file path (upload if form asks): ${resumePath}`);

  if (profile.qaAnswers && Object.keys(profile.qaAnswers).length > 0) {
    lines.push('', 'Pre-set answers for common questions:');
    for (const [question, answer] of Object.entries(profile.qaAnswers)) {
      lines.push(`Q: ${question}`, `A: ${answer}`);
    }
  }

  const dataBlock = lines.join('\n');

  return `${BASE_RULES}

Fill any EMPTY form fields that are FULLY visible on screen, from TOP to BOTTOM:
${FIELD_FILL_RULES}

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;
}

// ---------------------------------------------------------------------------
// Core scroll-and-fill loop
// ---------------------------------------------------------------------------

export async function fillWithSmartScroll(
  agent: AgentHandle,
  profile: UserProfile,
  emit: EmitFn,
  resumePath?: string,
): Promise<void> {
  const MAX_ROUNDS = 10;
  const page = agent.page;

  // Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const fillPrompt = buildFillPrompt(profile, resumePath);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Check if we've reached the bottom (skip check on first round)
    if (round > 0) {
      const { scrollY, maxScroll } = await page.evaluate(() => ({
        scrollY: window.scrollY,
        maxScroll: document.documentElement.scrollHeight - window.innerHeight,
      }));
      if (scrollY >= maxScroll - 10) {
        emit('status', 'Reached bottom of form');
        break;
      }
    }

    // LLM fills only visible fields (with ZERO SCROLLING rule)
    emit('status', `Filling visible fields (section ${round + 1})...`);
    await agent.act(fillPrompt);

    // Programmatic scroll: 65% of viewport height
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
    await page.waitForTimeout(800);
    const scrollAfter = await page.evaluate(() => window.scrollY);

    // If scroll position didn't change, we've hit the bottom
    if (scrollAfter <= scrollBefore) {
      emit('status', 'Reached bottom of form');
      break;
    }
  }

  // Scroll to bottom where the navigation button lives
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(800);

  // Click the navigation button
  emit('status', 'Clicking Save and Continue...');
  await agent.act(
    'Click the "Save and Continue" or "Next" or "Submit" button at the bottom of the page. Do NOT scroll. If no such button is visible, STOP.',
  );
}
