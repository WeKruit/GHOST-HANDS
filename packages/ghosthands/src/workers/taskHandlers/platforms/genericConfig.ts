import { z } from 'zod';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import type { PlatformConfig, PageState, PageType, ScannedField, ScanResult } from './types.js';

// ---------------------------------------------------------------------------
// Base rules (generic — works for most ATS platforms)
// ---------------------------------------------------------------------------

const GENERIC_BASE_RULES = `YOUR ROLE: You are a form-filling assistant. You can ONLY see what is currently on screen. You have NO ability to reveal more content. Scrolling happens ONLY after you report done — reporting done IS the trigger for scrolling.

RULES — follow in strict order:

1. Work strictly TOP TO BOTTOM. Start with the TOPMOST unanswered field and fill it. Then move to the next one below it. Do NOT skip ahead.

2. FILL every empty field that is 100% FULLY VISIBLE on screen using the data below.

3. SKIP fields that already have text, a selection, or a checked checkbox. NEVER uncheck a checkbox that is already checked. NEVER clear a field that already has a value.

4. SKIP fields with no matching data (e.g. Middle Name, Address Line 2).

5. CRITICAL — CUT-OFF DETECTION: Before answering ANY question near the bottom half of the screen, ask yourself: "Can I see the COMPLETE question text AND every single answer option?" If the answer is no — or if an expected answer choice (like "No" or "Yes") is missing — the question is CUT OFF. DO NOT TOUCH IT.
   How to tell a question is cut off:
   - The question is near the bottom of the screen
   - You can see some answer choices but not all (e.g. you see "Yes" but not "No")
   - The answer you need to select is not visible even though it should obviously exist
   - The question text runs off the bottom edge
   If ANY of these are true: DO NOT interact with the question. Just report done. The scroller will bring it fully into view and you will answer it next time.

6. You MAY click dropdowns, radio buttons, checkboxes, "Add Another", "Upload", and other form controls — but ONLY for questions that are 100% fully visible.

7. NEVER click any button that says Next, Continue, Submit, Submit Application, Save, Send, or similar. You are ONLY here to fill fields — NEVER to submit or advance the application. If you see a review/summary page, report done immediately.

8. Before reporting done, mentally scan from the TOP of the screen to the BOTTOM: did you answer every FULLY VISIBLE question? If you missed any, go back and answer it NOW.

9. When all fully visible questions are handled, IMMEDIATELY report done. Do NOT use the wait action. Reporting done is how you tell the system to scroll.`;

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

export function findBestAnswer(label: string, qaMap: Record<string, string>): string | null {
  const norm = normalizeLabel(label);
  if (!norm) return null;

  // Pass 1: exact match (case-insensitive)
  for (const [q, a] of Object.entries(qaMap)) {
    if (normalizeLabel(q) === norm) return a;
  }

  // Pass 2: label contains a Q&A key (e.g. label="First Name *" contains key="First Name")
  for (const [q, a] of Object.entries(qaMap)) {
    const normQ = normalizeLabel(q);
    if (normQ.length >= 3 && norm.includes(normQ)) return a;
  }

  // Pass 3: Q&A key contains label (short labels like "Gender")
  for (const [q, a] of Object.entries(qaMap)) {
    if (normalizeLabel(q).includes(norm) && norm.length >= 3) return a;
  }

  // Pass 4: significant word overlap — but only if ALL distinguishing words in the
  // label also appear in the key. This prevents "Middle Name" matching "First Name"
  // just because they share the word "Name".
  const normWords = norm.split(/\s+/).filter(w => w.length > 2);
  if (normWords.length === 0) return null;

  // Generic/common words that shouldn't count as distinguishing
  const GENERIC_WORDS = new Set(['name', 'number', 'address', 'date', 'line', 'code', 'url', 'type', 'level', 'status', 'field', 'info', 'the', 'your', 'please', 'enter', 'select', 'provide']);

  // Find distinguishing words in the label (words that are NOT generic)
  const distinguishingWords = normWords.filter(w => !GENERIC_WORDS.has(w));

  for (const [q, a] of Object.entries(qaMap)) {
    const qWords = normalizeLabel(q).split(/\s+/).filter(w => w.length > 2);
    const overlap = normWords.filter(w => qWords.includes(w));

    // If label has distinguishing words, ALL of them must appear in the key
    if (distinguishingWords.length > 0) {
      const distinguishingOverlap = distinguishingWords.filter(w => qWords.includes(w));
      if (distinguishingOverlap.length === distinguishingWords.length && overlap.length >= 2) {
        return a;
      }
    } else if (overlap.length >= 2) {
      // All words are generic — require at least 2 word overlap
      return a;
    }
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
        return raw.replace(/\s+/g, ' ').substring(0, 60).toLowerCase();
      });

      // Apply button
      const hasApplyButton = clickableTexts.some(t =>
        t === 'apply' || t === 'apply now' || t === 'apply for this job' ||
        t === 'apply on company site' || t === 'apply to this job'
      );

      // Submit button (distinct from Apply — means "submit this application")
      const hasSubmitButton = clickableTexts.some(t =>
        t === 'submit' || t === 'submit application' || t === 'submit my application'
      );

      // Review page signals — text that indicates this is a review/summary page
      const hasReviewSignals = bodyText.includes('review your application')
        || bodyText.includes('review & apply') || bodyText.includes('review and apply')
        || bodyText.includes('review application') || bodyText.includes('application summary')
        || bodyText.includes('review & submit') || bodyText.includes('review and submit');

      // Job description signals — text that indicates this is a job listing, not a form
      const hasJobDescription = bodyText.includes('job description') || bodyText.includes('responsibilities')
        || bodyText.includes('qualifications') || bodyText.includes('about the role')
        || bodyText.includes('about this job') || bodyText.includes('what you\'ll do');

      // Sign-in detection
      const hasPasswordField = document.querySelectorAll('input[type="password"]').length > 0;
      const hasEmailField = document.querySelectorAll('input[type="email"]').length > 0;
      const hasSignInWithGoogle = bodyText.includes('sign in with google') || bodyText.includes('continue with google');
      const hasSignInClickable = clickableTexts.some(t =>
        t === 'sign in' || t === 'log in' || t === 'login' ||
        t === 'sign in with google' || t === 'continue with google'
      );
      const isLoginPage = hasPasswordField || hasSignInWithGoogle ||
        (hasEmailField && hasSignInClickable) || hasSignInClickable;

      // Native inputs + ARIA-based form controls
      const hasFormInputs = document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], textarea, select, [role="combobox"], [role="radiogroup"], [role="radio"]:not([aria-checked="true"]), [role="listbox"], [contenteditable="true"], input[type="file"]'
      ).length > 2;

      const hasConfirmation = bodyText.includes('thank you') || bodyText.includes('application received') || bodyText.includes('successfully submitted');

      return { hasApplyButton, hasSubmitButton, hasReviewSignals, hasJobDescription, isLoginPage, hasSignInClickable, hasSignInWithGoogle, hasFormInputs, hasConfirmation };
    });

    if (signals.hasConfirmation && !signals.hasFormInputs) {
      return { page_type: 'confirmation', page_title: 'Confirmation' };
    }

    // Review page: has review signals — MUST check before Apply button since
    // review pages often have an "Apply" button that means "submit"
    if (signals.hasReviewSignals) {
      return { page_type: 'review', page_title: 'Review' };
    }

    // Job listing: has an Apply button AND looks like a job posting (description text
    // or no form fields). NOT a review page (checked above).
    if (signals.hasApplyButton && (signals.hasJobDescription || !signals.hasFormInputs)) {
      return { page_type: 'job_listing', page_title: 'Job Listing', has_apply_button: true };
    }

    // Login: has sign-in button/link
    if (signals.isLoginPage) {
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

      // Native inputs + ARIA-based form controls (Google Careers, Workday, etc.)
      const allEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), select:not([disabled]), [role="combobox"], [role="listbox"], [role="radiogroup"], [role="radio"], [contenteditable="true"], input[type="file"]'
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

    // Basic profile fields (include common label variations for DOM text fill)
    if (profile.first_name) {
      map['First Name'] = profile.first_name;
      map['Given Name'] = profile.first_name;
    }
    if (profile.last_name) {
      map['Last Name'] = profile.last_name;
      map['Family Name'] = profile.last_name;
      map['Surname'] = profile.last_name;
    }
    if (profile.email) {
      map['Email'] = profile.email;
      map['Email Address'] = profile.email;
    }
    if (profile.phone) {
      map['Phone'] = profile.phone;
      map['Phone Number'] = profile.phone;
      map['Mobile'] = profile.phone;
    }

    // Address
    const addr = profile.address || {};
    if (addr.street || profile.street) {
      const street = addr.street || profile.street;
      map['Street'] = street;
      map['Address'] = street;
      map['Address Line 1'] = street;
    }
    if (profile.address?.city || profile.city) map['City'] = profile.address?.city || profile.city;
    if (profile.address?.state || profile.state) map['State'] = profile.address?.state || profile.state;
    if (profile.address?.zip || profile.zip) {
      const zip = profile.address?.zip || profile.zip;
      map['Zip Code'] = zip;
      map['Zip'] = zip;
      map['Postal Code'] = zip;
    }
    if (profile.address?.country || profile.country) map['Country'] = profile.address?.country || profile.country;

    // Professional
    if (profile.linkedin_url) {
      map['LinkedIn'] = profile.linkedin_url;
      map['LinkedIn URL'] = profile.linkedin_url;
    }
    if (profile.portfolio_url || profile.website_url) {
      map['Website'] = profile.portfolio_url || profile.website_url;
      map['Portfolio'] = profile.portfolio_url || profile.website_url;
    }
    if (profile.current_company) {
      map['Current Company'] = profile.current_company;
      map['Employer'] = profile.current_company;
      map['Company'] = profile.current_company;
    }
    if (profile.current_title) {
      map['Current Title'] = profile.current_title;
      map['Job Title'] = profile.current_title;
    }

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

  // --- Scan-First Field Discovery ---

  async scanPageFields(adapter: BrowserAutomationAdapter): Promise<ScanResult> {
    // Shim esbuild's __name helper in the browser context.
    // esbuild's --keep-names wraps const arrow functions with __name() which doesn't
    // exist in the browser. Defining it globally once covers all page.evaluate calls.
    await adapter.page.evaluate('if(typeof __name==="undefined"){window.__name=function(f){return f}}');

    // Clean stale scan attributes from any previous scan cycle to avoid selector collisions
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-scan-idx]').forEach(el => el.removeAttribute('data-gh-scan-idx'));
    });

    const viewportHeight = await adapter.page.evaluate(() => window.innerHeight);
    const scrollHeight = await adapter.page.evaluate(() => document.documentElement.scrollHeight);

    // Scroll to top
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    const allFields: ScannedField[] = [];
    const seenSelectors = new Set<string>();
    let nextIdx = 0;

    // Scroll through page in 70% viewport steps (overlap catches fields at edges)
    let currentScroll = 0;
    const maxScroll = Math.max(0, scrollHeight - viewportHeight);
    const maxSteps = 15;
    let steps = 0;

    while (steps < maxSteps) {
      const rawFields = await this.collectVisibleFields(adapter, nextIdx);

      for (const field of rawFields) {
        if (!seenSelectors.has(field.selector)) {
          seenSelectors.add(field.selector);
          allFields.push(field);
          nextIdx++;
        }
      }

      if (currentScroll >= maxScroll) break;

      const nextScroll = Math.min(currentScroll + Math.round(viewportHeight * 0.7), maxScroll);
      await adapter.page.evaluate((y: number) => window.scrollTo(0, y), nextScroll);
      await adapter.page.waitForTimeout(400);
      currentScroll = nextScroll;
      steps++;
    }

    // Scroll back to top
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(300);

    // Sort by page position (top to bottom)
    allFields.sort((a, b) => a.absoluteY - b.absoluteY);

    console.log(`[GenericConfig] Scan complete: ${allFields.length} field(s) found across ${steps + 1} viewport(s)`);
    return { fields: allFields, scrollHeight, viewportHeight };
  }

  /**
   * Collect all form fields visible in the current viewport.
   * Runs inside page.evaluate — all logic must be browser-compatible.
   */
  private async collectVisibleFields(
    adapter: BrowserAutomationAdapter,
    startIdx: number,
  ): Promise<ScannedField[]> {
    return adapter.page.evaluate((startIdxArg: number) => {
      const vh = window.innerHeight;
      const scrollY = window.scrollY;
      const fields: any[] = [];
      let idx = startIdxArg;

      // --- Label extraction helper (8 strategies) ---
      const extractLabel = (el: Element): string => {
        let label = '';
        const htmlEl = el as HTMLInputElement;

        // 1. Associated <label> element
        if ('labels' in htmlEl && htmlEl.labels?.length) {
          label = (htmlEl.labels[0].textContent || '').trim();
        }
        // 2. aria-label
        if (!label) label = el.getAttribute('aria-label') || '';
        // 3. aria-labelledby
        if (!label) {
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) label = (labelEl.textContent || '').trim();
          }
        }
        // 4. Placeholder
        if (!label) label = el.getAttribute('placeholder') || '';
        // 5. label[for] matching id
        if (!label && htmlEl.id) {
          const forLabel = document.querySelector('label[for="' + CSS.escape(htmlEl.id) + '"]');
          if (forLabel) label = (forLabel.textContent || '').trim();
        }
        // 6. Parent container label
        if (!label) {
          const parent = el.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset, [class*="input"]');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(el)) label = (lbl.textContent || '').trim();
          }
        }
        // 7. Preceding sibling
        if (!label) {
          const prev = el.previousElementSibling;
          if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
            const t = (prev.textContent || '').trim();
            if (t.length < 80) label = t;
          }
        }
        // 8. name or id fallback
        if (!label) label = htmlEl.name || htmlEl.id || '';

        return label.substring(0, 120);
      };

      // --- Visibility check helper ---
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) return false;
        if (rect.bottom < 0 || rect.top > vh) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        return true;
      };

      // --- Build stable CSS selector ---
      const buildSelector = (el: Element, scanIdx: number): string => {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId + '"]';
        const autoId = el.getAttribute('data-automation-id');
        if (autoId) return '[data-automation-id="' + autoId + '"]';
        // Reuse existing scan attribute if element was already tagged (prevents
        // duplicate selectors when the same element is visible across scroll steps)
        const existingIdx = el.getAttribute('data-gh-scan-idx');
        if (existingIdx) return '[data-gh-scan-idx="' + existingIdx + '"]';
        el.setAttribute('data-gh-scan-idx', String(scanIdx));
        return '[data-gh-scan-idx="' + scanIdx + '"]';
      };

      // --- Check if element is inside a disabled fieldset ---
      const isInsideDisabledFieldset = (el: Element): boolean => {
        const fs = el.closest('fieldset');
        return fs !== null && (fs as HTMLFieldSetElement).disabled;
      };

      const isRequired = (el: Element): boolean => {
        return (el as HTMLInputElement).required
          || el.getAttribute('aria-required') === 'true'
          || (el.closest('[class*="required"]') !== null);
      };

      // ── 1. Text inputs + textareas ──
      const textInputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );
      for (const input of textInputs) {
        if (input.disabled || (input as HTMLInputElement).readOnly) continue;
        if ((input as HTMLInputElement).type === 'hidden') continue;
        if (!isVisible(input)) continue;
        if (isInsideDisabledFieldset(input)) continue;
        const rect = input.getBoundingClientRect();
        const sel = buildSelector(input, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'text',
          fillStrategy: 'native_setter',
          selector: sel,
          label: extractLabel(input),
          currentValue: (input.value || '').trim(),
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(input),
          filled: false,
        });
        idx++;
      }

      // ── 2. Native <select> ──
      const selects = document.querySelectorAll<HTMLSelectElement>('select:not([disabled])');
      for (const select of selects) {
        if (!isVisible(select)) continue;
        if (isInsideDisabledFieldset(select)) continue;
        const rect = select.getBoundingClientRect();
        const sel = buildSelector(select, idx);
        // Filter out placeholder options (empty value + generic text)
        const options = Array.from(select.options).filter(o => {
          if (o.value === '' || o.disabled) return false;
          const t = o.text.trim().toLowerCase();
          if (t === '' || t.startsWith('select') || t.startsWith('choose') || t.startsWith('please') || t === '--' || t === '---' || t === 'none') return false;
          return true;
        }).map(o => o.text.trim());
        fields.push({
          id: 'field-' + idx,
          kind: 'select',
          fillStrategy: 'native_setter',
          selector: sel,
          label: extractLabel(select),
          currentValue: select.selectedIndex > 0 ? (select.options[select.selectedIndex]?.text || '').trim() : '',
          options,
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(select),
          filled: false,
        });
        idx++;
      }

      // ── 3. Custom dropdowns ──
      // Broad detection: ARIA roles + haspopup (any value) + aria-expanded +
      // class-name patterns for styled select/dropdown/picker components.
      const ddSelector =
        '[role="combobox"], [role="listbox"], ' +
        '[aria-haspopup], ' +                            // any haspopup value
        '[aria-expanded]:not(input):not(textarea), ' +   // expandable non-inputs
        '[class*="select"]:not(select), ' +              // class-based (not native <select>)
        '[class*="dropdown"], [class*="picker"]';
      const customDropdowns = document.querySelectorAll(ddSelector);
      const seenDDElements = new Set<Element>();
      const NAV_EXCLUDE = 'nav, header, [role="navigation"], [role="menubar"], [role="menu"], [role="toolbar"]';

      for (const dd of customDropdowns) {
        // --- Exclusion filters ---
        if (dd.getAttribute('aria-disabled') === 'true') continue;
        if (dd.closest('select')) continue;                // inside native <select>
        if (dd.tagName === 'SELECT') continue;             // IS a native <select> (handled in section 2)
        if (dd.tagName === 'INPUT') continue;              // text inputs with aria-expanded
        if (dd.tagName === 'TEXTAREA') continue;
        if (!isVisible(dd)) continue;
        if (isInsideDisabledFieldset(dd)) continue;
        if (dd.closest(NAV_EXCLUDE)) continue;             // nav/header/menu elements

        // Skip elements that are clearly not form dropdowns:
        // links, plain images, icons, list items in a nav context
        const tag = dd.tagName;
        if (tag === 'A' || tag === 'IMG' || tag === 'SVG' || tag === 'LI') continue;

        // Deduplicate: skip if this element or an ancestor was already added
        if (seenDDElements.has(dd)) continue;
        const parentDD = dd.parentElement?.closest(ddSelector);
        if (parentDD && seenDDElements.has(parentDD)) continue;
        // Also skip if a child was already added (we want the outermost)
        let childAlreadySeen = false;
        for (const seen of seenDDElements) {
          if (dd.contains(seen)) { childAlreadySeen = true; break; }
        }
        if (childAlreadySeen) continue;
        seenDDElements.add(dd);

        const rect = dd.getBoundingClientRect();
        const inputChild = dd.querySelector('input') as HTMLInputElement | null;
        const currentValue = inputChild?.value?.trim() || '';
        const displayText = (dd.textContent || '').trim();
        const displayLower = displayText.toLowerCase();

        // --- Determine if empty or already filled ---
        const placeholderWords = ['select', 'choose', 'please', '--', '---', 'none', 'pick'];
        const looksLikePlaceholder = placeholderWords.some(p => displayLower.startsWith(p)) || displayLower === '';

        // If the element has a concrete input value and it's not placeholder text, it's filled
        if (currentValue && !looksLikePlaceholder) continue;

        // For elements without an input child: check if display text is just the label
        // (e.g., "Country/Region" shows as both label and button text when nothing is selected)
        // In that case it's EMPTY and should be included.
        // Only skip if display text looks like a real selected value (not the label, not placeholder)
        if (!currentValue && !looksLikePlaceholder && displayText.length > 0 && displayText.length < 100) {
          const ddLabel = extractLabel(dd);
          // If the display text doesn't match its own label, it's probably an already-selected value — skip
          const normDisplay = displayLower.replace(/[^a-z0-9]/g, '');
          const normLabel = ddLabel.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normLabel && normDisplay && !normDisplay.includes(normLabel) && !normLabel.includes(normDisplay)) {
            continue; // display text ≠ label → likely a real value is selected
          }
        }

        const sel = buildSelector(dd, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'custom_dropdown',
          fillStrategy: 'click_option',
          selector: sel,
          label: extractLabel(dd),
          currentValue,
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(dd),
          filled: false,
        });
        idx++;
      }

      // ── 4. Native radio groups ──
      const radiosByName: Record<string, HTMLInputElement[]> = {};
      const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]:not([disabled])');
      for (const r of radios) {
        if (!r.name) continue;
        if (!isVisible(r)) continue;
        if (isInsideDisabledFieldset(r)) continue;
        if (!radiosByName[r.name]) radiosByName[r.name] = [];
        radiosByName[r.name].push(r);
      }
      for (const [groupName, groupRadios] of Object.entries(radiosByName)) {
        const hasChecked = groupRadios.some(r => r.checked);
        const firstRadio = groupRadios[0];
        const rect = firstRadio.getBoundingClientRect();

        // Extract question text from fieldset/legend or container
        let questionText = '';
        const fieldset = firstRadio.closest('fieldset');
        if (fieldset) {
          const legend = fieldset.querySelector('legend');
          if (legend) questionText = (legend.textContent || '').trim();
        }
        if (!questionText) {
          const container = firstRadio.closest('[role="group"], [role="radiogroup"]');
          if (container) {
            const labelledBy = container.getAttribute('aria-labelledby');
            if (labelledBy) {
              const labelEl = document.getElementById(labelledBy);
              if (labelEl) questionText = (labelEl.textContent || '').trim();
            }
            if (!questionText) questionText = container.getAttribute('aria-label') || '';
          }
        }
        if (!questionText) {
          const parent = firstRadio.closest('[class*="question"], [class*="field"], [class*="form-group"], fieldset, section');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"], [class*="question-text"], h3, h4, p');
            if (lbl && !lbl.querySelector('input[type="radio"]')) {
              questionText = (lbl.textContent || '').trim();
            }
          }
        }
        if (!questionText) {
          let prev = firstRadio.parentElement?.previousElementSibling;
          if (!prev) prev = firstRadio.parentElement?.parentElement?.previousElementSibling;
          if (prev) {
            const t = (prev.textContent || '').trim();
            if (t.length > 5 && t.length < 200) questionText = t;
          }
        }

        // Extract option texts
        const options: string[] = [];
        for (const r of groupRadios) {
          let optText = '';
          if (r.id) {
            const lbl = document.querySelector('label[for="' + CSS.escape(r.id) + '"]');
            if (lbl) optText = (lbl.textContent || '').trim();
          }
          if (!optText && r.labels?.length) optText = (r.labels[0].textContent || '').trim();
          if (!optText) {
            const parentLabel = r.closest('label');
            if (parentLabel) optText = (parentLabel.textContent || '').trim();
          }
          if (!optText) optText = r.value || '';
          options.push(optText);
        }

        // Use first radio's selector as the group entry point
        const sel = buildSelector(firstRadio, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'radio',
          fillStrategy: 'click_option',
          selector: sel,
          label: questionText,
          currentValue: hasChecked ? 'checked' : '',
          options,
          groupKey: groupName,
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(firstRadio),
          filled: false,
        });
        idx++;
      }

      // ── 5. ARIA radiogroups ──
      const ariaGroups = document.querySelectorAll('[role="radiogroup"]');
      for (const group of ariaGroups) {
        if ((group as HTMLElement).getAttribute('aria-disabled') === 'true') continue;
        if (!isVisible(group)) continue;
        if (isInsideDisabledFieldset(group)) continue;
        if (group.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"], [role="toolbar"]')) continue;
        const rect = group.getBoundingClientRect();
        const groupRadioEls = group.querySelectorAll('[role="radio"]');
        let hasChecked = false;
        for (const r of groupRadioEls) {
          if (r.getAttribute('aria-checked') === 'true') { hasChecked = true; break; }
        }

        let questionText = '';
        const labelledBy = group.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) questionText = (labelEl.textContent || '').trim();
        }
        if (!questionText) questionText = group.getAttribute('aria-label') || '';
        if (!questionText) {
          const parent = group.closest('[class*="question"], [class*="field"], fieldset, section');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"], [class*="question-text"], h3, h4, p');
            if (lbl && !lbl.querySelector('[role="radio"]')) questionText = (lbl.textContent || '').trim();
          }
        }

        const options: string[] = [];
        for (const radio of groupRadioEls) {
          let optText = radio.getAttribute('aria-label') || '';
          if (!optText) {
            const labelId = radio.getAttribute('aria-labelledby');
            if (labelId) {
              const lbl = document.getElementById(labelId);
              if (lbl) optText = (lbl.textContent || '').trim();
            }
          }
          if (!optText) optText = (radio.textContent || '').trim();
          options.push(optText);
        }

        const sel = buildSelector(group, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'aria_radio',
          fillStrategy: 'click_option',
          selector: sel,
          label: questionText,
          currentValue: hasChecked ? 'checked' : '',
          options,
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(group),
          filled: false,
        });
        idx++;
      }

      // ── 5b. Standalone ARIA radios (not inside a radiogroup) ──
      const standaloneRadios = document.querySelectorAll('[role="radio"]');
      const standaloneByContainer: Record<string, Element[]> = {};
      for (const radio of standaloneRadios) {
        if (radio.closest('[role="radiogroup"]')) continue; // already handled in 5
        if (radio.getAttribute('aria-disabled') === 'true') continue;
        if (!isVisible(radio)) continue;
        if (isInsideDisabledFieldset(radio)) continue;
        if (radio.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"], [role="toolbar"]')) continue;
        // Group by nearest question/field container
        const container = radio.closest('[class*="question"], [class*="field"], [class*="form-group"], fieldset, section, [class*="radio"]') || radio.parentElement;
        const key = container ? (container.getAttribute('data-gh-scan-idx') || container.id || container.className.substring(0, 40) || 'standalone') : 'standalone';
        if (!standaloneByContainer[key]) standaloneByContainer[key] = [];
        standaloneByContainer[key].push(radio);
      }
      for (const [containerKey, groupRadios] of Object.entries(standaloneByContainer)) {
        let hasChecked = false;
        for (const r of groupRadios) {
          if (r.getAttribute('aria-checked') === 'true') { hasChecked = true; break; }
        }
        const firstRadio = groupRadios[0];
        const rect = firstRadio.getBoundingClientRect();

        // Extract question text
        let questionText = '';
        const container = firstRadio.closest('[class*="question"], [class*="field"], [class*="form-group"], fieldset, section');
        if (container) {
          const lbl = container.querySelector('label, legend, [class*="label"], [class*="question-text"], h3, h4, p');
          if (lbl && !lbl.querySelector('[role="radio"]')) questionText = (lbl.textContent || '').trim();
        }
        if (!questionText) {
          const labelledBy = firstRadio.getAttribute('aria-labelledby');
          if (labelledBy) {
            const lbl = document.getElementById(labelledBy);
            if (lbl) questionText = (lbl.textContent || '').trim();
          }
        }
        if (!questionText) questionText = firstRadio.getAttribute('aria-label') || '';

        // Extract option texts
        const options: string[] = [];
        for (const r of groupRadios) {
          let optText = r.getAttribute('aria-label') || '';
          if (!optText) {
            const labelId = r.getAttribute('aria-labelledby');
            if (labelId) {
              const lbl = document.getElementById(labelId);
              if (lbl) optText = (lbl.textContent || '').trim();
            }
          }
          if (!optText) optText = (r.textContent || '').trim();
          options.push(optText);
        }

        const sel = buildSelector(firstRadio, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'aria_radio',
          fillStrategy: 'click_option',
          selector: sel,
          label: questionText,
          currentValue: hasChecked ? 'checked' : '',
          options,
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(firstRadio),
          filled: false,
        });
        idx++;
      }

      // ── 6. Checkboxes ──
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([disabled])');
      for (const cb of checkboxes) {
        if (!isVisible(cb)) continue;
        if (isInsideDisabledFieldset(cb)) continue;
        const rect = cb.getBoundingClientRect();
        const sel = buildSelector(cb, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'checkbox',
          fillStrategy: 'click',
          selector: sel,
          label: extractLabel(cb),
          currentValue: cb.checked ? 'checked' : '',
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(cb),
          filled: false,
        });
        idx++;
      }

      // ── 7. Date inputs ──
      const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]:not([disabled])');
      for (const input of dateInputs) {
        if (!isVisible(input)) continue;
        if (isInsideDisabledFieldset(input)) continue;
        const rect = input.getBoundingClientRect();
        const sel = buildSelector(input, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'date',
          fillStrategy: 'native_setter',
          selector: sel,
          label: extractLabel(input),
          currentValue: (input.value || '').trim(),
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(input),
          filled: false,
        });
        idx++;
      }

      // ── 8. File inputs ──
      const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]:not([disabled])');
      for (const fi of fileInputs) {
        if (isInsideDisabledFieldset(fi)) continue;
        const hasFiles = fi.files && fi.files.length > 0;
        // Check visibility of file input or its label/wrapper
        let vis = isVisible(fi);
        if (!vis) {
          const lbl = fi.id ? document.querySelector('label[for="' + CSS.escape(fi.id) + '"]') : null;
          const wrap = fi.closest('[class*="upload"], [class*="file"], [class*="resume"]');
          const proxy = lbl || wrap || fi.parentElement;
          if (proxy && proxy !== fi) vis = isVisible(proxy);
        }
        if (!vis) continue;
        const rect = fi.getBoundingClientRect();
        const sel = buildSelector(fi, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'file',
          fillStrategy: 'set_input_files',
          selector: sel,
          label: extractLabel(fi),
          currentValue: hasFiles ? 'has_file' : '',
          absoluteY: (rect.height > 0 ? rect.top : 0) + scrollY,
          isRequired: isRequired(fi),
          filled: false,
        });
        idx++;
      }

      // ── 9. Upload buttons (no file input) ──
      const uploadWords = ['upload', 'attach', 'choose file', 'select file', 'browse',
        'add file', 'add resume', 'add cv', 'add document', 'add cover letter',
        'drag', 'drop file', 'drop your', 'drop here'];
      const uploadEls = document.querySelectorAll(
        'button, [role="button"], a[href], label[for], [class*="upload"], [class*="dropzone"], [class*="drop-zone"], [class*="file-upload"], [class*="attach"]'
      );
      for (const el of uploadEls) {
        if (!isVisible(el)) continue;
        const text = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (text.length > 150) continue;
        if (text === 'submit' || text === 'next' || text === 'continue' || text === 'save') continue;
        let isUpload = false;
        for (const w of uploadWords) { if (text.includes(w)) { isUpload = true; break; } }
        if (!isUpload) continue;
        // Check if file already uploaded nearby
        const container = el.closest('[class*="upload"], [class*="file"], [class*="resume"], form, fieldset, section') || el.parentElement;
        if (container) {
          const ct = (container.textContent || '').toLowerCase();
          if (ct.includes('.pdf') || ct.includes('.doc') || ct.includes('uploaded') || ct.includes('attached') || ct.includes('remove file')) continue;
        }
        const rect = el.getBoundingClientRect();
        const sel = buildSelector(el, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'upload_button',
          fillStrategy: 'llm_act',
          selector: sel,
          label: text.substring(0, 60),
          currentValue: '',
          absoluteY: rect.top + scrollY,
          isRequired: false,
          filled: false,
        });
        idx++;
      }

      // ── 10. Contenteditable divs ──
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (const el of editables) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const content = (el as HTMLElement).textContent?.trim() || '';
        const isEmpty = content.length === 0 || (el as HTMLElement).innerHTML === '<br>';
        const sel = buildSelector(el, idx);
        fields.push({
          id: 'field-' + idx,
          kind: 'contenteditable',
          fillStrategy: 'llm_act',
          selector: sel,
          label: extractLabel(el),
          currentValue: isEmpty ? '' : content.substring(0, 50),
          absoluteY: rect.top + scrollY,
          isRequired: isRequired(el),
          filled: false,
        });
        idx++;
      }

      return fields;
    }, startIdx) as Promise<ScannedField[]>;
  }

  async fillScannedField(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    switch (field.fillStrategy) {
      case 'native_setter':
        return this.fillByNativeSetter(adapter, field, answer);
      case 'click_option':
        return this.fillByClickOption(adapter, field, answer);
      case 'click':
        return this.fillByClick(adapter, field);
      case 'set_input_files':
        // Handled separately by resume upload logic in smartApplyHandler
        return false;
      case 'keyboard_type':
        return this.fillByKeyboardType(adapter, field, answer);
      case 'llm_act':
        // Handled by LLM phase in smartApplyHandler
        return false;
      default:
        return false;
    }
  }

  /**
   * Fill a text input, textarea, or native select via native value setter + events.
   */
  private async fillByNativeSetter(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    if (field.kind === 'select') {
      // For native selects, find the best matching option first
      const normAnswer = normalizeLabel(answer);
      const bestOption = field.options?.find(o => normalizeLabel(o) === normAnswer)
        || field.options?.find(o => normalizeLabel(o).includes(normAnswer))
        || field.options?.find(o => normAnswer.includes(normalizeLabel(o)));
      if (!bestOption) return false;

      return adapter.page.evaluate(
        ({ sel, value }: { sel: string; value: string }) => {
          const select = document.querySelector(sel) as HTMLSelectElement | null;
          if (!select) return false;
          const option = Array.from(select.options).find(o => o.text.trim() === value);
          if (!option) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(select, option.value);
          else select.value = option.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
        { sel: field.selector, value: bestOption },
      );
    }

    // Text input or textarea
    return adapter.page.evaluate(
      ({ sel, value }: { sel: string; value: string }) => {
        const input = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!input) return false;
        if (input.value && input.value.trim() !== '') return false; // Already filled
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) nativeSetter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        return true;
      },
      { sel: field.selector, value: answer },
    );
  }

  /**
   * Fill a radio group or custom dropdown by scrolling into view and clicking.
   */
  private async fillByClickOption(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    // Scroll into view first
    await adapter.page.evaluate(
      (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'instant' }),
      field.selector,
    );
    await adapter.page.waitForTimeout(300);

    if (field.kind === 'radio') {
      return this.fillNativeRadioBySelector(adapter, field, answer);
    }
    if (field.kind === 'aria_radio') {
      return this.fillAriaRadioBySelector(adapter, field, answer);
    }
    if (field.kind === 'custom_dropdown') {
      // Reuse existing searchable/clickable dropdown logic
      const hasInput = await adapter.page.evaluate(
        (sel: string) => !!document.querySelector(sel)?.querySelector('input'),
        field.selector,
      );
      if (hasInput) {
        return (await this.fillSearchableDropdown(adapter, field.selector, answer)) > 0;
      }
      return (await this.fillClickableDropdown(adapter, field.selector, answer)) > 0;
    }
    return false;
  }

  private async fillNativeRadioBySelector(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    if (!field.groupKey || !field.options) return false;
    const normAnswer = answer.toLowerCase().trim();

    // Find the best matching option
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < field.options.length; i++) {
      const normOpt = field.options[i].toLowerCase().trim();
      if (normOpt === normAnswer) { bestIdx = i; break; }
      if (normOpt.includes(normAnswer) && 80 > bestScore) { bestScore = 80; bestIdx = i; }
      if (normAnswer.includes(normOpt) && normOpt.length >= 2 && 60 > bestScore) { bestScore = 60; bestIdx = i; }
    }
    if (bestIdx < 0) return false;

    return adapter.page.evaluate(
      ({ groupName, optIdx }: { groupName: string; optIdx: number }) => {
        const radios = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="' + CSS.escape(groupName) + '"]:not([disabled])')
        );
        const target = radios[optIdx];
        if (!target) return false;
        target.click();
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      { groupName: field.groupKey, optIdx: bestIdx },
    );
  }

  private async fillAriaRadioBySelector(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    if (!field.options) return false;
    const normAnswer = answer.toLowerCase().trim();

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < field.options.length; i++) {
      const normOpt = field.options[i].toLowerCase().trim();
      if (normOpt === normAnswer) { bestIdx = i; break; }
      if (normOpt.includes(normAnswer) && 80 > bestScore) { bestScore = 80; bestIdx = i; }
      if (normAnswer.includes(normOpt) && normOpt.length >= 2 && 60 > bestScore) { bestScore = 60; bestIdx = i; }
    }
    if (bestIdx < 0) return false;

    return adapter.page.evaluate(
      ({ sel, optIdx }: { sel: string; optIdx: number }) => {
        const group = document.querySelector(sel);
        if (!group) return false;
        const radios = group.querySelectorAll('[role="radio"]');
        const target = radios[optIdx] as HTMLElement | undefined;
        if (!target) return false;
        target.click();
        return true;
      },
      { sel: field.selector, optIdx: bestIdx },
    );
  }

  /**
   * Fill a checkbox by clicking it.
   */
  private async fillByClick(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
  ): Promise<boolean> {
    await adapter.page.evaluate(
      (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'instant' }),
      field.selector,
    );
    await adapter.page.waitForTimeout(200);

    return adapter.page.evaluate(
      (sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return false;
        if (el.checked) return false; // Already checked
        el.click();
        return true;
      },
      field.selector,
    );
  }

  /**
   * Fill a field by focusing and typing (for segmented date fields etc).
   */
  private async fillByKeyboardType(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    try {
      const locator = adapter.page.locator(field.selector).first();
      await locator.scrollIntoViewIfNeeded();
      await locator.click();
      await adapter.page.waitForTimeout(200);
      await adapter.page.keyboard.type(answer, { delay: 50 });
      return true;
    } catch {
      return false;
    }
  }

  // --- Programmatic DOM Helpers (legacy, kept for backward compatibility) ---

  async fillTextFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    // Gather visible text-like inputs with their labels
    const fieldData = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const results: Array<{ index: number; label: string; inputType: string; tagName: string }> = [];

      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );

      inputs.forEach((input, i) => {
        if (input.disabled || (input as HTMLInputElement).readOnly) return;
        if ((input as HTMLInputElement).type === 'hidden') return;
        // Skip already-filled fields
        if (input.value && input.value.trim() !== '') return;
        const rect = input.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) return;
        if (rect.bottom < 0 || rect.top > vh) return;
        if (input.getAttribute('aria-hidden') === 'true') return;
        const st = window.getComputedStyle(input);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;

        // Find the label via multiple strategies
        let label = '';

        // 1. Associated <label> element
        if ('labels' in input && (input as HTMLInputElement).labels?.length) {
          label = ((input as HTMLInputElement).labels![0].textContent || '').trim();
        }

        // 2. aria-label
        if (!label) label = input.getAttribute('aria-label') || '';

        // 3. aria-labelledby
        if (!label) {
          const labelledBy = input.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) label = (labelEl.textContent || '').trim();
          }
        }

        // 4. Placeholder text (often descriptive on job sites)
        if (!label) label = input.getAttribute('placeholder') || '';

        // 5. label[for] matching input id
        if (!label && input.id) {
          const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
          if (forLabel) label = (forLabel.textContent || '').trim();
        }

        // 6. Parent/sibling label text
        if (!label) {
          const parent = input.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset, [class*="input"]');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl) label = (lbl.textContent || '').trim();
          }
        }

        // 7. Preceding sibling label
        if (!label) {
          const prev = input.previousElementSibling;
          if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
            const t = (prev.textContent || '').trim();
            if (t.length < 80) label = t;
          }
        }

        // 8. name or id attribute as last resort
        if (!label) label = input.name || input.id || '';

        results.push({
          index: i,
          label,
          inputType: (input as HTMLInputElement).type || 'text',
          tagName: input.tagName.toLowerCase(),
        });
      });

      return results;
    });

    let filled = 0;

    for (const field of fieldData) {
      const answer = findBestAnswer(field.label, qaMap);
      if (!answer) continue;

      const didFill = await adapter.page.evaluate(
        ({ idx, value }) => {
          const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
          );
          const input = inputs[idx];
          if (!input) return false;
          // Double-check it's still empty (may have been filled by a previous iteration)
          if (input.value && input.value.trim() !== '') return false;

          // Use the NATIVE value setter to bypass React's override on the value property.
          const proto = input.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(input, value);
          } else {
            input.value = value;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          // Also dispatch blur to trigger validation
          input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          return true;
        },
        { idx: field.index, value: answer },
      );

      if (didFill) {
        filled++;
        console.log(`[GenericConfig] DOM-filled "${field.label}" (${field.inputType})`);
      }
    }

    return filled;
  }

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

  /**
   * Fill custom (non-native) dropdowns: ARIA comboboxes, listboxes, and
   * custom div-based selects. Handles both type-to-search and click-to-select.
   * Uses Playwright APIs to click options directly (no scroll needed).
   */
  async fillCustomDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    // 1. Gather visible custom dropdowns and their labels
    const dropdownData = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const results: Array<{
        selector: string;
        label: string;
        isCombobox: boolean;
        hasInputChild: boolean;
        currentValue: string;
      }> = [];

      // Find ARIA combobox/listbox triggers
      const triggers = document.querySelectorAll(
        '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="true"]'
      );

      for (let i = 0; i < triggers.length; i++) {
        const el = triggers[i] as HTMLElement;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;

        // Skip if already inside a native <select>
        if (el.closest('select')) continue;

        // Check current value
        const inputChild = el.querySelector('input') as HTMLInputElement | null;
        const currentValue = inputChild?.value?.trim()
          || el.getAttribute('aria-activedescendant')
          || '';

        // Skip if it already has a meaningful value (not placeholder text)
        const displayText = (el.textContent || '').trim().toLowerCase();
        const isPlaceholder = !currentValue && (
          displayText.startsWith('select') || displayText.startsWith('choose')
          || displayText.startsWith('please') || displayText.startsWith('--')
          || displayText === '' || displayText === 'none'
        );

        // If it has a real value and it's not a placeholder, skip
        if (currentValue && !isPlaceholder) continue;
        // If it doesn't look like a placeholder either, it might already be filled
        if (!isPlaceholder && displayText.length > 0 && displayText.length < 50) continue;

        // Build a unique selector for this element
        let selector = '';
        if (el.id) {
          selector = '#' + CSS.escape(el.id);
        } else if (el.getAttribute('data-testid')) {
          selector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
        } else if (el.getAttribute('aria-labelledby')) {
          selector = '[aria-labelledby="' + el.getAttribute('aria-labelledby') + '"]';
        } else {
          // Fallback: use role + nth-of-type index
          const role = el.getAttribute('role') || '';
          const allSameRole = document.querySelectorAll('[role="' + role + '"]');
          let idx = 0;
          for (let j = 0; j < allSameRole.length; j++) {
            if (allSameRole[j] === el) { idx = j; break; }
          }
          selector = '[role="' + role + '"]:nth(' + idx + ')';
        }

        // Find label
        let label = '';
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) label = labelEl.textContent?.trim() || '';
        }
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label) {
          // Check preceding sibling or parent for label text
          const prev = el.previousElementSibling;
          if (prev && prev.tagName === 'LABEL') label = prev.textContent?.trim() || '';
          if (!label) {
            const parent = el.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
            if (parent) {
              const lbl = parent.querySelector('label, legend, [class*="label"]');
              if (lbl) label = lbl.textContent?.trim() || '';
            }
          }
        }

        results.push({
          selector,
          label,
          isCombobox: el.getAttribute('role') === 'combobox' || !!inputChild,
          hasInputChild: !!inputChild,
          currentValue,
        });
      }

      return results;
    });

    let filled = 0;

    for (const dd of dropdownData) {
      const answer = findBestAnswer(dd.label, qaMap);
      if (!answer) continue;

      try {
        if (dd.isCombobox && dd.hasInputChild) {
          // Type-to-search combobox: click, clear, type the answer, wait for options, pick best match
          filled += await this.fillSearchableDropdown(adapter, dd.selector, answer);
        } else {
          // Click-to-open dropdown: click to open, find matching option, click it
          filled += await this.fillClickableDropdown(adapter, dd.selector, answer);
        }
      } catch (err) {
        console.warn(`[GenericConfig] Custom dropdown fill failed for "${dd.label}": ${err}`);
      }
    }

    return filled;
  }

  /**
   * Fill a searchable combobox: click to focus, type the answer, pick the matching option.
   */
  private async fillSearchableDropdown(
    adapter: BrowserAutomationAdapter,
    triggerSelector: string,
    answer: string,
  ): Promise<number> {
    const trigger = adapter.page.locator(triggerSelector).first();
    await trigger.click();
    await adapter.page.waitForTimeout(300);

    // Find and clear the input inside
    const input = trigger.locator('input').first();
    await input.fill('');
    await adapter.page.waitForTimeout(100);
    await input.fill(answer);
    await adapter.page.waitForTimeout(800); // Wait for search/filter

    // Find the best matching option in any open listbox/menu
    const picked = await adapter.page.evaluate((ans) => {
      const normAns = ans.toLowerCase().trim();
      // Look for open option lists
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, [class*="option"], [class*="menu-item"], [class*="dropdown-item"]'
      );
      let bestMatch: Element | null = null;
      let bestScore = 0;

      for (let i = 0; i < options.length; i++) {
        const opt = options[i] as HTMLElement;
        const rect = opt.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (opt.textContent || '').trim().toLowerCase();
        if (!text) continue;

        // Exact match
        if (text === normAns) { bestMatch = opt; bestScore = 100; break; }
        // Contains
        if (text.includes(normAns) && text.length < normAns.length * 3) {
          const score = 50 + (normAns.length / text.length) * 30;
          if (score > bestScore) { bestScore = score; bestMatch = opt; }
        }
        if (normAns.includes(text) && text.length > 2) {
          const score = 40 + (text.length / normAns.length) * 30;
          if (score > bestScore) { bestScore = score; bestMatch = opt; }
        }
      }

      if (bestMatch) {
        (bestMatch as HTMLElement).click();
        return true;
      }
      return false;
    }, answer);

    if (picked) {
      await adapter.page.waitForTimeout(300);
      return 1;
    }

    // Fallback: press Enter to accept the top suggestion
    await adapter.page.keyboard.press('Enter');
    await adapter.page.waitForTimeout(300);
    return 1;
  }

  /**
   * Fill a click-to-open dropdown: click trigger, find the matching option in the
   * popup, and click it. Uses Playwright's auto-scroll within the popup element.
   */
  private async fillClickableDropdown(
    adapter: BrowserAutomationAdapter,
    triggerSelector: string,
    answer: string,
  ): Promise<number> {
    // Click to open
    const trigger = adapter.page.locator(triggerSelector).first();
    await trigger.click();
    await adapter.page.waitForTimeout(500);

    // Find and click the best matching option
    const normAnswer = answer.toLowerCase().trim();

    // Try role="option" first, then common patterns
    const optionSelectors = [
      '[role="option"]',
      '[role="listbox"] li',
      '[role="menu"] [role="menuitem"]',
      '[class*="option"]',
      '[class*="menu-item"]',
      '[class*="dropdown-item"]',
      'li[data-value]',
    ];

    for (const optSel of optionSelectors) {
      const options = adapter.page.locator(optSel);
      const count = await options.count();
      if (count === 0) continue;

      let bestIdx = -1;
      let bestScore = 0;

      for (let i = 0; i < count; i++) {
        const text = (await options.nth(i).textContent() || '').trim().toLowerCase();
        if (!text) continue;

        if (text === normAnswer) { bestIdx = i; bestScore = 100; break; }
        if (text.includes(normAnswer)) {
          const score = 50 + (normAnswer.length / text.length) * 30;
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        if (normAnswer.includes(text) && text.length > 2) {
          const score = 40 + (text.length / normAnswer.length) * 30;
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
      }

      if (bestIdx >= 0) {
        // Playwright's .click() auto-scrolls within scroll containers — no page scroll needed
        await options.nth(bestIdx).click({ force: true });
        await adapter.page.waitForTimeout(300);
        return 1;
      }
    }

    // No match found — close the dropdown by pressing Escape
    await adapter.page.keyboard.press('Escape');
    await adapter.page.waitForTimeout(200);
    return 0;
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

        const isRequired = cb.required || cb.getAttribute('aria-required') === 'true';

        // Search wider: parent, grandparent, associated label, and nearby container
        let nearbyText = '';
        // Direct label association
        if (cb.id) {
          const lbl = document.querySelector('label[for="' + CSS.escape(cb.id) + '"]');
          if (lbl) nearbyText += ' ' + (lbl.textContent || '');
        }
        if (cb.labels?.length) {
          for (const l of cb.labels) nearbyText += ' ' + (l.textContent || '');
        }
        // Walk up to 3 levels of parents for context text
        let el: HTMLElement | null = cb.parentElement;
        for (let depth = 0; depth < 3 && el; depth++) {
          nearbyText += ' ' + (el.textContent || '');
          el = el.parentElement;
        }
        nearbyText = nearbyText.toLowerCase();

        const consentWords = [
          'agree', 'acknowledge', 'terms', 'consent', 'privacy',
          'certify', 'confirm', 'authorize', 'accept', 'understand',
          'i have read', 'i agree', 'i consent', 'i acknowledge',
          'i certify', 'i confirm', 'i understand', 'i accept',
        ];
        let isTerms = false;
        for (const word of consentWords) {
          if (nearbyText.includes(word)) { isTerms = true; break; }
        }

        if (isRequired || isTerms) {
          cb.click();
          checked++;
        }
      }
      return checked;
    });
  }

  async fillRadioButtonsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    // Gather visible radio groups with their question text and options
    const groupData = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const results: Array<{
        groupIndex: number;
        questionText: string;
        options: Array<{ text: string; optionIndex: number }>;
        isAria: boolean;
      }> = [];

      // --- Native radio groups ---
      const radiosByName: Record<string, HTMLInputElement[]> = {};
      const radios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]:not([disabled])');
      for (const r of radios) {
        if (!r.name) continue;
        const rect = r.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (!radiosByName[r.name]) radiosByName[r.name] = [];
        radiosByName[r.name].push(r);
      }

      let groupIdx = 0;
      for (const [, groupRadios] of Object.entries(radiosByName)) {
        // Skip if already has a selection
        if (groupRadios.some(r => r.checked)) continue;

        // Find question text from fieldset/legend, parent container label, or nearest heading
        let questionText = '';
        const firstRadio = groupRadios[0];

        // Try fieldset > legend
        const fieldset = firstRadio.closest('fieldset');
        if (fieldset) {
          const legend = fieldset.querySelector('legend');
          if (legend) questionText = (legend.textContent || '').trim();
        }

        // Try aria-labelledby on the group container
        if (!questionText) {
          const container = firstRadio.closest('[role="group"], [role="radiogroup"]');
          if (container) {
            const labelledBy = container.getAttribute('aria-labelledby');
            if (labelledBy) {
              const labelEl = document.getElementById(labelledBy);
              if (labelEl) questionText = (labelEl.textContent || '').trim();
            }
            if (!questionText) {
              const ariaLabel = container.getAttribute('aria-label');
              if (ariaLabel) questionText = ariaLabel;
            }
          }
        }

        // Try parent container with label/heading
        if (!questionText) {
          const parent = firstRadio.closest('[class*="question"], [class*="field"], [class*="form-group"], [class*="form-row"], fieldset, section, [data-testid]');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"], [class*="question-text"], h3, h4, p');
            if (lbl && !lbl.querySelector('input[type="radio"]')) {
              questionText = (lbl.textContent || '').trim();
            }
          }
        }

        // Try preceding sibling
        if (!questionText) {
          let prev = firstRadio.parentElement?.previousElementSibling;
          if (!prev) prev = firstRadio.parentElement?.parentElement?.previousElementSibling;
          if (prev) {
            const t = (prev.textContent || '').trim();
            if (t.length > 5 && t.length < 200) questionText = t;
          }
        }

        const options: Array<{ text: string; optionIndex: number }> = [];
        groupRadios.forEach((r, i) => {
          let optText = '';
          // label[for]
          if (r.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
            if (lbl) optText = (lbl.textContent || '').trim();
          }
          // labels property
          if (!optText && r.labels?.length) {
            optText = (r.labels[0].textContent || '').trim();
          }
          // Parent label
          if (!optText) {
            const parentLabel = r.closest('label');
            if (parentLabel) optText = (parentLabel.textContent || '').trim();
          }
          // Sibling text
          if (!optText) {
            const next = r.nextElementSibling || r.nextSibling;
            if (next) optText = (next.textContent || '').trim();
          }
          // value attribute as last resort
          if (!optText) optText = r.value || '';
          options.push({ text: optText, optionIndex: i });
        });

        if (questionText || options.length > 0) {
          results.push({ groupIndex: groupIdx, questionText, options, isAria: false });
        }
        groupIdx++;
      }

      // --- ARIA radiogroups ---
      const ariaGroups = document.querySelectorAll('[role="radiogroup"]');
      for (let g = 0; g < ariaGroups.length; g++) {
        const group = ariaGroups[g] as HTMLElement;
        if (group.getAttribute('aria-disabled') === 'true') continue;
        const rect = group.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;

        // Skip if already has a selection
        const groupRadioEls = group.querySelectorAll('[role="radio"]');
        let hasChecked = false;
        for (const r of groupRadioEls) {
          if (r.getAttribute('aria-checked') === 'true') { hasChecked = true; break; }
        }
        if (hasChecked) continue;

        // Find question text
        let questionText = '';
        const labelledBy = group.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) questionText = (labelEl.textContent || '').trim();
        }
        if (!questionText) questionText = group.getAttribute('aria-label') || '';
        if (!questionText) {
          const parent = group.closest('[class*="question"], [class*="field"], fieldset, section');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"], [class*="question-text"], h3, h4, p');
            if (lbl && !lbl.querySelector('[role="radio"]')) {
              questionText = (lbl.textContent || '').trim();
            }
          }
        }

        const options: Array<{ text: string; optionIndex: number }> = [];
        for (let r = 0; r < groupRadioEls.length; r++) {
          const radio = groupRadioEls[r] as HTMLElement;
          let optText = radio.getAttribute('aria-label') || '';
          if (!optText) {
            const labelId = radio.getAttribute('aria-labelledby');
            if (labelId) {
              const lbl = document.getElementById(labelId);
              if (lbl) optText = (lbl.textContent || '').trim();
            }
          }
          if (!optText) optText = (radio.textContent || '').trim();
          options.push({ text: optText, optionIndex: r });
        }

        if (questionText || options.length > 0) {
          results.push({ groupIndex: g, questionText, options, isAria: true });
        }
      }

      return results;
    });

    let filled = 0;

    for (const group of groupData) {
      // Match question text against qaMap
      const answer = findBestAnswer(group.questionText, qaMap);
      if (!answer) continue;

      // Find the option that matches the answer
      const normAnswer = answer.toLowerCase().trim();
      let bestOption: typeof group.options[0] | null = null;
      let bestScore = 0;

      for (const opt of group.options) {
        const normOpt = opt.text.toLowerCase().trim();
        if (!normOpt) continue;

        // Exact match
        if (normOpt === normAnswer) { bestOption = opt; bestScore = 100; break; }
        // Option contains answer
        if (normOpt.includes(normAnswer)) {
          const score = 80;
          if (score > bestScore) { bestScore = score; bestOption = opt; }
        }
        // Answer contains option (e.g. answer="Yes" option="Yes, I am")
        if (normAnswer.includes(normOpt) && normOpt.length >= 2) {
          const score = 60;
          if (score > bestScore) { bestScore = score; bestOption = opt; }
        }
      }

      if (!bestOption) continue;

      // Click the matching radio option
      if (group.isAria) {
        const clicked = await adapter.page.evaluate(
          ({ gIdx, oIdx }) => {
            const ariaGroups = document.querySelectorAll('[role="radiogroup"]');
            const g = ariaGroups[gIdx];
            if (!g) return false;
            const radios = g.querySelectorAll('[role="radio"]');
            const target = radios[oIdx] as HTMLElement | undefined;
            if (!target) return false;
            target.click();
            return true;
          },
          { gIdx: group.groupIndex, oIdx: bestOption.optionIndex },
        );
        if (clicked) {
          filled++;
          console.log(`[GenericConfig] DOM-filled radio "${group.questionText}" → "${bestOption.text}"`);
        }
      } else {
        // Native radio: click via Playwright for proper event handling
        const clicked = await adapter.page.evaluate(
          ({ groupName, oIdx }) => {
            const radiosByName: Record<string, HTMLInputElement[]> = {};
            const allRadios = document.querySelectorAll<HTMLInputElement>('input[type="radio"]:not([disabled])');
            for (const r of allRadios) {
              if (!r.name) continue;
              if (!radiosByName[r.name]) radiosByName[r.name] = [];
              radiosByName[r.name].push(r);
            }
            // Find the group by iterating in the same order as the gather phase
            const groupNames = Object.keys(radiosByName).filter(name => {
              return !radiosByName[name].some(r => r.checked);
            });
            const name = groupNames[groupName];
            if (!name) return false;
            const radios = radiosByName[name];
            const target = radios[oIdx];
            if (!target) return false;
            target.click();
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
          { groupName: group.groupIndex, oIdx: bestOption.optionIndex },
        );
        if (clicked) {
          filled++;
          console.log(`[GenericConfig] DOM-filled radio "${group.questionText}" → "${bestOption.text}"`);
        }
      }

      await adapter.page.waitForTimeout(300);
    }

    return filled;
  }

  async hasEmptyVisibleFields(adapter: BrowserAutomationAdapter): Promise<boolean> {
    // NOTE: Do NOT define named functions (const fn = ...) inside page.evaluate —
    // esbuild's --keep-names injects __name() wrappers that don't exist in the browser context.
    return adapter.page.evaluate(() => {
      const vh = window.innerHeight;

      // Inline visibility check — repeated per section to avoid __name crash
      // checks: non-zero size, in viewport, not display:none/hidden/opacity:0, not aria-hidden

      // 1. Text inputs and textareas
      const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="password"], input:not([type]), textarea');
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i] as HTMLInputElement;
        if (input.disabled || input.readOnly || input.type === 'hidden') continue;
        const rect = input.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (input.getAttribute('aria-hidden') === 'true') continue;
        const st = window.getComputedStyle(input);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        if (!input.value || input.value.trim() === '') return true;
      }

      // 2. Unfilled <select> elements
      const selects = document.querySelectorAll('select:not([disabled])');
      for (let i = 0; i < selects.length; i++) {
        const select = selects[i] as HTMLSelectElement;
        const rect = select.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (select.selectedIndex <= 0) return true;
      }

      // 3. Required checkboxes
      const checkboxes = document.querySelectorAll('input[type="checkbox"]:not([disabled])');
      for (let i = 0; i < checkboxes.length; i++) {
        const cb = checkboxes[i] as HTMLInputElement;
        if (cb.checked) continue;
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (cb.required || cb.getAttribute('aria-required') === 'true') return true;
      }

      // 4a. Native radio groups with no selection
      const radioGroups: Record<string, boolean> = {};
      const radios = document.querySelectorAll('input[type="radio"]:not([disabled])');
      for (let i = 0; i < radios.length; i++) {
        const radio = radios[i] as HTMLInputElement;
        if (!radio.name) continue;
        const rect = radio.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (!(radio.name in radioGroups)) radioGroups[radio.name] = false;
        if (radio.checked) radioGroups[radio.name] = true;
      }
      for (const name in radioGroups) {
        if (!radioGroups[name]) return true;
      }

      // 4b. ARIA radiogroups — custom div/span radio buttons (Google Careers, Workday, etc.)
      const ariaRadioGroups = document.querySelectorAll('[role="radiogroup"]');
      for (let i = 0; i < ariaRadioGroups.length; i++) {
        const group = ariaRadioGroups[i] as HTMLElement;
        if (group.getAttribute('aria-disabled') === 'true') continue;
        const rect = group.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        // Check if any radio in this group is selected
        const groupRadios = group.querySelectorAll('[role="radio"]');
        let hasChecked = false;
        for (let j = 0; j < groupRadios.length; j++) {
          if (groupRadios[j].getAttribute('aria-checked') === 'true') { hasChecked = true; break; }
        }
        if (!hasChecked) return true;
      }

      // 4c. Standalone ARIA radios not inside a radiogroup
      const standaloneRadios = document.querySelectorAll('[role="radio"]');
      for (let i = 0; i < standaloneRadios.length; i++) {
        const sr = standaloneRadios[i] as HTMLElement;
        if (sr.getAttribute('aria-disabled') === 'true') continue;
        // Skip if already inside a radiogroup (handled above)
        if (sr.closest('[role="radiogroup"]')) continue;
        const rect = sr.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (sr.getAttribute('aria-checked') !== 'true') return true;
      }

      // 5. File upload inputs (visible OR hidden behind styled button/label)
      const fileInputs = document.querySelectorAll('input[type="file"]');
      for (let i = 0; i < fileInputs.length; i++) {
        const fi = fileInputs[i] as HTMLInputElement;
        if (fi.disabled) continue;
        if (fi.files && fi.files.length > 0) continue;
        const fiRect = fi.getBoundingClientRect();
        // Visible file input in viewport
        if (fiRect.width > 0 && fiRect.height > 0 && fiRect.bottom >= 0 && fiRect.top <= vh) return true;
        // Hidden file input — check if its label/wrapper is visible
        const lbl = fi.id ? document.querySelector('label[for="' + fi.id + '"]') : null;
        const wrap = fi.closest('[class*="upload"], [class*="file"], [class*="drop"], [class*="resume"], [class*="attach"]');
        const proxy = lbl || wrap || fi.parentElement;
        if (proxy && proxy !== fi) {
          const pr = proxy.getBoundingClientRect();
          if (pr.width > 0 && pr.height > 0 && pr.bottom >= 0 && pr.top <= vh) return true;
        }
      }

      // 6. Upload / attach / file buttons and dropzones (broad keyword matching)
      const uploadWords = [
        'upload', 'attach', 'choose file', 'select file', 'browse',
        'add file', 'add resume', 'add cv', 'add document', 'add cover letter',
        'drag', 'drop file', 'drop your', 'drop here',
      ];
      const interactives = document.querySelectorAll(
        'button, [role="button"], a[href], label[for], [class*="upload"], [class*="dropzone"], [class*="drop-zone"], [class*="file-upload"], [class*="attach"]'
      );
      for (let i = 0; i < interactives.length; i++) {
        const el = interactives[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const text = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (text.length > 150) continue;
        let matchesUpload = false;
        for (let k = 0; k < uploadWords.length; k++) {
          if (text.indexOf(uploadWords[k]) !== -1) { matchesUpload = true; break; }
        }
        if (!matchesUpload) continue;
        // Skip nav buttons that happen to say these words
        if (text === 'submit' || text === 'next' || text === 'continue' || text === 'save' || text === 'sign in' || text === 'log in') continue;
        // Check if file already uploaded nearby
        const container = el.closest('[class*="upload"], [class*="file"], [class*="resume"], [class*="attach"], form, fieldset, section') || el.parentElement;
        if (container) {
          const ct = (container.textContent || '').toLowerCase();
          if (ct.indexOf('.pdf') !== -1 || ct.indexOf('.doc') !== -1 || ct.indexOf('uploaded') !== -1 || ct.indexOf('attached') !== -1 || ct.indexOf('remove file') !== -1 || ct.indexOf('delete file') !== -1 || ct.indexOf('replace') !== -1) continue;
        }
        return true;
      }

      // 7. Custom ARIA dropdown/combobox components
      const customDropdowns = document.querySelectorAll(
        '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="true"]'
      );
      for (let i = 0; i < customDropdowns.length; i++) {
        const dd = customDropdowns[i] as HTMLElement;
        if (dd.getAttribute('aria-disabled') === 'true') continue;
        const rect = dd.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(dd);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const val = dd.getAttribute('aria-activedescendant')
          || (dd.querySelector('[aria-selected="true"]') || {} as any).textContent?.trim()
          || (dd as any).value?.trim()
          || '';
        if (val) continue; // has a value
        const displayText = (dd.textContent || '').trim().toLowerCase();
        if (displayText.indexOf('select') === 0 || displayText.indexOf('choose') === 0 || displayText.indexOf('please select') === 0 || displayText.indexOf('-- select') === 0 || displayText.indexOf('pick') === 0) return true;
      }

      // 8. Content-editable divs (rich text fields)
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (let i = 0; i < editables.length; i++) {
        const el = editables[i] as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const text = el.textContent?.trim() || '';
        if (text.length === 0 || el.innerHTML === '<br>') return true;
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
