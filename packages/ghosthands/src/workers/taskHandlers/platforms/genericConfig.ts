import { z } from 'zod';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import type { PlatformConfig, PageState, PageType } from './types.js';

// ---------------------------------------------------------------------------
// Base rules (generic — works for most ATS platforms)
// ---------------------------------------------------------------------------

const GENERIC_BASE_RULES = `YOUR ROLE: You are a form-filling assistant. Your ONLY job is to type data into the empty fields currently visible on screen. Nothing else. A separate system handles scrolling, page navigation, and detecting new fields. You NEVER need to worry about what is off-screen or on the next page.

RULES:
1. FILL empty fields CURRENTLY VISIBLE on screen using the data below. Work top to bottom.
2. SKIP fields that already have text or a selection.
3. SKIP fields that have no matching data (e.g. Middle Name, Address Line 2) — do NOT try to find them or navigate to them.
4. You MAY click dropdowns, radio buttons, checkboxes, "Add Another", "Upload", and other form controls to fill fields.
5. DO NOT click Next, Continue, Submit, Save, or any navigation button. Another system handles that.
6. DO NOT scroll, press Tab to navigate, or try to discover more fields. Another system handles that.
7. DO NOT navigate to a URL, reload the page, or use the address bar.
8. When every visible empty field is filled (or has no matching data), IMMEDIATELY report done. Do not look for more fields.`;

const FIELD_INTERACTION_RULES = `HOW TO FILL:
- Text fields: Click, type the value, click away to deselect.
- Dropdowns: Click to open, type to filter, click the match. If no exact match, pick the closest option.
- Radio buttons: Click the matching option.
- Required checkboxes (terms, agreements): Check them.
- If a field has no match in the data mapping (e.g. Middle Name, Address Line 2), skip it.
- If stuck on a field after two tries, skip it and move on.`;

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

      // Scan ALL clickable elements — buttons, links, role="button", submit inputs
      const clickables = Array.from(document.querySelectorAll(
        'button, [role="button"], input[type="submit"], a[href], a[role="link"]'
      ));
      const clickableTexts = clickables.map(el => {
        const raw = (el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '').trim();
        // Collapse whitespace and take first 60 chars to avoid grabbing entire paragraphs from links
        return raw.replace(/\s+/g, ' ').substring(0, 60).toLowerCase();
      });

      // Apply button
      const hasApplyButton = clickableTexts.some(t =>
        t === 'apply' || t === 'apply now' || t === 'apply for this job' ||
        t === 'apply on company site' || t === 'apply to this job'
      );

      // Sign-in detection — check clickable elements AND form fields
      const hasPasswordField = document.querySelectorAll('input[type="password"]').length > 0;
      const hasEmailField = document.querySelectorAll('input[type="email"]').length > 0;
      const hasSignInWithGoogle = bodyText.includes('sign in with google') || bodyText.includes('continue with google');
      const hasSignInClickable = clickableTexts.some(t =>
        t === 'sign in' || t === 'log in' || t === 'login' ||
        t === 'sign in with google' || t === 'continue with google'
      );

      // A page is login-related if it has sign-in form fields OR a sign-in button/link
      const isLoginPage = hasPasswordField || hasSignInWithGoogle ||
        (hasEmailField && hasSignInClickable) || hasSignInClickable;

      const hasFormInputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea, select').length > 3;
      const hasConfirmation = bodyText.includes('thank you') || bodyText.includes('application received') || bodyText.includes('successfully submitted');

      return { hasApplyButton, isLoginPage, hasSignInClickable, hasSignInWithGoogle, hasFormInputs, hasConfirmation };
    });

    if (signals.hasConfirmation && !signals.hasFormInputs) {
      return { page_type: 'confirmation', page_title: 'Confirmation' };
    }

    // Job listing: has an Apply button and no form fields → user needs to click Apply
    if (signals.hasApplyButton && !signals.hasFormInputs) {
      return { page_type: 'job_listing', page_title: 'Job Listing', has_apply_button: true };
    }

    // Login: has sign-in button/link (even without form fields — the form may be on the next page)
    if (signals.isLoginPage && !signals.hasApplyButton) {
      return { page_type: 'login', page_title: 'Sign-In', has_sign_in_with_google: signals.hasSignInWithGoogle };
    }

    // Form page: has multiple input fields → skip the expensive LLM classification
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

      const allEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), select:not([disabled])'
      );
      const hasAnyEditableInputs = allEditableInputs.length > 0;

      // Scan ALL clickable elements — buttons, links, role="button", submit inputs
      const clickables = Array.from(document.querySelectorAll(
        'button, [role="button"], input[type="submit"], a[href], a[role="link"]'
      ));
      const clickableTexts = clickables.map(el => {
        const raw = (el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '').trim();
        return raw.replace(/\s+/g, ' ').substring(0, 60).toLowerCase();
      });

      const hasSubmitButton = clickableTexts.some(t => t === 'submit' || t === 'submit application');
      const hasNextButton = clickableTexts.some(t => t === 'next' || t === 'continue' || t.includes('save and continue'));
      const hasApplyButton = clickableTexts.some(t =>
        t === 'apply' || t === 'apply now' || t === 'apply for this job' ||
        t === 'apply on company site' || t === 'apply to this job'
      );
      const hasPasswordField = document.querySelectorAll('input[type="password"]').length > 0;
      const hasSignInClickable = clickableTexts.some(t =>
        t === 'sign in' || t === 'log in' || t === 'login' || t === 'sign in with google'
      );

      // Review: submit button, no editable inputs, no next button
      if (hasSubmitButton && !hasAnyEditableInputs && !hasNextButton) return 'review' as PageType;

      if (allText.includes('thank you') || allText.includes('application received') || allText.includes('successfully submitted')) return 'confirmation' as PageType;

      // Job listing: has an Apply button
      if (hasApplyButton) return 'job_listing' as PageType;

      // Login: has a sign-in button/link or password field
      if (hasPasswordField || hasSignInClickable) return 'login' as PageType;

      // Form pages with editable inputs
      if (hasAnyEditableInputs) {
        if (allText.includes('application questions') || allText.includes('screening questions')) return 'questions' as PageType;
        if (allText.includes('work experience') || allText.includes('resume') || allText.includes('upload cv')) return 'experience' as PageType;
        if (allText.includes('personal info') || allText.includes('contact info') || allText.includes('your information')) return 'personal_info' as PageType;
        return 'questions' as PageType; // Default form page
      }

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

  // --- Navigation ---

  async clickNextButton(adapter: BrowserAutomationAdapter): Promise<'clicked' | 'review_detected' | 'not_found'> {
    // NOTE: Do NOT define named functions (const fn = ...) inside page.evaluate —
    // esbuild's --keep-names injects __name() wrappers that don't exist in the browser context.
    return adapter.page.evaluate(() => {
      const NEXT_TEXTS = ['next', 'continue', 'proceed', 'review application', 'review my application', 'go to next step', 'next step'];
      const NEXT_INCLUDES = ['save and continue', 'save & continue', 'skip and continue', 'skip & continue', 'submit profile', 'submit and continue', 'submit & continue'];

      const vh = window.innerHeight;
      const allButtons = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
        'button, [role="button"], input[type="submit"], a.btn'
      ));

      const allButtonTexts = allButtons.map(b => {
        const rect = b.getBoundingClientRect();
        return {
          el: b,
          text: (b.textContent || b.getAttribute('value') || '').trim().toLowerCase(),
          visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh,
        };
      });

      // Review detection scans ALL buttons (page-wide) — a Submit button anywhere
      // with no Next button anywhere means this is the review page.
      const hasSubmit = allButtonTexts.some(b => b.text === 'submit' || b.text === 'submit application');
      const hasNext = allButtonTexts.some(b =>
        NEXT_TEXTS.indexOf(b.text) !== -1 || NEXT_INCLUDES.some(s => b.text.indexOf(s) !== -1)
      );

      if (hasSubmit && !hasNext) return 'review_detected' as const;

      // Only click buttons that are visible in the current viewport.
      // If the Next button is below the fold, the orchestrator will scroll to it.
      const visibleNext = allButtonTexts.find(b =>
        b.visible && (NEXT_TEXTS.indexOf(b.text) !== -1 || NEXT_INCLUDES.some(s => b.text.indexOf(s) !== -1))
      );

      if (visibleNext) {
        (visibleNext.el as HTMLElement).click();
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
