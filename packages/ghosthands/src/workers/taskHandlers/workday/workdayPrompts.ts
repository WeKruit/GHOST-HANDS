/**
 * Workday LLM Prompts
 *
 * Centralized prompt strings for the WorkdayApplyHandler.
 * The base rules are shared across all page handlers; each page type
 * adds its own context-specific instructions on top.
 */

// ---------------------------------------------------------------------------
// Base rules (shared across all form-filling prompts)
// ---------------------------------------------------------------------------

export const WORKDAY_BASE_RULES = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: Before interacting with ANY field, check that you can see the ENTIRE perimeter of its input box — all four edges (top, bottom, left, right) must be fully visible on screen. If even one edge of the box is cut off or hidden by the top or bottom of the screen, that field is OFF LIMITS. Do not click it, do not type in it, do not try to expand it, do not click anywhere near it — pretend it does not exist. Only interact with fields where you can see the complete box with space around it. When you run out of fully visible fields, STOP immediately and do nothing more. I will scroll the page for you and call you again.

ABSOLUTE RULE #3 — ONE ATTEMPT PER TEXT FIELD: You may type into a given TEXT INPUT field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field. Typing into the same field multiple times causes duplicate text (e.g. "WuWuWu" instead of "Wu").
EXCEPTION — DROPDOWNS: If you attempted a dropdown but it is still showing "Select One" (meaning the selection did not register), you SHOULD retry it. Dropdowns do not have the duplicate-text problem, so retrying is safe.

ABSOLUTE RULE #4 — CLICK BEFORE TYPING: NEVER type unless you have just clicked on a text input field and can see it is focused (blue border or cursor visible). Typing without a focused field causes the page to jump to a random location. Always: 1) CLICK the field, 2) confirm it is focused, 3) THEN type.

ABSOLUTE RULE #5 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #6 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.`;

// ---------------------------------------------------------------------------
// Common interaction patterns (reused across page-specific prompts)
// ---------------------------------------------------------------------------

/** Standard instructions for filling empty fields top-to-bottom. */
export const FIELD_FILL_RULES = `1. If the field already has ANY value (even if formatted differently), SKIP IT entirely.
2. Phone numbers like "(408) 555-1234" are CORRECTLY formatted by Workday — do NOT re-enter them.
3. If the field is truly empty (blank/no text): CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.`;

/** How to interact with dropdown fields. */
export const DROPDOWN_RULES = `DROPDOWNS: Fill ONLY ONE dropdown per turn. After completing one dropdown, STOP and do nothing more — I will call you again for the next one. Follow these steps:
  Step 1: CLICK the dropdown button to open it.
  Step 2: TYPE your desired answer (e.g. "No", "Yes", "Male", "Website"). You MUST type — never skip this step.
  Step 3: WAIT 3 seconds. Do nothing during this time — let the dropdown filter and update.
  Step 4: A dropdown LIST appears BELOW the button you clicked. Read the text of each visible option and CLICK the one whose text best matches your desired answer. Ignore background colors — just match the text. Then click on empty whitespace to deselect.
  Step 5: VERIFY — after clicking whitespace, check the dropdown button text. If it still says "Select One", your selection did NOT register. Retry from Step 1 (click the dropdown again, type your answer, wait, and click the matching option). You may retry a dropdown up to 2 times.
  Step 6: STOP. You are done for this turn. Do not fill any more fields — I will call you again.
  TRUST THE DROPDOWN: When you click a dropdown and options appear, those options ALWAYS belong to the dropdown you just clicked — even if the popup visually overlaps with other questions above or below. Do NOT second-guess which question the options belong to. Be confident and click your answer. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.`;

/** How to interact with date fields. */
export const DATE_FIELD_RULES = (todayDate: string, todayFormatted: string) =>
  `DATE FIELDS (MM/DD/YYYY): Click on the MM (month) part FIRST, then type the full date as continuous digits with NO slashes (e.g. "${todayDate}" for ${todayFormatted}). For "today's date" or "signature date", type "${todayDate}". For "expected graduation date" use 05012027.`;

/** How to interact with checkboxes. */
export const CHECKBOX_RULES = `CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.`;

/** "Stop if done" footer. */
export const STOP_IF_DONE = `If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.`;

// ---------------------------------------------------------------------------
// Page-specific prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the Personal Info page.
 */
export function buildPersonalInfoPrompt(dataBlock: string): string {
  const todayDate = getTodayDateDigits();
  const todayFormatted = getTodayFormatted();

  return `${WORKDAY_BASE_RULES}

Fill any EMPTY form fields that are FULLY visible on screen, from TOP to BOTTOM:
${FIELD_FILL_RULES}
4. ${DROPDOWN_RULES}
5. ${DATE_FIELD_RULES(todayDate, todayFormatted)}
6. ${CHECKBOX_RULES}

${STOP_IF_DONE}

${dataBlock}`;
}

/**
 * Build the prompt for a Questions / Application Questions page.
 */
export function buildFormPagePrompt(pageDescription: string, dataPrompt: string): string {
  const todayDate = getTodayDateDigits();
  const todayFormatted = getTodayFormatted();

  return `${WORKDAY_BASE_RULES}

You are on a "${pageDescription}" form page. Fill any EMPTY questions/fields that are FULLY visible on screen, from top to bottom:
${FIELD_FILL_RULES}
4. ${DROPDOWN_RULES}
5. ${DATE_FIELD_RULES(todayDate, todayFormatted)}
6. ${CHECKBOX_RULES}

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataPrompt}`;
}

/**
 * Build the prompt for the My Experience page (work history, education, skills).
 */
export function buildExperiencePrompt(dataBlock: string): string {
  return `${WORKDAY_BASE_RULES}

This is the "My Experience" page. Fill any EMPTY fields/sections that are FULLY visible on screen.

IMPORTANT INTERACTION PATTERNS:
1. "Add" BUTTONS: ONLY click "Add" under "Work Experience" and "Education" sections. Do NOT click "Add" under "Websites" or "Certifications" — those must stay empty. If the form fields are already expanded (you can see Job Title, Company, etc.), do NOT click Add again.
2. ${DROPDOWN_RULES}
3. TYPEAHEAD FIELDS (e.g. Field of Study, Skills): Click the input, type the value, then press ENTER to trigger the dropdown. WAIT 3 seconds for the suggestions to load. Then CLICK on the matching option in the dropdown list — the field is NOT filled until you click the option. Just typing is NOT enough. If the EXACT option is NOT found (you see "No matches found" or the value doesn't exist in the list): clear the input (click the X button or select all + delete), type a SHORTER/BROADER search term (e.g., just the first word — "Business" instead of "Business Analytics"), press ENTER, wait 3 seconds, and click the closest matching option. Do NOT scroll endlessly through the entire dropdown — if the exact value doesn't exist, use a shorter term and select the best available match. After clicking, click on empty whitespace to dismiss.
4. DATE FIELDS (MM/YYYY): Look for the text "MM" on screen — it is a tiny input box. Click DIRECTLY on the letters "MM". Do NOT click the calendar icon or the box showing "YYYY". After clicking "MM", type the digits continuously (e.g. "012026") and Workday auto-advances to YYYY. If the date shows "1900" or an error, do this recovery: click on the "MM" box, press Delete 6 times to clear it, then type the date digits again.
5. ${CHECKBOX_RULES}
6. After filling each field, CLICK on empty whitespace to deselect before moving to the next field.

BEFORE REPORTING DONE: Check for ANY "Add" buttons visible on screen for Work Experience or Education. If you see an "Add" button for a section that does NOT yet have an entry (no expanded form fields below it), you MUST click it to add an entry. Only report done when all sections either have filled entries or you have clicked their "Add" buttons AND filled the resulting fields.

If ALL visible fields already have values AND no unfilled "Add" buttons for Work Experience or Education remain, STOP — do nothing.

${dataBlock}`;
}

// ---------------------------------------------------------------------------
// Experience entry base rules (scrolling ALLOWED within a single entry)
// ---------------------------------------------------------------------------

/**
 * Base rules for filling a single work experience or education entry.
 * Unlike WORKDAY_BASE_RULES, scrolling DOWN is explicitly ALLOWED so the LLM
 * can reach fields that extend below the viewport (e.g. date fields,
 * role description) without stopping prematurely.
 */
export const EXPERIENCE_ENTRY_RULES = `ABSOLUTE RULE — SCROLL DOWN ONLY: You ARE allowed to scroll DOWN on this page to reveal more fields for this entry. Each scroll must be at least 40 pixels. You may ONLY scroll DOWN — NEVER scroll up. Scrolling up is STRICTLY FORBIDDEN because it will bring previous entries into view and cause you to overwrite their data. If you cannot find a field, keep scrolling DOWN — it is always below you, never above.

RULE — ONE ATTEMPT PER TEXT FIELD: You may type into a given TEXT INPUT field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field. Typing into the same field multiple times causes duplicate text (e.g. "WuWuWu" instead of "Wu").
EXCEPTION — DROPDOWNS: If you attempted a dropdown but it is still showing "Select One" (meaning the selection did not register), you SHOULD retry it. Dropdowns do not have the duplicate-text problem, so retrying is safe.

RULE — CLICK BEFORE TYPING: NEVER type unless you have just clicked on a text input field and can see it is focused (blue border or cursor visible). Typing without a focused field causes the page to jump to a random location. Always: 1) CLICK the field, 2) confirm it is focused, 3) THEN type.

RULE — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

RULE — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. Do NOT click any "Add" button. When you have filled ALL fields listed below, simply STOP taking actions.`;

/**
 * Build the prompt for filling a single work experience or education entry.
 * Uses relaxed scrolling rules so the LLM can scroll within the entry.
 */
export function buildExperienceEntryPrompt(dataBlock: string): string {
  return `${EXPERIENCE_ENTRY_RULES}

You are on the "My Experience" page filling a SINGLE entry. Fill ALL the fields listed below — scroll down if needed to find them.

INTERACTION PATTERNS:
1. ${DROPDOWN_RULES}
2. TYPEAHEAD FIELDS (e.g. Field of Study, Skills): Click the input, type the value, then press ENTER to trigger the dropdown. WAIT 3 seconds for the suggestions to load. Then CLICK on the matching option in the dropdown list — the field is NOT filled until you click the option. Just typing is NOT enough. If the EXACT option is NOT found (you see "No matches found" or the value doesn't exist in the list): clear the input (click the X button or select all + delete), type a SHORTER/BROADER search term (e.g., just the first word — "Business" instead of "Business Analytics"), press ENTER, wait 3 seconds, and click the closest matching option. Do NOT scroll endlessly through the entire dropdown — if the exact value doesn't exist, use a shorter term and select the best available match. After clicking, click on empty whitespace to dismiss.
3. DATE FIELDS (MM/YYYY): Look for the text "MM" on screen — it is a tiny input box. Click DIRECTLY on the letters "MM". Do NOT click the calendar icon or the box showing "YYYY". After clicking "MM", type the digits continuously (e.g. "012026") and Workday auto-advances to YYYY. If the date shows "1900" or an error, do this recovery: click on the "MM" box, press Delete 6 times to clear it, then type the date digits again.
4. ${CHECKBOX_RULES}
5. After filling each field, CLICK on empty whitespace to deselect before moving to the next field.
6. If a field already has a value, SKIP IT — do not re-enter or overwrite it.

${dataBlock}

After filling ALL fields listed above, STOP immediately.`;
}

/** Self-identification field values for prompt builders. */
export interface SelfIdFields {
  gender: string;
  race_ethnicity: string;
  veteran_status: string;
  disability_status: string;
}

/**
 * Build the prompt for the Voluntary Self-Identification page (gender, race, veteran, disability).
 */
export function buildVoluntaryDisclosurePrompt(selfId: SelfIdFields): string {
  // Extract short typing hints from the full values (first few distinctive words)
  const genderHint = selfId.gender.split(/\s+/).slice(0, 1).join(' ');
  const raceHint = selfId.race_ethnicity.split(/\s+/).slice(0, 1).join(' ');
  const veteranHint = selfId.veteran_status.includes('not') ? 'not a protected' : selfId.veteran_status.split(/\s+/).slice(0, 3).join(' ');
  const disabilityHint = selfId.disability_status.toLowerCase().startsWith('no') ? 'No' : selfId.disability_status.split(/\s+/).slice(0, 3).join(' ');

  return `${WORKDAY_BASE_RULES}

This is a voluntary self-identification page. Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Gender → type "${genderHint}" then click "${selfId.gender}"
   - Race/Ethnicity → type "${raceHint}" then click "${selfId.race_ethnicity}"
   - Veteran Status → type "${veteranHint}" then click "${selfId.veteran_status}"
   - Disability → type "${disabilityHint}" then click "${selfId.disability_status}"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. ${CHECKBOX_RULES}

If ALL visible questions already have answers, STOP IMMEDIATELY.`;
}

/**
 * Build the prompt for the Self-Identify page (typically disability status).
 */
export function buildSelfIdentifyPrompt(selfId: SelfIdFields): string {
  const disabilityHint = selfId.disability_status.toLowerCase().startsWith('no') ? 'No' : selfId.disability_status.split(/\s+/).slice(0, 3).join(' ');

  return `${WORKDAY_BASE_RULES}

This is a self-identification page (often about disability status). Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a field/dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Disability Status → type "${disabilityHint}" then click "${selfId.disability_status}"
   - Any other question → type "Decline"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. ${CHECKBOX_RULES}

If ALL visible questions already have answers, STOP IMMEDIATELY.`;
}

/**
 * Build the prompt for a generic / unknown page type.
 */
export function buildGenericPagePrompt(dataPrompt: string): string {
  return `${WORKDAY_BASE_RULES}

Look at this page. Fill any EMPTY form fields that are FULLY visible, from top to bottom:
1. If a field already has ANY value, SKIP IT — do not re-enter or "fix" it.
2. If truly empty: CLICK the field, type/select the correct value, CLICK whitespace to deselect.
3. ${DROPDOWN_RULES}
4. ${CHECKBOX_RULES}

If ALL fields already have values or no form fields exist, STOP IMMEDIATELY.

${dataPrompt}`;
}

/**
 * Build the prompt for the Google sign-in LLM fallback.
 *
 * SECURITY: This prompt is sent to an LLM provider. Never include passwords
 * or other credentials here — LLM providers log prompts and completions.
 * Password entry is handled via direct DOM manipulation (page.fill) in the
 * workdayApplyHandler, never through LLM instructions.
 */
export function buildGoogleSignInFallbackPrompt(email: string): string {
  return `This is a Google sign-in page. Do exactly ONE of these actions, then STOP:
1. If you see an existing account for "${email}", click on it.
2. If you see an "Email or phone" field, type "${email}" and click "Next".
3. If you see a "Password" field, STOP immediately — do NOT type anything into it.
Do NOT interact with CAPTCHAs, reCAPTCHAs, or image challenges. If you see one, STOP immediately.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get today's date as continuous digits for Workday date fields (MMDDYYYY). */
function getTodayDateDigits(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  return `${mm}${dd}${yyyy}`;
}

/** Get today's date in MM/DD/YYYY format for prompt text. */
function getTodayFormatted(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  return `${mm}/${dd}/${yyyy}`;
}
