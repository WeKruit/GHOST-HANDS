/**
 * formFiller.ts
 *
 * Production-grade form filler adapted from toy-job-app/fill-form.ts and
 * toy-job-app/extract-form-structure.ts.
 *
 * Exports a single entry point `fillFormOnPage()` that:
 *   1. Injects browser-side helpers and extracts all form fields
 *   2. Discovers dropdown options by briefly opening custom dropdowns
 *      (including hierarchical Workday dropdowns with chevron sub-categories)
 *   3. Asks Claude Haiku 4.5 for answers (single LLM call for all fields)
 *   4. Iteratively fills fields via DOM, re-extracting after each round
 *   5. Falls back to MagnitudeHand (adapter.act()) for unfilled fields
 *
 * This module is imported by SmartApplyHandler — it does NOT launch a browser
 * or manage navigation. The caller provides a Playwright Page and an adapter.
 */

import type { Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { WorkdayUserProfile } from './workday/workdayTypes.js';

// ── Types ────────────────────────────────────────────────────

export interface FormField {
  id: string;
  name: string;
  type: string;
  section: string;
  required: boolean;
  options?: string[];
  choices?: string[];
  accept?: string;
  isNative: boolean;
  isMultiSelect?: boolean;
  visibleByDefault: boolean;
  visibleWhen?: any[];
}

export type AnswerMap = Record<string, string>;

export interface FillResult {
  domFilled: number;
  magnitudeFilled: number;
  totalAttempted: number;
  totalFields: number;
  llmCalls: number;
  /** Total input tokens consumed by formFiller LLM calls */
  inputTokens: number;
  /** Total output tokens consumed by formFiller LLM calls */
  outputTokens: number;
}

interface GenerateResult {
  answers: AnswerMap;
  fieldIdToKey: Record<string, string>;
  inputTokens: number;
  outputTokens: number;
}

interface RepeaterInfo {
  label: string;
  addButtonSelector: string;
  currentCount: number;
}

// ── Constants ────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = [
  'input', 'select', 'textarea',
  '[role="textbox"]', '[role="combobox"]', '[role="listbox"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="spinbutton"]', '[role="slider"]', '[role="searchbox"]',
  '[data-uxi-widget-type="selectinput"]',
  '[aria-haspopup="listbox"]',
].join(', ');

const PLACEHOLDER_RE = /^(select|choose|pick|--|—)/i;

const MAGNITUDE_HAND_ACT_TIMEOUT_MS = 30_000;

// ── Profile text builder ─────────────────────────────────────

/** Convert a WorkdayUserProfile into a human-readable profile string for LLM prompts. */
export function buildProfileText(p: WorkdayUserProfile): string {
  const lines: string[] = [];

  lines.push(`Name: ${p.first_name} ${p.last_name}`);
  lines.push(`Email: ${p.email}`);
  if (p.phone) lines.push(`Phone: ${p.phone}`);
  if (p.address?.city || p.address?.state) {
    const loc = [p.address.city, p.address.state].filter(Boolean).join(', ');
    if (p.address.zip) lines.push(`Location: ${loc} ${p.address.zip}`);
    else lines.push(`Location: ${loc}`);
  }
  if (p.linkedin_url) lines.push(`LinkedIn: ${p.linkedin_url}`);
  if (p.website_url) lines.push(`Portfolio: ${p.website_url}`);

  if (p.experience?.length) {
    lines.push('');
    const current = p.experience.find((e) => e.currently_work_here);
    if (current) {
      lines.push(`Current Role: ${current.title} at ${current.company}`);
    }
    for (const job of p.experience) {
      if (job === current) continue;
      const dates = [job.start_date, job.end_date].filter(Boolean).join(' – ');
      lines.push(`Previous: ${job.title} at ${job.company}${dates ? ` (${dates})` : ''}`);
    }
  }

  if (p.education?.length) {
    lines.push('');
    for (const edu of p.education) {
      let edLine = `Education: ${edu.degree}`;
      if (edu.field_of_study) edLine += ` in ${edu.field_of_study}`;
      edLine += `, ${edu.school}`;
      if (edu.end_date) edLine += `, ${edu.end_date}`;
      if (edu.gpa) edLine += ` (GPA: ${edu.gpa})`;
      lines.push(edLine);
    }
  }

  if (p.skills?.length) {
    lines.push('');
    lines.push(`Skills: ${p.skills.join(', ')}`);
  }

  lines.push('');
  lines.push(`Work authorization: ${p.work_authorization || 'Yes'}`);
  lines.push(`Visa sponsorship needed: ${p.visa_sponsorship || 'No'}`);

  lines.push('');
  lines.push('Demographics:');
  if (p.gender) lines.push(`Gender: ${p.gender}`);
  if (p.race_ethnicity) lines.push(`Race/Ethnicity: ${p.race_ethnicity}`);
  if (p.veteran_status) lines.push(`Veteran status: ${p.veteran_status}`);
  if (p.disability_status) lines.push(`Disability: ${p.disability_status}`);

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function defaultValue(field: FormField): string {
  switch (field.type) {
    case 'email': return 'a@gmail.com';
    case 'tel': return '1234567890';
    case 'url': return 'https://a.com';
    case 'number': return '1';
    case 'date': return '2025-01-01';
    case 'textarea':
      return 'I am excited about this opportunity and believe my skills and experience make me a strong candidate for this position.';
    default: return '';
  }
}

function isSkillLikeFieldName(name: string): boolean {
  const n = normalizeName(name);
  return /\bskills?\b/.test(n) || /\btechnolog(y|ies)\b/.test(n);
}

function parseProfileSkills(profileText: string): string[] {
  const match = profileText.match(/^\s*Skills:\s*(.+)$/im);
  if (!match) return [];
  const deduped = new Set<string>();
  for (const raw of match[1].split(/[;,|]/)) {
    const skill = raw.trim();
    if (!skill) continue;
    deduped.add(skill);
  }
  return [...deduped];
}

function resolveExistingFilePath(candidate?: string | null): string | null {
  if (!candidate) return null;
  try {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    return stat.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function isExplicitFalse(value?: string): boolean {
  if (!value) return false;
  return /^(false|off|no|unchecked|0)$/i.test(value.trim());
}

async function readBinaryControlState(page: Page, ffId: string): Promise<boolean | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-ff-id="${id}"]`) as HTMLElement | null;
    if (!el) return null;

    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'checkbox' || input.type === 'radio') return input.checked;
    }

    const nested = el.querySelector('input[type="checkbox"], input[type="radio"]') as HTMLInputElement | null;
    if (nested) return nested.checked;

    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked === 'true') return true;
    if (ariaChecked === 'false') return false;

    return null;
  }, ffId);
}

/** Explicit resume/CV keywords — high confidence this field wants a resume. */
const RESUME_KEYWORDS = ['resume', 'cv', 'curriculum vitae'];

/**
 * Determine if a file input is a resume upload field.
 *
 * Returns:
 *  - 'yes'   — label explicitly mentions resume/CV
 *  - 'maybe' — label is empty or purely generic (e.g. "Attach", "Upload file")
 *  - 'no'    — label describes something else (cover letter, portfolio, etc.)
 */
function classifyFileInput(label: string): 'yes' | 'maybe' | 'no' {
  const trimmed = label.trim();
  if (!trimmed) return 'maybe'; // Unlabeled
  const lower = trimmed.toLowerCase();
  // Explicit resume match
  if (RESUME_KEYWORDS.some(kw => lower.includes(kw))) return 'yes';
  // Generic labels with no specific content descriptor
  // e.g. "Attach", "Upload", "Choose file", "Browse" — these are ambiguous
  const genericOnly = /^(attach|upload|choose|browse|select|add)(\s+(a\s+)?file)?s?\.?$/i;
  if (genericOnly.test(trimmed)) return 'maybe';
  // Anything else (cover letter, portfolio, writing sample, etc.)
  return 'no';
}

/**
 * Check if a file input should receive the resume.
 * Wraps classifyFileInput — returns true for 'yes' and 'maybe'.
 */
function isResumeFileInput(label: string): boolean {
  return classifyFileInput(label) !== 'no';
}

async function uploadResumeIfPresent(page: Page, resumePath?: string | null): Promise<boolean> {
  const resolvedResume = resolveExistingFilePath(resumePath);
  if (!resolvedResume) return false;

  // Get file inputs with their labels so we can skip non-resume fields
  const fileInputInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
    return inputs.map((input, idx) => {
      const hasFile = (input.files?.length || 0) > 0 || (input.value || '').trim().length > 0;
      // Gather accessible label: aria-label, associated <label>, or nearby text
      let label = input.getAttribute('aria-label') || '';
      if (!label) {
        const labelEl = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
        label = labelEl?.textContent?.trim() || '';
      }
      if (!label) {
        // Check parent/sibling text
        const parent = input.closest('.field, .form-group, .form-field, [class*="upload"]');
        if (parent) {
          const clone = parent.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('input, button').forEach((el: any) => el.remove());
          label = clone.textContent?.trim() || '';
        }
      }
      return { idx, hasFile, label };
    });
  }).catch(() => [] as { idx: number; hasFile: boolean; label: string }[]);

  if (fileInputInfo.length === 0) return false;
  if (fileInputInfo.every(fi => fi.hasFile)) return true;

  // Classify each file input and prioritize explicit resume fields
  const classified = fileInputInfo
    .filter(fi => !fi.hasFile)
    .map(fi => ({ ...fi, classification: classifyFileInput(fi.label) }));

  // Two-pass: try explicit resume fields first, then generic/unlabeled ones
  const explicitResume = classified.filter(fi => fi.classification === 'yes');
  const genericFields = classified.filter(fi => fi.classification === 'maybe');
  const candidates = explicitResume.length > 0 ? explicitResume : genericFields;

  if (candidates.length === 0) {
    for (const fi of classified.filter(c => c.classification === 'no')) {
      console.log(`[formFiller] skip file input "${fi.label}" (not a resume field)`);
    }
    return false;
  }

  const fileInputs = page.locator('input[type="file"]');
  for (const fi of candidates) {
    try {
      await fileInputs.nth(fi.idx).setInputFiles(resolvedResume, { timeout: 2500 });
      console.log(`[formFiller] resume upload → ${path.basename(resolvedResume)} (field: "${fi.label || 'unlabeled'}")`);
      await page.waitForTimeout(500);
      return true;
    } catch {
      // Keep trying other candidates
    }
  }

  return false;
}

function normalizeName(s: string): string {
  return s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getAnswer(answers: AnswerMap, field: FormField): string | undefined {
  if (field.name in answers) return answers[field.name];
  const norm = normalizeName(field.name);
  for (const [key, val] of Object.entries(answers)) {
    if (normalizeName(key) === norm) return val;
  }
  return undefined;
}

function getAnswerForField(
  answers: AnswerMap,
  field: FormField,
  fieldIdMap?: Record<string, string>,
): string | undefined {
  const mappedKey = fieldIdMap?.[field.id];
  if (mappedKey) {
    if (mappedKey in answers) return answers[mappedKey];
    const mappedNorm = normalizeName(mappedKey);
    for (const [key, val] of Object.entries(answers)) {
      if (normalizeName(key) === mappedNorm) return val;
    }
  }
  return getAnswer(answers, field);
}

// ── MagnitudeHand neighbor context ───────────────────────────

const NEIGHBOR_RADIUS = 4;

/**
 * Build a text snippet showing the target field in context of its neighbors.
 * This helps MagnitudeHand understand ambiguous field labels (e.g. "Yes") by
 * showing surrounding fields so the visual agent can reason about what the
 * field actually is.
 */
function buildNeighborContext(
  target: FormField,
  allVisible: FormField[],
  answers: AnswerMap,
  fieldIdMap?: Record<string, string>,
  filledIds?: Set<string>,
): string {
  const idx = allVisible.findIndex((f) => f.id === target.id);
  if (idx === -1) return '';

  const start = Math.max(0, idx - NEIGHBOR_RADIUS);
  const end = Math.min(allVisible.length, idx + NEIGHBOR_RADIUS + 1);
  const neighbors = allVisible.slice(start, end);

  if (neighbors.length <= 1) return '';

  const lines: string[] = [];
  let lastSection = '';

  for (const f of neighbors) {
    if (f.section && f.section !== lastSection) {
      lines.push(`  [${f.section}]`);
      lastSection = f.section;
    }

    const isTarget = f.id === target.id;
    const prefix = isTarget ? '  >>> ' : '      ';
    let desc = f.name || '(unlabeled)';

    // Add type annotation for disambiguation (skip plain text — too noisy)
    if (f.type && f.type !== 'text') {
      desc += ` (${f.type})`;
    }

    // Show choices for radio/checkbox groups
    if (f.choices?.length) {
      desc += ` [${f.choices.join(' | ')}]`;
    }

    // Show filled value for non-target neighbors
    if (!isTarget && filledIds?.has(f.id)) {
      const ans = getAnswerForField(answers, f, fieldIdMap);
      if (ans) {
        desc += ` = "${ans.length > 40 ? ans.slice(0, 37) + '...' : ans}"`;
      } else {
        desc += ` (filled)`;
      }
    }

    lines.push(`${prefix}${desc}`);
  }

  return lines.join('\n');
}

// ── Browser-side injection ───────────────────────────────────

async function injectHelpers(page: Page): Promise<void> {
  const selectorStr = JSON.stringify(INTERACTIVE_SELECTOR);
  await page.evaluate(`
    if (typeof globalThis.__name === 'undefined') {
      globalThis.__name = function(fn) { return fn; };
    }
    var _prevNextId = (window.__ff && window.__ff.nextId) || 0;
    window.__ff = {
      SELECTOR: ${selectorStr},

      getAccessibleName: function(el) {
        var lblBy = el.getAttribute('aria-labelledby');
        if (lblBy) {
          var uxiC = el.closest('[data-uxi-widget-type]') || el.closest('[role="combobox"]');
          var t = lblBy.split(/\\s+/)
            .map(function(id) {
              var r = document.getElementById(id);
              if (!r) return '';
              if (uxiC && uxiC.contains(r)) return '';
              if (el.contains(r)) return '';
              return r.textContent.trim();
            })
            .filter(Boolean).join(' ');
          if (t) return t;
        }
        var elType = el.type || el.getAttribute('role') || '';
        var al = el.getAttribute('aria-label');
        // For radio/checkbox, aria-label is the option text ("Yes"/"No"), not the
        // question label.  Skip it here — it's captured separately in itemLabel.
        if (al && elType !== 'radio' && elType !== 'checkbox') {
          al = al.trim();
          if (el.getAttribute('aria-haspopup') === 'listbox' && el.textContent) {
            var val = el.textContent.trim();
            if (val && al.includes(val)) {
              al = al.replace(val, '');
              if (/\\bRequired\\b/i.test(al)) {
                el.dataset.ffRequired = 'true';
                al = al.replace(/\\s*Required\\s*/gi, ' ');
              }
              al = al.replace(/\\s+/g, ' ').trim();
            }
          }
          if (al) return al;
        }
        if (el.id) {
          var lbl = document.querySelector('label[for="' + el.id + '"]');
          if (lbl) {
            var c = lbl.cloneNode(true);
            c.querySelectorAll('input, .required, span[aria-hidden]').forEach(function(x) { x.remove(); });
            var tx = c.textContent.trim();
            if (tx) return tx;
          }
        }
        var from = el;
        var tp = el.type || el.getAttribute('role') || '';
        if (tp === 'checkbox' || tp === 'radio') {
          var grp = el.closest('.checkbox-group, .radio-group, [role=group], [role=radiogroup]');
          if (grp && grp.parentElement) from = grp.parentElement;
        }
        var group = from.closest('.form-group, .field, .form-field, fieldset') || from;
        var lbl2 = group.querySelector(':scope > label, :scope > legend');
        if (lbl2) {
          var c2 = lbl2.cloneNode(true);
          c2.querySelectorAll('input, .required, span[aria-hidden]').forEach(function(x) { x.remove(); });
          var tx2 = c2.textContent.trim();
          if (tx2) return tx2;
        }
        if (el.type === 'file') {
          var card = el.closest('.card, .section, [class*="upload"], [class*="drop"]');
          if (card) {
            var parent = card.closest('.card, .section') || card;
            var hdr = parent.querySelector('h1, h2, h3, h4, legend, [class*="heading"], [class*="title"]');
            if (hdr) {
              var ht = hdr.textContent.trim();
              if (ht) return ht;
            }
          }
        }
        return el.placeholder || el.getAttribute('title') || '';
      },

      isVisible: function(el) {
        var n = el;
        while (n && n !== document.body) {
          var s = window.getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return false;
          n = n.parentElement;
        }
        return true;
      },

      getSection: function(el) {
        var n = el.parentElement;
        while (n) {
          var h = n.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > legend');
          if (h) return h.textContent.trim();
          n = n.parentElement;
        }
        return '';
      },

      nextId: _prevNextId,
      tag: function(el) {
        if (!el.hasAttribute('data-ff-id')) {
          el.setAttribute('data-ff-id', 'ff-' + (window.__ff.nextId++));
        }
        return el.getAttribute('data-ff-id');
      }
    };
  `);
}

// ── Field extraction ─────────────────────────────────────────

async function extractFields(page: Page): Promise<FormField[]> {
  const raw: any[] = await page.evaluate(() => {
    const ff = (window as any).__ff;
    const seen = new Set();
    const out: any[] = [];

    const shouldSkip = (el: any): boolean => {
      if (el.closest('[class*="select-dropdown"], [class*="select-option"]')) return true;
      if (el.closest('.iti__dropdown-content')) return true;
      if (el.closest('[data-automation-id="activeListContainer"]')) return true;
      if (el.getAttribute('role') === 'listbox' && el.closest('[role="combobox"]')) return true;
      if (el.getAttribute('role') === 'listbox' && el.id) {
        const controller = document.querySelector('[role="combobox"][aria-controls="' + el.id + '"]');
        if (controller) return true;
      }
      if (el.tagName === 'INPUT' && el.type === 'search' && el.closest('[class*="dropdown"], [role="dialog"]')) return true;
      if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox') && window.getComputedStyle(el).display === 'none') return true;
      return false;
    };

    const getOptionMainText = (opt: any): string => {
      const clone = opt.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[class*="desc"], [class*="sub"], [class*="hint"], .option-desc, small').forEach((x: any) => x.remove());
      return clone.textContent?.trim() || '';
    };

    document.querySelectorAll(ff.SELECTOR).forEach((el: any) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (shouldSkip(el)) return;

      const id = ff.tag(el);
      const type = (() => {
        const role = el.getAttribute('role');
        if (role === 'textbox' && el.getAttribute('aria-multiline') === 'true') return 'textarea';
        if (role === 'textbox') return 'text';
        if (role === 'combobox') return 'select';
        if (role === 'listbox') return 'select';
        if (el.getAttribute('data-uxi-widget-type') === 'selectinput') return 'select';
        if (el.getAttribute('aria-haspopup') === 'listbox') return 'select';
        if (role === 'radio') return 'radio';
        if (role === 'checkbox') return 'checkbox';
        if (role === 'spinbutton') return 'number';
        if (role === 'slider') return 'range';
        if (role === 'searchbox') return 'search';
        if (role === 'switch') return 'toggle';
        if (el.tagName === 'SELECT') return 'select';
        if (el.tagName === 'TEXTAREA') return 'textarea';
        const t = el.type || '';
        return ({ text:'text', email:'email', tel:'tel', url:'url', number:'number', date:'date', file:'file', checkbox:'checkbox', radio:'radio', search:'search', password:'password' } as any)[t] || t || 'text';
      })();

      const visible = (() => {
        if (type === 'file' && !ff.isVisible(el)) {
          const container = el.closest('[class*=upload], [class*=drop], .form-group, .field');
          return container ? ff.isVisible(container) : false;
        }
        return ff.isVisible(el);
      })();

      const isNative = el.tagName === 'SELECT';
      const isMultiSelect = type === 'select' && !isNative && !!(
        el.querySelector('[class*="multi"]') ||
        el.classList.toString().includes('multi') ||
        el.getAttribute('aria-multiselectable') === 'true' ||
        el.querySelector('[aria-selected]')?.closest('[class*="multi"]')
      );

      const entry: any = {
        id, name: ff.getAccessibleName(el), type, section: ff.getSection(el),
        required: el.required || el.getAttribute('aria-required') === 'true' || el.dataset.required === 'true' || el.dataset.ffRequired === 'true',
        visible, isNative, isMultiSelect,
      };

      if (el.accept) entry.accept = el.accept;

      if (type === 'select') {
        let opts: string[] = [];
        if (el.tagName === 'SELECT') {
          opts = Array.from(el.options as HTMLOptionsCollection)
            .filter((o: any) => o.value !== '')
            .map((o: any) => o.textContent?.trim() || '')
            .filter(Boolean);
        } else {
          const ctrlId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
          let src = ctrlId ? document.getElementById(ctrlId) : null;
          if (!src && el.tagName === 'INPUT') {
            src = el.closest('[class*="select"], [class*="combobox"], .form-group, .field');
          }
          if (!src) src = el;
          if (src) {
            opts = Array.from(src.querySelectorAll('[role="option"], [role="menuitem"]'))
              .map((o: any) => getOptionMainText(o)).filter(Boolean);
          }
        }
        if (opts.length) entry.options = opts;
      }

      if (type === 'checkbox' || type === 'radio') {
        const labelEl = el.querySelector('[class*="label"], .rc-label');
        if (labelEl) {
          entry.itemLabel = labelEl.textContent?.trim() || '';
        } else {
          const wrap = el.closest('label');
          if (wrap) {
            const c = wrap.cloneNode(true) as HTMLElement;
            c.querySelectorAll('input, [class*=desc], small').forEach((x: any) => x.remove());
            entry.itemLabel = c.textContent?.trim() || '';
          } else {
            entry.itemLabel = el.getAttribute('aria-label') || ff.getAccessibleName(el);
          }
        }
        entry.itemValue = el.value || el.querySelector('input')?.value || '';
      }

      out.push(entry);
    });
    return out;
  });

  // Group checkboxes/radios
  const fields: FormField[] = [];
  const seen = new Set<string>();

  for (const f of raw) {
    if (!f.id || seen.has(f.id)) continue;

    if (f.type === 'checkbox' || f.type === 'radio') {
      if (seen.has('group:' + f.name)) continue;
      seen.add(f.id);

      const siblings = raw.filter((r: any) =>
        (r.type === 'checkbox' || r.type === 'radio') && r.name === f.name && r.section === f.section
      );
      if (siblings.length > 1) {
        seen.add('group:' + f.name);
        for (const s of siblings) seen.add(s.id);
        fields.push({
          id: f.id, name: f.name, type: `${f.type}-group`, section: f.section,
          required: f.required, isNative: false,
          choices: siblings.map((s: any) => s.itemLabel || s.name),
          visibleByDefault: f.visible,
        });
      } else {
        fields.push({
          id: f.id, name: f.itemLabel || f.name, type: f.type, section: f.section,
          required: f.required, isNative: false, visibleByDefault: f.visible,
        });
      }
    } else {
      seen.add(f.id);
      const field: FormField = {
        id: f.id, name: f.name, type: f.type, section: f.section,
        required: f.required, isNative: f.isNative, visibleByDefault: f.visible,
      };
      if (f.accept) field.accept = f.accept;
      if (f.options) field.options = f.options;
      if (f.isMultiSelect) field.isMultiSelect = true;
      fields.push(field);
    }
  }

  // Strip Workday internal elements
  return fields.filter((f) => f.name !== 'items selected');
}

// ── Combobox interaction ─────────────────────────────────────

async function clickComboboxTrigger(page: Page, id: string): Promise<void> {
  const targetSelector = await page.evaluate((ffId) => {
    const el = document.querySelector(`[data-ff-id="${ffId}"]`) as HTMLElement;
    if (!el) return null;

    if (el.tagName === 'INPUT') {
      const control = el.closest('[class*="select__control"]') ||
        el.closest('[class*="control"]') || el.closest('[class*="select-shell"]');
      if (control) {
        if (!control.hasAttribute('data-ff-id')) {
          control.setAttribute('data-ff-click-target', ffId);
        }
        return `[data-ff-click-target="${ffId}"], [data-ff-id="${ffId}"]`;
      }
    }

    const trigger = el.querySelector(':scope > [class*="trigger"]') ||
      el.querySelector(':scope > button') || el.querySelector(':scope > div');
    if (trigger && trigger !== el) {
      (trigger as HTMLElement).click();
      return '__already_clicked__';
    }
    el.click();
    return '__already_clicked__';
  }, id);

  if (!targetSelector) throw new Error(`Combobox ${id} not found`);

  if (targetSelector !== '__already_clicked__') {
    try {
      await page.click(targetSelector, { timeout: 2000 });
    } catch {
      await page.focus(`[data-ff-id="${id}"]`);
    }
  }
  await page.waitForTimeout(600);
}

// ── Workday portal helpers ───────────────────────────────────

/** Read de-duplicated option texts from any visible dropdown portal. */
async function readActiveListOptions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const results: string[] = [];
    function collect(items: Element[]) {
      for (const o of items) {
        const r = (o as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const t = (o.textContent || '').trim();
        if (t && t.length < 200) results.push(t);
      }
    }

    // 1. Workday activeListContainer portal
    const container = document.querySelector('[data-automation-id="activeListContainer"]');
    if (container) {
      let items = Array.from(container.querySelectorAll('[role="option"]'));
      if (items.length === 0) {
        items = Array.from(container.querySelectorAll(
          '[data-automation-id="promptOption"], [data-automation-id="menuItem"]'
        ));
      }
      collect(items);
    }

    // 2. Any visible [role="listbox"]
    if (results.length === 0) {
      const listboxes = document.querySelectorAll('[role="listbox"]');
      for (const lb of listboxes) {
        const r = (lb as HTMLElement).getBoundingClientRect();
        if (r.height > 0) {
          collect(Array.from(lb.querySelectorAll('[role="option"]')));
        }
      }
    }

    // 3. Any visible standalone [role="option"]
    if (results.length === 0) {
      collect(Array.from(document.querySelectorAll('[role="option"]')).filter(el => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.height > 0;
      }));
    }

    // 4. Generic dropdown li items
    if (results.length === 0) {
      const dropdowns = document.querySelectorAll(
        '[class*="dropdown"]:not([style*="display: none"]), [class*="menu"]:not([style*="display: none"]), [class*="listbox"]:not([style*="display: none"])'
      );
      for (const dd of dropdowns) {
        const r = (dd as HTMLElement).getBoundingClientRect();
        if (r.height > 0) {
          collect(Array.from(dd.querySelectorAll('li')));
        }
      }
    }

    return [...new Set(results)];
  });
}

/** Click an option inside a dropdown using Playwright locators (proper events). */
async function clickActiveListOption(page: Page, text: string): Promise<boolean> {
  const exactRe = new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  try {
    // Try activeListContainer portal first (Workday)
    const portal = page.locator('[data-automation-id="activeListContainer"]');
    if (await portal.count() > 0) {
      let option = portal.locator(`[role="option"]`).filter({ hasText: exactRe }).first();
      if (await option.count() === 0) {
        option = portal.locator(`[data-automation-id="promptOption"], [data-automation-id="menuItem"]`)
          .filter({ hasText: exactRe }).first();
      }
      if (await option.count() > 0) {
        await option.click({ timeout: 2000 });
        return true;
      }
      // Substring fallback in portal
      option = portal.locator(`[role="option"]`).filter({ hasText: text }).first();
      if (await option.count() > 0) {
        await option.click({ timeout: 2000 });
        return true;
      }
    }

    // Visible [role="listbox"] [role="option"]
    const listbox = page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: exactRe }).first();
    if (await listbox.count() > 0) {
      await listbox.click({ timeout: 2000 });
      return true;
    }

    // Any visible [role="option"]
    const anyOption = page.locator('[role="option"]:visible').filter({ hasText: exactRe }).first();
    if (await anyOption.count() > 0) {
      await anyOption.click({ timeout: 2000 });
      return true;
    }

    // Generic dropdown li patterns
    for (const containerSel of [
      'ul:visible li',
      '[class*="dropdown"]:visible li',
      '[class*="menu"]:visible li',
      '[class*="select"]:visible li',
      '[class*="listbox"]:visible li',
    ]) {
      const li = page.locator(containerSel).filter({ hasText: exactRe }).first();
      if (await li.count() > 0) {
        await li.click({ timeout: 2000 });
        return true;
      }
    }

    // Substring fallback for non-portal
    const subMatch = page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: text }).first();
    if (await subMatch.count() > 0) {
      await subMatch.click({ timeout: 2000 });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** Dismiss any open Workday dropdown/popup. */
async function dismissDropdown(page: Page): Promise<void> {
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }).catch(() => {});
  await page.waitForTimeout(150);
}

// ── Dropdown option discovery ────────────────────────────────

/** Open each custom dropdown briefly to discover its options at fill-time.
 *  For hierarchical Workday dropdowns (with chevron sub-categories),
 *  drills into each category and stores options as "Category > SubOption". */
async function discoverDropdownOptions(page: Page, fields: FormField[]): Promise<void> {
  for (const f of fields) {
    if (f.type !== 'select' || f.isNative || (f.options && f.options.length > 0)) continue;
    if (!f.name) continue;

    try {
      // Dismiss any lingering dropdown portal before opening next
      await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); }).catch(() => {});
      await page.waitForTimeout(300);

      await clickComboboxTrigger(page, f.id);
      await page.waitForTimeout(500);

      // Check if activeListContainer appeared (Workday selectinput)
      const topLevel = await readActiveListOptions(page);

      if (topLevel.length > 0) {
        // Detect chevrons indicating hierarchical sub-categories
        const hasChevrons = await page.evaluate(() => {
          const container = document.querySelector('[data-automation-id="activeListContainer"]');
          if (!container) return false;
          return container.querySelector('svg.wd-icon-chevron-right-small') !== null ||
            container.querySelector('[data-uxi-multiselectlistitem-hassidecharm="true"]') !== null;
        });

        if (hasChevrons) {
          // Hierarchical dropdown — drill into each category
          const allOptions: string[] = [];

          for (let i = 0; i < topLevel.length; i++) {
            const category = topLevel[i];

            if (i > 0) {
              // Reopen dropdown for each category after the first
              await clickComboboxTrigger(page, f.id);
              await page.waitForTimeout(500);
            }

            // Click the category to drill into sub-options
            await clickActiveListOption(page, category);
            await page.waitForTimeout(800);

            // Read sub-options, handling virtualized lists
            const info = await page.evaluate(() => {
              const c = document.querySelector('[data-automation-id="activeListContainer"]');
              if (!c) return { setsize: 0, texts: [] as string[] };
              const items = c.querySelectorAll('[role="option"]');
              const setsize = parseInt(items[0]?.getAttribute('aria-setsize') || '0', 10);
              const texts = Array.from(items)
                .filter((o: any) => o.getBoundingClientRect().height > 0)
                .map((o: any) => (o.textContent || '').trim())
                .filter(Boolean);
              return { setsize, texts: [...new Set(texts)] };
            });

            const allSubs: string[] = [...info.texts];

            // If virtualized, scroll to load more items
            if (info.setsize > info.texts.length) {
              for (let scrollAttempt = 0; scrollAttempt < 20; scrollAttempt++) {
                await page.evaluate(() => {
                  const c = document.querySelector('[data-automation-id="activeListContainer"]') as HTMLElement;
                  if (c) c.scrollTop += 300;
                });
                await page.waitForTimeout(200);

                const moreTexts = await page.evaluate(() => {
                  const c = document.querySelector('[data-automation-id="activeListContainer"]');
                  if (!c) return [];
                  return Array.from(c.querySelectorAll('[role="option"]'))
                    .filter((o: any) => o.getBoundingClientRect().height > 0)
                    .map((o: any) => (o.textContent || '').trim())
                    .filter(Boolean);
                });

                let newCount = 0;
                for (const t of moreTexts) {
                  if (!allSubs.includes(t)) {
                    allSubs.push(t);
                    newCount++;
                  }
                }
                if (newCount === 0) break;
              }
            }

            for (const sub of allSubs) {
              allOptions.push(`${category} > ${sub}`);
            }

            // Close and dismiss before next category
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
            await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); }).catch(() => {});
            await page.waitForTimeout(200);
          }

          f.options = allOptions;
          console.log(`[formFiller] discovered ${allOptions.length} hierarchical options for "${f.name}"`);
        } else {
          // Flat dropdown — use top-level options directly
          f.options = topLevel;
          console.log(`[formFiller] discovered ${topLevel.length} options for "${f.name}"`);
        }
      } else {
        // No activeListContainer — fall back to standard option extraction
        const options = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return [];
          const ff = (window as any).__ff;
          const results: string[] = [];

          function collect(container: Element) {
            const opts = container.querySelectorAll('[role="option"], [role="menuitem"], li');
            for (const o of opts) {
              const r = (o as HTMLElement).getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const t = o.textContent?.trim();
              if (t && t.length < 200) results.push(t);
            }
          }

          collect(el);
          const ctrlId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
          if (ctrlId) {
            const popup = document.getElementById(ctrlId);
            if (popup) collect(popup);
          }
          if (el.tagName === 'INPUT') {
            const container = el.closest('[class*="select"], [class*="combobox"], .form-group');
            if (container) collect(container);
          }
          // Workday button dropdowns
          const listboxes = document.querySelectorAll('[role="listbox"]');
          for (const lb of listboxes) {
            const r = (lb as HTMLElement).getBoundingClientRect();
            if (r.height > 0) collect(lb);
          }
          return [...new Set(results)];
        }, f.id);

        if (options.length > 0) {
          f.options = options;
          console.log(`[formFiller] discovered ${options.length} options for "${f.name}" (fallback)`);
        }
      }

      // Ensure dropdown is fully closed
      await page.keyboard.press('Escape');
      await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); }).catch(() => {});
      await page.waitForTimeout(300);
    } catch {
      // Ignore — some fields won't open
    }
  }
}

// ── LLM answer generation ────────────────────────────────────

async function generateAnswers(fields: FormField[], profileText: string): Promise<GenerateResult> {
  const client = new Anthropic();

  // Disambiguate duplicate field names by appending "#2", "#3", etc.
  const nameCounts = new Map<string, number>();
  const disambiguatedNames: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const baseName = fields[i].name?.trim() || `Field ${i + 1}`;
    const norm = normalizeName(baseName) || `field-${i + 1}`;
    const count = (nameCounts.get(norm) || 0) + 1;
    nameCounts.set(norm, count);
    disambiguatedNames.push(count > 1 ? `${baseName} #${count}` : baseName);
  }

  const fieldIdToKey: Record<string, string> = {};
  for (let i = 0; i < fields.length; i++) {
    fieldIdToKey[fields[i].id] = disambiguatedNames[i];
  }

  const fieldDescriptions = fields.map((f, i) => {
    const displayName = disambiguatedNames[i];
    let desc = `- "${displayName}" (type: ${f.isMultiSelect ? 'multi-select' : f.type})`;
    if (f.options?.length) desc += ` options: [${f.options.join(', ')}]`;
    if (f.choices?.length) desc += ` choices: [${f.choices.join(', ')}]`;
    if (f.section) desc += ` [section: ${f.section}]`;
    return desc;
  }).join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are filling out a job application form on behalf of an applicant. Today's date is ${new Date().toLocaleDateString('en-CA')}.

Here is their profile:

${profileText}

Here are the form fields to fill:

${fieldDescriptions}

Rules:
- For each field, decide what value to put based on the profile.
- Fields marked with * are REQUIRED. NEVER return "" for required fields. Always provide a value from the profile or make up a plausible one.
- For optional fields, still fill them in if the profile has any relevant info. Only return "" for optional fields where there is truly nothing relevant to put (e.g. phone extension when none exists, middle name when none provided).
- For dropdowns/radio groups with listed options, you MUST pick the EXACT text of one of the available options.
- For hierarchical dropdown options (format "Category > SubOption"), pick the EXACT full path including the " > " separator.
- For dropdowns WITHOUT listed options, provide your best guess for the value.
- For skill typeahead fields (labels containing "skill", e.g. "Type to Add Skills"), options are often partial/virtualized. Return an ARRAY of relevant skills from the applicant profile even if the options list is incomplete.
- For multi-select fields, return a JSON array of ALL matching options from the available list (e.g., ["Python", "Java", "Go"]). Select every option that matches the applicant's skills/background.
- For checkboxes/toggles, respond with "checked"/"unchecked" or "on"/"off".
- For file upload fields, skip them (don't include in output).
- For textarea fields (cover letters, open-ended questions), write 2-4 thoughtful sentences using the applicant's real background. NEVER return a single letter or placeholder — write a genuine response.
- For conditional "Please specify" or "Other (please explain)" fields, answer in context of what triggered them (e.g., if "How did you hear about us?" was "Other", specify the referral source, not the job title).
- For demographic/EEO fields (gender, race, ethnicity, veteran, disability), use the applicant's actual demographic info from their profile. Pick the option that best matches. If the profile has NO demographic info for a field, choose the most neutral "decline" option (e.g. "Not Declared", "Prefer not to say", "I do not wish to disclose", "Decline to self-identify") — NEVER leave it as the default placeholder.
- NEVER select a default placeholder value like "Select One", "Choose one", "Please select", "-- Select --", or any similar default/blank option. These are not valid answers. Always pick a real option from the list.
- For salary fields, provide a realistic number based on the role and experience level (e.g., 120000 for a mid-level engineer).
- Fields with "#2", "#3", etc. are repeated fields from repeater sections (e.g. multiple work experiences or education entries). Use the matching numbered entry from the profile.
- Use the EXACT field names shown above (including any "#N" suffix) as JSON keys.
- You MUST respond with ONLY a valid JSON object. No explanation, no commentary, no markdown fences.

Example response:
{"First Name": "Alexander", "Last Name": "Chen", "How Did You Hear About Us?": "Employee Referral > Referral", "Programming Languages": ["Python", "JavaScript / TypeScript", "Go"], "Cover Letter / Why do you want to work here?": "I am excited to apply because..."}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  if (response.stop_reason === 'max_tokens') {
    console.log('[formFiller] WARNING: LLM response was truncated (hit max_tokens limit). Some fields may be missing answers.');
  }
  console.log('[formFiller] LLM response: ' + text.slice(0, 200) + (text.length > 200 ? '…' : ''));

  try {
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned) as AnswerMap;
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) (parsed as any)[k] = v.join(',');
      else if (typeof v === 'number') (parsed as any)[k] = String(v);
    }

    // Post-processing: replace placeholder answers with neutral "decline" options
    const placeholderPattern = /^(select one|choose one|please select|-- ?select ?--|— ?select ?—|\(select\)|select\.{0,3})$/i;
    const declinePatterns = [
      /not declared/i, /prefer not/i, /decline/i, /do not wish/i,
      /choose not/i, /rather not/i, /not specified/i, /not applicable/i, /n\/?a/i,
    ];
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string' && placeholderPattern.test(val.trim())) {
        // Find the matching field to get its options
        const fieldIdx = disambiguatedNames.indexOf(key);
        const field = fieldIdx >= 0 ? fields[fieldIdx] : undefined;
        const options = field?.options ?? field?.choices ?? [];
        // Find best neutral "decline" option
        const neutral = options.find(o => declinePatterns.some(p => p.test(o)));
        if (neutral) {
          console.log(`[formFiller] Replaced placeholder "${val}" → "${neutral}" for field "${key}"`);
          (parsed as any)[key] = neutral;
        } else if (options.length > 0) {
          // No explicit decline option — pick the last non-placeholder option (often the "other" or neutral one)
          const nonPlaceholder = options.filter(o => !placeholderPattern.test(o.trim()));
          if (nonPlaceholder.length > 0) {
            const fallback = nonPlaceholder[nonPlaceholder.length - 1];
            console.log(`[formFiller] Replaced placeholder "${val}" → "${fallback}" (last non-placeholder) for field "${key}"`);
            (parsed as any)[key] = fallback;
          }
        }
      }
    }

    return { answers: parsed, fieldIdToKey, inputTokens, outputTokens };
  } catch {
    console.log('[formFiller] Failed to parse LLM response as JSON, using empty answers');
    return { answers: {}, fieldIdToKey, inputTokens, outputTokens };
  }
}

// ── Fill a single field ──────────────────────────────────────

async function fillField(page: Page, field: FormField, answers: AnswerMap, resumePath?: string | null, resumeAlreadyUploaded = false): Promise<boolean> {
  const sel = `[data-ff-id="${field.id}"]`;
  const tag = `[${field.name || field.type}]`;

  const exists = await page.evaluate(({ ffId, type }) => {
    const ff = (window as any).__ff;
    const el = document.querySelector(`[data-ff-id="${ffId}"]`);
    if (!el) return false;
    if (ff.isVisible(el)) return true;
    if (type === 'file') {
      const container = el.closest('[class*=upload], [class*=drop], .form-group, .field');
      return container ? ff.isVisible(container) : false;
    }
    return false;
  }, { ffId: field.id, type: field.type });
  if (!exists) return false;

  switch (field.type) {
    case 'text':
    case 'email':
    case 'tel':
    case 'url':
    case 'number':
    case 'password':
    case 'search': {
      // Detect searchable dropdowns (Workday selectinput, comboboxes, etc.)
      const searchDropdown = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return false;
        return (
          el.getAttribute('role') === 'combobox' ||
          el.getAttribute('data-uxi-widget-type') === 'selectinput' ||
          el.getAttribute('data-automation-id') === 'searchBox' ||
          (el.getAttribute('autocomplete') === 'off' && el.getAttribute('aria-controls'))
        );
      }, field.id);

      if (searchDropdown) {
        const val = getAnswer(answers, field);
        if (!val) {
          console.log(`[formFiller]   skip ${tag} (searchable dropdown, no answer)`);
          return false;
        }
        try {
          // Click to open the dropdown
          await page.click(sel, { timeout: 2000 });
          await page.waitForTimeout(400);

          // Type to search — this filters the dropdown
          await page.fill(sel, '', { timeout: 1000 }).catch(() => {});
          await page.type(sel, val, { delay: 30 });
          await page.waitForTimeout(1500);

          // Try to click a matching element
          const clicked = await page.evaluate((text) => {
            const lowerText = text.toLowerCase();

            // Strategy 1: ARIA/role-based elements
            const roleEls = document.querySelectorAll(
              '[role="option"], [role="menuitem"], [role="treeitem"], ' +
              '[data-automation-id*="promptOption"], [data-automation-id*="menuItem"]'
            );
            for (const o of roleEls) {
              const rect = o.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const t = (o.textContent || '').trim().toLowerCase();
              if (t === lowerText || t.includes(lowerText)) {
                (o as HTMLElement).click();
                return (o.textContent || '').trim();
              }
            }

            // Strategy 2: Any visible clickable element whose text matches
            const allVisible = document.querySelectorAll(
              'div[tabindex], div[data-automation-id], span[data-automation-id], ' +
              'li, a, button, [role="button"]'
            );
            for (const o of allVisible) {
              const rect = o.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              let directText = '';
              for (const n of o.childNodes) {
                if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;
                else if (n.nodeType === Node.ELEMENT_NODE) directText += (n as Element).textContent;
              }
              directText = directText.trim().toLowerCase();
              if (directText && (directText === lowerText || directText.includes(lowerText))) {
                (o as HTMLElement).click();
                return directText;
              }
            }
            return null;
          }, val);

          if (clicked) {
            console.log(`[formFiller]   search-select ${tag} → "${clicked}"`);
            await page.waitForTimeout(300);
            return true;
          }

          // Last resort: press down + enter to select first result
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(200);
          await page.keyboard.press('Enter');
          console.log(`[formFiller]   search-select ${tag} → first result (keyboard)`);
          await page.waitForTimeout(300);
          return true;
        } catch (e: any) {
          console.log(`[formFiller]   skip ${tag} (searchable dropdown failed: ${e.message?.slice(0, 60)})`);
          return false;
        }
      }

      const val = getAnswer(answers, field) ?? defaultValue(field);
      if (!val) {
        if (field.required || field.name.includes('*')) {
          // Required but no answer — don't fill with empty string, let MagnitudeHand handle it
          console.log(`[formFiller]   skip ${tag} (no answer, required — deferring to MagnitudeHand)`);
        } else {
          console.log(`[formFiller]   skip ${tag} (no answer, optional)`);
        }
        return false;
      }
      try {
        // Workday date components
        const isWorkdayDate = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return false;
          const auto = el.getAttribute('data-automation-id') || '';
          if (auto.includes('dateSection')) return true;
          const parent = el.closest('[data-automation-id*="dateSection"]');
          return !!parent;
        }, field.id);

        if (isWorkdayDate) {
          await page.evaluate((ffId) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`) as HTMLElement;
            if (!el) return;
            const section = el.closest('[data-automation-id*="dateSection"]:not([data-automation-id*="-input"]):not([data-automation-id*="-display"])') as HTMLElement;
            if (section) section.click();
            else el.parentElement?.click();
          }, field.id);
          await page.waitForTimeout(300);
          await page.focus(sel).catch(() => {});
          await page.waitForTimeout(100);
          await page.keyboard.press('Home');
          await page.keyboard.press('Shift+End');
          await page.keyboard.type(val, { delay: 30 });
          await page.keyboard.press('Tab');
          await page.waitForTimeout(200);
          console.log(`[formFiller]   fill ${tag} = "${val}"`);
          return true;
        }

        await page.fill(sel, val, { timeout: 2000 });
        console.log(`[formFiller]   fill ${tag} = "${val}"`);
        return true;
      } catch {
        // Fallback: click + type for elements that don't support fill
        try {
          await page.click(sel, { timeout: 2000 });
          await page.waitForTimeout(100);
          await page.keyboard.press('Home');
          await page.keyboard.press('Shift+End');
          await page.keyboard.type(val, { delay: 30 });
          await page.keyboard.press('Tab');
          console.log(`[formFiller]   fill ${tag} = "${val}" (click+type)`);
          return true;
        } catch {
          console.log(`[formFiller]   skip ${tag} (not fillable)`);
          return false;
        }
      }
    }

    case 'date': {
      const val = getAnswer(answers, field) ?? '2025-01-01';
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.log(`[formFiller]   fill ${tag} = "${val}"`);
        return true;
      } catch {
        try {
          await page.evaluate(({ sel, val }) => {
            const el = document.querySelector(sel) as HTMLInputElement;
            if (!el) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { sel, val });
          console.log(`[formFiller]   fill ${tag} = "${val}" (direct)`);
          return true;
        } catch {
          console.log(`[formFiller]   skip ${tag} (not fillable)`);
          return false;
        }
      }
    }

    case 'textarea': {
      const val = getAnswer(answers, field) ?? defaultValue(field);
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.log(`[formFiller]   fill ${tag} = "${val.slice(0, 80)}${val.length > 80 ? '…' : ''}"`);
        return true;
      } catch {
        try {
          await page.evaluate(({ sel, val }) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return;
            el.textContent = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { sel, val });
          console.log(`[formFiller]   fill ${tag} = "${val.slice(0, 80)}${val.length > 80 ? '…' : ''}" (contenteditable)`);
          return true;
        } catch {
          console.log(`[formFiller]   skip ${tag} (not fillable)`);
          return false;
        }
      }
    }

    case 'select': {
      const answer = getAnswer(answers, field);
      const isSkillField = isSkillLikeFieldName(field.name);

      // Skip if already shows correct value
      if (answer && !field.isNative) {
        const currentDisplay = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return '';
          if (el.tagName === 'INPUT') return (el as HTMLInputElement).value.trim();
          const searchInput = el.querySelector('[data-automation-id="searchBox"], .wd-selectinput-search');
          if (searchInput) return (searchInput as HTMLInputElement).value.trim();
          const pills = el.closest('[data-automation-id]')
            ?.querySelector('[data-automation-id="selectedItem"], [data-automation-id="multiSelectPill"]');
          if (pills) return pills.textContent?.trim() || '';
          const trigger = el.querySelector('.custom-select-trigger, .multi-select-trigger, [class*="select-trigger"]');
          if (trigger) return trigger.textContent?.trim() || '';
          const clone = el.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('[role="listbox"], [class*="dropdown"], [class*="select-dropdown"]').forEach((x: any) => x.remove());
          return clone.textContent?.trim() || '';
        }, field.id);
        const isPlaceholder = !currentDisplay || /^(select|choose|pick|prefer not|--|—|\+\d{1,3}$)/i.test(currentDisplay);
        if (!isPlaceholder && currentDisplay.toLowerCase().includes(answer.toLowerCase())) {
          console.log(`[formFiller]   skip ${tag} (already has "${currentDisplay}")`);
          return true;
        }
      }

      if (field.isNative) {
        try {
          if (answer) {
            try {
              await page.selectOption(sel, { label: answer }, { timeout: 2000 });
              console.log(`[formFiller]   select ${tag} → "${answer}"`);
            } catch {
              const matched = await page.evaluate(
                ({ ffId, text }) => {
                  const el = document.querySelector(`[data-ff-id="${ffId}"]`) as HTMLSelectElement;
                  if (!el) return null;
                  const lower = text.toLowerCase();
                  for (const opt of el.options) {
                    const t = opt.textContent?.trim().toLowerCase() || '';
                    if (t.startsWith(lower) || lower.startsWith(t) || t.includes(lower)) return opt.value;
                  }
                  return null;
                },
                { ffId: field.id, text: answer }
              );
              if (matched) {
                await page.selectOption(sel, matched, { timeout: 2000 });
                console.log(`[formFiller]   select ${tag} → "${answer}" (fuzzy)`);
              } else {
                await page.selectOption(sel, { index: 1 }, { timeout: 2000 });
                console.log(`[formFiller]   select ${tag} → option index 1 (answer "${answer}" not found)`);
              }
            }
          } else {
            await page.selectOption(sel, { index: 1 }, { timeout: 2000 });
            console.log(`[formFiller]   select ${tag} → option index 1`);
          }
          return true;
        } catch {
          console.log(`[formFiller]   skip ${tag} (native select failed)`);
          return false;
        }
      }

      // Multi-select values (comma-separated, or skill fields with single/multi values)
      const MAX_SKILL_TAGS = 3; // Cap skill entries to avoid slow typeahead loops
      const allValues = answer ? answer.split(',').map(v => v.trim()).filter(Boolean) : [];
      const values = isSkillField ? allValues.slice(0, MAX_SKILL_TAGS) : allValues;
      if ((answer && answer.includes(',')) || (isSkillField && values.length > 0)) {
        let clicked = 0;
        try {
          await clickComboboxTrigger(page, field.id);
          await page.waitForTimeout(600);

          for (const val of values) {
            try {
              const ok = await clickActiveListOption(page, val);
              if (ok) {
                clicked++;
                await page.waitForTimeout(200);
              } else {
                // Try fuzzy match
                const available = await readActiveListOptions(page);
                const lv = val.toLowerCase();
                const fuzzy = available.find(a => {
                  const la = a.toLowerCase();
                  return la.includes(lv) || lv.includes(la);
                });
                if (fuzzy) {
                  const fok = await clickActiveListOption(page, fuzzy);
                  if (fok) clicked++;
                  await page.waitForTimeout(200);
                }
              }
            } catch { /* keep going */ }
          }
        } catch { /* open failed */ }

        if (clicked > 0) {
          await dismissDropdown(page);
          console.log(`[formFiller]   multi-select ${tag} → ${clicked}/${values.length} options`);
          return true;
        }

        // Fallback: typeahead/autocomplete inputs (e.g., Workday "Type to Add Skills")
        try {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(200);
          await page.click(sel, { timeout: 2000 });
          await page.waitForTimeout(200);
          let added = 0;
          for (const val of values) {
            const beforePillCount = await page.evaluate((ffId) => {
              const el = document.querySelector(`[data-ff-id="${ffId}"]`);
              const scope = el?.closest('[data-automation-id], .form-group, .field, form') || document;
              return scope.querySelectorAll(
                '[data-automation-id="multiSelectPill"], [data-automation-id="selectedItem"], [class*="pill"]'
              ).length;
            }, field.id).catch(() => 0);

            await page.keyboard.type(val, { delay: 30 });
            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);

            let picked = false;
            try { picked = await clickActiveListOption(page, val); } catch { /* no active list */ }

            if (!picked) {
              // Tag matching option and click with Playwright locator
              try {
                const tagged = await page.evaluate((searchText) => {
                  document.querySelectorAll('[data-ff-click-target="skill"]').forEach(el => el.removeAttribute('data-ff-click-target'));
                  const containers = document.querySelectorAll(
                    '[role="listbox"], [data-automation-id="activeListContainer"], ' +
                    '[class*="dropdown"], [class*="suggestions"], [class*="autocomplete"]'
                  );
                  const lower = searchText.toLowerCase().trim();
                  for (const c of containers) {
                    const items = c.querySelectorAll('[role="option"], li, [class*="option"], [class*="item"]');
                    for (const item of items) {
                      const r = (item as HTMLElement).getBoundingClientRect();
                      if (r.height === 0) continue;
                      const t = (item.textContent || '').trim().toLowerCase();
                      if (t === lower || t.includes(lower) || lower.includes(t)) {
                        (item as HTMLElement).setAttribute('data-ff-click-target', 'skill');
                        return true;
                      }
                    }
                  }
                  return false;
                }, val);
                if (tagged) {
                  await page.locator('[data-ff-click-target="skill"]').first().click({ timeout: 2000 });
                  await page.evaluate(() => document.querySelectorAll('[data-ff-click-target="skill"]').forEach(el => el.removeAttribute('data-ff-click-target')));
                  picked = true;
                }
              } catch { /* no dropdown */ }
            }

            // If no exact match, retry once with a broader term (first token)
            if (!picked && val.includes(' ')) {
              await page.click(sel, { clickCount: 3, timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(100);
              await page.keyboard.press('Backspace');
              await page.waitForTimeout(200);

              const shortTerm = val.split(' ')[0];
              await page.keyboard.type(shortTerm, { delay: 30 });
              await page.waitForTimeout(300);
              await page.keyboard.press('Enter');
              await page.waitForTimeout(3000);

              try { picked = await clickActiveListOption(page, val); } catch { /* no active list */ }
              if (!picked) {
                try {
                  const tagged = await page.evaluate((searchText) => {
                    document.querySelectorAll('[data-ff-click-target="skill"]').forEach(el => el.removeAttribute('data-ff-click-target'));
                    const containers = document.querySelectorAll(
                      '[role="listbox"], [data-automation-id="activeListContainer"], ' +
                      '[class*="dropdown"], [class*="suggestions"], [class*="autocomplete"]'
                    );
                    const lower = searchText.toLowerCase().trim();
                    for (const c of containers) {
                      const items = c.querySelectorAll('[role="option"], li, [class*="option"], [class*="item"]');
                      for (const item of items) {
                        const r = (item as HTMLElement).getBoundingClientRect();
                        if (r.height === 0) continue;
                        const t = (item.textContent || '').trim().toLowerCase();
                        if (t === lower || t.includes(lower) || lower.includes(t)) {
                          (item as HTMLElement).setAttribute('data-ff-click-target', 'skill');
                          return true;
                        }
                      }
                    }
                    return false;
                  }, val);
                  if (tagged) {
                    await page.locator('[data-ff-click-target="skill"]').first().click({ timeout: 2000 });
                    await page.evaluate(() => document.querySelectorAll('[data-ff-click-target="skill"]').forEach(el => el.removeAttribute('data-ff-click-target')));
                    picked = true;
                  }
                } catch { /* no dropdown */ }
              }
            }

            if (!picked) {
              await page.keyboard.press('Enter');
              await page.waitForTimeout(500);
            }

            const afterPillCount = await page.evaluate((ffId) => {
              const el = document.querySelector(`[data-ff-id="${ffId}"]`);
              const scope = el?.closest('[data-automation-id], .form-group, .field, form') || document;
              return scope.querySelectorAll(
                '[data-automation-id="multiSelectPill"], [data-automation-id="selectedItem"], [class*="pill"]'
              ).length;
            }, field.id).catch(() => beforePillCount);
            if (!picked && afterPillCount > beforePillCount) {
              picked = true;
            }

            await page.evaluate(() => { const body = document.querySelector('body'); if (body) body.click(); });
            await page.waitForTimeout(300);
            await page.click(sel, { clickCount: 3, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(100);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(200);
            if (picked) added++;
          }
          if (added > 0) {
            console.log(`[formFiller]   multi-select ${tag} → ${added}/${values.length} tags (type+enter)`);
            return true;
          }
        } catch { /* typeahead failed */ }

        await page.keyboard.press('Escape').catch(() => {});
        console.log(`[formFiller]   skip ${tag} (multi-select failed)`);
        return false;
      }

      if (isSkillField && !answer) {
        console.log(`[formFiller]   skip ${tag} (skills field with no resolved answer)`);
        return false;
      }

      // opt will be set by hierarchical fallthrough or below
      let opt: string | undefined;

      // Hierarchical dropdown: "Category > SubOption" path
      if (answer && answer.includes(' > ')) {
        const [category, value] = answer.split(' > ', 2);
        try {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(300);

          await clickComboboxTrigger(page, field.id);
          await page.waitForTimeout(500);

          const hasContainer = await page.evaluate(() =>
            !!document.querySelector('[data-automation-id="activeListContainer"]')
          );

          if (hasContainer) {
            const catClicked = await clickActiveListOption(page, category);
            if (catClicked) {
              await page.waitForTimeout(1000);

              const portalOpen = await page.evaluate(() =>
                !!document.querySelector('[data-automation-id="activeListContainer"]')
              );

              if (portalOpen) {
                // Find and click sub-option, handling virtualized lists
                const findAndTag = async (): Promise<boolean> => {
                  return page.evaluate((searchText) => {
                    const c = document.querySelector('[data-automation-id="activeListContainer"]');
                    if (!c) return false;
                    const items = Array.from(c.querySelectorAll('[role="option"]'));
                    const lower = searchText.toLowerCase().trim();
                    for (const item of items) {
                      const r = (item as HTMLElement).getBoundingClientRect();
                      if (r.height === 0) continue;
                      const t = (item.textContent || '').trim().toLowerCase();
                      if (t === lower || t.includes(lower) || lower.includes(t)) {
                        (item as HTMLElement).setAttribute('data-ff-click-target', 'sub');
                        return true;
                      }
                    }
                    return false;
                  }, value);
                };

                let foundSub = await findAndTag();

                // Scroll through virtualized list to find the option
                if (!foundSub) {
                  for (let scrollAttempt = 0; scrollAttempt < 30; scrollAttempt++) {
                    await page.evaluate(() => {
                      const c = document.querySelector('[data-automation-id="activeListContainer"]') as HTMLElement;
                      if (c) c.scrollTop += 300;
                    });
                    await page.waitForTimeout(150);
                    foundSub = await findAndTag();
                    if (foundSub) break;
                  }
                }

                if (foundSub) {
                  await page.locator('[data-ff-click-target="sub"]').first().click({ timeout: 2000 });
                  await page.evaluate(() => document.querySelectorAll('[data-ff-click-target]').forEach(el => el.removeAttribute('data-ff-click-target')));
                  await dismissDropdown(page);
                  console.log(`[formFiller]   select ${tag} → "${category} > ${value}"`);
                  return true;
                }

                // clickActiveListOption fallback
                const subClicked = await clickActiveListOption(page, value);
                if (subClicked) {
                  await dismissDropdown(page);
                  console.log(`[formFiller]   select ${tag} → "${category} > ${value}"`);
                  return true;
                }
              }
            }
          }

          // Hierarchical path didn't work — close and fall through
          await page.keyboard.press('Escape').catch(() => {});
          await dismissDropdown(page);
        } catch {
          await page.keyboard.press('Escape').catch(() => {});
        }
        opt = value; // try just the sub-option text as flat select
      }

      // Custom dropdown: use answer if provided, else first non-placeholder
      if (!opt) {
        opt = answer
          ?? field.options?.find((o) => !PLACEHOLDER_RE.test(o))
          ?? field.options?.[0];
      }

      if (!opt) {
        // No options known — try clicking to discover them on the fly
        try {
          await clickComboboxTrigger(page, field.id);
          await page.waitForTimeout(600);
          const options = await readActiveListOptions(page);
          if (options.length > 0) {
            const clicked = await clickActiveListOption(page, options[0]);
            if (clicked) {
              await dismissDropdown(page);
              console.log(`[formFiller]   select ${tag} → first available option`);
              return true;
            }
          }
          await page.keyboard.press('Escape');
          console.log(`[formFiller]   skip ${tag} (no options found)`);
          return false;
        } catch {
          console.log(`[formFiller]   skip ${tag} (no options)`);
          return false;
        }
      }

      // Use Playwright locator clicks (proper events for Workday UXI)
      try {
        await clickComboboxTrigger(page, field.id);
        await page.waitForTimeout(600);

        // Try direct Playwright locator click
        let clicked = await clickActiveListOption(page, opt);
        if (clicked) {
          await dismissDropdown(page);
          console.log(`[formFiller]   select ${tag} → "${opt}"`);
          return true;
        }

        // Type-to-search: if selectinput has a search box, type to filter
        try {
          const hasSearch = await page.evaluate((ffId) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return false;
            const input = el.querySelector('input[type="text"], input:not([type])') as HTMLInputElement;
            if (input && document.activeElement === input) return true;
            return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'hidden';
          }, field.id);
          if (hasSearch) {
            await page.keyboard.type(opt.slice(0, 30), { delay: 50 });
            await page.waitForTimeout(800);
            clicked = await clickActiveListOption(page, opt);
            if (clicked) {
              await dismissDropdown(page);
              console.log(`[formFiller]   select ${tag} → "${opt}" (typed)`);
              return true;
            }
          }
        } catch { /* type-to-search failed */ }

        // Fuzzy matching: read available options and find best match
        const available = await readActiveListOptions(page);
        const lowerOpt = opt.toLowerCase();

        let match = available.find(a => {
          const la = a.toLowerCase();
          return la.startsWith(lowerOpt) || lowerOpt.startsWith(la);
        });

        if (!match) {
          match = available.find(a => {
            const la = a.toLowerCase();
            return la.includes(lowerOpt) || lowerOpt.includes(la);
          });
        }

        if (!match && !answer) {
          match = available[0];
        }

        if (match) {
          clicked = await clickActiveListOption(page, match);
          if (clicked) {
            await dismissDropdown(page);
            console.log(`[formFiller]   select ${tag} → "${match}"`);
            return true;
          }
        }

        // Last resort: re-open via trigger child, find option inside field's dropdown
        try {
          await page.keyboard.press('Escape').catch(() => {});
          await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); }).catch(() => {});
          await page.waitForTimeout(200);
          const triggerChild = page.locator(`${sel} > [class*="trigger"], ${sel} > button, ${sel} > div`).first();
          if (await triggerChild.count() > 0) {
            await triggerChild.click({ timeout: 1000 });
          } else {
            await page.click(sel, { timeout: 1000 });
          }
          await page.waitForTimeout(300);
          for (const optSel of [
            `${sel} [role="option"]`,
            `${sel} li`,
            `${sel} [role="menuitem"]`,
          ]) {
            const directOption = page.locator(optSel).filter({ hasText: opt }).first();
            if (await directOption.count() > 0) {
              await directOption.click({ timeout: 2000 });
              await dismissDropdown(page);
              console.log(`[formFiller]   select ${tag} → "${opt}" (direct)`);
              return true;
            }
          }
        } catch { /* direct approach failed */ }

        // Native <select> fallback: hidden native select inside/near element
        try {
          const nativeSelect = await page.evaluate((ffId) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return null;
            let sel = el.querySelector('select') as HTMLSelectElement | null;
            if (!sel) {
              const group = el.closest('.form-group, .field, .form-field, fieldset, .select-container');
              if (group) sel = group.querySelector('select');
            }
            if (!sel && el.nextElementSibling?.tagName === 'SELECT') {
              sel = el.nextElementSibling as HTMLSelectElement;
            }
            if (!sel) return null;
            return sel.getAttribute('data-ff-id') || sel.id || null;
          }, field.id);

          if (nativeSelect) {
            const nativeSel = nativeSelect.startsWith('ff-')
              ? `[data-ff-id="${nativeSelect}"]`
              : `#${nativeSelect}`;
            try {
              await page.selectOption(nativeSel, { label: opt }, { timeout: 2000 });
              console.log(`[formFiller]   select ${tag} → "${opt}" (native fallback)`);
              return true;
            } catch {
              const matched = await page.evaluate(
                ({ selector, text }) => {
                  const el = document.querySelector(selector) as HTMLSelectElement;
                  if (!el) return null;
                  const lower = text.toLowerCase();
                  for (const o of el.options) {
                    const t = o.textContent?.trim().toLowerCase() || '';
                    if (t.includes(lower) || lower.includes(t)) return o.value;
                  }
                  return null;
                },
                { selector: nativeSel, text: opt }
              );
              if (matched) {
                await page.selectOption(nativeSel, matched, { timeout: 2000 });
                console.log(`[formFiller]   select ${tag} → "${opt}" (native fuzzy)`);
                return true;
              }
            }
          }
        } catch { /* native fallback failed */ }

        await page.keyboard.press('Escape');
        console.log(`[formFiller]   skip ${tag} (could not click option "${opt}", available: ${available.slice(0, 5).join(', ')})`);
        return false;
      } catch (e: any) {
        console.log(`[formFiller]   skip ${tag} (${e.message?.slice(0, 50)})`);
        await page.keyboard.press('Escape').catch(() => {});
        return false;
      }
    }

    case 'radio-group': {
      const choice = getAnswer(answers, field) ?? field.choices?.[0];
      const clicked = await page.evaluate(
        ({ ffId, text }) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return false;
          const group = el.closest('[role="radiogroup"], [role="group"], .radio-cards, .radio-group') || el;
          const items = group.querySelectorAll('[role="radio"], label.radio-card, .radio-card');
          if (text) {
            for (const item of items) {
              const labelEl = item.querySelector('[class*="label"], .rc-label');
              const itemText = labelEl ? labelEl.textContent?.trim() : item.textContent?.trim();
              if (itemText === text || itemText?.includes(text)) { (item as HTMLElement).click(); return true; }
            }
          }
          if (items.length > 0) { (items[0] as HTMLElement).click(); return true; }
          return false;
        },
        { ffId: field.id, text: choice || '' }
      );
      if (clicked) { console.log(`[formFiller]   radio ${tag} → "${choice || 'first'}"`); return true; }
      console.log(`[formFiller]   skip ${tag} (no radio items)`);
      return false;
    }

    case 'checkbox-group': {
      const val = getAnswer(answers, field);
      if (isExplicitFalse(val)) {
        console.log(`[formFiller]   check ${tag} → skip (answer=unchecked)`);
        return true;
      }
      const status = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return { clicked: false, alreadyChecked: false };
        const group = el.closest('.checkbox-group, [role="group"]') || el;
        const cbs = Array.from(group.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) as HTMLElement[];
        if (cbs.length === 0) return { clicked: false, alreadyChecked: false };
        for (const cb of cbs) {
          const input = cb as HTMLInputElement;
          if (input.checked) return { clicked: true, alreadyChecked: true };
          if (cb.getAttribute('aria-checked') === 'true') return { clicked: true, alreadyChecked: true };
        }
        cbs[0].click();
        return { clicked: true, alreadyChecked: false };
      }, field.id);
      if (status.clicked && status.alreadyChecked) {
        console.log(`[formFiller]   skip ${tag} (already checked)`);
        return true;
      }
      console.log(status.clicked ? `[formFiller]   check ${tag} → first` : `[formFiller]   skip ${tag}`);
      return status.clicked;
    }

    case 'checkbox': {
      const val = getAnswer(answers, field);
      const desiredChecked = !isExplicitFalse(val);
      if (!desiredChecked) {
        console.log(`[formFiller]   check ${tag} → skip (answer=unchecked)`);
        return true;
      }
      const before = await readBinaryControlState(page, field.id);
      if (before === true) {
        console.log(`[formFiller]   skip ${tag} (already checked)`);
        return true;
      }
      try {
        await page.click(sel, { timeout: 2000 });
        const after = await readBinaryControlState(page, field.id);
        if (after === true || after === null) {
          console.log(`[formFiller]   check ${tag}`);
          return true;
        }
      } catch {
        const clicked = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return false;
          const label = el.closest('label') || el;
          (label as HTMLElement).click();
          return true;
        }, field.id);
        if (!clicked) {
          console.log(`[formFiller]   skip ${tag}`);
          return false;
        }
        const after = await readBinaryControlState(page, field.id);
        if (after === true || after === null) {
          console.log(`[formFiller]   check ${tag}`);
          return true;
        }
      }
      console.log(`[formFiller]   skip ${tag} (did not remain checked)`);
      return false;
    }

    case 'toggle': {
      const val = getAnswer(answers, field);
      const desiredOn = !isExplicitFalse(val);
      if (!desiredOn) {
        console.log(`[formFiller]   toggle ${tag} → skip (answer=off)`);
        return true;
      }
      const before = await readBinaryControlState(page, field.id);
      if (before === true) {
        console.log(`[formFiller]   skip ${tag} (already on)`);
        return true;
      }
      await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`) as any;
        if (el) el.click();
      }, field.id);
      const after = await readBinaryControlState(page, field.id);
      if (after === true || after === null) {
        console.log(`[formFiller]   toggle ${tag} → on`);
        return true;
      }
      console.log(`[formFiller]   skip ${tag} (did not remain on)`);
      return false;
    }

    case 'file': {
      // Skip if resume was already uploaded to any field on this page
      if (resumeAlreadyUploaded) {
        console.log(`[formFiller]   skip ${tag} (resume already uploaded)`);
        return true;
      }

      // Skip non-resume file fields (cover letter, portfolio, etc.)
      if (!isResumeFileInput(field.name)) {
        console.log(`[formFiller]   skip ${tag} (not a resume field)`);
        return false;
      }

      const llmPath = getAnswer(answers, field)?.trim();
      let filePath = resolveExistingFilePath(resumePath) || '';
      if (!filePath) filePath = resolveExistingFilePath(llmPath) || '';

      if (!filePath) {
        console.log(`[formFiller]   skip ${tag} (no resume path)`);
        return false;
      }

      try {
        await page.setInputFiles(sel, filePath, { timeout: 2000 });
        console.log(`[formFiller]   upload ${tag} → ${path.basename(filePath)}`);
        return true;
      } catch {
        try {
          const fallbackSelector = await page.evaluate((ffId) => {
            const root = document.querySelector(`[data-ff-id="${ffId}"]`);
            const candidates: HTMLInputElement[] = [];

            if (root instanceof HTMLInputElement && root.type === 'file') {
              candidates.push(root);
            }

            const container = root?.closest('form, .form-group, .field, .form-field, [data-automation-id]') || document;
            container.querySelectorAll('input[type="file"]').forEach((el) => {
              candidates.push(el as HTMLInputElement);
            });

            if (candidates.length === 0) {
              document.querySelectorAll('input[type="file"]').forEach((el) => {
                candidates.push(el as HTMLInputElement);
              });
            }

            for (const cand of candidates) {
              const marker = cand.getAttribute('data-ff-file-fallback') || `ff-file-${Math.random().toString(36).slice(2)}`;
              cand.setAttribute('data-ff-file-fallback', marker);
              return `[data-ff-file-fallback="${marker}"]`;
            }

            return null;
          }, field.id);

          if (fallbackSelector) {
            await page.setInputFiles(fallbackSelector, filePath, { timeout: 2500 });
            console.log(`[formFiller]   upload ${tag} → ${path.basename(filePath)} (fallback)`);
            return true;
          }
        } catch {
          // Continue to final failure log below
        }
        console.log(`[formFiller]   skip ${tag} (file input failed)`);
        return false;
      }
    }

    default:
      console.log(`[formFiller]   skip ${tag} (unhandled type: ${field.type})`);
      return false;
  }
}

// ── Unfilled field detection ─────────────────────────────────

async function isFieldFilled(page: Page, ffId: string): Promise<boolean> {
  return page.evaluate((ffId) => {
    const el = document.querySelector(`[data-ff-id="${ffId}"]`);
    if (!el) return true;
    const tag = el.tagName;
    const type = (el as HTMLInputElement).type || '';
    const role = el.getAttribute('role') || '';

    if (type === 'radio') {
      const name = (el as HTMLInputElement).name;
      if (name) {
        const form = el.closest('form') || document;
        return !!form.querySelector(`input[type="radio"][name="${name}"]:checked`);
      }
      return (el as HTMLInputElement).checked;
    }
    if (role === 'radiogroup') return !!el.querySelector('input[type="radio"]:checked');
    if (role === 'switch') {
      const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb) return cb.checked;
      return el.getAttribute('aria-checked') === 'true';
    }
    if (type === 'checkbox') return (el as HTMLInputElement).checked;
    if (type === 'range') return true;
    if (type === 'file') return true;
    if (el.getAttribute('contenteditable') === 'true') return (el.textContent?.trim() || '').length > 0;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return ((el as HTMLInputElement).value?.trim() || '').length > 0;
    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      const val = sel.value;
      const selectedOpt = sel.options[sel.selectedIndex];
      if (!selectedOpt) return false;
      const text = selectedOpt.textContent?.trim() || '';
      return val !== '' && !/^(select|choose|pick|--|—)/i.test(text);
    }
    // Custom combobox: check for selected value
    if (role === 'combobox' && tag !== 'INPUT' && tag !== 'SELECT') {
      const trigger = el.querySelector('.custom-select-trigger span');
      const text = trigger?.textContent?.trim() || '';
      if (text && !/^(select|choose|pick|--|—|start typing)/i.test(text)) return true;
      // Check Workday pills
      const pills = el.closest('[data-automation-id]')
        ?.querySelector('[data-automation-id="selectedItem"], [data-automation-id="multiSelectPill"]');
      if (pills && pills.textContent?.trim()) return true;
      // Check inner input value
      const innerInput = el.querySelector('input');
      if (innerInput && innerInput.value.trim()) return true;
      return !!el.querySelector('.custom-select-option.selected, [aria-selected="true"]');
    }
    if (role === 'combobox' && tag === 'INPUT') return ((el as HTMLInputElement).value?.trim() || '').length > 0;
    // Workday selectinput/button: check for selected text
    if (el.getAttribute('data-uxi-widget-type') === 'selectinput' || el.getAttribute('aria-haspopup') === 'listbox') {
      const pills = el.closest('[data-automation-id]')
        ?.querySelector('[data-automation-id="selectedItem"], [data-automation-id="multiSelectPill"]');
      if (pills && pills.textContent?.trim()) return true;
      const innerInput = el.querySelector('input');
      if (innerInput && innerInput.value.trim()) return true;
    }
    return (el.textContent?.trim() || '').length > 0;
  }, ffId);
}

async function hasFieldValueForRerender(page: Page, ffId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-ff-id="${id}"]`) as HTMLElement | null;
    if (!el) return false;

    const tag = el.tagName;
    const role = el.getAttribute('role') || '';
    const type = (el as HTMLInputElement).type || '';

    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (type === 'checkbox' || type === 'radio') {
        return (el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true';
      }
      return !!(el as HTMLInputElement).value?.trim();
    }

    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      const selectedOpt = sel.options[sel.selectedIndex];
      if (!selectedOpt) return false;
      const text = selectedOpt.textContent?.trim() || '';
      return sel.value !== '' && !/^(select|choose|pick|--|—)/i.test(text);
    }

    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      if (el.getAttribute('aria-checked') === 'true') return true;
      const inner = el.querySelector('input[type="checkbox"], input[type="radio"]') as HTMLInputElement | null;
      return !!inner?.checked;
    }

    if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
      const pills = el.closest('[data-automation-id]')
        ?.querySelector('[data-automation-id="selectedItem"], [data-automation-id="multiSelectPill"]');
      if (pills && pills.textContent?.trim()) return true;
      const input = (el as HTMLInputElement).value ? (el as HTMLInputElement) : el.querySelector('input');
      if (input && (input as HTMLInputElement).value?.trim()) return true;
      const trigger = el.querySelector('.custom-select-trigger span');
      if (trigger && trigger.textContent?.trim()) {
        const t = trigger.textContent.trim();
        if (!/^(select|choose|pick|--|—|start typing)/i.test(t)) return true;
      }
      return false;
    }

    if (el.getAttribute('contenteditable') === 'true') {
      return !!el.textContent?.trim();
    }

    return false;
  }, ffId);
}

// ── Repeater section handling (Work Experience / Education "Add" buttons) ──

async function detectRepeaters(page: Page): Promise<RepeaterInfo[]> {
  return page.evaluate(() => {
    const repeaters: RepeaterInfo[] = [];
    const ADD_RE = /^\+?\s*add\b/i;

    const buttons = Array.from(document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a.add-btn, .add-btn'
    ));

    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const style = window.getComputedStyle(btn);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (btn.getAttribute('aria-hidden') === 'true') continue;
      if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') continue;

      const text = (btn.textContent || '').trim();
      if (!ADD_RE.test(text)) continue;

      const card = btn.closest(
        '.card, .section, [class*="section"], [class*="card"], ' +
        '[data-automation-id*="Section"], [data-automation-id*="panel"], ' +
        '[class*="Panel"], [class*="panel"]'
      );

      let label = '';
      if (card) {
        const heading = card.querySelector(
          'h2, h3, h4, [class*="heading"], [class*="title"], ' +
          '[data-automation-id*="sectionHeader"], [data-automation-id*="Title"], ' +
          'legend, [class*="legend"]'
        );
        label = heading?.textContent?.trim() || '';
      }

      if (!label) {
        let el: Element | null = btn.parentElement;
        while (el && !label) {
          const prev = el.previousElementSibling;
          if (prev) {
            const tag = prev.tagName;
            if (tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'LEGEND') {
              label = prev.textContent?.trim() || '';
            }
            const hdr = prev.querySelector('[data-automation-id*="sectionHeader"], [data-automation-id*="Title"]');
            if (hdr) label = hdr.textContent?.trim() || '';
          }
          el = el.parentElement;
          if (el === card) break;
        }
      }

      if (!label) {
        label = btn.getAttribute('aria-label')?.trim() || text;
      }

      let currentCount = 0;
      if (card) {
        const allText = card.textContent || '';
        const sectionBase = label.replace(/\s*\d+$/, '').trim();
        if (sectionBase) {
          const numberedRe = new RegExp(`${sectionBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+`, 'gi');
          const matches = allText.match(numberedRe);
          if (matches) {
            const unique = new Set(matches.map((m) => m.trim().toLowerCase()));
            currentCount = unique.size;
          }
        }

        if (currentCount === 0) {
          const list = card.querySelector(
            '.repeater-list, [class*="repeater"], [class*="entries"], ' +
            '[data-automation-id*="itemList"], [data-automation-id*="entryList"]'
          );
          if (list) currentCount = list.children.length;
        }

        if (currentCount === 0) {
          const fieldsets = card.querySelectorAll('fieldset, [class*="entry"], [class*="item-group"]');
          if (fieldsets.length > 0) currentCount = fieldsets.length;
        }

        if (currentCount === 0) {
          const inputs = card.querySelectorAll('input[type="text"], textarea');
          for (const inp of inputs) {
            if ((inp as HTMLInputElement).value.trim()) {
              currentCount = 1;
              break;
            }
          }
        }
      }

      const marker = `ff-add-${repeaters.length}`;
      btn.setAttribute('data-ff-add', marker);

      repeaters.push({
        label,
        addButtonSelector: `[data-ff-add="${marker}"]`,
        currentCount,
      });
    }

    return repeaters;
  });
}

function countNumberedEntriesInSection(profileText: string, header: string): number {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockMatch = profileText.match(
    new RegExp(`${escaped}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z][^\\n:]{1,40}:|\\nDemographics:|$)`, 'i')
  );
  if (!blockMatch) return 0;

  const numbered = blockMatch[1].match(/^\s*\d+\.\s+/gm);
  if (numbered?.length) return numbered.length;

  const bulleted = blockMatch[1].match(/^\s*[-*•]\s+/gm);
  if (bulleted?.length) return bulleted.length;

  return 0;
}

function countProfileEntries(profileText: string, sectionLabel: string): number {
  const cap = (n: number) => Math.max(1, Math.min(n, 8));
  const lower = sectionLabel.toLowerCase();

  if (lower.includes('work') || lower.includes('experience') || lower.includes('employment')) {
    const numbered = countNumberedEntriesInSection(profileText, 'Work Experience');
    if (numbered > 0) return cap(numbered);

    const roleLines = profileText.match(/^\s*(Current Role|Previous):\s+/gim);
    if (roleLines?.length) return cap(roleLines.length);

    const workBlock = profileText.match(
      /Work Experience:\s*\n([\s\S]*?)(?=\nEducation:|\nSkills:|\nWork authorization:|\nDemographics:|$)/i
    );
    if (workBlock) {
      const atCount = workBlock[1].match(/\bat\s+[A-Za-z0-9]/gi)?.length || 0;
      if (atCount > 0) return cap(atCount);
    }

    return 1;
  }

  if (lower.includes('education') || lower.includes('school') || lower.includes('university')) {
    const numbered = countNumberedEntriesInSection(profileText, 'Education');
    if (numbered > 0) return cap(numbered);

    const eduLines = profileText.match(/^\s*Education:\s+/gim);
    if (eduLines?.length) return cap(eduLines.length);

    return 1;
  }

  return 1;
}

async function expandRepeaters(page: Page, profileText: string): Promise<void> {
  const repeaters = await detectRepeaters(page);
  if (repeaters.length === 0) return;

  const targetSections = /(work|experience|employment|education|school|university)/i;
  const deduped = new Map<string, RepeaterInfo>();
  for (const rep of repeaters) {
    if (!targetSections.test(rep.label)) continue;
    const key = normalizeName(rep.label);
    if (!deduped.has(key)) deduped.set(key, rep);
  }

  if (deduped.size === 0) return;
  console.log(`[formFiller] Found ${deduped.size} repeater section(s).`);

  for (const rep of deduped.values()) {
    const needed = countProfileEntries(profileText, rep.label);
    const toAdd = Math.max(0, needed - rep.currentCount);
    console.log(
      `[formFiller] repeater "${rep.label}": need ${needed}, have ${rep.currentCount}, adding ${toAdd}`
    );

    for (let i = 0; i < toAdd; i++) {
      try {
        await page.click(rep.addButtonSelector, { timeout: 3000 });
        await page.waitForTimeout(500);
      } catch (e: any) {
        console.log(`[formFiller] repeater "${rep.label}" add failed: ${e.message?.slice(0, 80)}`);
        break;
      }
    }
  }

  await page.waitForTimeout(500);
}

// ── Main entry point ─────────────────────────────────────────

/**
 * Fill all form fields on the current page using the proven DOM-first +
 * MagnitudeHand fallback approach from fill-form.ts.
 *
 * @param page       Playwright Page (from adapter.page)
 * @param adapter    BrowserAutomationAdapter (for adapter.act() MagnitudeHand calls)
 * @param profileText Human-readable profile text (from buildProfileText)
 * @param resumePath  Optional path to resume file for file inputs
 */
export async function fillFormOnPage(
  page: Page,
  adapter: BrowserAutomationAdapter,
  profileText: string,
  resumePath?: string | null,
  opts?: { forceMagnitude?: boolean },
): Promise<FillResult> {
  const result: FillResult = {
    domFilled: 0,
    magnitudeFilled: 0,
    totalAttempted: 0,
    totalFields: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  // 0. Ensure __name polyfill (esbuild/bun may inject __name into serialized
  //    page.evaluate callbacks; define it in browser context and re-inject
  //    on every navigation via addInitScript).
  await page.addInitScript('if(typeof globalThis.__name==="undefined"){globalThis.__name=function(f){return f}}');
  await page.evaluate('if(typeof globalThis.__name==="undefined"){globalThis.__name=function(f){return f}}');

  // 1. Inject browser-side helpers
  await injectHelpers(page);

  // 2. Reveal accordion/tab sections
  await page.evaluate(() => {
    document.querySelectorAll(
      '[data-section], .form-section, .form-step, .step-content, ' +
      '.tab-pane, .accordion-content, .panel-body, [role="tabpanel"]'
    ).forEach((el: any) => {
      el.style.display = '';
      el.classList.add('active');
      el.removeAttribute('hidden');
      el.setAttribute('aria-hidden', 'false');
    });
  });

  // 3. Expand repeater sections (Work Experience / Education) first.
  await expandRepeaters(page, profileText);
  await injectHelpers(page);

  // Track whether the resume has already been uploaded to ANY file input.
  // Once true, all subsequent file fields are skipped to prevent duplicate uploads
  // (e.g. on retry rounds or multi-file inputs that would accept a second file).
  let resumeAlreadyUploaded = await uploadResumeIfPresent(page, resumePath);

  // 4. Extract fields
  console.log('[formFiller] Extracting form fields…');
  const allFields = await extractFields(page);
  const visibleFields = allFields.filter((f) => f.visibleByDefault && (f.name || f.type === 'file'));
  const llmFields = visibleFields.filter((f) => f.type !== 'file' && !!f.name);
  const profileSkills = parseProfileSkills(profileText);
  const profileSkillsCsv = profileSkills.join(', ');
  result.totalFields = visibleFields.length;
  console.log(`[formFiller] Found ${visibleFields.length} visible fields.`);

  if (visibleFields.length === 0) {
    console.log('[formFiller] No visible fields found — skipping fill.');
    return result;
  }

  // 5. Discover dropdown options (including hierarchical Workday dropdowns)
  console.log('[formFiller] Discovering dropdown options…');
  await discoverDropdownOptions(page, allFields);

  // 6. Ask LLM for answers
  let answers: AnswerMap = {};
  const fieldIdMap: Record<string, string> = {};
  if (llmFields.length > 0) {
    console.log('[formFiller] Asking LLM for answers…');
    const genResult = await generateAnswers(llmFields, profileText);
    answers = { ...genResult.answers };
    Object.assign(fieldIdMap, genResult.fieldIdToKey);
    result.llmCalls++;
    result.inputTokens += genResult.inputTokens;
    result.outputTokens += genResult.outputTokens;
    console.log(`[formFiller] LLM provided ${Object.keys(answers).length} answers.`);
  } else {
    console.log('[formFiller] No named non-file fields for LLM — skipping answer generation.');
  }

  // 7. Iterative fill loop
  const attempted = new Set<string>();
  const domFilledOk = new Set<string>();
  let round = 0;

  while (round < 10) {
    round++;
    // Re-inject helpers in case a page interaction (e.g. dropdown click causing
    // SPA navigation) wiped out window.__ff.
    const hasHelpers = await page.evaluate(() => !!(window as any).__ff).catch(() => false);
    if (!hasHelpers) {
      console.log(`[formFiller] Re-injecting helpers (lost after page interaction)`);
      await injectHelpers(page);
    }
    if (!resumeAlreadyUploaded) {
      resumeAlreadyUploaded = await uploadResumeIfPresent(page, resumePath);
    }
    const fields = await extractFields(page);
    const visible = fields.filter((f) => f.visibleByDefault && (f.name || f.type === 'file'));

    const candidates = visible.filter((f) => !attempted.has(f.id));
    if (candidates.length === 0) break;

    // Skip React re-rendered replacements that already contain a value.
    const toFill: FormField[] = [];
    for (const field of candidates) {
      if (round > 1) {
        const hasValue = await hasFieldValueForRerender(page, field.id);
        if (hasValue) {
          attempted.add(field.id);
          domFilledOk.add(field.id);
          continue;
        }
      }
      toFill.push(field);
    }
    if (toFill.length === 0) break;

    // If new fields appeared that the LLM hasn't seen, ask again
    const unseen = toFill.filter(
      (f) => {
        if (f.type === 'file') return false;
        if (isSkillLikeFieldName(f.name) && profileSkillsCsv) return false;
        return getAnswerForField(answers, f, fieldIdMap) === undefined;
      }
    );
    if (unseen.length > 0 && round > 1) {
      console.log(`[formFiller] ${unseen.length} new fields discovered — asking LLM…`);
      const extraResult = await generateAnswers(unseen, profileText);
      Object.assign(answers, extraResult.answers);
      Object.assign(fieldIdMap, extraResult.fieldIdToKey);
      result.llmCalls++;
      result.inputTokens += extraResult.inputTokens;
      result.outputTokens += extraResult.outputTokens;
    }

    console.log(`[formFiller] Round ${round}: ${toFill.length} new fields to fill…`);

    for (const field of toFill) {
      attempted.add(field.id);
      let resolved = getAnswerForField(answers, field, fieldIdMap);
      if (!resolved && isSkillLikeFieldName(field.name) && profileSkillsCsv) {
        resolved = profileSkillsCsv;
      }
      const fieldAnswers = resolved !== undefined ? { ...answers, [field.name]: resolved } : answers;
      const ok = await fillField(page, field, fieldAnswers, resumePath, resumeAlreadyUploaded);
      if (ok) {
        domFilledOk.add(field.id);
        if (field.type === 'file') resumeAlreadyUploaded = true;
      }
    }

    // Dismiss any leftover open dropdowns
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); }).catch(() => {});
    await page.waitForTimeout(400);
  }

  result.domFilled = domFilledOk.size;
  result.totalAttempted = attempted.size;
  console.log(`[formFiller] DOM fill done: ${domFilledOk.size}/${attempted.size} fields in ${round} round(s).`);

  // 8. MagnitudeHand fallback
  const forceMagnitude = opts?.forceMagnitude === true;
  await page.waitForTimeout(500);
  const postFields = await extractFields(page);
  const postVisible = postFields.filter((f) => f.visibleByDefault);

  const unfilledFields: FormField[] = [];
  const filledIds = new Set<string>(domFilledOk);
  for (const f of postVisible) {
    // Skip file inputs and non-interactive types from MagnitudeHand
    if (f.type === 'file') continue;

    if (forceMagnitude) {
      // Escalation mode: send ALL visible fields to MagnitudeHand — DOM values
      // may be present but wrong (e.g. bad date format, validation failures).
      unfilledFields.push(f);
      continue;
    }

    if (domFilledOk.has(f.id)) continue;

    const filled = await isFieldFilled(page, f.id);
    if (filled) {
      filledIds.add(f.id);
    } else {
      const answer = getAnswerForField(answers, f, fieldIdMap)
        ?? (isSkillLikeFieldName(f.name) && profileSkillsCsv ? profileSkillsCsv : undefined);
      if (answer !== undefined && answer.trim() === '') continue;
      unfilledFields.push(f);
    }
  }

  if (unfilledFields.length > 0) {
    console.log(`[formFiller] [MagnitudeHand] ${unfilledFields.length} field(s) — ${forceMagnitude ? 'ESCALATION: DOM fill failed validation, retrying all fields' : 'using visual agent'}…`);

    let filledCount = 0;
    let adapterBusyCount = 0;
    let abortedDueToBusy = false;

    for (const field of unfilledFields) {
      // Skip fields with empty labels — MagnitudeHand can't identify them
      if (!field.name || !field.name.trim()) {
        console.log(`[formFiller] [MagnitudeHand] Skipping field with empty label (id=${field.id}, type=${field.type})`);
        continue;
      }

      await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'auto' });
      }, field.id);
      await page.waitForTimeout(300);

      const answer = getAnswerForField(answers, field, fieldIdMap)
        ?? (isSkillLikeFieldName(field.name) && profileSkillsCsv ? profileSkillsCsv : undefined);
      let prompt = `You are filling out a job application for this person. Today's date is ${new Date().toLocaleDateString('en-CA')}.\n${profileText.trim()}\n\n`;

      const neighborCtx = buildNeighborContext(field, postVisible, answers, fieldIdMap, filledIds);
      if (neighborCtx) {
        prompt += `Here are the nearby form fields on this page (the target field is marked with >>>):\n${neighborCtx}\n\n`;
        prompt += `Fill the form field marked with >>>`;
      } else {
        prompt += `Fill the form field labeled "${field.name}"`;
      }
      if (answer) {
        prompt += ` with the value "${answer}"`;
      } else {
        prompt += ` using the applicant's profile above to choose the best value`;
      }

      if (field.type === 'select') {
        if (field.options?.length) {
          prompt += `. This is a dropdown with options: [${field.options.slice(0, 15).join(', ')}]. Click the dropdown to open it, then click the correct option. If the exact answer is not available, pick the closest matching option.`;
        } else {
          prompt += `. This is a dropdown — click it to open, then select the most appropriate option available.`;
        }
      } else if (field.type === 'search' || field.type === 'text') {
        const role = await page.evaluate((ffId) => {
          return document.querySelector(`[data-ff-id="${ffId}"]`)?.getAttribute('role') || '';
        }, field.id);
        if (role === 'combobox') {
          prompt += `. This is an autocomplete/typeahead field. Type the value, wait for suggestions to appear, then click the matching suggestion from the dropdown.`;
        }
      } else if (field.type === 'textarea') {
        prompt += `. This is a text area. Click on it and type the value.`;
      } else if (field.type === 'range') {
        prompt += `. This is a slider. Drag it to the desired value.`;
      }

      prompt += ` Focus ONLY on this single field. Do NOT interact with any other fields or buttons.`;

      console.log(`[formFiller] [MagnitudeHand] act() → "${field.name}"${neighborCtx ? ' (with neighbor context)' : ''}…`);
      try {
        await adapter.act(prompt, { timeoutMs: MAGNITUDE_HAND_ACT_TIMEOUT_MS });
        console.log(`[formFiller] [MagnitudeHand] Filled "${field.name}" OK`);
        filledCount++;
        adapterBusyCount = 0;
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        const shortMsg = msg.slice(0, 160);
        console.log(`[formFiller] [MagnitudeHand] ERROR on "${field.name}": ${shortMsg}`);

        const isBusy = msg.includes('adapter busy: previous act() still running')
          || msg.includes('adapter busy: act() already in flight');
        const isTimeout = msg.includes('act() timed out');

        // When act() times out, the underlying SDK call keeps running and poisons
        // the adapter mutex. Additional act() calls will just thrash.
        if (isTimeout || isBusy) {
          adapterBusyCount += 1;
          const waitMs = Math.min(2_000 * adapterBusyCount, 8_000);
          console.log(`[formFiller] [MagnitudeHand] Waiting ${waitMs}ms for in-flight action to settle...`);
          await page.waitForTimeout(waitMs);

          // Stop issuing further visual-agent calls in this pass. The page will
          // continue with DOM-filled state and next loop can recover naturally.
          abortedDueToBusy = true;
        }
      }

      if (abortedDueToBusy) {
        console.log('[formFiller] [MagnitudeHand] Aborting remaining visual-agent fields due to in-flight act() contention.');
        break;
      }

      await page.waitForTimeout(200);
    }

    result.magnitudeFilled = filledCount;
    console.log(`[formFiller] [MagnitudeHand] Done! Filled ${filledCount}/${unfilledFields.length} field(s) via visual agent.`);
  } else {
    console.log('[formFiller] [MagnitudeHand] No unfilled fields — DOM filler handled everything.');
  }

  return result;
}
