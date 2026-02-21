import { z } from 'zod';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import type { PlatformConfig, PageState, PageType } from './types.js';

// ---------------------------------------------------------------------------
// Base rules (generic — works for most ATS platforms)
// ---------------------------------------------------------------------------

const GENERIC_BASE_RULES = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: If ANY part of a field, dropdown, or input is cut off at the top or bottom edge of the screen, DO NOT interact with it. Only touch fields where the ENTIRE element is within the viewport.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if it appears empty, trust that your input was registered and move on.

ABSOLUTE RULE #4 — NEVER NAVIGATE: Do NOT click "Next", "Continue", "Submit", "Save and Continue", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.

ABSOLUTE RULE #5 — TRUST FILLED FIELDS: If a text field shows ANY text at all, it is already filled — DO NOT touch it. Text in narrow input boxes is often visually truncated (e.g. an email field may display "alexanderwguwastak" when the full value "alexanderwguwastaken@gmail.com" is stored). This is normal browser behavior. Never click on, clear, or retype a field that already contains text.`;

const FIELD_FILL_RULES = `1. If the field already has ANY value (even if formatted differently), SKIP IT entirely. IMPORTANT: Text in narrow input fields is often TRUNCATED visually — the field may show "alexanderwguwastak" when the full value "alexanderwguwastaken@gmail.com" is actually there. If a field shows ANY text at all, it is FILLED — do NOT click on it, do NOT retype it, do NOT "fix" it. Move on.
2. If the field is truly empty (blank/no text): CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.
3. After filling each field, CLICK on empty whitespace to deselect before moving to the next field.`;

const DROPDOWN_RULES = `DROPDOWNS: After clicking a dropdown, type your desired answer to filter the list, then click the matching option. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword.`;

const CHECKBOX_RULES = `CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click it to check it.`;

// ---------------------------------------------------------------------------
// Page state schema (generic page types only)
// ---------------------------------------------------------------------------

const GenericPageStateSchema = z.object({
  page_type: z.enum([
    'job_listing', 'login', 'google_signin', 'verification_code', 'phone_2fa',
    'account_creation', 'personal_info', 'experience', 'resume_upload',
    'questions', 'review', 'confirmation', 'error', 'unknown',
  ]),
  page_title: z.string().optional().default(''),
  has_apply_button: z.boolean().optional().default(false),
  has_next_button: z.boolean().optional().default(false),
  has_submit_button: z.boolean().optional().default(false),
  has_sign_in_with_google: z.boolean().optional().default(false),
  error_message: z.string().optional().default(''),
});

// ---------------------------------------------------------------------------
// Fuzzy matching for dropdown label → QA map answer
// ---------------------------------------------------------------------------

function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function findBestAnswer(label: string, qaMap: Record<string, string>): string | null {
  const norm = normalizeLabel(label);
  if (!norm) return null;

  // Pass 1: exact match (case-insensitive)
  for (const [q, a] of Object.entries(qaMap)) {
    if (normalizeLabel(q) === norm) return a;
  }

  // Pass 2: label contains a Q&A key
  for (const [q, a] of Object.entries(qaMap)) {
    if (norm.includes(normalizeLabel(q))) return a;
  }

  // Pass 3: Q&A key contains label (short labels like "Gender")
  for (const [q, a] of Object.entries(qaMap)) {
    if (normalizeLabel(q).includes(norm) && norm.length >= 3) return a;
  }

  // Pass 4: significant word overlap
  const normWords = norm.split(/\s+/).filter(w => w.length > 2);
  for (const [q, a] of Object.entries(qaMap)) {
    const qWords = normalizeLabel(q).split(/\s+/).filter(w => w.length > 2);
    const overlap = normWords.filter(w => qWords.includes(w));
    if (overlap.length >= 2 || (overlap.length >= 1 && normWords.length <= 2)) return a;
  }

  return null;
}

// ---------------------------------------------------------------------------
// GenericPlatformConfig
// ---------------------------------------------------------------------------

export class GenericPlatformConfig implements PlatformConfig {
  readonly platformId: string = 'generic';
  readonly displayName: string = 'Generic (any site)';
  readonly pageStateSchema: z.ZodType<PageState> = GenericPageStateSchema as z.ZodType<PageState>;
  readonly baseRules: string = GENERIC_BASE_RULES;
  readonly needsCustomExperienceHandler: boolean = false;
  readonly authDomains: string[] = [];

  // --- Page Detection ---

  detectPageByUrl(url: string): PageState | null {
    // Google SSO detection (universal)
    if (url.includes('accounts.google.com')) {
      if (url.includes('/pwd') || url.includes('/identifier')) {
        return { page_type: 'google_signin', page_title: 'Google Sign-In' };
      }
      if (url.includes('/challenge/')) {
        return { page_type: 'phone_2fa', page_title: 'Google Challenge (manual solve required)' };
      }
      return { page_type: 'google_signin', page_title: 'Google Sign-In' };
    }
    return null;
  }

  async detectPageByDOM(adapter: BrowserAutomationAdapter): Promise<PageState | null> {
    const signals = await adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const html = document.body.innerHTML.toLowerCase();
      return {
        hasSignInWithGoogle: bodyText.includes('sign in with google') || bodyText.includes('continue with google'),
        hasSignIn: bodyText.includes('sign in') || bodyText.includes('log in') || bodyText.includes('login'),
        hasCreateAccount: bodyText.includes('create account') || bodyText.includes('sign up') || bodyText.includes('register'),
        hasApplyButton: (bodyText.includes('apply') || bodyText.includes('apply now')) && !bodyText.includes('application questions'),
        hasSubmitApplication: bodyText.includes('submit application') || bodyText.includes('submit your application'),
        hasConfirmation: bodyText.includes('thank you') || bodyText.includes('application received') || bodyText.includes('successfully submitted'),
        hasFormInputs: document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea, select').length > 3,
      };
    });

    if (signals.hasConfirmation && !signals.hasFormInputs) {
      return { page_type: 'confirmation', page_title: 'Confirmation' };
    }

    if (signals.hasSignInWithGoogle || (signals.hasSignIn && !signals.hasApplyButton && !signals.hasFormInputs)) {
      return { page_type: 'login', page_title: 'Sign-In', has_sign_in_with_google: signals.hasSignInWithGoogle };
    }

    return null;
  }

  buildClassificationPrompt(urlHints: string[]): string {
    const urlContext = urlHints.length > 0 ? `URL context: ${urlHints.join(' ')} ` : '';
    return `${urlContext}Analyze the current page and classify it in a job application process.

CLASSIFICATION RULES (check in this order):
1. If the page has login/sign-in fields, OAuth buttons, or "Sign in with Google" → "login"
2. If the page shows a job description with an "Apply" or "Apply Now" button → "job_listing"
3. If the page asks for name, email, phone, address (personal details) → "personal_info"
4. If the page asks for resume/CV upload, work experience, education history → "experience" or "resume_upload"
5. If the page has screening questions (radio buttons, dropdowns, text answers about eligibility, availability, etc.) → "questions"
6. If the page shows a summary of the entire application with a prominent "Submit" or "Submit Application" button and NO editable fields → "review"
7. If the page shows an error message → "error"
8. If the page shows a confirmation, thank-you message, or "application received" → "confirmation"
9. If the page asks to create an account or register → "account_creation"
10. Otherwise → "unknown"

IMPORTANT: If a page has BOTH "Sign In" and "Create Account" options, classify as "login" (NOT "account_creation").`;
  }

  async classifyByDOMFallback(adapter: BrowserAutomationAdapter): Promise<PageType> {
    return adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const allText = headingText + ' ' + bodyText.substring(0, 3000);

      // Check for review page (no editable fields + submit button)
      const hasEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
      ).length > 0;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const buttonTexts = buttons.map(b => (b.textContent || '').trim().toLowerCase());
      const hasSubmitButton = buttonTexts.some(t => t === 'submit' || t === 'submit application');
      if (hasSubmitButton && !hasEditableInputs) return 'review' as PageType;

      if (allText.includes('thank you') || allText.includes('application received') || allText.includes('successfully submitted')) return 'confirmation' as PageType;
      if (allText.includes('sign in') || allText.includes('log in')) return 'login' as PageType;
      if (allText.includes('application questions') || allText.includes('screening questions')) return 'questions' as PageType;
      if (allText.includes('work experience') || allText.includes('resume') || allText.includes('upload cv')) return 'experience' as PageType;
      if (allText.includes('personal info') || allText.includes('contact info') || allText.includes('your information')) return 'personal_info' as PageType;
      return 'unknown' as PageType;
    });
  }

  // --- Form Filling ---

  buildDataPrompt(profile: Record<string, any>, qaOverrides: Record<string, string>): string {
    const parts: string[] = ['FIELD-TO-VALUE MAPPING — read each field label and fill with the matching value:'];
    parts.push('');

    // Flatten profile into field mappings
    if (profile.first_name) parts.push(`If label says "First Name" or "Given Name" → type: ${profile.first_name}`);
    if (profile.last_name) parts.push(`If label says "Last Name" or "Family Name" or "Surname" → type: ${profile.last_name}`);
    if (profile.email) parts.push(`If label says "Email" or "Email Address" → type: ${profile.email}`);
    if (profile.phone) parts.push(`If label says "Phone" or "Phone Number" or "Mobile" → type: ${profile.phone}`);

    // Address
    if (profile.address?.street || profile.street) parts.push(`If label says "Street" or "Address" or "Address Line 1" → type: ${profile.address?.street || profile.street}`);
    if (profile.address?.city || profile.city) parts.push(`If label says "City" → type: ${profile.address?.city || profile.city}`);
    if (profile.address?.state || profile.state) parts.push(`If label says "State" or "Province" → type: ${profile.address?.state || profile.state}`);
    if (profile.address?.zip || profile.zip) parts.push(`If label says "Zip" or "Postal Code" or "Zip Code" → type: ${profile.address?.zip || profile.zip}`);
    if (profile.address?.country || profile.country) parts.push(`If label says "Country" → type: ${profile.address?.country || profile.country}`);

    // Professional
    if (profile.linkedin_url) parts.push(`If label says "LinkedIn" or "LinkedIn URL" → type: ${profile.linkedin_url}`);
    if (profile.portfolio_url || profile.website_url) parts.push(`If label says "Website" or "Portfolio" → type: ${profile.portfolio_url || profile.website_url}`);
    if (profile.current_company) parts.push(`If label says "Current Company" or "Current Employer" → type: ${profile.current_company}`);
    if (profile.current_title) parts.push(`If label says "Current Title" or "Job Title" → type: ${profile.current_title}`);

    // Work authorization
    if (profile.work_authorization) parts.push(`If question about work authorization → answer: ${profile.work_authorization}`);
    if (profile.salary_expectation) parts.push(`If question about salary expectations → answer: ${profile.salary_expectation}`);
    if (profile.years_of_experience != null) parts.push(`If question about years of experience → answer: ${profile.years_of_experience}`);

    // Q&A overrides
    if (qaOverrides && Object.keys(qaOverrides).length > 0) {
      parts.push('');
      parts.push('--- SCREENING QUESTIONS ---');
      for (const [question, answer] of Object.entries(qaOverrides)) {
        parts.push(`If question asks "${question}" → answer: ${answer}`);
      }
    }

    // General rules
    parts.push('');
    parts.push('--- GENERAL RULES ---');
    parts.push('For any question not covered above, use reasonable professional defaults.');
    parts.push('For "How did you hear about us?" → answer: Company Website');
    parts.push('NEVER click Submit, Next, or any navigation button.');

    return parts.join('\n');
  }

  buildQAMap(profile: Record<string, any>, qaOverrides: Record<string, string>): Record<string, string> {
    const map: Record<string, string> = {};

    // Basic profile fields
    if (profile.first_name) map['First Name'] = profile.first_name;
    if (profile.last_name) map['Last Name'] = profile.last_name;
    if (profile.email) map['Email'] = profile.email;
    if (profile.phone) map['Phone'] = profile.phone;

    // Address
    if (profile.address?.city || profile.city) map['City'] = profile.address?.city || profile.city;
    if (profile.address?.state || profile.state) map['State'] = profile.address?.state || profile.state;
    if (profile.address?.zip || profile.zip) map['Zip Code'] = profile.address?.zip || profile.zip;
    if (profile.address?.country || profile.country) map['Country'] = profile.address?.country || profile.country;

    // Common screening questions with generic defaults
    map['Are you legally authorized to work in the United States?'] = profile.work_authorization || 'Yes';
    map['Will you now or in the future require sponsorship?'] = profile.visa_sponsorship || 'No';
    map['Are you at least 18 years of age?'] = 'Yes';
    map['How did you hear about this position?'] = 'Company Website';
    map['Are you willing to relocate?'] = 'Yes';

    // User overrides take priority
    Object.assign(map, qaOverrides);

    return map;
  }

  buildPagePrompt(pageType: PageType, dataBlock: string): string {
    const pageLabel = pageType === 'unknown' ? 'form' : pageType.replace(/_/g, ' ');

    return `${GENERIC_BASE_RULES}

You are on a "${pageLabel}" page. Fill any EMPTY form fields that are FULLY visible on screen, from TOP to BOTTOM:
${FIELD_FILL_RULES}
4. ${DROPDOWN_RULES}
5. ${CHECKBOX_RULES}

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;
  }

  // --- Programmatic DOM Helpers ---

  async fillDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    // Generic approach: find <select> elements and standard ARIA dropdowns
    const selectData = await adapter.page.evaluate(() => {
      const results: Array<{ index: number; label: string; options: string[] }> = [];
      const selects = document.querySelectorAll<HTMLSelectElement>('select');

      selects.forEach((select, i) => {
        // Skip if already filled
        if (select.value && select.selectedIndex > 0) return;
        // Skip if not visible
        const rect = select.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;

        // Find label
        let label = '';
        const labelEl = select.labels?.[0];
        if (labelEl) label = labelEl.textContent?.trim() || '';
        if (!label) label = select.getAttribute('aria-label') || '';
        if (!label) label = select.name || select.id || '';

        const options = Array.from(select.options).map(o => o.text.trim());
        results.push({ index: i, label, options });
      });

      return results;
    });

    let filled = 0;
    for (const sel of selectData) {
      const answer = findBestAnswer(sel.label, qaMap);
      if (!answer) continue;

      // Find the best matching option
      const normAnswer = normalizeLabel(answer);
      let bestOption = sel.options.find(o => normalizeLabel(o) === normAnswer);
      if (!bestOption) bestOption = sel.options.find(o => normalizeLabel(o).includes(normAnswer));
      if (!bestOption) bestOption = sel.options.find(o => normAnswer.includes(normalizeLabel(o)));

      if (bestOption) {
        await adapter.page.evaluate(
          ({ idx, value }) => {
            const selects = document.querySelectorAll<HTMLSelectElement>('select');
            const select = selects[idx];
            if (!select) return;
            const option = Array.from(select.options).find(o => o.text.trim() === value);
            if (option) {
              select.value = option.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          { idx: sel.index, value: bestOption },
        );
        filled++;
      }
    }

    return filled;
  }

  async fillDateFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
    _qaMap: Record<string, string>,
  ): Promise<number> {
    // Generic approach: find <input type="date"> elements that are empty
    return adapter.page.evaluate(() => {
      let filled = 0;
      const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
      for (const input of dateInputs) {
        if (input.value) continue;
        const rect = input.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

        // Check if this looks like a "today's date" or "signature date" field
        const label = (input.getAttribute('aria-label') || input.name || '').toLowerCase();
        if (label.includes('today') || label.includes('signature') || label.includes('current')) {
          input.value = new Date().toISOString().split('T')[0];
          input.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      }
      return filled;
    });
  }

  async checkRequiredCheckboxes(adapter: BrowserAutomationAdapter): Promise<number> {
    return adapter.page.evaluate(() => {
      let checked = 0;
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (cb.checked) continue;
        if (cb.disabled) continue;
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

        // Only check required checkboxes or ones near terms/conditions text
        const isRequired = cb.required || cb.getAttribute('aria-required') === 'true';
        const nearbyText = (cb.parentElement?.textContent || '').toLowerCase();
        const isTerms = nearbyText.includes('agree') || nearbyText.includes('acknowledge')
          || nearbyText.includes('terms') || nearbyText.includes('consent')
          || nearbyText.includes('privacy') || nearbyText.includes('certify');

        if (isRequired || isTerms) {
          cb.click();
          checked++;
        }
      }
      return checked;
    });
  }

  async hasEmptyVisibleFields(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      // Check text inputs and textareas
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        if (input.disabled || input.readOnly) continue;
        if (input.type === 'hidden') continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (input.getAttribute('aria-hidden') === 'true') continue;

        const style = window.getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        if (!input.value || input.value.trim() === '') return true;
      }

      // Check unfilled <select> elements
      const selects = document.querySelectorAll<HTMLSelectElement>('select');
      for (const select of selects) {
        if (select.disabled) continue;
        const rect = select.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (select.selectedIndex <= 0) return true;
      }

      // Check unchecked required checkboxes
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (cb.checked || cb.disabled) continue;
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (cb.required || cb.getAttribute('aria-required') === 'true') return true;
      }

      return false;
    });
  }

  async centerNextEmptyField(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea, select'
      );
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        if ((input as HTMLInputElement).disabled || (input as HTMLInputElement).readOnly) continue;
        if ((input as HTMLInputElement).type === 'hidden') continue;
        if (input.getAttribute('aria-hidden') === 'true') continue;

        const style = window.getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const isEmpty = input instanceof HTMLSelectElement
          ? input.selectedIndex <= 0
          : !input.value || input.value.trim() === '';

        if (isEmpty) {
          // Scroll so this field is centered in the viewport
          const fieldCenter = rect.top + rect.height / 2 + window.scrollY;
          const targetScroll = fieldCenter - window.innerHeight / 2;
          window.scrollTo(0, Math.max(0, targetScroll));
          return true;
        }
      }
      return false;
    });
  }

  // --- Navigation ---

  async clickNextButton(adapter: BrowserAutomationAdapter): Promise<'clicked' | 'review_detected' | 'not_found'> {
    return adapter.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
        'button, [role="button"], input[type="submit"], a.btn'
      ));

      const buttonTexts = buttons.map(b => ({
        el: b,
        text: (b.textContent || b.getAttribute('value') || '').trim().toLowerCase(),
      }));

      // Check if this is the review page (Submit button present, no Next button)
      const hasSubmit = buttonTexts.some(b => b.text === 'submit' || b.text === 'submit application');
      const hasNext = buttonTexts.some(b =>
        b.text === 'next' || b.text === 'continue' || b.text.includes('save and continue')
        || b.text.includes('save & continue')
      );

      if (hasSubmit && !hasNext) return 'review_detected' as const;

      // Try to find and click Next/Continue
      const nextButton = buttonTexts.find(b =>
        b.text === 'next' || b.text === 'continue' || b.text.includes('save and continue')
        || b.text.includes('save & continue')
      );

      if (nextButton) {
        (nextButton.el as HTMLElement).click();
        return 'clicked' as const;
      }

      return 'not_found' as const;
    });
  }

  async detectValidationErrors(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      // Look for common error patterns
      const errorPatterns = [
        'required field', 'this field is required', 'please fill', 'please enter',
        'please select', 'error', 'invalid', 'must be completed',
      ];
      // Check for visible error elements
      const errorEls = document.querySelectorAll(
        '[role="alert"], .error, .field-error, .validation-error, .form-error, [class*="error"]'
      );
      for (const el of errorEls) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && el.textContent?.trim()) return true;
      }
      return false;
    });
  }
}
