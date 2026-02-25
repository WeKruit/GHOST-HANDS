import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import type { PlatformConfig, PageState, PageType, ScannedField, ScanResult } from './types.js';
import type { WorkdayUserProfile } from '../workdayTypes.js';
import {
  WORKDAY_BASE_RULES,
  buildPersonalInfoPrompt,
  buildFormPagePrompt,
  buildExperiencePrompt,
  buildVoluntaryDisclosurePrompt,
  buildSelfIdentifyPrompt,
  buildGenericPagePrompt,
  buildGoogleSignInFallbackPrompt,
  type SelfIdFields,
} from '../workdayPrompts.js';

// Re-export for backward compatibility
export { WORKDAY_BASE_RULES };

// ---------------------------------------------------------------------------
// Workday page state schema (extends base with voluntary_disclosure, self_identify)
// ---------------------------------------------------------------------------

const WorkdayPageStateSchema = z.object({
  page_type: z.enum([
    'job_listing', 'login', 'google_signin', 'verification_code', 'phone_2fa',
    'account_creation', 'personal_info', 'experience', 'resume_upload',
    'questions', 'voluntary_disclosure', 'self_identify',
    'review', 'confirmation', 'error', 'unknown',
  ]),
  page_title: z.string().optional().default(''),
  has_apply_button: z.boolean().optional().default(false),
  has_next_button: z.boolean().optional().default(false),
  has_submit_button: z.boolean().optional().default(false),
  has_sign_in_with_google: z.boolean().optional().default(false),
  error_message: z.string().optional().default(''),
});

// ---------------------------------------------------------------------------
// Workday-specific fuzzy matching (5-pass: exact, contains, reverse, word, stem)
// ---------------------------------------------------------------------------

function findBestDropdownAnswer(
  label: string,
  qaMap: Record<string, string>,
): string | null {
  if (!label) return null;

  const labelLower = label.toLowerCase().replace(/\*/g, '').trim();
  if (labelLower.length < 2) return null;

  // Pass 1: Exact match (case-insensitive)
  for (const [q, a] of Object.entries(qaMap)) {
    if (q.toLowerCase() === labelLower) return a;
  }

  // Pass 2: Label contains the Q&A key — key must cover ≥ 60% of label length
  for (const [q, a] of Object.entries(qaMap)) {
    const qLower = q.toLowerCase();
    if (qLower.length >= 3 && labelLower.includes(qLower) && qLower.length >= labelLower.length * 0.6) return a;
  }

  // Pass 3: Q&A key contains the label (short labels like "Gender", "State")
  // Guard: label must be ≥ 50% of key length to prevent incidental substring matches
  // (e.g. "city" matching "ethnicity" because "ethnicity" ends in "city")
  for (const [q, a] of Object.entries(qaMap)) {
    const qLower = q.toLowerCase();
    if (qLower.includes(labelLower) && labelLower.length > 3 && labelLower.length >= qLower.length * 0.5) return a;
  }

  // Pass 4: Significant word overlap (for rephrased questions)
  const labelWords = new Set(labelLower.split(/\s+/).filter(w => w.length > 3));
  let bestMatch: { answer: string; overlap: number } | null = null;

  for (const [q, a] of Object.entries(qaMap)) {
    const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = qWords.filter(w => labelWords.has(w)).length;
    if (overlap >= 3 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { answer: a, overlap };
    }
  }

  if (bestMatch) return bestMatch.answer;

  // Pass 5: Stem-based overlap
  const stem = (word: string) =>
    word.replace(/(ating|ting|ing|tion|sion|ment|ness|able|ible|ed|ly|er|est|ies|es|s)$/i, '');
  const labelStems = new Set(
    labelLower.split(/\s+/).filter(w => w.length > 3).map(stem),
  );
  bestMatch = null;

  for (const [q, a] of Object.entries(qaMap)) {
    const qStems = q.toLowerCase().split(/\s+/).filter(w => w.length > 3).map(stem);
    const overlap = qStems.filter(s => labelStems.has(s)).length;
    if (overlap >= 2 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { answer: a, overlap };
    }
  }

  if (bestMatch) return bestMatch.answer;

  return null;
}

// ---------------------------------------------------------------------------
// WorkdayPlatformConfig
// ---------------------------------------------------------------------------

export class WorkdayPlatformConfig implements PlatformConfig {
  readonly platformId = 'workday';
  readonly displayName = 'Workday';
  readonly pageStateSchema = WorkdayPageStateSchema as z.ZodType<PageState>;
  readonly baseRules = WORKDAY_BASE_RULES;
  readonly needsCustomExperienceHandler = true;
  readonly authDomains = ['accounts.google.com', 'myworkdayjobs.com'];
  private _selfIdFields: SelfIdFields | null = null;

  // =========================================================================
  // Page Detection
  // =========================================================================

  detectPageByUrl(url: string): PageState | null {
    // Google SSO detection
    if (url.includes('accounts.google.com')) {
      if (url.includes('/pwd') || url.includes('/identifier')) {
        return { page_type: 'google_signin', page_title: 'Google Sign-In (password)' };
      }
      if (url.includes('/challenge/')) {
        const challengeType = url.includes('recaptcha') ? 'CAPTCHA'
          : url.includes('ipp') ? 'Phone/SMS verification'
          : url.includes('dp') ? 'Device prompt'
          : 'Google challenge';
        return { page_type: 'phone_2fa', page_title: `${challengeType} (manual solve required)` };
      }
      return { page_type: 'google_signin', page_title: 'Google Sign-In' };
    }

    return null;
  }

  async detectPageByDOM(adapter: BrowserAutomationAdapter): Promise<PageState | null> {
    const domSignals = await adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id*="pageHeader"], [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');

      // Check for "Create Account" as the PRIMARY heading/view — means
      // the page IS an account creation form (even if it has a "Sign In" link).
      const isCreateAccountView = headingText.includes('create account') || headingText.includes('register');
      // Also check for confirm-password field (Create Account has 2 password inputs)
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const hasConfirmPassword = passwordFields.length > 1;
      const hasPasswordField = passwordFields.length > 0;

      // Count actual form fields — if the page has many inputs, it's an application
      // form, not a login page (even if "sign in" text appears somewhere on the page)
      const formFieldCount = document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), ' +
        'input[type="email"]:not([readonly]):not([disabled]), ' +
        'input[type="tel"]:not([readonly]):not([disabled]), ' +
        'textarea:not([readonly]):not([disabled]), ' +
        'select:not([disabled]), ' +
        '[role="combobox"]:not([aria-disabled="true"])'
      ).length;

      return {
        hasSignInWithGoogle: bodyText.includes('sign in with google') || bodyText.includes('continue with google'),
        hasSignIn: bodyText.includes('sign in') || bodyText.includes('log in'),
        hasApplyButton: bodyText.includes('apply') && !bodyText.includes('application questions'),
        hasSubmitApplication: bodyText.includes('submit application') || bodyText.includes('submit your application'),
        isCreateAccountView: isCreateAccountView || hasConfirmPassword,
        hasPasswordField,
        formFieldCount,
      };
    });

    // Create Account page — classify as account_creation, NOT login
    if (domSignals.isCreateAccountView) {
      return { page_type: 'account_creation', page_title: 'Workday Create Account' };
    }

    // Only classify as login if the page actually looks like a login form:
    // - Must have a password field OR a Google SSO button (not just "sign in" text)
    // - Must NOT have many form fields (which would indicate an application form
    //   that just happens to mention "sign in" somewhere on the page, e.g. header)
    const looksLikeLoginForm = domSignals.hasPasswordField || domSignals.hasSignInWithGoogle;
    const isApplicationForm = domSignals.formFieldCount >= 5;

    if (domSignals.hasSignInWithGoogle && !isApplicationForm) {
      return { page_type: 'login', page_title: 'Workday Sign-In', has_sign_in_with_google: true };
    }

    if (looksLikeLoginForm && !isApplicationForm && domSignals.hasSignIn && !domSignals.hasApplyButton && !domSignals.hasSubmitApplication) {
      return { page_type: 'login', page_title: 'Workday Sign-In', has_sign_in_with_google: domSignals.hasSignInWithGoogle };
    }

    return null;
  }

  buildClassificationPrompt(urlHints: string[]): string {
    const urlContext = urlHints.length > 0 ? `URL context: ${urlHints.join(' ')} ` : '';
    return `${urlContext}Analyze the current page and determine what type of page this is in a Workday job application process.

CLASSIFICATION RULES (check in this order):
1. If the page has a "Sign in with Google" button, OR shows login/sign-in options (even if "Create Account" is also present) → classify as "login".
2. If the page heading/title contains "Application Questions" or "Additional Questions" or you see screening questions (radio buttons, dropdowns, text inputs asking about eligibility, availability, referral source, etc.) → classify as "questions".
3. If the page shows a summary of the entire application with a prominent "Submit" or "Submit Application" button → classify as "review".
4. If the page heading says "My Experience" or "Work Experience" or asks for resume upload → classify as "experience" or "resume_upload".
5. If the page asks for name, email, phone, address fields → classify as "personal_info".
6. If the page heading says "Voluntary Disclosures" and asks about gender, race/ethnicity, veteran status → classify as "voluntary_disclosure".
7. If the page heading says "Self Identify" or "Self-Identification" or asks specifically about disability status (e.g. "Please indicate if you have a disability") → classify as "self_identify".
8. If the page asks about gender, race/ethnicity, veteran status, disability but doesn't match rules 6 or 7 → classify as "voluntary_disclosure".
9. If you see ONLY a "Create Account" or "Sign Up" form with no sign-in option → classify as "account_creation".

IMPORTANT: Pages titled "Application Questions (1 of N)" or "(2 of N)" are ALWAYS "questions", never "experience".
IMPORTANT: If a page has BOTH "Sign In" and "Create Account" options, classify as "login" (NOT "account_creation").`;
  }

  async classifyByDOMFallback(adapter: BrowserAutomationAdapter): Promise<PageType> {
    const currentUrl = await adapter.getCurrentUrl();

    // URL-based fallback for Workday login pages
    if (currentUrl.includes('myworkdayjobs.com') && (currentUrl.includes('login') || currentUrl.includes('signin'))) {
      return 'login';
    }

    return adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id*="pageHeader"], [data-automation-id*="stepTitle"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');

      // REVIEW page detection FIRST (review contains all section headings as summary)
      const hasSelectOneDropdowns = Array.from(document.querySelectorAll('button')).some(b => (b.textContent || '').trim() === 'Select One');
      const hasFormInputs = document.querySelectorAll('input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]').length > 0;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const buttonTexts = buttons.map(b => (b.textContent || '').trim().toLowerCase());
      const hasSubmitButton = buttonTexts.some(t => t === 'submit' || t === 'submit application');
      const hasSaveAndContinue = buttonTexts.some(t => t.includes('save and continue'));

      // Review page: heading says "review" AND no form inputs / dropdowns to fill
      if (headingText.includes('review') && !hasFormInputs && !hasSelectOneDropdowns && !hasSaveAndContinue) return 'review' as PageType;
      if (hasSubmitButton && !hasSaveAndContinue && !hasSelectOneDropdowns && !hasFormInputs) return 'review' as PageType;

      const allText = headingText + ' ' + bodyText.substring(0, 2000);
      if (allText.includes('application questions') || allText.includes('additional questions')) return 'questions' as PageType;
      if (allText.includes('voluntary disclosures') || allText.includes('voluntary self')) return 'voluntary_disclosure' as PageType;
      if (allText.includes('self identify') || allText.includes('self-identify') || allText.includes('disability status')) return 'self_identify' as PageType;
      if (allText.includes('my experience') || allText.includes('work experience') || allText.includes('resume')) return 'experience' as PageType;
      if (allText.includes('my information') || allText.includes('personal info')) return 'personal_info' as PageType;
      return 'unknown' as PageType;
    });
  }

  // =========================================================================
  // Form Filling — Prompts & Data
  // =========================================================================

  buildDataPrompt(profile: Record<string, any>, qaOverrides: Record<string, string>): string {
    const p = profile as WorkdayUserProfile;
    const parts: string[] = [
      'FIELD-TO-VALUE MAPPING — read each field label and match it to the correct value:',
      '',
      '--- NAME FIELDS ---',
      `If the label says "First Name" or "Legal First Name" → type: ${p.first_name}`,
      `If the label says "Last Name" or "Legal Last Name" → type: ${p.last_name}`,
      '',
      '--- CONTACT FIELDS ---',
      `If the label says "Email" or "Email Address" → type: ${p.email}`,
      `If the label says "Phone Number" or "Phone" → type: ${p.phone}`,
      `If the label says "Phone Device Type" → select: ${p.phone_device_type || 'Mobile'}`,
      `If the label says "Country Phone Code" or "Phone Country Code" → select: ${p.phone_country_code || '+1'} (United States)`,
      '',
      '--- ADDRESS FIELDS ---',
      `If the label says "Country" or "Country/Territory" → select from dropdown: ${p.address.country}`,
      `If the label says "Address Line 1" or "Street" → type: ${p.address.street}`,
      `If the label says "City" → type: ${p.address.city}`,
      `If the label says "State" or "State/Province" → select from dropdown: ${p.address.state}`,
      `If the label says "Postal Code" or "ZIP" or "ZIP Code" → type: ${p.address.zip}`,
    ];

    if (p.linkedin_url) {
      parts.push('');
      parts.push('--- LINKS ---');
      parts.push(`If the label says "LinkedIn" → type: ${p.linkedin_url}`);
      if (p.website_url) parts.push(`If the label says "Website" → type: ${p.website_url}`);
    }

    if (p.education?.length > 0) {
      const edu = p.education[0];
      parts.push('');
      parts.push('--- EDUCATION ---');
      parts.push(`School/University → ${edu.school}`);
      parts.push(`Degree → ${edu.degree}`);
      parts.push(`Field of Study → ${edu.field_of_study}`);
      if (edu.gpa) parts.push(`GPA → ${edu.gpa}`);
      parts.push(`Start Date → ${edu.start_date}`);
      parts.push(`End Date → ${edu.end_date}`);
    }

    // Q&A overrides for screening questions
    if (Object.keys(qaOverrides).length > 0) {
      parts.push('');
      parts.push('--- SCREENING QUESTIONS — match the question text and select/type the answer ---');
      for (const [question, answer] of Object.entries(qaOverrides)) {
        parts.push(`If the question asks "${question}" → answer: ${answer}`);
      }
    }

    // Voluntary self-identification
    this._selfIdFields = {
      gender: p.gender || 'I do not wish to answer',
      race_ethnicity: p.race_ethnicity || 'I do not wish to answer',
      veteran_status: p.veteran_status || 'I am not a protected veteran',
      disability_status: p.disability_status || 'I do not wish to answer',
    };
    parts.push('');
    parts.push('--- SELF-IDENTIFICATION ---');
    parts.push(`Gender → ${this._selfIdFields.gender}`);
    parts.push(`Race/Ethnicity → ${this._selfIdFields.race_ethnicity}`);
    parts.push(`Veteran Status → ${this._selfIdFields.veteran_status}`);
    parts.push(`Disability Status → ${this._selfIdFields.disability_status}`);

    parts.push('');
    parts.push('--- GENERAL ---');
    parts.push(`Work Authorization → ${p.work_authorization}`);
    parts.push(`Visa Sponsorship → ${p.visa_sponsorship}`);
    parts.push('For unknown questions not listed above, skip the field rather than guessing.');
    parts.push('NESTED DROPDOWNS: Some dropdowns have sub-menus. After selecting a category (e.g. "Website"), a second list appears with specific options (e.g. "workday.com"). Select the sub-option. Do NOT click any back arrow or "← Category" button — that navigates backwards.');

    return parts.join('\n');
  }

  buildQAMap(profile: Record<string, any>, qaOverrides: Record<string, string>): Record<string, string> {
    const p = profile as WorkdayUserProfile;
    return {
      // Self-identification (voluntary disclosure) defaults
      'Gender': p.gender || 'I do not wish to answer',
      'Race/Ethnicity': p.race_ethnicity || 'I do not wish to answer',
      'Race': p.race_ethnicity || 'I do not wish to answer',
      // NOTE: Do NOT add bare 'Ethnicity' key — normalizeLabel("Ethnicity") = "ethnicity"
      // which contains "city" as a suffix, causing "City" fields to match it.
      // A dropdown labeled "Ethnicity" will still match via 'Race/Ethnicity' in Pass 3.
      'Veteran Status': p.veteran_status || 'I am not a protected veteran',
      'Are you a protected veteran': p.veteran_status || 'I am not a protected veteran',
      'Disability': p.disability_status || 'I do not wish to answer',
      'Disability Status': p.disability_status || 'I do not wish to answer',
      'Please indicate if you have a disability': p.disability_status || 'I do not wish to answer',
      // Contact info
      'Email': p.email,
      'Email Address': p.email,
      'Phone': p.phone,
      'Phone Number': p.phone,
      'City': p.address.city,
      'Address Line 1': p.address.street,
      'Street': p.address.street,
      'Address': p.address.street,
      'Postal Code': p.address.zip,
      'Zip Code': p.address.zip,
      'Zip': p.address.zip,
      // Contact info dropdowns
      'Country': p.address.country,
      'Country/Territory': p.address.country,
      'State': p.address.state,
      'State/Province': p.address.state,
      'Phone Device Type': p.phone_device_type || 'Mobile',
      'Phone Type': p.phone_device_type || 'Mobile',
      // Name fields — specific entries MUST come before generic "Name"
      'First Name': p.first_name,
      'Legal First Name': p.first_name,
      'Given Name': p.first_name,
      'Last Name': p.last_name,
      'Legal Last Name': p.last_name,
      'Family Name': p.last_name,
      'Surname': p.last_name,
      // Text field answers (signatures, generic name prompts)
      'Please enter your name': `${p.first_name} ${p.last_name}`,
      'Please enter your name:': `${p.first_name} ${p.last_name}`,
      'Enter your name': `${p.first_name} ${p.last_name}`,
      'Your name': `${p.first_name} ${p.last_name}`,
      'Full name': `${p.first_name} ${p.last_name}`,
      'Full Name': `${p.first_name} ${p.last_name}`,
      'Signature': `${p.first_name} ${p.last_name}`,
      'What is your desired salary?': 'Open to discussion',
      'Desired salary': 'Open to discussion',
      // User-provided Q&A overrides take highest priority
      ...qaOverrides,
    };
  }

  buildPagePrompt(pageType: PageType, dataBlock: string): string {
    switch (pageType) {
      case 'personal_info':
        return buildPersonalInfoPrompt(dataBlock);
      case 'questions':
        return buildFormPagePrompt('application questions', dataBlock);
      case 'voluntary_disclosure':
        return buildVoluntaryDisclosurePrompt(this._selfIdFields ?? {
          gender: 'I do not wish to answer',
          race_ethnicity: 'I do not wish to answer',
          veteran_status: 'I am not a protected veteran',
          disability_status: 'I do not wish to answer',
        });
      case 'self_identify':
        return buildSelfIdentifyPrompt(this._selfIdFields ?? {
          gender: 'I do not wish to answer',
          race_ethnicity: 'I do not wish to answer',
          veteran_status: 'I am not a protected veteran',
          disability_status: 'I do not wish to answer',
        });
      default:
        return buildGenericPagePrompt(dataBlock);
    }
  }

  // =========================================================================
  // Scan-First Field Discovery
  // =========================================================================

  async scanPageFields(adapter: BrowserAutomationAdapter): Promise<ScanResult> {
    // Start with the generic scan
    const { GenericPlatformConfig } = await import('./genericConfig.js');
    const generic = new GenericPlatformConfig();
    const scan = await generic.scanPageFields(adapter);

    // Workday enhancement: detect "Select One" buttons as unfilled dropdowns
    const workdayDropdowns = await adapter.page.evaluate(() => {
      const fields: any[] = [];
      const buttons = document.querySelectorAll('button');
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if ((btn.textContent || '').trim() !== 'Select One') continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Already tagged by generic scan?
        if (btn.getAttribute('data-gh-scan-idx')) continue;

        // Extract label (walk up for label text)
        let label = '';
        let node: HTMLElement | null = btn.parentElement;
        for (let d = 0; d < 10 && node; d++) {
          const lbl = node.querySelector('label, [data-automation-id*="formLabel"]');
          if (lbl && (lbl.textContent || '').trim() !== 'Select One') {
            label = (lbl.textContent || '').trim();
            break;
          }
          node = node.parentElement;
        }
        if (!label) {
          const parent = btn.closest('[data-automation-id]');
          if (parent) {
            const t = (parent.textContent || '').replace(/Select One/g, '').replace(/Required/gi, '').replace(/[*]/g, '').trim();
            if (t.length > 3 && t.length < 200) label = t;
          }
        }

        const idx = 'wd-dd-' + i;
        btn.setAttribute('data-gh-scan-idx', idx);
        fields.push({
          id: 'field-wd-dd-' + i,
          kind: 'custom_dropdown',
          fillStrategy: 'click_option',
          selector: '[data-gh-scan-idx="' + idx + '"]',
          label: label.substring(0, 120),
          currentValue: '',
          absoluteY: rect.top + window.scrollY,
          isRequired: true,
          filled: false,
          platformMeta: { widgetType: 'workday_select_one' },
        });
      }
      return fields;
    }) as ScannedField[];

    // Merge Workday-specific fields, avoiding duplicates by label
    const existingLabels = new Set(scan.fields.map(f => f.label.toLowerCase()));
    for (const wd of workdayDropdowns) {
      if (!existingLabels.has(wd.label.toLowerCase())) {
        scan.fields.push(wd);
      }
    }

    // Re-sort by position
    scan.fields.sort((a, b) => a.absoluteY - b.absoluteY);
    return scan;
  }

  async fillScannedField(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean> {
    // Workday "Select One" dropdown — use the existing clickDropdownOption logic
    if (field.platformMeta?.widgetType === 'workday_select_one') {
      try {
        const locator = adapter.page.locator(field.selector).first();
        await locator.scrollIntoViewIfNeeded();
        await adapter.page.waitForTimeout(200);
        await locator.click();
        await adapter.page.waitForTimeout(600);
        const clicked = await this.clickDropdownOption(adapter, answer);
        if (!clicked) {
          await adapter.page.keyboard.press('Escape');
          await adapter.page.waitForTimeout(300);
          return false;
        }
        await adapter.page.waitForTimeout(500);
        return true;
      } catch {
        return false;
      }
    }

    // Everything else — delegate to generic
    const { GenericPlatformConfig } = await import('./genericConfig.js');
    const generic = new GenericPlatformConfig();
    return generic.fillScannedField(adapter, field, answer);
  }

  // =========================================================================
  // Programmatic DOM Helpers (legacy, kept for backward compatibility)
  // =========================================================================

  /**
   * Workday dropdown filler — 8-strategy label finder + click option with
   * type-to-filter and arrow-scroll fallback.
   */
  async fillDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    // Scan page for all unfilled dropdowns with "Select One" buttons.
    // Uses string-based evaluate to avoid Bun/esbuild __name injection.
    const dropdownInfos: Array<{ index: number; label: string }> = await adapter.page.evaluate(`
      (() => {
        var results = [];
        var buttons = document.querySelectorAll('button');
        var idx = 0;

        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var text = (btn.textContent || '').trim();
          if (text !== 'Select One') continue;

          var rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          btn.setAttribute('data-gh-dropdown-idx', String(idx));

          var labelText = '';

          // Strategy 1: aria-label on the button or a close ancestor
          if (!labelText) {
            var ariaLabel = btn.getAttribute('aria-label');
            if (!ariaLabel || ariaLabel === 'Select One') {
              var ariaParent = btn.closest('[aria-label]');
              if (ariaParent) ariaLabel = ariaParent.getAttribute('aria-label');
            }
            if (ariaLabel && ariaLabel !== 'Select One') {
              labelText = ariaLabel;
            }
          }

          // Strategy 2: Walk up to find a <label> tag
          if (!labelText) {
            var node = btn.parentElement;
            for (var d = 0; d < 10 && node; d++) {
              var lbl = node.querySelector('label');
              if (lbl && (lbl.textContent || '').trim() && (lbl.textContent || '').trim() !== 'Select One') {
                labelText = (lbl.textContent || '').trim();
                break;
              }
              node = node.parentElement;
            }
          }

          // Strategy 3: data-automation-id labels (Workday-specific)
          if (!labelText) {
            var daParent = btn.closest('[data-automation-id]');
            if (daParent) {
              var labelEls = daParent.querySelectorAll('[data-automation-id*="formLabel"], [data-automation-id*="label"], [data-automation-id*="questionText"]');
              for (var le = 0; le < labelEls.length; le++) {
                var t = (labelEls[le].textContent || '').trim();
                if (t && t !== 'Select One' && t.length > 3) {
                  labelText = t;
                  break;
                }
              }
            }
          }

          // Strategy 4: Find nearest ancestor with exactly one "Select One" button
          if (!labelText) {
            var ancestor = btn.parentElement;
            for (var up = 0; up < 12 && ancestor; up++) {
              var selectBtns = ancestor.querySelectorAll('button');
              var selectOneCount = 0;
              for (var sb = 0; sb < selectBtns.length; sb++) {
                if ((selectBtns[sb].textContent || '').trim() === 'Select One') selectOneCount++;
              }
              if (selectOneCount === 1) {
                var fullText = (ancestor.textContent || '').trim();
                var cleaned = fullText
                  .replace(/Select One/g, '')
                  .replace(/Required/gi, '')
                  .replace(/[*]/g, '')
                  .trim();
                if (cleaned.length > 8) {
                  labelText = cleaned;
                  break;
                }
              }
              ancestor = ancestor.parentElement;
            }
          }

          // Strategy 5: Walk up and check preceding siblings
          if (!labelText) {
            var container = btn.parentElement;
            for (var u = 0; u < 8 && container; u++) {
              var prev = container.previousElementSibling;
              if (prev) {
                var pt = (prev.textContent || '').trim();
                if (pt && pt.length > 5 && pt !== 'Select One' && pt !== 'Required') {
                  labelText = pt;
                  break;
                }
              }
              container = container.parentElement;
            }
          }

          // Strategy 6: Look at text in parent divs (up to 6 levels)
          if (!labelText) {
            var parentNode = btn.parentElement;
            for (var p = 0; p < 6 && parentNode; p++) {
              var childNodes = parentNode.childNodes;
              for (var cn = 0; cn < childNodes.length; cn++) {
                var child = childNodes[cn];
                if (child === btn) continue;
                if (child.contains && child.contains(btn)) continue;
                var candidateText = '';
                if (child.nodeType === 3) {
                  candidateText = (child.textContent || '').trim();
                } else if (child.nodeType === 1) {
                  var tag = (child.tagName || '').toLowerCase();
                  if (tag === 'button' || tag === 'input' || tag === 'select') continue;
                  candidateText = (child.textContent || '').trim();
                }
                if (candidateText && candidateText.length > 5
                    && candidateText !== 'Select One'
                    && candidateText !== 'Required') {
                  labelText = candidateText;
                  break;
                }
              }
              if (labelText) break;
              parentNode = parentNode.parentElement;
            }
          }

          // Strategy 7: aria-describedby / aria-labelledby + relaxed ancestor walk
          if (!labelText) {
            var describedBy = btn.getAttribute('aria-describedby') || btn.getAttribute('aria-labelledby');
            if (describedBy) {
              var ids = describedBy.split(/\\s+/);
              for (var di = 0; di < ids.length; di++) {
                var el = document.getElementById(ids[di]);
                if (el) {
                  var txt = (el.textContent || '').trim();
                  if (txt && txt.length > 5 && txt !== 'Select One') {
                    labelText = txt;
                    break;
                  }
                }
              }
            }
          }
          if (!labelText) {
            var anc = btn.parentElement;
            for (var w = 0; w < 15 && anc; w++) {
              var ancText = (anc.textContent || '');
              var stripped = ancText
                .replace(/Select One/g, '')
                .replace(/Required/gi, '')
                .replace(/[*]/g, '')
                .trim();
              if (stripped.length > 15 && stripped.length < 2000) {
                var sentences = stripped.split(/[.?!\\n]/).filter(function(s) { return s.trim().length > 10; });
                if (sentences.length > 0) {
                  labelText = sentences[0].trim();
                  break;
                }
              }
              anc = anc.parentElement;
            }
          }

          // Strategy 8: Positional — find text blocks geometrically above the button
          if (!labelText) {
            var btnRect = btn.getBoundingClientRect();
            var bestDist = 9999;
            var bestText = '';
            var textEls = document.querySelectorAll('p, div, span, label, h1, h2, h3, h4, h5, li');
            for (var te = 0; te < textEls.length; te++) {
              var tel = textEls[te];
              if (tel.contains(btn) || tel === btn) continue;
              if (tel.closest('[role="listbox"]')) continue;
              var telRect = tel.getBoundingClientRect();
              if (telRect.bottom > btnRect.top) continue;
              var dist = btnRect.top - telRect.bottom;
              if (dist > 300) continue;
              var telText = (tel.textContent || '').trim();
              if (!telText || telText.length < 10 || telText === 'Select One' || telText === 'Required') continue;
              if (tel.children.length > 5) continue;
              if (dist < bestDist) {
                bestDist = dist;
                bestText = telText;
              }
            }
            if (bestText) {
              labelText = bestText;
            }
          }

          // Clean up label text
          labelText = labelText
            .replace(/\\s*\\*\\s*/g, ' ')
            .replace(/\\s*Required\\s*/gi, '')
            .replace(/\\s+/g, ' ')
            .replace(/Select One/g, '')
            .trim();
          if (labelText.length > 200) {
            labelText = labelText.substring(0, 200).trim();
          }

          results.push({ index: idx, label: labelText });
          idx++;
        }

        return results;
      })()
    `);

    if (dropdownInfos.length === 0) return 0;

    console.log(`[Workday] [Programmatic] Found ${dropdownInfos.length} unfilled dropdown(s):`);
    for (const info of dropdownInfos) {
      console.log(`  [${info.index}] label="${info.label || '(empty)'}"`);
    }

    let filled = 0;

    for (const info of dropdownInfos) {
      const answer = findBestDropdownAnswer(info.label, qaMap);
      if (!answer) {
        console.log(`[Workday] [Programmatic] No answer matched for: "${info.label}"`);
        continue;
      }

      // Verify the button still shows "Select One"
      const btn = adapter.page.locator(`button[data-gh-dropdown-idx="${info.index}"]`);
      const stillUnfilled = await btn.textContent().catch(() => '');
      if (!stillUnfilled?.includes('Select One')) continue;

      console.log(`[Workday] [Programmatic] Filling: "${info.label}" → "${answer}"`);

      await btn.scrollIntoViewIfNeeded();
      await adapter.page.waitForTimeout(200);
      await btn.click();
      await adapter.page.waitForTimeout(600);

      let clicked = await this.clickDropdownOption(adapter, answer);

      // Retry with dispatchEvent if wrong dropdown opened
      if (!clicked) {
        await adapter.page.keyboard.press('Escape');
        await adapter.page.waitForTimeout(300);

        console.log(`[Workday] [Programmatic] Retrying with dispatchEvent for: "${info.label}"`);
        await adapter.page.evaluate((idx: string) => {
          const el = document.querySelector(`button[data-gh-dropdown-idx="${idx}"]`);
          if (el) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }, String(info.index));
        await adapter.page.waitForTimeout(600);

        clicked = await this.clickDropdownOption(adapter, answer);
      }

      if (clicked) {
        filled++;
        await adapter.page.waitForTimeout(500);
      } else {
        await adapter.page.keyboard.press('Escape');
        await adapter.page.waitForTimeout(300);
        console.warn(`[Workday] [Programmatic] Option "${answer}" not found for "${info.label}"`);
      }
    }

    // Clean up temporary attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-dropdown-idx]').forEach(el => {
        el.removeAttribute('data-gh-dropdown-idx');
      });
    });

    return filled;
  }

  // Workday text fields use the same DOM approach as generic.
  async fillTextFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    // Reuse the generic implementation — Workday text inputs are standard DOM elements
    const { GenericPlatformConfig } = await import('./genericConfig.js');
    const generic = new GenericPlatformConfig();
    return generic.fillTextFieldsProgrammatically(adapter, qaMap);
  }

  // Workday radio buttons use the same DOM approach as generic.
  async fillRadioButtonsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number> {
    const { GenericPlatformConfig } = await import('./genericConfig.js');
    const generic = new GenericPlatformConfig();
    return generic.fillRadioButtonsProgrammatically(adapter, qaMap);
  }

  // Workday has its own dropdown handling in fillDropdownsProgrammatically — no-op here.
  async fillCustomDropdownsProgrammatically(
    _adapter: BrowserAutomationAdapter,
    _qaMap: Record<string, string>,
  ): Promise<number> {
    return 0;
  }

  /**
   * Workday segmented date fields (MM/DD/YYYY) — click MM, type full digits,
   * Workday auto-advances through segments.
   */
  async fillDateFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
    _qaMap: Record<string, string>,
  ): Promise<number> {
    const dateFields = await adapter.page.evaluate(`
      (() => {
        var results = [];
        var dateInputs = document.querySelectorAll(
          'input[placeholder*="MM"], input[data-automation-id*="dateSectionMonth"], input[aria-label*="Month"], input[aria-label*="date"]'
        );
        for (var i = 0; i < dateInputs.length; i++) {
          var inp = dateInputs[i];
          var rect = inp.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          if (inp.value && inp.value.trim() !== '' && inp.value !== 'MM') continue;
          inp.setAttribute('data-gh-date-idx', String(i));
          var label = '';
          var ancestor = inp.parentElement;
          for (var up = 0; up < 8 && ancestor; up++) {
            var labels = ancestor.querySelectorAll('label, [data-automation-id*="formLabel"]');
            for (var l = 0; l < labels.length; l++) {
              var t = (labels[l].textContent || '').trim();
              if (t && t.length > 3) { label = t; break; }
            }
            if (label) break;
            var allText = (ancestor.textContent || '').trim();
            if (allText.length > 5 && allText.length < 200 && !allText.includes('Select One')) {
              label = allText.replace(/MM.*YYYY/g, '').replace(/[*]/g, '').replace(/Required/gi, '').trim();
              if (label.length > 5) break;
              label = '';
            }
            ancestor = ancestor.parentElement;
          }
          results.push({ index: i, label: label });
        }
        return results;
      })()
    `) as Array<{ index: number; label: string }>;

    if (dateFields.length === 0) return 0;

    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const todayDigits = `${mm}${dd}${yyyy}`;

    // Dynamic graduation date: May of next year if past May, otherwise May of this year
    const gradYear = now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear();
    const graduationDigits = `0501${gradYear}`;

    let filled = 0;
    for (const field of dateFields) {
      const labelLower = field.label.toLowerCase();
      let dateValue = todayDigits;

      if (labelLower.includes('graduation') || labelLower.includes('expected')) {
        dateValue = graduationDigits;
      } else if (labelLower.includes('start')) {
        // Default start date: use today's date (will be overridden by profile data via LLM)
        dateValue = todayDigits;
      } else if (labelLower.includes('end')) {
        dateValue = graduationDigits;
      }

      console.log(`[Workday] [Date] Filling "${field.label || 'date field'}" → ${dateValue.substring(0, 2)}/${dateValue.substring(2, 4)}/${dateValue.substring(4)}`);

      const clicked = await adapter.page.evaluate((idx: string) => {
        const el = document.querySelector(`input[data-gh-date-idx="${idx}"]`) as HTMLInputElement;
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        el.click();
        return true;
      }, String(field.index));

      if (!clicked) {
        console.warn(`[Workday] [Date] Could not find date input ${field.index}`);
        continue;
      }

      await adapter.page.waitForTimeout(300);
      await adapter.page.keyboard.type(dateValue, { delay: 80 });
      await adapter.page.waitForTimeout(200);
      await adapter.page.keyboard.press('Tab');
      await adapter.page.waitForTimeout(200);
      filled++;
    }

    // Clean up temporary attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-date-idx]').forEach(el => {
        el.removeAttribute('data-gh-date-idx');
      });
    });

    return filled;
  }

  async checkRequiredCheckboxes(adapter: BrowserAutomationAdapter): Promise<number> {
    const checked = await adapter.page.evaluate(`
      (() => {
        var count = 0;
        var checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < checkboxes.length; i++) {
          var cb = checkboxes[i];
          if (cb.checked) continue;
          var rect = cb.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
          var parent = cb.closest('div, label, fieldset');
          var parentText = (parent ? parent.textContent : '').toLowerCase();
          if (parentText.includes('acknowledge') || parentText.includes('terms') ||
              parentText.includes('agree') || parentText.includes('privacy') ||
              parentText.includes('i have read')) {
            cb.click();
            count++;
          }
        }
        return count;
      })()
    `) as number;

    if (checked > 0) {
      console.log(`[Workday] [Checkbox] Checked ${checked} required checkbox(es)`);
    }
    return checked;
  }

  async hasEmptyVisibleFields(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const result = await adapter.page.evaluate(() => {
      const emptyFields: string[] = [];

      // Check text inputs and textareas
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
      );
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (input.disabled || input.readOnly) continue;
        if (input.type === 'hidden') continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

        // Skip Workday date segments
        const placeholder = input.placeholder?.toUpperCase() || '';
        if (placeholder === 'MM' || placeholder === 'DD' || placeholder === 'YYYY') continue;

        // Skip inputs inside dropdowns
        if (input.closest('[role="listbox"], [role="combobox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]')) continue;

        if (rect.width < 20 || rect.height < 10) continue;
        if (input.getAttribute('aria-hidden') === 'true') continue;

        const style = window.getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        // Skip optional internal Workday fields
        const automationId = input.getAttribute('data-automation-id') || '';
        const fieldName = input.name || input.id || '';
        const fieldLabel = input.getAttribute('aria-label') || '';
        const fieldIdentifier = (automationId + ' ' + fieldName + ' ' + fieldLabel).toLowerCase();
        if (fieldIdentifier.includes('extension') || fieldIdentifier.includes('countryphone') ||
            fieldIdentifier.includes('country-phone') || fieldIdentifier.includes('phonecode') ||
            fieldIdentifier.includes('middlename') || fieldIdentifier.includes('middle-name') ||
            fieldIdentifier.includes('middle name')) continue;

        if (!input.value || input.value.trim() === '') {
          emptyFields.push(`input:"${fieldLabel || automationId || fieldName || 'text'}"`);
        }
      }

      // Check for unfilled dropdowns ("Select One" buttons)
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim();
        if (text !== 'Select One') continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        emptyFields.push(`dropdown:"Select One"`);
      }

      // Check for unchecked required checkboxes
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (cb.checked) continue;
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const parent = cb.closest('div, label, fieldset');
        const parentText = (parent?.textContent || '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('required') || parentText.includes('*')) {
          emptyFields.push(`checkbox:"${parentText.substring(0, 60)}..."`);
        }
      }

      // Check for unanswered radio button groups
      const radioGroups = new Set<string>();
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(r => {
        if (r.name) radioGroups.add(r.name);
      });
      for (const groupName of radioGroups) {
        const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${groupName}"]`);
        const anyChecked = Array.from(radios).some(r => r.checked);
        if (!anyChecked) {
          for (const r of radios) {
            const rect = r.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight) {
              emptyFields.push(`radio:${groupName}`);
              break;
            }
          }
        }
      }

      return emptyFields;
    });

    if (result.length > 0) {
      console.log(`[Workday] [EmptyCheck] Found ${result.length} empty field(s): ${result.join(', ')}`);
      return true;
    }
    return false;
  }

  async centerNextEmptyField(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const centered = await adapter.page.evaluate(() => {
      // 1. Empty text inputs / textareas
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea'
      );
      for (const inp of inputs) {
        if (inp.disabled || inp.readOnly) continue;
        if (inp.type === 'hidden') continue;
        const rect = inp.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Skip date segment inputs
        const ph = (inp.placeholder || '').toUpperCase();
        if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
        // Skip internal dropdown inputs
        if (inp.closest('[role="listbox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]')) continue;
        // Skip hidden via CSS
        const style = window.getComputedStyle(inp);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (inp.getAttribute('aria-hidden') === 'true') continue;
        // Skip optional internal fields
        const ident = ((inp.getAttribute('data-automation-id') || '') + ' ' + (inp.name || '') + ' ' + (inp.getAttribute('aria-label') || '')).toLowerCase();
        if (ident.includes('extension') || ident.includes('countryphone') || ident.includes('phonecode') || ident.includes('middlename') || ident.includes('middle name') || ident.includes('middle-name')) continue;

        if (!inp.value || inp.value.trim() === '') {
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      // 2. Unfilled dropdowns ("Select One" buttons)
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text !== 'Select One') continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }

      // 3. Unchecked required checkboxes
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:checked)');
      for (const cb of checkboxes) {
        const rect = cb.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const parent = cb.closest('div, label, fieldset');
        const parentText = (parent?.textContent || '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('required') || parentText.includes('*')) {
          cb.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      return false;
    });

    if (centered) {
      await adapter.page.waitForTimeout(300);
    }
    return centered;
  }

  // =========================================================================
  // Navigation
  // =========================================================================

  /**
   * Click "Save and Continue" / "Next" via DOM.
   * Safety: if only "Submit" is available, check for review page first.
   */
  async clickNextButton(adapter: BrowserAutomationAdapter): Promise<'clicked' | 'review_detected' | 'not_found'> {
    const result = await adapter.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));

      // Priority 1: Safe buttons that never submit
      const safePriorities = ['save and continue', 'next', 'continue'];
      for (const target of safePriorities) {
        const btn = buttons.find(b => (b.textContent?.trim().toLowerCase() || '') === target);
        if (btn) {
          (btn as HTMLElement).click();
          return 'clicked';
        }
      }
      // Partial match for safe buttons
      const fallback = buttons.find(b => {
        const text = b.textContent?.trim().toLowerCase() || '';
        return text.includes('save and continue') || text.includes('next');
      });
      if (fallback) {
        (fallback as HTMLElement).click();
        return 'clicked';
      }

      // Priority 2: "Submit" — only if NOT on the review page
      const submitBtn = buttons.find(b => {
        const text = b.textContent?.trim().toLowerCase() || '';
        return text === 'submit' || text === 'submit application';
      });
      if (submitBtn) {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
        const isReviewHeading = headings.some(h => (h.textContent || '').toLowerCase().includes('review'));
        const hasEditableInputs = document.querySelectorAll(
          'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
        ).length > 0;
        const hasSelectOne = buttons.some(b => (b.textContent?.trim() || '') === 'Select One');
        // Only count VISIBLE unchecked checkboxes as blocking review
        const hasUncheckedRequired = Array.from(document.querySelectorAll('input[type="checkbox"]:not(:checked)')).some(cb => {
          const rect = (cb as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        if (isReviewHeading || (!hasEditableInputs && !hasSelectOne && !hasUncheckedRequired)) {
          return 'review_detected';
        }

        (submitBtn as HTMLElement).click();
        return 'clicked';
      }

      return 'not_found';
    });

    if (result === 'not_found') {
      // Last resort: LLM with strict instruction
      console.warn('[Workday] DOM click failed, falling back to LLM act()');
      try {
        await adapter.act(
          'Click the "Save and Continue" button. Click ONLY that button and then STOP. Do absolutely nothing else. Do NOT click "Submit" or "Submit Application".',
        );
        return 'clicked';
      } catch {
        // LLM also couldn't find a button — report not_found so caller
        // doesn't assume navigation succeeded
        return 'not_found';
      }
    }

    return result as 'clicked' | 'review_detected' | 'not_found';
  }

  async detectValidationErrors(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const errorBanner = document.querySelector(
        '[data-automation-id="errorMessage"], [role="alert"], .css-1fdonr0, [class*="WJLK"]'
      );
      if (errorBanner && errorBanner.textContent?.toLowerCase().includes('error')) return true;
      const allText = document.body.innerText;
      return allText.includes('Errors Found') || allText.includes('Error -');
    });
  }

  // =========================================================================
  // Optional Platform-Specific Overrides
  // =========================================================================

  /**
   * Workday's "My Experience" page requires a custom handler because
   * fields are hidden behind "Add" buttons and resume must be uploaded via DOM.
   */
  async handleExperiencePage(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
    _dataPrompt: string,
  ): Promise<void> {
    const userProfile = profile as WorkdayUserProfile;

    console.log('[Workday] On My Experience page — uploading resume via DOM, then LLM fills sections...');

    // Scroll to top first
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    // ==================== DOM-ONLY: Upload Resume ====================
    if (userProfile.resume_path) {
      console.log('[Workday] [MyExperience] Uploading resume via DOM...');
      const resumePath = path.isAbsolute(userProfile.resume_path)
        ? userProfile.resume_path
        : path.resolve(process.cwd(), userProfile.resume_path);

      if (!fs.existsSync(resumePath)) {
        console.warn(`[Workday] [MyExperience] Resume not found at ${resumePath} — skipping upload.`);
      } else {
        try {
          const fileInput = adapter.page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(resumePath);
          console.log('[Workday] [MyExperience] Resume file set via DOM file input.');
          await adapter.page.waitForTimeout(5000);

          const uploadOk = await adapter.page.evaluate(() => {
            return document.body.innerText.toLowerCase().includes('successfully uploaded')
              || document.body.innerText.toLowerCase().includes('successfully');
          });
          if (uploadOk) {
            console.log('[Workday] [MyExperience] Resume upload confirmed.');
          } else {
            console.warn('[Workday] [MyExperience] Resume upload status unclear — continuing.');
          }
        } catch (err) {
          console.warn(`[Workday] [MyExperience] Resume upload failed: ${err}`);
        }
      }
    }

    // ==================== DOM-ONLY: Fill Skills ====================
    if (userProfile.skills && userProfile.skills.length > 0) {
      await this.fillSkillsProgrammatically(adapter, userProfile.skills);
    }

    // ==================== LLM fills everything else ====================
    const exp = userProfile.experience?.[0];
    const edu = userProfile.education?.[0];

    let dataBlock = `CRITICAL — DO NOT TOUCH THESE SECTIONS:
- "Websites" section: Do NOT click its "Add" button. Do NOT interact with it at all. Leave it completely empty. Clicking "Add" on Websites creates a required URL field that causes errors.
- "Certifications" section: Do NOT click its "Add" button. Leave it empty.
- Do NOT add more than one work experience entry.
- Do NOT add more than one education entry.

MY EXPERIENCE PAGE DATA:
`;

    if (exp) {
      const fromDate = exp.start_date ? (() => {
        const parts = exp.start_date.split('-');
        return parts.length >= 2 ? `${parts[1]}/${parts[0]}` : exp.start_date;
      })() : '';
      dataBlock += `
WORK EXPERIENCE (click "Add" under Work Experience section first):
  Job Title: ${exp.title}
  Company: ${exp.company}
  Location: ${exp.location || ''}
  I currently work here: ${exp.currently_work_here ? 'YES — check the checkbox' : 'No'}
  From date: ${fromDate} — IMPORTANT: The date field has TWO parts side by side: MM on the LEFT and YYYY on the RIGHT. You MUST click on the LEFT part (the MM box) first, NOT the right part (YYYY). Then type "${fromDate.replace('/', '')}" as continuous digits — Workday will auto-advance from the MM box to the YYYY box as you type.
  Role Description: ${exp.description}
`;
    }

    if (edu) {
      dataBlock += `
EDUCATION (click "Add" under Education section first):
  School or University: ${edu.school}
  Degree: ${edu.degree} (this is a DROPDOWN — click it, then type "${edu.degree}" to filter and select)
  Field of Study: ${edu.field_of_study} (this is a TYPEAHEAD — type "${edu.field_of_study}", wait for suggestions to load, then press Enter to select the first match)
`;
    }

    // Skills are handled programmatically BEFORE the LLM loop — see fillSkillsProgrammatically()
    // Only fall back to LLM if programmatic fill didn't handle all skills.
    if (userProfile.skills && userProfile.skills.length > 0) {
      dataBlock += `
SKILLS: If any skills still need to be added (check if the skills section already shows tags/chips),
  use the skills input (usually has placeholder "Type to Add Skills"):
  1. Click the skills input field
  2. Type the skill name (e.g. "Python")
  3. Press Enter to search
  4. WAIT 2 seconds for the autocomplete results to appear
  5. Click the correct matching result from the dropdown
  6. Click on empty whitespace to dismiss the dropdown
  7. Repeat for each remaining skill
  Skills to add: ${userProfile.skills.map(s => `"${s}"`).join(', ')}
`;
    }

    if (userProfile.linkedin_url) {
      dataBlock += `
LINKEDIN (under "Social Network URLs" section — NOT under "Websites"):
  LinkedIn: ${userProfile.linkedin_url}
  NOTE: The LinkedIn field is in the "Social Network URLs" section, which is DIFFERENT from the "Websites" section. Only fill the LinkedIn field.
`;
    }

    const fillPrompt = buildExperiencePrompt(dataBlock);

    // Custom scroll+LLM loop: ALWAYS invoke LLM each round because fields
    // are behind "Add" buttons that hasEmptyVisibleFields() can't detect.
    const MAX_SCROLL_ROUNDS = 8;
    const MAX_LLM_CALLS = 6;
    let llmCallCount = 0;

    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    for (let round = 1; round <= MAX_SCROLL_ROUNDS; round++) {
      if (llmCallCount < MAX_LLM_CALLS) {
        // On round 1, stay at the top of the page so the LLM sees "Add" buttons
        // for Work Experience / Education. centerNextEmptyField would jump to
        // the skills input (first empty text field) and skip those sections.
        if (round > 1) {
          await this.centerNextEmptyField(adapter);
        }
        console.log(`[Workday] [MyExperience] LLM fill round ${round} (call ${llmCallCount + 1}/${MAX_LLM_CALLS})...`);
        await adapter.act(fillPrompt);
        llmCallCount++;
        await adapter.page.waitForTimeout(1000);
      }

      const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
      const scrollMax = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );

      if (scrollBefore >= scrollMax - 10) {
        console.log('[Workday] [MyExperience] Reached bottom of page.');
        break;
      }

      await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
      await adapter.page.waitForTimeout(800);

      const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
      if (scrollAfter <= scrollBefore) {
        console.log('[Workday] [MyExperience] Cannot scroll further.');
        break;
      }

      console.log(`[Workday] [MyExperience] Scrolled to ${scrollAfter}px (round ${round})...`);
    }

    console.log(`[Workday] [MyExperience] Page complete. Total LLM calls: ${llmCallCount}`);
    // NOTE: Navigation (clickNext) is handled by SmartApplyHandler after this returns
  }

  /**
   * Search open skill dropdown results for a matching option and click it.
   * Returns true if an option was clicked.
   */
  private async findAndClickSkillOption(
    adapter: BrowserAutomationAdapter,
    skill: string,
  ): Promise<boolean> {
    return adapter.page.evaluate((skillName: string) => {
      const normSkill = skillName.toLowerCase().trim();
      // Broad selector set covering Workday dropdown variants
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
        '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"], ' +
        '[data-automation-id*="searchOption"], ' +
        '[class*="option"], [class*="menu-item"], [class*="multiselectItem"]'
      );

      let bestMatch: HTMLElement | null = null;
      let bestScore = 0;

      for (const opt of options) {
        const el = opt as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim().toLowerCase();
        if (!text || text === 'no items.' || text === 'no results') continue;

        // Exact match
        if (text === normSkill) { bestMatch = el; bestScore = 100; break; }
        // Option starts with skill name
        if (text.startsWith(normSkill)) {
          const score = 90;
          if (score > bestScore) { bestScore = score; bestMatch = el; }
        }
        // Skill name starts with option text (e.g. option "Python" matches skill "Python (Programming)")
        if (normSkill.startsWith(text)) {
          const score = 85;
          if (score > bestScore) { bestScore = score; bestMatch = el; }
        }
        // Option contains skill name
        if (text.includes(normSkill) && text.length < normSkill.length * 3) {
          const score = 70 + (normSkill.length / text.length) * 20;
          if (score > bestScore) { bestScore = score; bestMatch = el; }
        }
        // Skill name contains option text (e.g. skill "Cloud Infrastructure" matches option "Cloud")
        if (normSkill.includes(text) && text.length >= 3) {
          const score = 60;
          if (score > bestScore) { bestScore = score; bestMatch = el; }
        }
      }

      if (bestMatch) {
        bestMatch.click();
        return true;
      }

      // If no fuzzy match, take the first non-empty visible option
      for (const opt of options) {
        const el = opt as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim().toLowerCase();
        if (text && text !== 'no items.' && text !== 'no results') {
          el.click();
          return true;
        }
      }

      return false;
    }, skill);
  }

  /**
   * Programmatically fill the Workday skills typeahead field.
   * Pattern: click input → type skill → press Enter → wait for results → click match.
   */
  private async fillSkillsProgrammatically(
    adapter: BrowserAutomationAdapter,
    skills: string[],
  ): Promise<void> {
    console.log(`[Workday] [Skills] Filling ${skills.length} skills programmatically...`);

    // Scroll down to find the skills section
    const skillsFound = await adapter.page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label, [data-automation-id*="label"], span'));
      for (const el of labels) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.includes('skills') || text.includes('type to add')) {
          el.scrollIntoView({ block: 'center' });
          return true;
        }
      }
      // Also look for the input directly
      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder*="Skills" i], input[placeholder*="skill" i], ' +
        'input[data-automation-id*="skill" i], input[aria-label*="skill" i]'
      );
      if (input) {
        input.scrollIntoView({ block: 'center' });
        return true;
      }
      return false;
    });

    if (!skillsFound) {
      console.log('[Workday] [Skills] Skills input not found on page — LLM will handle.');
      return;
    }
    await adapter.page.waitForTimeout(500);

    for (const skill of skills) {
      console.log(`[Workday] [Skills] Adding skill: "${skill}"...`);

      // Find and click the skills input
      const inputClicked = await adapter.page.evaluate(() => {
        const sels = [
          'input[placeholder*="Skills" i]', 'input[placeholder*="skill" i]',
          'input[data-automation-id*="skill" i]', 'input[aria-label*="skill" i]',
          'input[placeholder*="Type to Add" i]',
        ];
        for (const sel of sels) {
          const input = document.querySelector<HTMLInputElement>(sel + ':not([disabled])');
          if (input && input.getBoundingClientRect().width > 0) {
            input.focus();
            input.click();
            return true;
          }
        }
        return false;
      });

      if (!inputClicked) {
        console.log(`[Workday] [Skills] Could not find skills input for "${skill}" — skipping.`);
        continue;
      }

      await adapter.page.waitForTimeout(300);

      // Clear any existing text and type the skill name
      await adapter.page.keyboard.press('Control+a');
      await adapter.page.keyboard.press('Backspace');
      await adapter.page.keyboard.type(skill, { delay: 50 });
      await adapter.page.waitForTimeout(300);

      // Press Enter to trigger the Workday server-side search
      await adapter.page.keyboard.press('Enter');
      await adapter.page.waitForTimeout(3000); // Wait for search results to load (server round-trip)

      // Look for matching option in dropdown results and click it
      let selected = await this.findAndClickSkillOption(adapter, skill);

      // Retry with shorter search term if no results (some Workday instances
      // have abbreviated skill names, e.g. "Python (Programming Language)")
      if (!selected && skill.length > 3) {
        console.log(`[Workday] [Skills] No results for "${skill}" — retrying with shorter term...`);
        // Clear and retype shorter term
        await adapter.page.keyboard.press('Control+a');
        await adapter.page.keyboard.press('Backspace');
        const shortTerm = skill.substring(0, Math.max(3, Math.floor(skill.length / 2)));
        await adapter.page.keyboard.type(shortTerm, { delay: 50 });
        await adapter.page.waitForTimeout(300);
        await adapter.page.keyboard.press('Enter');
        await adapter.page.waitForTimeout(3000);
        selected = await this.findAndClickSkillOption(adapter, skill);
      }

      if (selected) {
        console.log(`[Workday] [Skills] Selected "${skill}" from dropdown.`);
      } else {
        console.log(`[Workday] [Skills] Could not find "${skill}" in dropdown results — skipping.`);
        // Dismiss dropdown without selecting
        await adapter.page.keyboard.press('Escape');
      }

      await adapter.page.waitForTimeout(500);

      // Click whitespace to dismiss any lingering dropdown
      await adapter.page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
      await adapter.page.waitForTimeout(300);
    }

    console.log(`[Workday] [Skills] Done adding ${skills.length} skills.`);
  }

  /**
   * Workday login: Google SSO with account chooser, email entry, password entry.
   */
  async handleLogin(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
  ): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();
    const userProfile = profile as WorkdayUserProfile;
    const email = userProfile.email;
    const password = process.env.TEST_GMAIL_PASSWORD || '';

    // Google sign-in page — handle each sub-page with DOM clicks
    if (currentUrl.includes('accounts.google.com')) {
      console.log(`[Workday] On Google sign-in page for ${email}...`);

      const googlePageType = await adapter.page.evaluate(`
        (() => {
          const targetEmail = ${JSON.stringify(email)}.toLowerCase();
          const bodyText = document.body.innerText.toLowerCase();

          let hasVisiblePassword = false;
          let hasVisibleEmail = false;
          document.querySelectorAll('input[type="password"]').forEach(el => {
            if (hasVisiblePassword) return;
            if (el.getAttribute('aria-hidden') === 'true') return;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) hasVisiblePassword = true;
          });
          document.querySelectorAll('input[type="email"]').forEach(el => {
            if (hasVisibleEmail) return;
            if (el.getAttribute('aria-hidden') === 'true') return;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) hasVisibleEmail = true;
          });

          if (hasVisiblePassword) return { type: 'password_entry', found: true };
          if (hasVisibleEmail) return { type: 'email_entry', found: true };

          // Check for confirmation page (account pre-selected, "Continue" button visible)
          var buttons = document.querySelectorAll('button, div[role="button"]');
          var hasContinue = Array.from(buttons).some(function(b) {
            var t = (b.textContent || '').trim().toLowerCase();
            return t === 'continue' || t === 'confirm' || t === 'allow';
          });
          if (hasContinue && (bodyText.includes(targetEmail) || bodyText.includes('confirm') || bodyText.includes('signing in'))) {
            return { type: 'confirmation', found: true };
          }

          const accountLinks = document.querySelectorAll('[data-email], [data-identifier]');
          for (const el of accountLinks) {
            const addr = (el.getAttribute('data-email') || el.getAttribute('data-identifier') || '').toLowerCase();
            if (addr === targetEmail) return { type: 'account_chooser', found: true };
          }
          if (bodyText.includes('choose an account') || bodyText.includes('select an account')) {
            return { type: 'account_chooser', found: true };
          }

          return { type: 'unknown', found: false };
        })()
      `) as { type: string; found: boolean };

      switch (googlePageType.type) {
        case 'confirmation': {
          console.log('[Workday] Google confirmation page — clicking Continue...');
          const continueClicked = await adapter.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, div[role="button"]');
            for (const btn of buttons) {
              const t = (btn.textContent || '').trim().toLowerCase();
              if (t === 'continue' || t === 'confirm' || t === 'allow') {
                (btn as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (!continueClicked) {
            await adapter.act('Click the "Continue" or "Confirm" button to proceed with the Google sign-in.');
          }
          await adapter.page.waitForTimeout(2000);
          return;
        }

        case 'account_chooser': {
          console.log('[Workday] Account chooser detected — clicking account via DOM...');
          const clicked = await adapter.page.evaluate((targetEmail: string) => {
            const byAttr = document.querySelector(`[data-email="${targetEmail}" i], [data-identifier="${targetEmail}" i]`);
            if (byAttr) { (byAttr as HTMLElement).click(); return true; }

            const allClickable = document.querySelectorAll('div[role="link"], li[role="option"], a, div[tabindex], li[data-email]');
            for (const el of allClickable) {
              if (el.textContent?.toLowerCase().includes(targetEmail.toLowerCase())) {
                (el as HTMLElement).click();
                return true;
              }
            }

            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
              const text = el.textContent?.toLowerCase() || '';
              if (text.includes(targetEmail.toLowerCase()) && el.children.length < 5) {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          }, email);

          if (!clicked) {
            console.warn('[Workday] Could not click account in chooser, falling back to LLM');
            await adapter.act(`Click on the account "${email}" to sign in with it.`);
          }

          await adapter.page.waitForTimeout(2000);
          return;
        }

        case 'email_entry': {
          console.log('[Workday] Email entry page — typing email via DOM...');
          const emailInput = adapter.page.locator('input[type="email"]:visible').first();
          await emailInput.fill(email);
          await adapter.page.waitForTimeout(300);
          const nextClicked = await adapter.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, div[role="button"]');
            for (const btn of buttons) {
              if (btn.textContent?.trim().toLowerCase().includes('next')) {
                (btn as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (!nextClicked) {
            await adapter.act('Click the "Next" button.');
          }
          await adapter.page.waitForTimeout(2000);
          return;
        }

        case 'password_entry': {
          console.log('[Workday] Password entry page — typing password via DOM...');
          const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
          await passwordInput.fill(password);
          await adapter.page.waitForTimeout(300);
          const nextClicked = await adapter.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, div[role="button"]');
            for (const btn of buttons) {
              if (btn.textContent?.trim().toLowerCase().includes('next')) {
                (btn as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (!nextClicked) {
            await adapter.act('Click the "Next" button.');
          }
          await adapter.page.waitForTimeout(2000);
          return;
        }

        default: {
          console.log('[Workday] Unknown Google page — using LLM fallback...');
          await adapter.act(buildGoogleSignInFallbackPrompt(email));
          await adapter.page.waitForTimeout(2000);
          return;
        }
      }
    }

    // Workday login page — try Google SSO first, then native email/password
    console.log('[Workday] On login page...');

    // Step 1: Try Google SSO via Playwright selectors
    let googleClicked = false;
    const googleBtnSelectors = [
      'button:has-text("Sign in with Google")',
      'button:has-text("Continue with Google")',
      'a:has-text("Sign in with Google")',
      '[data-automation-id*="google" i]',
    ];
    for (const sel of googleBtnSelectors) {
      try {
        const btn = adapter.page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click();
          googleClicked = true;
          console.log('[Workday] Clicked "Sign in with Google" via Playwright locator.');
          break;
        }
      } catch { /* try next selector */ }
    }

    if (googleClicked) {
      try {
        await adapter.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await adapter.page.waitForTimeout(3000);
      } catch { /* non-fatal */ }
      return;
    }

    // Step 2: Detect page layout — Workday shows "Create Account" by default with
    // a "Sign In" tab. We need to click the tab FIRST before filling credentials,
    // otherwise we'd fill the Create Account form by mistake.
    const pageContext = await adapter.page.evaluate(() => {
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const hasConfirmPassword = passwordFields.length > 1;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const isCreateAccountView = hasConfirmPassword
        || headingText.includes('create account')
        || headingText.includes('register');

      const signInTab = Array.from(
        document.querySelectorAll('button, a, [role="tab"], [role="button"], [role="link"]')
      ).find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'sign in' || text === 'log in';
      });

      return {
        isCreateAccountView,
        hasSignInTab: !!signInTab,
        hasPasswordField: passwordFields.length > 0,
      };
    });

    console.log(`[Workday] Page context: createAccount=${pageContext.isCreateAccountView}, signInTab=${pageContext.hasSignInTab}, password=${pageContext.hasPasswordField}`);

    // If we already tried login and landed back on Create Account page,
    // don't loop — just return so the detection pipeline classifies as account_creation.
    if (pageContext.isCreateAccountView && (profile as any)._loginAttempted) {
      console.log('[Workday] Already tried login — returning to let account creation handler take over.');
      return;
    }

    // If on Create Account view, click "Sign In" tab first to switch views
    if (pageContext.isCreateAccountView && pageContext.hasSignInTab) {
      console.log('[Workday] Create Account view — clicking Sign In tab first...');
      const tabClicked = await adapter.page.evaluate(() => {
        const els = document.querySelectorAll('button, a, [role="tab"], [role="button"], [role="link"]');
        for (const el of els) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (text === 'sign in' || text === 'log in') {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (tabClicked) {
        await adapter.page.waitForTimeout(1500);
      }
    } else if (!pageContext.hasPasswordField) {
      // No password field visible at all — LLM finds sign-in option
      console.log('[Workday] No login form visible — using LLM to find sign-in...');
      await adapter.act(
        'Look for a "Sign in with Google" button or a "Sign In" link/tab and click it to open the sign-in form. Do NOT click "Create Account". Click ONLY ONE button, then report done.',
      );
      await adapter.page.waitForTimeout(2000);
    }

    // Helper: fill the sign-in modal/form and submit with the given password
    const tryLogin = async (pw: string): Promise<string | null> => {
      const fillResult = await adapter.page.evaluate((creds: { email: string; password: string }) => {
        const modal = document.querySelector<HTMLElement>(
          '[role="dialog"], [aria-modal="true"], [data-automation-id="popUpDialog"]'
        );
        const ctx: ParentNode = modal || document;

        const emailSels = [
          'input[type="email"]', 'input[autocomplete="email"]',
          'input[name*="email" i]', 'input[name*="user" i]',
          'input[id*="email" i]', 'input[data-automation-id*="email" i]',
        ];
        let emailInput: HTMLInputElement | null = null;
        for (const sel of emailSels) {
          const input = ctx.querySelector<HTMLInputElement>(sel + ':not([disabled])');
          if (input && input.getBoundingClientRect().width > 0) {
            emailInput = input;
            break;
          }
        }
        if (!emailInput) {
          const pw = ctx.querySelector<HTMLInputElement>('input[type="password"]:not([disabled])');
          if (pw) {
            const form = pw.closest('form') || ctx;
            const txt = form.querySelector<HTMLInputElement>(
              'input[type="text"]:not([disabled]), input:not([type]):not([disabled])'
            );
            if (txt && txt.getBoundingClientRect().width > 0) emailInput = txt;
          }
        }

        if (emailInput) {
          emailInput.focus();
          emailInput.value = creds.email;
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          emailInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const pwInput = ctx.querySelector<HTMLInputElement>('input[type="password"]:not([disabled])');
        if (pwInput && pwInput.getBoundingClientRect().width > 0) {
          pwInput.focus();
          pwInput.value = creds.password;
          pwInput.dispatchEvent(new Event('input', { bubbles: true }));
          pwInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (!emailInput && !pwInput) return { filled: false, submitted: false };

        const wdSubmit = ctx.querySelector<HTMLElement>(
          '[data-automation-id="click_filter"][aria-label*="Sign In" i], ' +
          '[data-automation-id="signInSubmitButton"]'
        );
        if (wdSubmit) {
          wdSubmit.click();
          return { filled: true, submitted: true };
        }

        const SIGNIN_TEXTS = ['sign in', 'log in', 'login'];
        const btns = ctx.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], [role="button"]'
        );
        for (const btn of btns) {
          const text = (btn.textContent || (btn as HTMLInputElement).value || '').trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
          const match = SIGNIN_TEXTS.some(t => text === t || ariaLabel === t);
          if (match && !btn.matches('[role="tab"]')) {
            btn.click();
            return { filled: true, submitted: true };
          }
        }
        const form = (pwInput || emailInput)?.closest('form');
        if (form) { form.requestSubmit(); return { filled: true, submitted: true }; }
        return { filled: true, submitted: false };
      }, { email, password: pw });

      if (fillResult.filled) {
        console.log(`[Workday] Filled login form with email="${email}", pw=***. submitted=${fillResult.submitted}`);
      } else {
        console.log('[Workday] Could not find login form fields to fill.');
        return null;
      }

      if (fillResult.filled && !fillResult.submitted) {
        await adapter.act('Click the "Sign In" or "Log In" button to submit the login form. Do NOT click "Create Account". Click ONLY ONE button.');
      }

      await adapter.page.waitForTimeout(3000);

      // Check for login errors
      const loginError = await adapter.page.evaluate(() => {
        const patterns = ['incorrect', 'invalid', 'wrong', 'not found', "doesn't exist",
          'does not exist', 'failed', 'try again', 'not recognized', 'no account', 'unable'];
        const alertEls = document.querySelectorAll(
          '[role="alert"], [class*="error"], [class*="alert"], [data-automation-id*="error" i]'
        );
        for (const el of alertEls) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const text = (el.textContent || '').trim().toLowerCase();
          if (text && patterns.some(p => text.includes(p))) return text.substring(0, 200);
        }
        return null;
      });

      return loginError;
    };

    // Step 3: Try login with base password
    const PASSWORD_SUFFIX = 'aA1!';
    let loginError = await tryLogin(password);

    // Step 3b: If base password failed, try with suffix appended
    if (loginError && password) {
      console.log(`[Workday] Login failed with base password: "${loginError}" — retrying with strengthened password...`);
      // Dismiss error / re-open sign-in form
      await adapter.page.keyboard.press('Escape');
      await adapter.page.waitForTimeout(500);
      // Re-open Sign In if we're back on the main page
      const needReopen = await adapter.page.evaluate(() => {
        return !document.querySelector('[role="dialog"], [aria-modal="true"], [data-automation-id="popUpDialog"]');
      });
      if (needReopen) {
        await adapter.page.evaluate(() => {
          const els = document.querySelectorAll('button, a, [role="tab"], [role="button"], [role="link"]');
          for (const el of els) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text === 'sign in' || text === 'log in') {
              (el as HTMLElement).click();
              return;
            }
          }
        });
        await adapter.page.waitForTimeout(1500);
      }
      loginError = await tryLogin(password + PASSWORD_SUFFIX);
    }

    // Mark that we attempted login
    (profile as any)._loginAttempted = true;

    // Step 4: Both passwords failed → navigate to account creation
    if (loginError) {
      console.log(`[Workday] Login failed: "${loginError}" — navigating to account creation...`);
      // Close modal if open
      await adapter.page.keyboard.press('Escape');
      await adapter.page.waitForTimeout(500);

      const clickedCreate = await adapter.page.evaluate(() => {
        const TEXTS = ['create account', 'sign up', 'register', 'create an account',
          "don't have an account", 'new user', 'get started'];
        const els = document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], span');
        for (const el of els) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (TEXTS.some(t => text.includes(t))) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clickedCreate) {
        console.log('[Workday] Clicked account creation option.');
      } else {
        await adapter.act('The login failed. Look for a "Create Account" tab or link and click it. Click ONLY ONE link.');
      }
      await adapter.page.waitForTimeout(2000);
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * Find and click a dropdown option matching the target answer.
   * 3-phase strategy: direct click → type-to-filter → arrow-scroll.
   */
  private async clickDropdownOption(
    adapter: BrowserAutomationAdapter,
    targetAnswer: string,
  ): Promise<boolean> {
    await adapter.page
      .waitForSelector(
        '[role="listbox"], [role="option"], [data-automation-id*="promptOption"]',
        { timeout: 3000 },
      )
      .catch(() => {});

    let searchText = targetAnswer;
    if (targetAnswer.includes('→')) {
      searchText = targetAnswer.split('→')[0].trim();
    }

    // Phase 1: Direct click on visible matching option
    const directClick = await adapter.page.evaluate((target: string) => {
      const targetLower = target.toLowerCase();
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
          '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
      );

      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.length > 2 && targetLower.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, searchText);

    if (directClick) return true;

    // Phase 2: Type-to-filter
    console.log(`[Workday] [Dropdown] Typing "${searchText}" to filter...`);
    await adapter.page.keyboard.type(searchText, { delay: 50 });
    await adapter.page.waitForTimeout(500);

    const typedMatch = await adapter.page.evaluate((target: string) => {
      const targetLower = target.toLowerCase();
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
          '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
      );
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      for (const opt of options) {
        const text = opt.textContent?.trim().toLowerCase() || '';
        if (text.length > 2 && targetLower.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, searchText);

    if (typedMatch) return true;

    // Phase 3: Arrow-scroll through options
    console.log(`[Workday] [Dropdown] Typing didn't filter, scrolling through options...`);
    await adapter.page.keyboard.press('Home');
    await adapter.page.waitForTimeout(100);

    const MAX_SCROLL_ATTEMPTS = 30;
    for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
      for (let k = 0; k < 3; k++) {
        await adapter.page.keyboard.press('ArrowDown');
        await adapter.page.waitForTimeout(80);
      }

      const scrollMatch = await adapter.page.evaluate((target: string) => {
        const targetLower = target.toLowerCase();

        const focused = document.querySelector('[role="option"][aria-selected="true"], [role="option"]:focus, [role="option"].selected');
        if (focused) {
          const text = focused.textContent?.trim().toLowerCase() || '';
          if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower) || (text.length > 2 && targetLower.includes(text))) {
            (focused as HTMLElement).click();
            return 'clicked';
          }
        }

        const options = document.querySelectorAll(
          '[role="option"], [role="listbox"] li, ' +
            '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
        );
        for (const opt of options) {
          const text = opt.textContent?.trim().toLowerCase() || '';
          if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
            (opt as HTMLElement).click();
            return 'clicked';
          }
        }

        return 'not_found';
      }, searchText);

      if (scrollMatch === 'clicked') return true;
    }

    return false;
  }
}
