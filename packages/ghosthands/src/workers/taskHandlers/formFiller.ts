/**
 * formFiller.ts
 *
 * Production-grade form filler adapted from toy-job-app/fill-form.ts and
 * toy-job-app/extract-form-structure.ts.
 *
 * Exports a single entry point `fillFormOnPage()` that:
 *   1. Injects browser-side helpers and extracts all form fields
 *   2. Discovers dropdown options by briefly opening custom dropdowns
 *   3. Asks Claude Haiku 4.5 for answers (single LLM call for all fields)
 *   4. Iteratively fills fields via DOM, re-extracting after each round
 *   5. Falls back to MagnitudeHand (adapter.act()) for unfilled fields
 *
 * This module is imported by SmartApplyHandler — it does NOT launch a browser
 * or manage navigation. The caller provides a Playwright Page and an adapter.
 */

import type { Page } from 'playwright';
import * as path from 'path';
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
}

interface GenerateResult {
  answers: AnswerMap;
  inputTokens: number;
  outputTokens: number;
}

// ── Constants ────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = [
  'input', 'select', 'textarea',
  '[role="textbox"]', '[role="combobox"]', '[role="listbox"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="spinbutton"]', '[role="slider"]', '[role="searchbox"]',
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
    case 'email': return 'a@a.com';
    case 'tel': return '1234567890';
    case 'url': return 'https://a.com';
    case 'number': return '1';
    case 'date': return '2025-01-01';
    case 'textarea':
      return 'I am excited about this opportunity and believe my skills and experience make me a strong candidate for this position.';
    default: return 'A';
  }
}

function getAnswer(answers: AnswerMap, field: FormField): string | undefined {
  if (field.name in answers) return answers[field.name];
  const lower = field.name.toLowerCase();
  for (const [key, val] of Object.entries(answers)) {
    if (key.toLowerCase() === lower) return val;
  }
  return undefined;
}

// ── Browser-side injection ───────────────────────────────────

async function injectHelpers(page: Page): Promise<void> {
  const selectorStr = JSON.stringify(INTERACTIVE_SELECTOR);
  await page.evaluate(`
    if (typeof __name === 'undefined') var __name = function(fn) { return fn; };
    window.__ff = {
      SELECTOR: ${selectorStr},

      getAccessibleName: function(el) {
        var lblBy = el.getAttribute('aria-labelledby');
        if (lblBy) {
          var t = lblBy.split(/\\s+/)
            .map(function(id) { var r = document.getElementById(id); return r ? r.textContent.trim() : ''; })
            .filter(Boolean).join(' ');
          if (t) return t;
        }
        var al = el.getAttribute('aria-label');
        if (al) return al.trim();
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

      nextId: 0,
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
        required: el.required || el.getAttribute('aria-required') === 'true' || el.dataset.required === 'true',
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

  return fields;
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
  await page.waitForTimeout(300);
}

// ── Dropdown option discovery ────────────────────────────────

async function discoverDropdownOptions(page: Page, fields: FormField[]): Promise<void> {
  for (const f of fields) {
    if (f.type !== 'select' || f.isNative || (f.options && f.options.length > 0)) continue;

    try {
      await clickComboboxTrigger(page, f.id);
      await page.waitForTimeout(300);

      const options = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return [];
        const results: string[] = [];

        const collect = (container: Element) => {
          const opts = container.querySelectorAll('[role="option"], [role="menuitem"], li');
          for (const o of opts) {
            const t = o.textContent?.trim();
            if (t && t.length < 200) results.push(t);
          }
        };

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
        return results;
      }, f.id);

      if (options.length > 0) {
        f.options = options;
        console.log(`[formFiller] discovered ${options.length} options for "${f.name}"`);
      }

      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    } catch {
      // Ignore — some fields won't open
    }
  }
}

// ── LLM answer generation ────────────────────────────────────

async function generateAnswers(fields: FormField[], profileText: string): Promise<GenerateResult> {
  const client = new Anthropic();

  const fieldDescriptions = fields.map((f) => {
    let desc = `- "${f.name}" (type: ${f.type}`;
    if (f.isMultiSelect) desc += ', multi-select';
    desc += ')';
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
      content: `You are filling out a job application form on behalf of an applicant. Here is their profile:

${profileText}

Here are the form fields to fill:

${fieldDescriptions}

Rules:
- For each field, decide what value to put based on the profile.
- If the profile doesn't have enough info, make up a plausible value.
- For dropdowns/radio groups with listed options, you MUST pick the EXACT text of one of the available options.
- For dropdowns WITHOUT listed options, provide your best guess for the value.
- For multi-select fields, return a JSON array of ALL matching options from the available list (e.g., ["Python", "Java", "Go"]). Select every option that matches the applicant's skills/background.
- For checkboxes/toggles, respond with "checked"/"unchecked" or "on"/"off".
- For file upload fields, skip them (don't include in output).
- For textarea fields (cover letters, open-ended questions), write 2-4 thoughtful sentences using the applicant's real background. NEVER return a single letter or placeholder — write a genuine response.
- For conditional "Please specify" or "Other (please explain)" fields, answer in context of what triggered them (e.g., if "How did you hear about us?" was "Other", specify the referral source, not the job title).
- For demographic/EEO fields (gender, race, ethnicity, veteran, disability), use the applicant's actual demographic info from their profile. Pick the option that best matches.
- For salary fields, provide a realistic number based on the role and experience level (e.g., 120000 for a mid-level engineer).
- You MUST respond with ONLY a valid JSON object. No explanation, no commentary, no markdown fences.

Example response:
{"First Name": "Alexander", "Last Name": "Chen", "Programming Languages": ["Python", "JavaScript / TypeScript", "Go"], "Cover Letter / Why do you want to work here?": "I am excited to apply because..."}`,
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
    return { answers: parsed, inputTokens, outputTokens };
  } catch {
    console.log('[formFiller] Failed to parse LLM response as JSON, using empty answers');
    return { answers: {}, inputTokens, outputTokens };
  }
}

// ── Fill a single field ──────────────────────────────────────

async function fillField(page: Page, field: FormField, answers: AnswerMap, resumePath?: string | null): Promise<boolean> {
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
      const isCombobox = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        return el?.getAttribute('role') === 'combobox';
      }, field.id);
      if (isCombobox) return false;

      const val = getAnswer(answers, field) ?? defaultValue(field);
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.log(`[formFiller]   fill ${tag} = "${val}"`);
        return true;
      } catch {
        console.log(`[formFiller]   skip ${tag} (not fillable)`);
        return false;
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

      // Multi-select
      if (field.isMultiSelect && answer) {
        const valuesToSelect = answer.split(',').map((v: string) => v.trim()).filter(Boolean);
        try {
          await clickComboboxTrigger(page, field.id);
          await page.waitForTimeout(200);
          const clickedCount = await page.evaluate(
            ({ ffId, values }) => {
              const el = document.querySelector(`[data-ff-id="${ffId}"]`);
              if (!el) return 0;
              let count = 0;
              const allOpts = el.querySelectorAll('[role="option"], .multi-select-option');
              for (const val of values) {
                const lowerVal = val.toLowerCase();
                for (const opt of allOpts) {
                  const optText = opt.textContent?.trim().toLowerCase() || '';
                  if (optText === lowerVal || optText.includes(lowerVal) || lowerVal.includes(optText)) {
                    if (opt.getAttribute('aria-selected') !== 'true') {
                      (opt as HTMLElement).click();
                    }
                    count++;
                    break;
                  }
                }
              }
              return count;
            },
            { ffId: field.id, values: valuesToSelect }
          );
          console.log(`[formFiller]   multi-select ${tag} → ${clickedCount}/${valuesToSelect.length}`);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
          return clickedCount > 0;
        } catch (e: any) {
          console.log(`[formFiller]   skip ${tag} (multi-select failed: ${e.message?.slice(0, 50)})`);
          return false;
        }
      }

      // Custom dropdown
      const opt = answer ?? field.options?.find((o) => !PLACEHOLDER_RE.test(o)) ?? field.options?.[0];

      if (!opt) {
        try {
          await clickComboboxTrigger(page, field.id);
          const clicked = await page.evaluate((ffId) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return false;
            const ff = (window as any).__ff;
            const tryClick = (container: Element): boolean => {
              const opts = container.querySelectorAll('[role="option"], [role="menuitem"]');
              for (const o of opts) {
                if (ff.isVisible(o)) { (o as HTMLElement).click(); return true; }
              }
              return false;
            };
            if (tryClick(el)) return true;
            const ctrlId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            if (ctrlId) {
              const popup = document.getElementById(ctrlId);
              if (popup && tryClick(popup)) return true;
            }
            if (el.tagName === 'INPUT') {
              const container = el.closest('[class*="select"], [class*="combobox"], .form-group');
              if (container && tryClick(container)) return true;
            }
            return false;
          }, field.id);
          if (clicked) {
            console.log(`[formFiller]   select ${tag} → first available option`);
            return true;
          }
          await page.keyboard.press('Escape');
          console.log(`[formFiller]   skip ${tag} (no options found)`);
          return false;
        } catch {
          console.log(`[formFiller]   skip ${tag} (no options)`);
          return false;
        }
      }

      try {
        await clickComboboxTrigger(page, field.id);
        const hasAnswer = !!answer;
        const clicked = await page.evaluate(
          ({ ffId, text, strict }) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return false;
            const lowerText = text.toLowerCase();

            const getOptionText = (o: Element): string => {
              const clone = o.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('[class*="desc"], [class*="sub"], .option-desc, small').forEach((x: any) => x.remove());
              return clone.textContent?.trim() || '';
            };

            const findAndClick = (container: Element): boolean => {
              const opts = container.querySelectorAll('[role="option"], [role="menuitem"]');
              for (const o of opts) { if (getOptionText(o) === text) { (o as HTMLElement).click(); return true; } }
              for (const o of opts) {
                const t = getOptionText(o).toLowerCase();
                if (t.startsWith(lowerText) || lowerText.startsWith(t)) { (o as HTMLElement).click(); return true; }
              }
              for (const o of opts) {
                const t = getOptionText(o).toLowerCase();
                if (t.includes(lowerText) || lowerText.includes(t)) { (o as HTMLElement).click(); return true; }
              }
              if (!strict) {
                for (const o of opts) {
                  const s = window.getComputedStyle(o as HTMLElement);
                  if (s.display !== 'none' && s.visibility !== 'hidden') { (o as HTMLElement).click(); return true; }
                }
              }
              return false;
            };

            if (findAndClick(el)) return true;
            const ctrlId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            if (ctrlId) {
              const popup = document.getElementById(ctrlId);
              if (popup && findAndClick(popup)) return true;
            }
            const dropdown = el.querySelector('[class*="dropdown"], [role="listbox"]');
            if (dropdown && findAndClick(dropdown)) return true;
            return false;
          },
          { ffId: field.id, text: opt, strict: hasAnswer }
        );
        if (clicked) {
          console.log(`[formFiller]   select ${tag} → "${opt}"`);
          return true;
        }
        await page.keyboard.press('Escape');
        console.log(`[formFiller]   skip ${tag} (could not click option)`);
        return false;
      } catch (e: any) {
        console.log(`[formFiller]   skip ${tag} (${e.message?.slice(0, 50)})`);
        return false;
      }
    }

    case 'radio-group': {
      const choice = getAnswer(answers, field) ?? field.choices?.[0];
      const clicked = await page.evaluate(
        ({ ffId, text }) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return false;
          const group = el.closest('[role="radiogroup"], .radio-cards, .radio-group') || el;
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
      const clicked = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return false;
        const group = el.closest('.checkbox-group, [role="group"]') || el;
        const cb = group.querySelector('input[type="checkbox"]') || group.querySelector('[role="checkbox"]');
        if (cb) { (cb as HTMLElement).click(); return true; }
        return false;
      }, field.id);
      console.log(clicked ? `[formFiller]   check ${tag} → first` : `[formFiller]   skip ${tag}`);
      return clicked;
    }

    case 'checkbox': {
      const val = getAnswer(answers, field);
      if (val === 'false' || val === 'unchecked') {
        console.log(`[formFiller]   check ${tag} → skip (answer=unchecked)`);
        return true;
      }
      try {
        await page.click(sel, { timeout: 2000 });
        console.log(`[formFiller]   check ${tag}`);
        return true;
      } catch {
        const clicked = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return false;
          const label = el.closest('label') || el;
          (label as HTMLElement).click();
          return true;
        }, field.id);
        console.log(clicked ? `[formFiller]   check ${tag}` : `[formFiller]   skip ${tag}`);
        return clicked;
      }
    }

    case 'toggle': {
      const val = getAnswer(answers, field);
      if (val === 'off' || val === 'false') {
        console.log(`[formFiller]   toggle ${tag} → skip (answer=off)`);
        return true;
      }
      await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`) as any;
        if (el) el.click();
      }, field.id);
      console.log(`[formFiller]   toggle ${tag} → on`);
      return true;
    }

    case 'file': {
      const filePath = getAnswer(answers, field)
        ? path.resolve(getAnswer(answers, field)!)
        : (resumePath || '');
      if (!filePath) {
        console.log(`[formFiller]   skip ${tag} (no resume path)`);
        return false;
      }
      try {
        await page.setInputFiles(sel, filePath, { timeout: 2000 });
        console.log(`[formFiller]   upload ${tag} → ${path.basename(filePath)}`);
        return true;
      } catch {
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
      if (cb) return true;
      return el.getAttribute('aria-checked') === 'true';
    }
    if (type === 'checkbox') return true;
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
    if (role === 'combobox' && tag !== 'INPUT' && tag !== 'SELECT') {
      const trigger = el.querySelector('.custom-select-trigger span');
      const text = trigger?.textContent?.trim() || '';
      if (text && !/^(select|choose|pick|--|—|start typing)/i.test(text)) return true;
      return !!el.querySelector('.custom-select-option.selected, [aria-selected="true"]');
    }
    if (role === 'combobox' && tag === 'INPUT') return ((el as HTMLInputElement).value?.trim() || '').length > 0;
    return (el.textContent?.trim() || '').length > 0;
  }, ffId);
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
): Promise<FillResult> {
  const result: FillResult = {
    domFilled: 0,
    magnitudeFilled: 0,
    totalAttempted: 0,
    totalFields: 0,
    llmCalls: 0,
  };

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

  // 3. Extract fields
  console.log('[formFiller] Extracting form fields…');
  const allFields = await extractFields(page);
  const visibleFields = allFields.filter((f) => f.visibleByDefault);
  result.totalFields = visibleFields.length;
  console.log(`[formFiller] Found ${visibleFields.length} visible fields.`);

  if (visibleFields.length === 0) {
    console.log('[formFiller] No visible fields found — skipping fill.');
    return result;
  }

  // 4. Discover dropdown options
  console.log('[formFiller] Discovering dropdown options…');
  await discoverDropdownOptions(page, allFields);

  // 5. Ask LLM for answers
  console.log('[formFiller] Asking LLM for answers…');
  const genResult = await generateAnswers(allFields, profileText);
  const answers = genResult.answers;
  result.llmCalls++;
  console.log(`[formFiller] LLM provided ${Object.keys(answers).length} answers.`);

  // 6. Iterative fill loop
  const attempted = new Set<string>();
  const domFilledOk = new Set<string>();
  let round = 0;

  while (round < 10) {
    round++;
    const fields = await extractFields(page);
    const visible = fields.filter((f) => f.visibleByDefault);

    const toFill = visible.filter((f) => !attempted.has(f.id));
    if (toFill.length === 0) break;

    // If new fields appeared that the LLM hasn't seen, ask again
    const unseen = toFill.filter(
      (f) => getAnswer(answers, f) === undefined && f.type !== 'file'
    );
    if (unseen.length > 0 && round > 1) {
      console.log(`[formFiller] ${unseen.length} new fields discovered — asking LLM…`);
      const extraResult = await generateAnswers(unseen, profileText);
      Object.assign(answers, extraResult.answers);
      result.llmCalls++;
    }

    console.log(`[formFiller] Round ${round}: ${toFill.length} new fields to fill…`);

    for (const field of toFill) {
      attempted.add(field.id);
      const ok = await fillField(page, field, answers, resumePath);
      if (ok) domFilledOk.add(field.id);
    }

    await page.waitForTimeout(400);
  }

  result.domFilled = domFilledOk.size;
  result.totalAttempted = attempted.size;
  console.log(`[formFiller] DOM fill done: ${domFilledOk.size}/${attempted.size} fields in ${round} round(s).`);

  // 7. MagnitudeHand fallback
  await page.waitForTimeout(500);
  const postFields = await extractFields(page);
  const postVisible = postFields.filter((f) => f.visibleByDefault);

  const unfilledFields: FormField[] = [];
  for (const f of postVisible) {
    if (domFilledOk.has(f.id)) continue;

    const filled = await isFieldFilled(page, f.id);
    if (!filled) {
      const answer = getAnswer(answers, f);
      if (answer !== undefined && answer.trim() === '') continue;
      unfilledFields.push(f);
    }
  }

  if (unfilledFields.length > 0) {
    console.log(`[formFiller] [MagnitudeHand] ${unfilledFields.length} unfilled field(s) — using visual agent…`);

    let filledCount = 0;

    for (const field of unfilledFields) {
      await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'auto' });
      }, field.id);
      await page.waitForTimeout(300);

      const answer = getAnswer(answers, field);
      let prompt = `You are filling out a job application for this person:\n${profileText.trim()}\n\n`;
      prompt += `Fill the form field labeled "${field.name}"`;
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

      console.log(`[formFiller] [MagnitudeHand] act() → "${field.name}"…`);
      try {
        await adapter.act(prompt, { timeoutMs: MAGNITUDE_HAND_ACT_TIMEOUT_MS });
        console.log(`[formFiller] [MagnitudeHand] Filled "${field.name}" OK`);
        filledCount++;
      } catch (e: any) {
        console.log(`[formFiller] [MagnitudeHand] ERROR on "${field.name}": ${e.message?.slice(0, 120)}`);
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
