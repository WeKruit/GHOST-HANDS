/**
 * Workday LLM Prompts
 *
 * Centralized prompt strings for the WorkdayApplyHandler and WorkdayPlatformConfig.
 * The base rules are shared across all page handlers; each page type
 * adds its own context-specific instructions on top.
 */

// ---------------------------------------------------------------------------
// Base rules (shared across all Workday form-filling prompts)
// ---------------------------------------------------------------------------

export const WORKDAY_BASE_RULES = `RULES:
1. NO SCROLLING — I handle all scrolling. Never scroll the page.
2. VISIBLE ONLY — Only interact with fields fully visible in the viewport. If any part is cut off at the screen edge, skip it. If you typed into a field but cannot see the text (field near screen edge), trust the value is there — move on.
3. ONE ATTEMPT PER FIELD — Fill each field once, then move to the next. If it looks empty after you typed, trust your input was registered. Retyping causes duplicates (e.g. "WuWuWu" instead of "Wu").
4. NO TAB KEY — After filling a field, click on empty whitespace to deselect, then click directly on the next field. Tab can jump to the wrong field in Workday.
5. NO NAVIGATION — Do not click "Save and Continue", "Next", "Submit", "Back", or any page-navigation button. I handle navigation.
6. TRUST FILLED FIELDS — If a field shows any text, it is already filled. Narrow fields truncate long values visually (e.g. "alexanderwgu..." for a full email). Never click on, clear, or retype a field that shows text. Phone numbers like "(408) 555-1234" are correctly formatted by Workday — do not re-enter them.
7. SIGNAL COMPLETION — When all visible fields are filled (or none need filling), report the task as done.`;

// ---------------------------------------------------------------------------
// Workday interaction patterns
// ---------------------------------------------------------------------------

/** Workday-specific dropdown instructions. */
export const DROPDOWN_RULES = `DROPDOWNS: Click the dropdown, then TYPE your answer to filter (e.g. "No", "Yes", "Male", "Website"), then click the matching option. The popup menu ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps other questions. If no match appears, click whitespace to close, reopen, and try a shorter keyword. Never use arrow keys or mouse-scroll inside dropdowns.`;

/** Workday segmented date fields. */
export const DATE_FIELD_RULES = (todayDate: string, todayFormatted: string, graduationDate: string) =>
  `DATE FIELDS (MM/DD/YYYY): Click the MM (month) part FIRST, then type the full date as continuous digits with no slashes (e.g. "${todayDate}" for ${todayFormatted}). For "today's date" or "signature date", type "${todayDate}". For "expected graduation date", type "${graduationDate}".`;

/** Checkbox instructions. */
export const CHECKBOX_RULES = `CHECKBOXES: Click required checkboxes (e.g. "I acknowledge...", Terms & Conditions) to check them.`;

// ---------------------------------------------------------------------------
// Page-specific prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the Personal Info page.
 */
export function buildPersonalInfoPrompt(dataBlock: string): string {
  const todayDate = getTodayDateDigits();
  const todayFormatted = getTodayFormatted();
  const graduationDate = getGraduationDateDigits();

  return `${WORKDAY_BASE_RULES}

HOW TO FILL FIELDS:
- Skip any field that already shows text or a selected value — even if truncated.
- Empty text fields: click the field, type the value, click whitespace to deselect.
- ${DROPDOWN_RULES}
- ${DATE_FIELD_RULES(todayDate, todayFormatted, graduationDate)}
- Radio buttons: click the correct option matching the data mapping.
- ${CHECKBOX_RULES}
- OPTIONAL FIELDS: Not every empty field needs filling. If an OPTIONAL field has no matching value in the data mapping (e.g., Address Line 2, Middle Name, Suffix), leave it empty and move on.
- REQUIRED FIELDS: If a REQUIRED field (marked with * or "required") has no exact match in the data mapping, use your best judgment to provide a reasonable answer that benefits the applicant. Think about what makes sense given the applicant's profile and the role they're applying for.

TASK: Fill any empty form fields visible on screen, top to bottom. When done, report the task as complete.

${dataBlock}`;
}

/**
 * Build the prompt for a Questions / Application Questions page.
 */
export function buildFormPagePrompt(pageDescription: string, dataPrompt: string): string {
  const todayDate = getTodayDateDigits();
  const todayFormatted = getTodayFormatted();
  const graduationDate = getGraduationDateDigits();

  return `${WORKDAY_BASE_RULES}

HOW TO FILL FIELDS:
- Skip any field that already shows text or a selected value — even if truncated.
- Empty text fields: click the field, type the value, click whitespace to deselect.
- ${DROPDOWN_RULES}
- ${DATE_FIELD_RULES(todayDate, todayFormatted, graduationDate)}
- Radio buttons: click the correct option matching the data mapping.
- ${CHECKBOX_RULES}
- OPTIONAL FIELDS: Not every empty field needs filling. If an OPTIONAL field has no matching value in the data mapping, leave it empty and move on.
- REQUIRED FIELDS: If a REQUIRED field (marked with * or "required") has no exact match in the data mapping, use your best judgment to provide a reasonable answer that benefits the applicant.

TASK: You are on a "${pageDescription}" form page. Fill any empty questions/fields visible on screen, top to bottom. When done, report the task as complete.

${dataPrompt}`;
}

/**
 * Build the prompt for the My Experience page (work history, education, skills).
 */
export function buildExperiencePrompt(dataBlock: string): string {
  return `${WORKDAY_BASE_RULES}

This is the "My Experience" page. Fill any empty fields/sections visible on screen.

HOW TO FILL FIELDS:
- "Add" buttons: ONLY click "Add" under "Work Experience" and "Education". Do NOT click "Add" under "Websites" or "Certifications" — leave those empty. If fields are already expanded (Job Title, Company visible), do NOT click Add again.
- ${DROPDOWN_RULES}
- Typeahead fields (e.g. Field of Study, Skills): type the value, wait 2-3 seconds for autocomplete, then press Enter to select the first match.
- Date fields (MM/YYYY): two boxes side by side — MM on left, YYYY on right. Click the LEFT box (MM) first, then type digits continuously (e.g. "012026"). Workday auto-advances to YYYY. Never click the right/YYYY box directly.
- Radio buttons: click the correct option matching the data.
- ${CHECKBOX_RULES}
- After filling each field, click whitespace to deselect before the next field.
- REQUIRED FIELDS: If a REQUIRED field (marked with * or "required") has no exact match in the data, use your best judgment to provide a reasonable answer that benefits the applicant.

When done, report the task as complete.

${dataBlock}`;
}

/**
 * Build the prompt for the Voluntary Self-Identification page (gender, race, veteran, disability).
 * Now data-driven — answers come from the dataBlock.
 */
export function buildVoluntaryDisclosurePrompt(dataBlock: string): string {
  return `${WORKDAY_BASE_RULES}

This is a voluntary self-identification page. Fill any unanswered questions visible on screen.

HOW TO FILL:
- If a dropdown already has an answer selected, skip it.
- If empty: click the dropdown, then TYPE the desired answer from the data mapping below to filter the list, then click the matching option.
- The popup menu ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps other questions.
- If typing doesn't produce a match, click whitespace to close, reopen, and try a shorter keyword. Never use arrow keys or mouse-scroll inside dropdowns.
- ${CHECKBOX_RULES}
- REQUIRED FIELDS: If a REQUIRED field has no exact match in the data mapping, use your best judgment — pick the most neutral/beneficial option for the applicant (e.g. "I do not wish to answer" for demographics).

When all visible questions have answers, report the task as complete.

${dataBlock}`;
}

/**
 * Build the prompt for the Self-Identify page (typically disability status).
 * Now data-driven — answers come from the dataBlock.
 */
export function buildSelfIdentifyPrompt(dataBlock: string): string {
  return `${WORKDAY_BASE_RULES}

This is a self-identification page (often about disability status). Fill any unanswered questions visible on screen.

HOW TO FILL:
- If a dropdown already has an answer selected, skip it.
- If empty: click the dropdown, then TYPE the desired answer from the data mapping below to filter the list, then click the matching option.
- The popup menu ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps other questions.
- If typing doesn't produce a match, click whitespace to close, reopen, and try a shorter keyword. Never use arrow keys or mouse-scroll inside dropdowns.
- ${CHECKBOX_RULES}
- REQUIRED FIELDS: If a REQUIRED field has no exact match in the data mapping, use your best judgment — pick the most neutral/beneficial option for the applicant (e.g. "I do not wish to answer" for demographics).

When all visible questions have answers, report the task as complete.

${dataBlock}`;
}

/**
 * Build the prompt for a generic / unknown page type.
 */
export function buildGenericPagePrompt(dataPrompt: string): string {
  return `${WORKDAY_BASE_RULES}

HOW TO FILL FIELDS:
- Skip any field that already shows text or a selected value.
- Empty fields: click the field, type/select the correct value, click whitespace to deselect.
- ${DROPDOWN_RULES}
- Radio buttons: click the correct option matching the data mapping.
- ${CHECKBOX_RULES}
- OPTIONAL FIELDS: Not every empty field needs filling. If an OPTIONAL field has no matching value in the data mapping, leave it empty and move on.
- REQUIRED FIELDS: If a REQUIRED field (marked with * or "required") has no exact match in the data mapping, use your best judgment to provide a reasonable answer that benefits the applicant.

TASK: Fill any empty form fields visible on screen, top to bottom. When done, report the task as complete.

${dataPrompt}`;
}

/**
 * Build the prompt for the Google sign-in LLM fallback.
 * NOTE: Password is NOT included — password entry is handled via DOM only.
 */
export function buildGoogleSignInFallbackPrompt(email: string): string {
  return `This is a Google sign-in page. Move through the sign-in flow for "${email}":
- If you see a "Continue", "Confirm", or "Allow" button, click it to proceed.
- If you see the account "${email}" listed, click on it to select it.
- If you see an "Email or phone" field, type "${email}" and click "Next".
- If you see a "Password" field, do NOT type anything — just report the task as done.
- If you see a CAPTCHA or image challenge, report the task as done.
Click only ONE button, then report the task as done.`;
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

/** Get expected graduation date as continuous digits (MMDDYYYY). Dynamic — always May of next year. */
function getGraduationDateDigits(): string {
  const now = new Date();
  // If we're past May, use May of next year; otherwise May of this year
  const gradYear = now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear();
  return `0501${gradYear}`;
}
