import { z } from 'zod';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import type { PlatformConfig, PageState, PageType } from './types.js';

// ---------------------------------------------------------------------------
// Base rules (generic — works for most ATS platforms)
// ---------------------------------------------------------------------------

const GENERIC_BASE_RULES = `RULES:
1. NO SCROLLING — Do NOT scroll the page. I handle all scrolling for you. The viewport has already been positioned to show the fields you need to fill. Only interact with what is currently visible on screen.
2. ONE ATTEMPT PER FIELD — Fill each field once, then move to the next. If it looks empty after you typed, trust your input was registered. Retyping causes duplicates (e.g. "WuWuWu" instead of "Wu").
3. NO PAGE NAVIGATION — Do not click "Next", "Continue", "Submit", "Save and Continue", or any button that moves to the next page/step. Do NOT click sidebar navigation links, section headers, or progress bar steps to jump to different sections — I handle all navigation between sections. ABSOLUTELY DO NOT navigate to a URL, reload the page, use the browser address bar, or use browser back/forward. Never use the browser:nav action. You MAY click buttons within the form like "Add Another", "Add Work Experience", "Add Education", "Upload", or similar buttons that add sections or expand fields on the current page.
4. TRUST FILLED FIELDS — If a field shows any text, it is already filled. Narrow fields truncate long values visually (e.g. "alexanderwgu..." for a full email address). Never click on, clear, or retype a field that already shows text.
5. SIGNAL COMPLETION — When all visible fields are filled (or none need filling), report the task as done immediately. Do not scroll looking for more fields — I will scroll for you and call you again if there are more fields below.
6. BROKEN PAGE — If the page shows raw JavaScript, source code, a blank screen, or looks completely broken, report the task as done immediately. Do NOT try to fix it, navigate away, or reload. I will handle the situation.`;

const FIELD_INTERACTION_RULES = `HOW TO FILL FIELDS:
- Text fields: Click the field, type the value from the data mapping, then click empty space to deselect.
- Dropdowns: Click to open, type your answer to filter the list (e.g. "Yes", "No", "Male"), then click the matching option. IMPORTANT: If your exact answer is not in the dropdown options, pick the CLOSEST available option (e.g. if "Company Website" is not listed, pick "Other" or "Website" or whatever is closest). Never scroll through a dropdown more than twice — if you haven't found an exact match after two scrolls, pick the best available option or "Other".
- Radio buttons: Click the correct option that matches the data mapping. If the answer is "Yes", click the "Yes" radio button.
- Required checkboxes (terms, agreements, "I acknowledge..."): Click to check them.
- Skip any field that already shows text, a selected value, or a checked state — even if the text looks truncated.
- OPTIONAL FIELDS: Not every empty field needs to be filled. If a field has no matching value in the data mapping (e.g., Address Line 2 with no apartment number, Middle Name, Suffix), leave it empty and move on. Only fill fields that have a clear match in the data mapping.
- If a question is not covered by the data mapping and you are unsure of the answer, skip it rather than guessing.
- NEVER get stuck on one field. If you have tried twice and cannot get the right value into a field, pick the closest available option or skip it and move on.`;

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

/**
 * Derive a standard education level from a degree string.
 * Maps free-text degree names to dropdown-friendly labels.
 */
function deriveEducationLevel(degree: string): string {
  const d = degree.toLowerCase();
  if (d.includes('phd') || d.includes('doctorate') || d.includes('doctor of')) return "Doctorate";
  if (d.includes('master') || d === 'mba' || d === 'ms' || d === 'ma' || d === 'msc') return "Master's Degree";
  if (d.includes('bachelor') || d === 'bs' || d === 'ba' || d === 'bsc') return "Bachelor's Degree";
  if (d.includes('associate')) return "Associate's Degree";
  if (d.includes('high school') || d.includes('ged') || d.includes('diploma')) return "High School or Equivalent";
  if (d.includes('certificate') || d.includes('certification')) return "Professional Certificate";
  return degree; // Pass through as-is if no match
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

    // If page has form inputs and none of the special types matched above,
    // classify as a form page. This avoids the ~2,050 token LLM classification
    // call for obvious form pages. All form types (personal_info, questions,
    // experience) go through the same fillWithSmartScroll path on generic sites.
    if (signals.hasFormInputs) {
      return { page_type: 'questions', page_title: 'Form Page' };
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
6. REVIEW PAGE — classify as "review" ONLY if ALL of these are true: (a) the page shows a READ-ONLY summary of your entire application (all your previously entered data displayed as non-editable text), (b) there is a prominent "Submit" or "Submit Application" button, and (c) there are truly NO fillable form fields on the page. A page that has a Submit button but ALSO has form fields, input boxes, dropdowns, or sections still to fill is NOT a review page — classify it based on what needs to be filled.
7. If the page shows an error message → "error"
8. If the page shows a confirmation, thank-you message, or "application received" → "confirmation"
9. If the page asks to create an account or register → "account_creation"
10. Otherwise → "unknown"

IMPORTANT: If a page has BOTH "Sign In" and "Create Account" options, classify as "login" (NOT "account_creation").
IMPORTANT: Many job sites show a "Submit" button on EVERY page — this does NOT mean you are on the review page. Only classify as "review" if the page is purely a read-only summary with no fields to fill.`;
  }

  async classifyByDOMFallback(adapter: BrowserAutomationAdapter): Promise<PageType> {
    return adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const allText = headingText + ' ' + bodyText.substring(0, 3000);

      // Check for review page — must check ENTIRE page DOM (not just viewport)
      // to avoid false positives on single-page forms where fields are below the fold
      const allEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), select:not([disabled])'
      );
      const hasAnyEditableInputs = allEditableInputs.length > 0;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const buttonTexts = buttons.map(b => (b.textContent || '').trim().toLowerCase());
      const hasSubmitButton = buttonTexts.some(t => t === 'submit' || t === 'submit application');
      const hasNextButton = buttonTexts.some(t => t === 'next' || t === 'continue' || t.includes('save and continue'));
      // Only classify as review if: submit button exists, NO editable inputs anywhere on page, and no "next" button
      if (hasSubmitButton && !hasAnyEditableInputs && !hasNextButton) return 'review' as PageType;

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
    const lines: string[] = ['DATA MAPPING:'];

    // Personal info
    if (profile.first_name) lines.push(`- First Name / Given Name: ${profile.first_name}`);
    if (profile.last_name) lines.push(`- Last Name / Family Name / Surname: ${profile.last_name}`);
    if (profile.email) lines.push(`- Email / Email Address: ${profile.email}`);
    if (profile.phone) lines.push(`- Phone / Phone Number / Mobile: ${profile.phone}`);

    // Address
    const addr = profile.address || {};
    if (addr.street || profile.street) lines.push(`- Street / Address / Address Line 1: ${addr.street || profile.street}`);
    const addrLine2 = addr.line2 || addr.address_line_2 || profile.address_line_2 || '';
    if (addrLine2) lines.push(`- Address Line 2 / Apt / Suite: ${addrLine2}`);
    if (addr.city || profile.city) lines.push(`- City: ${addr.city || profile.city}`);
    if (addr.state || profile.state) lines.push(`- State / Province: ${addr.state || profile.state}`);
    if (addr.zip || profile.zip) lines.push(`- Zip / Postal Code / ZIP Code: ${addr.zip || profile.zip}`);
    if (addr.country || profile.country) lines.push(`- Country: ${addr.country || profile.country}`);

    // Professional
    if (profile.linkedin_url) lines.push(`- LinkedIn / LinkedIn URL: ${profile.linkedin_url}`);
    if (profile.portfolio_url || profile.website_url) lines.push(`- Website / Portfolio: ${profile.portfolio_url || profile.website_url}`);
    if (profile.current_company) lines.push(`- Current Company / Employer: ${profile.current_company}`);
    if (profile.current_title) lines.push(`- Current Title / Job Title: ${profile.current_title}`);

    // Work authorization
    if (profile.work_authorization) lines.push(`- Work authorization: ${profile.work_authorization}`);
    if (profile.salary_expectation) lines.push(`- Salary expectations: ${profile.salary_expectation}`);
    if (profile.years_of_experience != null) lines.push(`- Years of experience: ${profile.years_of_experience}`);

    // Education
    const educationArr = profile.education || profile.work_history_education || [];
    if (Array.isArray(educationArr) && educationArr.length > 0) {
      const edu = educationArr[0]; // Primary education entry
      const degree = edu.degree || edu.level || '';
      const school = edu.school || edu.institution || '';
      const field = edu.field_of_study || edu.field || edu.major || '';
      const gradYear = edu.graduation_year || edu.end_date || '';

      // Derive education level from degree string
      const educationLevel = deriveEducationLevel(degree);
      if (educationLevel) lines.push(`- Education Level / Highest Degree: ${educationLevel}`);
      if (degree) lines.push(`- Degree: ${degree}`);
      if (school) lines.push(`- School / University / Institution: ${school}`);
      if (field) lines.push(`- Field of Study / Major: ${field}`);
      if (gradYear) lines.push(`- Graduation Year: ${gradYear}`);
    }

    // Work experience
    const experienceArr = profile.experience || profile.work_history || [];
    if (Array.isArray(experienceArr) && experienceArr.length > 0) {
      lines.push('');
      lines.push('WORK EXPERIENCE:');
      for (const exp of experienceArr) {
        const company = exp.company || '';
        const title = exp.title || '';
        const location = exp.location || '';
        const startDate = exp.start_date || '';
        const endDate = exp.currently_work_here ? 'Present' : (exp.end_date || '');
        const desc = exp.description || '';
        lines.push(`- ${title} at ${company}${location ? ` (${location})` : ''}, ${startDate}–${endDate}`);
        if (desc) lines.push(`  Description: ${desc}`);
      }
    }

    // Skills
    const skills = profile.skills || [];
    if (Array.isArray(skills) && skills.length > 0) {
      lines.push(`- Skills: ${skills.join(', ')}`);
    }

    // Voluntary self-identification
    if (profile.gender) lines.push(`- Gender: ${profile.gender}`);
    if (profile.race_ethnicity) lines.push(`- Race / Ethnicity: ${profile.race_ethnicity}`);
    if (profile.veteran_status) lines.push(`- Veteran Status: ${profile.veteran_status}`);
    if (profile.disability_status) lines.push(`- Disability Status: ${profile.disability_status}`);

    // Q&A overrides
    if (qaOverrides && Object.keys(qaOverrides).length > 0) {
      lines.push('');
      lines.push('SCREENING QUESTIONS:');
      for (const [question, answer] of Object.entries(qaOverrides)) {
        lines.push(`- "${question}" → ${answer}`);
      }
    }

    // Defaults
    lines.push('');
    lines.push('DEFAULTS:');
    lines.push('- "How did you hear about us?" → Other');
    lines.push('- For unknown questions not listed above, skip the field rather than guessing.');

    return lines.join('\n');
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

    // Education
    const eduArr = profile.education || [];
    if (Array.isArray(eduArr) && eduArr.length > 0) {
      const edu = eduArr[0];
      const degree = edu.degree || edu.level || '';
      if (degree) {
        const level = deriveEducationLevel(degree);
        map['Education Level'] = level;
        map['Highest Degree'] = level;
        map['Degree'] = degree;
      }
      const school = edu.school || edu.institution || '';
      if (school) {
        map['School'] = school;
        map['University'] = school;
        map['Institution'] = school;
      }
      const field = edu.field_of_study || edu.field || edu.major || '';
      if (field) {
        map['Field of Study'] = field;
        map['Major'] = field;
      }
    }

    // Common screening questions with generic defaults
    map['Are you legally authorized to work in the United States?'] = profile.work_authorization || 'Yes';
    map['Will you now or in the future require sponsorship?'] = profile.visa_sponsorship || 'No';
    map['Are you at least 18 years of age?'] = 'Yes';
    map['How did you hear about this position?'] = 'Other';
    map['Are you willing to relocate?'] = 'Yes';

    // User overrides take priority
    Object.assign(map, qaOverrides);

    return map;
  }

  buildPagePrompt(_pageType: PageType, dataBlock: string): string {
    return `${GENERIC_BASE_RULES}

${FIELD_INTERACTION_RULES}

TASK: Fill any empty form fields visible on screen, working top to bottom. Use the data mapping below to find the right answer for each field. If all fields are already filled or there are no fields that match the data mapping, report the task as done immediately.

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
              // Use the NATIVE value setter to bypass React's override on the value property.
              // React intercepts `select.value = x` via a custom setter. If we use it directly,
              // React's internal state is NOT updated and the value reverts on the next re-render.
              // The native setter writes directly to the DOM, then the dispatched events propagate
              // through React's event delegation so React picks up the change.
              const nativeSetter = Object.getOwnPropertyDescriptor(
                HTMLSelectElement.prototype, 'value'
              )?.set;
              if (nativeSetter) {
                nativeSetter.call(select, option.value);
              } else {
                select.value = option.value;
              }
              select.dispatchEvent(new Event('input', { bubbles: true }));
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
          // Use the NATIVE value setter so React picks up the change
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value'
          )?.set;
          const newValue = new Date().toISOString().split('T')[0];
          if (nativeSetter) {
            nativeSetter.call(input, newValue);
          } else {
            input.value = newValue;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
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

      // Check radio button groups where none is selected
      const radioGroups = new Map<string, boolean>();
      const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]:not([disabled])');
      for (const radio of radios) {
        const name = radio.name;
        if (!name) continue;
        const rect = radio.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (!radioGroups.has(name)) radioGroups.set(name, false);
        if (radio.checked) radioGroups.set(name, true);
      }
      for (const [, hasSelection] of radioGroups) {
        if (!hasSelection) return true; // Found a visible radio group with no selection
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
    // NOTE: Do NOT define named functions (const fn = ...) inside page.evaluate —
    // esbuild's --keep-names injects __name() wrappers that don't exist in the browser context.
    return adapter.page.evaluate(() => {
      const NEXT_TEXTS = ['next', 'continue', 'proceed', 'review application', 'review my application', 'go to next step', 'next step'];
      const NEXT_INCLUDES = ['save and continue', 'save & continue', 'skip and continue', 'skip & continue'];

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
        NEXT_TEXTS.indexOf(b.text) !== -1 || NEXT_INCLUDES.some(s => b.text.indexOf(s) !== -1)
      );

      if (hasSubmit && !hasNext) return 'review_detected' as const;

      // Try to find and click Next/Continue (priority order: exact matches first)
      const nextButton = buttonTexts.find(b =>
        NEXT_TEXTS.indexOf(b.text) !== -1 || NEXT_INCLUDES.some(s => b.text.indexOf(s) !== -1)
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
      // Strategy: Only detect REAL validation errors by checking for visible elements
      // whose text content contains actual error language. Avoid false positives from
      // React error boundaries, hidden error containers, or generic class names.

      const ERROR_TEXT_PATTERNS = [
        'required', 'this field is required', 'please fill', 'please enter',
        'please select', 'invalid', 'must be completed', 'cannot be blank',
        'is not valid', 'must provide', 'missing required',
      ];

      // Check specific error role elements and common error CSS classes
      // NOTE: Intentionally NOT using [class*="error"] — it matches React internals,
      // error boundary wrappers, and other false positives on SPAs like Amazon.jobs.
      const errorEls = document.querySelectorAll(
        '[role="alert"], .field-error, .validation-error, .form-error, .input-error, .error-message'
      );
      for (const el of errorEls) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim().toLowerCase();
        if (!text || text.length > 500) continue; // Skip empty or suspiciously large elements
        // Must contain actual error language
        if (ERROR_TEXT_PATTERNS.some(p => text.includes(p))) return true;
      }

      // Also check for red-bordered inputs (common validation indicator)
      const inputs = document.querySelectorAll('input, select, textarea');
      for (const input of inputs) {
        const rect = (input as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const style = window.getComputedStyle(input as HTMLElement);
        // Check for red border (common error indicator)
        const borderColor = style.borderColor;
        if (borderColor && (borderColor.includes('rgb(255, 0') || borderColor.includes('rgb(220, 53') || borderColor.includes('rgb(239, 68'))) {
          // Only count if the input also has aria-invalid
          if ((input as HTMLElement).getAttribute('aria-invalid') === 'true') return true;
        }
      }

      return false;
    });
  }
}
