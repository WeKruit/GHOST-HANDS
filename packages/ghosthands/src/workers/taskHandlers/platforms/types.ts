import { z } from 'zod';
import type { BrowserAutomationAdapter } from '../../../adapters/types.js';

// ---------------------------------------------------------------------------
// Universal page types
// ---------------------------------------------------------------------------

/** Page types that the multi-page loop can detect and route to. */
export type PageType =
  | 'job_listing'
  | 'login'
  | 'google_signin'
  | 'verification_code'
  | 'phone_2fa'
  | 'account_creation'
  | 'personal_info'
  | 'experience'
  | 'resume_upload'
  | 'questions'
  | 'review'
  | 'confirmation'
  | 'error'
  | 'unknown'
  | (string & {}); // Allow platform-specific page types

export interface PageState {
  page_type: PageType;
  page_title: string;
  has_apply_button?: boolean;
  has_next_button?: boolean;
  has_submit_button?: boolean;
  has_sign_in_with_google?: boolean;
  error_message?: string;
}

// ---------------------------------------------------------------------------
// Scan-first field discovery types
// ---------------------------------------------------------------------------

/** What kind of form field was detected. */
export type FieldKind =
  | 'text'            // input[type=text|email|tel|url|number], input:not([type]), textarea
  | 'select'          // native <select>
  | 'custom_dropdown' // ARIA combobox/listbox/aria-haspopup
  | 'radio'           // native radio group (by name)
  | 'aria_radio'      // role="radiogroup"
  | 'checkbox'        // input[type=checkbox]
  | 'date'            // input[type=date] or segmented
  | 'file'            // input[type=file]
  | 'contenteditable' // contenteditable div
  | 'upload_button'   // upload/attach button (no file input)
  | 'unknown';

/** How a scanned field should be filled. */
export type FillStrategy =
  | 'native_setter'   // page.evaluate with native setter (text, select)
  | 'click_option'    // scroll into view, click trigger, click option (radios, custom dropdowns)
  | 'click'           // simple click (checkboxes)
  | 'set_input_files' // Playwright setInputFiles (file upload)
  | 'keyboard_type'   // focus + type (segmented dates)
  | 'llm_act';        // LLM fallback

/** A single form field discovered during the scan phase. */
export interface ScannedField {
  /** Unique ID for this scan session (e.g. "field-0", "field-1") */
  id: string;
  /** What kind of field this is */
  kind: FieldKind;
  /** How we plan to fill it */
  fillStrategy: FillStrategy;
  /** CSS selector that uniquely identifies this field (or its trigger) */
  selector: string;
  /** The label text extracted via label-finding strategies */
  label: string;
  /** Current value (empty string if unfilled) */
  currentValue: string;
  /** For select/radio/custom_dropdown: available option texts */
  options?: string[];
  /** For radio groups: the group name (native) or ARIA group selector */
  groupKey?: string;
  /** Absolute Y position on the page (rect.top + scrollY) for ordering */
  absoluteY: number;
  /** Whether this field appears to be required */
  isRequired: boolean;
  /** The matching QA answer, if found during fill phase */
  matchedAnswer?: string;
  /** Whether this field was filled during the current fill cycle */
  filled: boolean;
  /** Platform-specific metadata (e.g. Workday date segments) */
  platformMeta?: Record<string, string>;
}

/** Result of scanning an entire page for form fields. */
export interface ScanResult {
  /** All fields found on the page, sorted by absoluteY (top to bottom) */
  fields: ScannedField[];
  /** Page scroll height at time of scan */
  scrollHeight: number;
  /** Viewport height */
  viewportHeight: number;
}

// ---------------------------------------------------------------------------
// PlatformConfig interface
// ---------------------------------------------------------------------------

/**
 * Configuration that varies per ATS platform.
 *
 * The SmartApplyHandler contains the generic multi-page loop (detect → fill →
 * scroll → next) and delegates all platform-specific behavior to this config.
 *
 * Implement this interface for each platform (Workday, Amazon, Greenhouse, etc.)
 * or use GenericPlatformConfig as a default that works for any site.
 */
export interface PlatformConfig {
  /** Platform identifier (e.g., 'workday', 'amazon', 'generic') */
  readonly platformId: string;
  /** Human-readable name */
  readonly displayName: string;

  // --- Page Detection ---

  /**
   * Zod schema for the page state that adapter.extract() should return.
   * Platforms can extend the base schema with their own page types.
   */
  readonly pageStateSchema: z.ZodType<PageState>;

  /**
   * URL-based page detection (fast, no LLM cost).
   * Return a PageState if the URL conclusively identifies the page type,
   * or null to fall through to DOM/LLM detection.
   */
  detectPageByUrl(url: string): PageState | null;

  /**
   * DOM-based page detection signals (fast, no LLM cost).
   * Return a PageState if DOM signals conclusively identify the page type,
   * or null to fall through to LLM detection.
   */
  detectPageByDOM(adapter: BrowserAutomationAdapter): Promise<PageState | null>;

  /**
   * LLM classification prompt for pages that URL/DOM detection couldn't identify.
   * Describes the platform's page types and classification rules.
   */
  buildClassificationPrompt(urlHints: string[]): string;

  /**
   * DOM fallback classification when LLM extraction fails.
   * Returns a page type string based on DOM heuristics.
   */
  classifyByDOMFallback(adapter: BrowserAutomationAdapter): Promise<PageType>;

  // --- Form Filling ---

  /**
   * Base rules for the LLM agent when filling forms on this platform.
   * Covers scrolling, field interaction, and navigation restrictions.
   */
  readonly baseRules: string;

  /**
   * Build a data prompt mapping field labels to user values.
   * Platform-specific because field labels differ between ATS systems.
   */
  buildDataPrompt(profile: Record<string, any>, qaOverrides: Record<string, string>): string;

  /**
   * Build the full Q&A map for programmatic dropdown/field filling.
   * Keys are question/field labels, values are the answers.
   */
  buildQAMap(profile: Record<string, any>, qaOverrides: Record<string, string>): Record<string, string>;

  /**
   * Build the full prompt for a given page type.
   * Combines baseRules + page-specific instructions + data block.
   */
  buildPagePrompt(pageType: PageType, dataBlock: string): string;

  // --- Scan-First Field Discovery ---

  /**
   * Scan the entire page to collect metadata on all form fields.
   * Scrolls through the page, collects field data at each viewport position,
   * deduplicates, then scrolls back to top.
   */
  scanPageFields(adapter: BrowserAutomationAdapter): Promise<ScanResult>;

  /**
   * Fill a single field by its scan result, using the appropriate strategy.
   * Returns true if the field was successfully filled.
   */
  fillScannedField(
    adapter: BrowserAutomationAdapter,
    field: ScannedField,
    answer: string,
  ): Promise<boolean>;

  // --- Programmatic DOM Helpers (legacy, kept for backward compatibility) ---

  /**
   * Platform-specific dropdown detection and filling.
   * Returns the number of dropdowns filled.
   */
  fillDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number>;

  /**
   * Custom (non-native) dropdown filling: ARIA comboboxes, listboxes, etc.
   * Returns the number of dropdowns filled.
   */
  fillCustomDropdownsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number>;

  /**
   * DOM-first text field filling: match visible text/email/tel/url inputs
   * to qaMap entries by label and fill them programmatically.
   * Returns the number of fields filled.
   */
  fillTextFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number>;

  /**
   * DOM-first radio button filling: match visible radio groups (native and ARIA)
   * to qaMap entries by question text and click the matching option.
   * Returns the number of radio groups filled.
   */
  fillRadioButtonsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number>;

  /**
   * Platform-specific date field detection and filling.
   * Returns the number of date fields filled.
   */
  fillDateFieldsProgrammatically(
    adapter: BrowserAutomationAdapter,
    qaMap: Record<string, string>,
  ): Promise<number>;

  /**
   * Check and fill required checkboxes (T&C, privacy, etc.).
   * Returns the number of checkboxes checked.
   */
  checkRequiredCheckboxes(adapter: BrowserAutomationAdapter): Promise<number>;

  /**
   * Detect whether the visible viewport has empty fields needing LLM attention.
   */
  hasEmptyVisibleFields(adapter: BrowserAutomationAdapter): Promise<boolean>;

  // --- Navigation ---

  /**
   * Click the "Next" / "Save and Continue" / "Continue" button via DOM.
   * Returns 'clicked', 'review_detected' (found Submit instead of Next), or 'not_found'.
   */
  clickNextButton(adapter: BrowserAutomationAdapter): Promise<'clicked' | 'review_detected' | 'not_found'>;

  /**
   * Detect and handle validation errors after clicking Next.
   * Returns true if errors were found.
   */
  detectValidationErrors(adapter: BrowserAutomationAdapter): Promise<boolean>;

  // --- Optional Platform-Specific Overrides ---

  /**
   * Handle platform-specific page types not in the universal set.
   * Returns true if handled, false to fall through to generic handling.
   */
  handleCustomPageType?(
    pageType: string,
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
    dataPrompt: string,
    qaMap: Record<string, string>,
  ): Promise<boolean>;

  /**
   * Whether this platform requires a custom experience page handler.
   * (e.g. Workday needs this because fields are behind "Add" buttons.)
   */
  readonly needsCustomExperienceHandler: boolean;

  /**
   * Custom experience page handler (only called if needsCustomExperienceHandler is true).
   */
  handleExperiencePage?(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
    dataPrompt: string,
  ): Promise<void>;

  /**
   * Platform-specific login handling.
   * If not provided, the SmartApplyHandler uses generic Google SSO detection.
   */
  handleLogin?(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
  ): Promise<void>;

  /** Domains that indicate this platform's auth flow (Google SSO, SAML, etc.) */
  readonly authDomains: string[];
}
