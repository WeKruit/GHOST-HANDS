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

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field. Typing into the same field multiple times causes duplicate text (e.g. "WuWuWu" instead of "Wu").

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.`;

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
  Step 4: A dropdown LIST appears BELOW the button you clicked. Look inside that list for the option with a SOLID BLUE FILLED BACKGROUND — this is your match. Do NOT click the dropdown button again. The blue-filled option is BELOW the button, inside the popup list. Click that blue-filled option. Then click on empty whitespace to deselect.
  Step 5: STOP. You are done for this turn. Do not fill any more fields — I will call you again.
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
3. TYPEAHEAD FIELDS (e.g. Field of Study, Skills): Type the value, then press Enter to trigger the dropdown. WAIT 2-3 seconds for the suggestions to load. Then CLICK on the matching option in the dropdown list. If the correct option is not visible, click the dropdown scrollbar to scroll through the options until you find it.
4. DATE FIELDS (MM/YYYY): Look for the text "MM" on screen — it is a tiny input box. Click DIRECTLY on the letters "MM". Do NOT click the calendar icon (📅) or the box showing "YYYY". After clicking "MM", type the digits continuously (e.g. "012026") and Workday auto-advances to YYYY. If the date shows "1900" or an error, do this recovery: click on the "MM" box, press Delete 6 times to clear it, then type the date digits again.
5. ${CHECKBOX_RULES}
6. After filling each field, CLICK on empty whitespace to deselect before moving to the next field.

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;
}

/**
 * Build the prompt for the Voluntary Self-Identification page (gender, race, veteran, disability).
 */
export function buildVoluntaryDisclosurePrompt(): string {
  return `${WORKDAY_BASE_RULES}

This is a voluntary self-identification page. Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Gender → type "Male"
   - Race/Ethnicity → type "Asian"
   - Veteran Status → type "not a protected"
   - Disability → type "do not wish"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. ${CHECKBOX_RULES}

If ALL visible questions already have answers, STOP IMMEDIATELY.`;
}

/**
 * Build the prompt for the Self-Identify page (typically disability status).
 */
export function buildSelfIdentifyPrompt(): string {
  return `${WORKDAY_BASE_RULES}

This is a self-identification page (often about disability status). Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a field/dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Disability Status → type "do not wish"
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
 */
export function buildGoogleSignInFallbackPrompt(email: string, password: string): string {
  return `This is a Google sign-in page. Do exactly ONE of these actions, then STOP:
1. If you see an existing account for "${email}", click on it.
2. If you see an "Email or phone" field, type "${email}" and click "Next".
3. If you see a "Password" field, type "${password}" and click "Next".
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
