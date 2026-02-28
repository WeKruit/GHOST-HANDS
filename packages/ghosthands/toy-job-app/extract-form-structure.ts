/**
 * extract-form-structure.ts
 *
 * Extracts form fields and conditional visibility rules from any web page.
 * Works with native HTML AND custom UI widgets (ARIA comboboxes, custom
 * dropdowns, etc.) by querying both native elements and ARIA roles.
 *
 * Each interactive element gets tagged with a data-ff-id attribute for
 * stable tracking across visibility snapshots during probing.
 *
 * Usage:
 *   bun run toy-job-app/extract-form-structure.ts [url-or-file]
 */

import { chromium, type Page } from "playwright";
import * as path from "path";
import * as fs from "fs";

// ── Types ────────────────────────────────────────────────────

export interface Condition {
  field: string;
  equals: string;
}
export type ConditionChain = Condition[];

export interface FormField {
  id: string; // internal data-ff-id
  name: string; // accessible name (label)
  type: string;
  section: string;
  required: boolean;
  options?: string[]; // combobox options (display text)
  choices?: string[]; // checkbox/radio group items
  accept?: string;
  isNative: boolean; // native <select> vs custom
  visibleByDefault: boolean;
  visibleWhen?: ConditionChain[];
}

export interface FormStructure {
  url: string;
  title: string;
  fields: Omit<FormField, "id" | "isNative">[];
}

// ── Constants ────────────────────────────────────────────────

export const INTERACTIVE_SELECTOR = [
  "input",
  "select",
  "textarea",
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="spinbutton"]',
  '[role="slider"]',
  '[role="searchbox"]',
  '[data-uxi-widget-type="selectinput"]',
  '[aria-haspopup="listbox"]',
].join(", ");

export const PLACEHOLDER_RE = /^(select|choose|pick|--|—)/i;
// Max options to probe per combobox — beyond this it's likely a data-entry field
// (e.g. country picker), not a conditional trigger
export const MAX_PROBE_OPTIONS = 20;
// For large dropdowns (> MAX_PROBE_OPTIONS), sample this many options to detect conditionals.
// Higher = more country-specific fields discovered, but slower.
export const SAMPLE_PROBE_COUNT = 10;

// ── Helpers ──────────────────────────────────────────────────

export function resolveUrl(input: string): string {
  if (/^https?:\/\/|^file:\/\//.test(input)) return input;
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new Error(`Not found: ${abs}`);
  return `file://${abs}`;
}

// ── Inject helpers into page context ─────────────────────────
// These run in the browser and are available to all page.evaluate() calls.

export async function injectHelpers(page: Page) {
  const selectorStr = JSON.stringify(INTERACTIVE_SELECTOR);
  await page.evaluate(`
    window.__ff = {
      SELECTOR: ${selectorStr},

      getAccessibleName: function(el) {
        // 1. aria-labelledby
        var lblBy = el.getAttribute('aria-labelledby');
        if (lblBy) {
          // For Workday selectinputs, the container holds both the label refs AND value refs.
          // Skip any referenced element inside the selectinput/combobox container (those are displayed values).
          var uxiC = el.closest('[data-uxi-widget-type]') || el.closest('[role="combobox"]');
          var t = lblBy.split(/\\s+/)
            .map(function(id) {
              var r = document.getElementById(id);
              if (!r) return '';
              // Skip refs inside the widget container (current value, "Required" text, etc.)
              if (uxiC && uxiC.contains(r)) return '';
              // Skip refs inside el itself
              if (el.contains(r)) return '';
              return r.textContent.trim();
            })
            .filter(Boolean).join(' ');
          if (t) return t;
        }
        // 2. aria-label
        var al = el.getAttribute('aria-label');
        if (al) {
          al = al.trim();
          // Workday dropdown buttons bake "Label + CurrentValue + Required" into aria-label.
          // Strip the current value (textContent) and "Required" to get the clean label.
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
        // 3. label[for]
        if (el.id) {
          var lbl = document.querySelector('label[for="' + el.id + '"]');
          if (lbl) {
            var c = lbl.cloneNode(true);
            c.querySelectorAll('input, .required, span[aria-hidden]').forEach(function(x) { x.remove(); });
            var tx = c.textContent.trim();
            if (tx) return tx;
          }
        }
        // 4. Walk up past checkbox/radio groups to form-group label
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
        // 5. Fallback
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

// ── Extract & tag all fields ─────────────────────────────────

export async function extractFields(page: Page): Promise<FormField[]> {
  const raw: any[] = await page.evaluate(() => {
    const ff = (window as any).__ff;
    const seen = new Set();
    const out: any[] = [];

    function shouldSkip(el: any): boolean {
      // Skip elements inside dropdown panels (search inputs, listbox internals)
      if (el.closest('[class*="select-dropdown"], [class*="select-option"]'))
        return true;
      // Skip elements inside intl-tel-input dropdown panels (country code picker internals)
      if (el.closest('.iti__dropdown-content'))
        return true;
      // Skip elements inside Workday dropdown portals (activeListContainer)
      if (el.closest('[data-automation-id="activeListContainer"]'))
        return true;
      // Skip standalone role="listbox" inside a role="combobox" (it's the popup)
      if (
        el.getAttribute("role") === "listbox" &&
        el.closest('[role="combobox"]')
      )
        return true;
      // Skip role="listbox" that is a popup for another combobox (via aria-controls)
      if (el.getAttribute("role") === "listbox" && el.id) {
        const controller = document.querySelector(
          '[role="combobox"][aria-controls="' + el.id + '"]'
        );
        if (controller) return true;
      }
      // Skip search inputs inside dropdown/popup containers (internal search, not form fields)
      if (
        el.tagName === "INPUT" &&
        el.type === "search" &&
        el.closest('[class*="dropdown"], [role="dialog"]')
      )
        return true;
      // Skip hidden radio/checkbox inputs inside card-style UIs
      if (
        el.tagName === "INPUT" &&
        (el.type === "radio" || el.type === "checkbox") &&
        window.getComputedStyle(el).display === "none"
      )
        return true;
      return false;
    }

    // Get only the "main" text of an option, ignoring description sub-elements
    function getOptionMainText(opt: any): string {
      // If it has child elements with description class, exclude them
      const clone = opt.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(
          '[class*="desc"], [class*="sub"], [class*="hint"], .option-desc, small'
        )
        .forEach((x: any) => x.remove());
      return clone.textContent?.trim() || "";
    }

    document.querySelectorAll(ff.SELECTOR).forEach((el: any) => {
      if (seen.has(el)) return;
      seen.add(el);

      if (shouldSkip(el)) return;

      const id = ff.tag(el);
      const type = (() => {
        const role = el.getAttribute("role");
        if (role === "textbox" && el.getAttribute("aria-multiline") === "true")
          return "textarea";
        if (role === "textbox") return "text";
        if (role === "combobox") return "select";
        if (role === "listbox") return "select";
        // Workday-style searchable dropdowns
        if (el.getAttribute("data-uxi-widget-type") === "selectinput") return "select";
        if (el.getAttribute("aria-haspopup") === "listbox") return "select";
        if (role === "radio") return "radio";
        if (role === "checkbox") return "checkbox";
        if (role === "spinbutton") return "number";
        if (role === "slider") return "range";
        if (role === "searchbox") return "search";
        if (role === "switch") return "toggle";
        if (el.tagName === "SELECT") return "select";
        if (el.tagName === "TEXTAREA") return "textarea";
        const t = el.type || "";
        return (
          ({
            text: "text",
            email: "email",
            tel: "tel",
            url: "url",
            number: "number",
            date: "date",
            file: "file",
            checkbox: "checkbox",
            radio: "radio",
            search: "search",
            password: "password",
          } as any)[t] || t || "text"
        );
      })();

      const visible = (() => {
        // File inputs hidden behind upload UIs
        if (type === "file" && !ff.isVisible(el)) {
          const container = el.closest(
            "[class*=upload], [class*=drop], .form-group, .field"
          );
          return container ? ff.isVisible(container) : false;
        }
        return ff.isVisible(el);
      })();

      const isNative = el.tagName === "SELECT";

      // Detect multi-select comboboxes
      const isMultiSelect =
        type === "select" &&
        !isNative &&
        !!(
          el.querySelector('[class*="multi"]') ||
          el.classList.toString().includes("multi") ||
          el.getAttribute("aria-multiselectable") === "true" ||
          el.querySelector('[aria-selected]')?.closest('[class*="multi"]')
        );

      const entry: any = {
        id,
        name: ff.getAccessibleName(el),
        type,
        section: ff.getSection(el),
        required:
          el.required ||
          el.getAttribute("aria-required") === "true" ||
          el.dataset.required === "true" ||
          el.dataset.ffRequired === "true",
        visible,
        isNative,
        isMultiSelect,
      };

      if (el.accept) entry.accept = el.accept;

      // Combobox options
      if (type === "select") {
        let opts: string[] = [];
        if (el.tagName === "SELECT") {
          opts = Array.from(el.options as HTMLOptionsCollection)
            .filter((o: any) => o.value !== "")
            .map((o: any) => o.textContent?.trim() || "")
            .filter(Boolean);
        } else {
          // Custom: check aria-controls, children, and ancestor containers
          const ctrlId =
            el.getAttribute("aria-controls") ||
            el.getAttribute("aria-owns");
          let src = ctrlId ? document.getElementById(ctrlId) : null;
          // For <input role="combobox"> (e.g. React Select), the input itself
          // has no children — look in ancestor container instead
          if (!src && el.tagName === "INPUT") {
            src = el.closest('[class*="select"], [class*="combobox"], .form-group, .field');
          }
          if (!src) src = el;
          if (src) {
            opts = Array.from(
              src.querySelectorAll('[role="option"], [role="menuitem"]')
            )
              .map((o: any) => getOptionMainText(o))
              .filter(Boolean);
          }
        }
        if (opts.length) entry.options = opts;
      }

      // Checkbox/radio item info (for role="radio" card UIs)
      if (type === "checkbox" || type === "radio") {
        // For role="radio" card UIs, get the label text from the card
        const labelEl = el.querySelector('[class*="label"], .rc-label');
        if (labelEl) {
          entry.itemLabel = labelEl.textContent?.trim() || "";
        } else {
          const wrap = el.closest("label");
          if (wrap) {
            const c = wrap.cloneNode(true) as HTMLElement;
            c.querySelectorAll("input, [class*=desc], small").forEach(
              (x: any) => x.remove()
            );
            entry.itemLabel = c.textContent?.trim() || "";
          } else {
            entry.itemLabel =
              el.getAttribute("aria-label") || ff.getAccessibleName(el);
          }
        }
        entry.itemValue = el.value || el.querySelector("input")?.value || "";
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

    if (f.type === "checkbox" || f.type === "radio") {
      // Group by name (accessible name of the group)
      if (seen.has("group:" + f.name)) continue;
      seen.add(f.id);

      const siblings = raw.filter(
        (r: any) =>
          (r.type === "checkbox" || r.type === "radio") &&
          r.name === f.name &&
          r.section === f.section
      );
      if (siblings.length > 1) {
        seen.add("group:" + f.name);
        for (const s of siblings) seen.add(s.id);
        fields.push({
          id: f.id, // use first item's id for tracking
          name: f.name,
          type: `${f.type}-group`,
          section: f.section,
          required: f.required,
          isNative: false,
          choices: siblings.map((s: any) => s.itemLabel || s.name),
          visibleByDefault: f.visible,
        });
      } else {
        fields.push({
          id: f.id,
          name: f.itemLabel || f.name,
          type: f.type,
          section: f.section,
          required: f.required,
          isNative: false,
          visibleByDefault: f.visible,
        });
      }
    } else {
      seen.add(f.id);
      const field: FormField = {
        id: f.id,
        name: f.name,
        type: f.type,
        section: f.section,
        required: f.required,
        isNative: f.isNative,
        visibleByDefault: f.visible,
      };
      if (f.accept) field.accept = f.accept;
      if (f.options) field.options = f.options;
      if (f.isMultiSelect) (field as any).isMultiSelect = true;
      fields.push(field);
    }
  }

  return fields;
}

// ── Visibility snapshot ──────────────────────────────────────

export async function tagAndSnapshot(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const ff = (window as any).__ff;
    const map: Record<string, boolean> = {};

    document.querySelectorAll(ff.SELECTOR).forEach((el: any) => {
      // Skip dropdown internals and hidden radio/checkbox inputs
      if (el.closest('[class*="select-dropdown"], [class*="select-option"]'))
        return;
      if (el.closest('.iti__dropdown-content'))
        return;
      // Skip elements inside Workday dropdown portals
      if (el.closest('[data-automation-id="activeListContainer"]'))
        return;
      if (
        el.getAttribute("role") === "listbox" &&
        el.closest('[role="combobox"]')
      )
        return;
      if (el.getAttribute("role") === "listbox" && el.id) {
        const ctrl = document.querySelector(
          '[role="combobox"][aria-controls="' + el.id + '"]'
        );
        if (ctrl) return;
      }
      if (
        el.tagName === "INPUT" &&
        el.type === "search" &&
        el.closest('[class*="dropdown"], [role="dialog"]')
      )
        return;
      if (
        el.tagName === "INPUT" &&
        (el.type === "radio" || el.type === "checkbox") &&
        window.getComputedStyle(el).display === "none"
      )
        return;

      const id = ff.tag(el); // tags new elements too
      if (map[id] === true) return; // already visible via sibling

      if (el.type === "file" && !ff.isVisible(el)) {
        const container = el.closest(
          "[class*=upload], [class*=drop], .form-group, .field"
        );
        map[id] = container ? ff.isVisible(container) : false;
        return;
      }

      map[id] = ff.isVisible(el);
    });

    return map;
  });
}

// ── Combobox interaction ─────────────────────────────────────

export interface ComboboxInfo {
  id: string;
  label: string;
  isNative: boolean;
  kind: "select" | "radio-group" | "toggle" | "checkbox"; // what type of control
  options: string[];
}

// ── Workday portal helpers (module-level) ───────────────────

// Read de-duplicated option texts from Workday's activeListContainer portal
export async function readActiveListOptions(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    const container = document.querySelector('[data-automation-id="activeListContainer"]');
    if (!container) return [];
    let items = Array.from(container.querySelectorAll('[role="option"]'));
    if (items.length === 0) {
      items = Array.from(container.querySelectorAll(
        '[data-automation-id="promptOption"], [data-automation-id="menuItem"]'
      ));
    }
    return items
      .filter((o: any) => {
        const r = o.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((o: any) => (o.textContent || "").trim())
      .filter(Boolean);
  });
  return [...new Set(raw)];
}

// Click an option inside a Workday dropdown (activeListContainer portal OR native listbox)
// Uses Playwright locators (page.evaluate el.click() doesn't fire Workday's React handlers)
export async function clickActiveListOption(page: Page, text: string): Promise<boolean> {
  try {
    // Try activeListContainer portal first (searchable selectinput dropdowns)
    const portal = page.locator('[data-automation-id="activeListContainer"]');
    if (await portal.count() > 0) {
      let option = portal.locator(`[role="option"]`).filter({ hasText: text }).first();
      if (await option.count() === 0) {
        option = portal.locator(`[data-automation-id="promptOption"], [data-automation-id="menuItem"]`)
          .filter({ hasText: text }).first();
      }
      if (await option.count() > 0) {
        await option.click({ timeout: 2000 });
        return true;
      }
    }
    // Fallback: native UL[role="listbox"] dropdown (Country, State, Phone Device Type)
    const listbox = page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: text }).first();
    if (await listbox.count() > 0) {
      await listbox.click({ timeout: 2000 });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function findVisibleProbeTargets(
  page: Page,
  skipDiscoveryIds?: Set<string>,
): Promise<ComboboxInfo[]> {
  const raw: any[] = await page.evaluate(() => {
    const ff = (window as any).__ff;
    const result: any[] = [];
    const seen = new Set();

    function getOptionMainText(opt: any): string {
      const clone = opt.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(
          '[class*="desc"], [class*="sub"], [class*="hint"], .option-desc, small'
        )
        .forEach((x: any) => x.remove());
      return clone.textContent?.trim() || "";
    }

    // Native selects
    document.querySelectorAll("select").forEach((el: any) => {
      if (seen.has(el) || !ff.isVisible(el)) return;
      seen.add(el);
      result.push({
        id: el.getAttribute("data-ff-id") || ff.tag(el),
        label: ff.getAccessibleName(el),
        isNative: true,
        kind: "select",
        options: Array.from(el.options as HTMLOptionsCollection)
          .filter((o: any) => o.value !== "")
          .map((o: any) => o.textContent?.trim() || "")
          .filter(Boolean),
      });
    });

    // Custom comboboxes (skip multi-selects, ITI internals, listboxes inside comboboxes)
    document
      .querySelectorAll('[role="combobox"]')
      .forEach((el: any) => {
        if (seen.has(el) || el.tagName === "SELECT" || !ff.isVisible(el))
          return;
        // Skip elements inside intl-tel-input dropdown panels
        if (el.closest('.iti__dropdown-content'))
          return;
        // Skip elements inside Workday dropdown portals
        if (el.closest('[data-automation-id="activeListContainer"]'))
          return;
        // Skip search inputs inside dropdown containers
        if (el.tagName === "INPUT" && el.type === "search" && el.closest('[class*="dropdown"], [role="dialog"]'))
          return;
        // Skip multi-selects — they don't reveal conditional fields
        if (
          el.classList.toString().includes("multi") ||
          el.getAttribute("aria-multiselectable") === "true"
        )
          return;
        seen.add(el);

        let opts: string[] = [];
        const ctrlId =
          el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
        const src = ctrlId ? document.getElementById(ctrlId) : el;
        if (src) {
          opts = Array.from(
            src.querySelectorAll('[role="option"], [role="menuitem"]')
          )
            .map((o: any) => getOptionMainText(o))
            .filter(Boolean);
        }

        result.push({
          id: el.getAttribute("data-ff-id") || ff.tag(el),
          label: ff.getAccessibleName(el),
          isNative: false,
          kind: "select",
          options: opts,
        });
      });

    // Workday-style searchable dropdowns (data-uxi-widget-type="selectinput")
    document
      .querySelectorAll('[data-uxi-widget-type="selectinput"], [aria-haspopup="listbox"]')
      .forEach((el: any) => {
        if (seen.has(el) || !ff.isVisible(el)) return;
        // Skip elements inside Workday dropdown portals
        if (el.closest('[data-automation-id="activeListContainer"]')) return;
        seen.add(el);
        result.push({
          id: el.getAttribute("data-ff-id") || ff.tag(el),
          label: ff.getAccessibleName(el),
          isNative: false,
          kind: "select",
          options: [], // will be discovered by clicking
        });
      });

    // Radio groups (including card-style radio groups)
    document
      .querySelectorAll('[role="radiogroup"], .radio-cards, .radio-group')
      .forEach((group: any) => {
        if (seen.has(group) || !ff.isVisible(group)) return;
        // Skip groups inside Workday dropdown portals
        if (group.closest('[data-automation-id="activeListContainer"]')) return;
        seen.add(group);

        const radios = group.querySelectorAll(
          '[role="radio"], input[type="radio"]'
        );
        const opts: string[] = [];
        radios.forEach((r: any) => {
          if (!ff.isVisible(r)) return;
          // Get label text from card or wrapping label
          const labelEl = r.querySelector('[class*="label"], .rc-label');
          if (labelEl) {
            opts.push(labelEl.textContent?.trim() || "");
          } else {
            const wrap = r.closest("label");
            if (wrap) {
              const c = wrap.cloneNode(true) as HTMLElement;
              c.querySelectorAll("input, [class*=desc], small").forEach(
                (x: any) => x.remove()
              );
              const txt = c.textContent?.trim();
              if (txt) opts.push(txt);
            }
          }
        });

        if (opts.length > 0) {
          const id = ff.tag(group);
          result.push({
            id,
            label: ff.getAccessibleName(group),
            isNative: false,
            kind: "radio-group",
            options: opts,
          });
        }
      });

    // Toggle switches (role="switch")
    document
      .querySelectorAll('[role="switch"]')
      .forEach((el: any) => {
        if (seen.has(el) || !ff.isVisible(el)) return;
        if (el.closest('[data-automation-id="activeListContainer"]')) return;
        seen.add(el);
        const id = el.getAttribute("data-ff-id") || ff.tag(el);
        result.push({
          id,
          label: ff.getAccessibleName(el) || el.getAttribute("aria-label") || "",
          isNative: false,
          kind: "toggle",
          options: ["on"],
        });
      });

    // Standalone checkboxes (may reveal conditional fields when checked)
    document
      .querySelectorAll('input[type="checkbox"], [role="checkbox"]')
      .forEach((el: any) => {
        if (seen.has(el) || !ff.isVisible(el)) return;
        // Skip checkboxes inside Workday dropdown portals
        if (el.closest('[data-automation-id="activeListContainer"]')) return;
        // Skip checkboxes inside multi-checkbox groups
        const inGroup = el.closest('.checkbox-group, [role="group"]');
        if (inGroup) {
          const otherCheckboxes = inGroup.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
          if (otherCheckboxes.length > 1) return; // actual group, skip
        }
        seen.add(el);
        const id = el.getAttribute("data-ff-id") || ff.tag(el);
        const label = ff.getAccessibleName(el) || el.getAttribute("aria-label") || "";
        if (!label) return; // skip unlabeled checkboxes
        result.push({
          id,
          label,
          isNative: false,
          kind: "checkbox",
          options: ["checked"],
        });
      });

    return result;
  });

  // For custom comboboxes with no options found, click to discover
  for (const cb of raw) {
    if (skipDiscoveryIds?.has(cb.id)) continue;
    if (cb.kind === "select" && !cb.isNative && cb.options.length === 0 && cb.id) {
      try {
        // Dismiss any lingering dropdown portals (Workday reuses them)
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
        await page.waitForTimeout(300);

        await clickComboboxTrigger(page, cb.id);
        await page.waitForTimeout(500);

        const topLevel = await readActiveListOptions(page);
        if (topLevel.length > 0) {
          // Detect if items have chevrons (side charms) indicating sub-categories
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
                await clickComboboxTrigger(page, cb.id);
                await page.waitForTimeout(500);
              }

              // Click the category to drill into its sub-options
              await clickActiveListOption(page, category);
              await page.waitForTimeout(800);

              // Read what's now showing — use aria-setsize to know total count
              const info = await page.evaluate(() => {
                const c = document.querySelector('[data-automation-id="activeListContainer"]');
                if (!c) return { count: 0, setsize: 0, texts: [] as string[] };
                const items = c.querySelectorAll('[role="option"]');
                const setsize = parseInt(items[0]?.getAttribute("aria-setsize") || "0", 10);
                const texts = Array.from(items)
                  .filter((o: any) => o.getBoundingClientRect().height > 0)
                  .map((o: any) => (o.textContent || "").trim())
                  .filter(Boolean);
                return { count: items.length, setsize, texts: [...new Set(texts)] };
              });

              // When chevrons are present, clicking a category ALWAYS drills into sub-options.
              // Even if setsize=1 or the sub-option name matches the category name
              // (e.g., "Careers Fair" has one sub-option also called "Careers Fair").
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
                      .map((o: any) => (o.textContent || "").trim())
                      .filter(Boolean);
                  });

                  let newCount = 0;
                  for (const t of moreTexts) {
                    if (!allSubs.includes(t)) {
                      allSubs.push(t);
                      newCount++;
                    }
                  }
                  if (newCount === 0) break; // no more new items
                }
              }

              for (const sub of allSubs) {
                allOptions.push(`${category} > ${sub}`);
              }

              // Close and dismiss
              await page.keyboard.press("Escape");
              await page.waitForTimeout(200);
              await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
              await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
              await page.waitForTimeout(200);
            }

            cb.options = allOptions;
            console.error(`  discovered ${allOptions.length} hierarchical options for "${cb.label}"`);
          } else {
            // Flat dropdown — no chevrons, just use top-level options
            cb.options = topLevel;
            console.error(`  discovered ${topLevel.length} flat options for "${cb.label}"`);
          }
        } else {
          // No activeListContainer — fall back to standard option extraction
          cb.options = await page.evaluate((ffId) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return [];
            const ff = (window as any).__ff;

            function extractOpts(container: Element): string[] {
              return Array.from(
                container.querySelectorAll('[role="option"], [role="menuitem"]')
              )
                .filter((o: any) => ff.isVisible(o))
                .map((o: any) => {
                  const clone = o.cloneNode(true) as HTMLElement;
                  clone
                    .querySelectorAll('[class*="desc"], .option-desc, small')
                    .forEach((x: any) => x.remove());
                  return clone.textContent?.trim() || "";
                })
                .filter(Boolean);
            }

            let opts = extractOpts(el);
            if (opts.length > 0) return opts;

            const ctrlId =
              el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
            if (ctrlId) {
              const popup = document.getElementById(ctrlId);
              if (popup) {
                opts = extractOpts(popup);
                if (opts.length > 0) return opts;
              }
            }

            if (el.tagName === "INPUT") {
              const container = el.closest(
                '[class*="select"], [class*="combobox"], .form-group'
              );
              if (container) {
                opts = extractOpts(container);
                if (opts.length > 0) return opts;
              }
            }

            return Array.from(
              document.querySelectorAll('[role="option"], [role="menuitem"]')
            )
              .filter((o: any) => ff.isVisible(o))
              .map((o: any) => o.textContent?.trim() || "")
              .filter(Boolean);
          }, cb.id);
          if (cb.options.length > 0) {
            console.error(`  discovered ${cb.options.length} options for "${cb.label}" (fallback)`);
          }
        }

        // Ensure dropdown is fully closed
        await page.keyboard.press("Escape");
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
        await page.waitForTimeout(300);
      } catch {
        // ignore — might not be an openable combobox
      }
    }
  }

  return raw.filter((cb) => cb.options.length > 0);
}

export async function clickComboboxTrigger(page: Page, id: string): Promise<void> {
  // Custom dropdowns often have a child "trigger" element that handles clicks.
  // React Select uses mouseDown on a container, not click on the input.
  const targetSelector = await page.evaluate((ffId) => {
    const el = document.querySelector(`[data-ff-id="${ffId}"]`) as HTMLElement;
    if (!el) return null;

    // For <input role="combobox"> (React Select pattern):
    // click the .select__control ancestor or similar wrapper, not the input
    if (el.tagName === "INPUT") {
      const control =
        el.closest('[class*="select__control"]') ||
        el.closest('[class*="control"]') ||
        el.closest('[class*="select-shell"]');
      if (control) {
        // Tag the control so we can click it with Playwright
        if (!control.hasAttribute("data-ff-id")) {
          control.setAttribute("data-ff-click-target", ffId);
        }
        return `[data-ff-click-target="${ffId}"], [data-ff-id="${ffId}"]`;
      }
    }

    // For div-based comboboxes: find trigger child
    const trigger =
      el.querySelector(':scope > [class*="trigger"]') ||
      el.querySelector(':scope > button') ||
      el.querySelector(':scope > div');
    if (trigger && trigger !== el) {
      (trigger as HTMLElement).click();
      return "__already_clicked__";
    }
    el.click();
    return "__already_clicked__";
  }, id);

  if (!targetSelector) throw new Error(`Combobox ${id} not found`);

  if (targetSelector !== "__already_clicked__") {
    // Use Playwright's click (fires proper mousedown/mouseup/click events)
    try {
      await page.click(targetSelector, { timeout: 2000 });
    } catch {
      // Fallback: focus the input directly
      await page.focus(`[data-ff-id="${id}"]`);
    }
  }
  await page.waitForTimeout(300);
}

export async function selectOption(
  page: Page,
  cb: ComboboxInfo,
  optionText: string
): Promise<void> {
  if (cb.kind === "toggle" || cb.kind === "checkbox") {
    // Toggle/checkbox: just click it
    await page.evaluate((ffId) => {
      const el = document.querySelector(`[data-ff-id="${ffId}"]`) as any;
      if (el) el.click();
    }, cb.id);
    await page.waitForTimeout(600); // Workday etc. need time to render conditional fields
    return;
  }

  if (cb.kind === "radio-group") {
    // Radio group: click the matching radio card/label
    const clicked = await page.evaluate(
      ({ ffId, text }) => {
        const group = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!group) return false;
        const items = group.querySelectorAll(
          '[role="radio"], label, .radio-card'
        );
        for (const item of items) {
          // Check card label text
          const labelEl = item.querySelector(
            '[class*="label"], .rc-label'
          );
          const itemText = labelEl
            ? labelEl.textContent?.trim()
            : item.textContent?.trim();
          if (itemText === text || itemText?.includes(text)) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      },
      { ffId: cb.id, text: optionText }
    );
    if (!clicked) {
      console.error(
        `  [warn] Could not select "${optionText}" in radio group ${cb.label}`
      );
    }
    await page.waitForTimeout(200);
    return;
  }

  if (cb.isNative) {
    await page.selectOption(`[data-ff-id="${cb.id}"]`, { label: optionText });
  } else {
    // Custom dropdown: click trigger to open, then click the option
    await clickComboboxTrigger(page, cb.id);

    // Try to find and click the matching option inside this combobox's dropdown
    const clicked = await page.evaluate(
      ({ ffId, text }) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return false;

        function matchOpt(opt: Element): boolean {
          const clone = opt.cloneNode(true) as HTMLElement;
          clone
            .querySelectorAll(
              '[class*="desc"], [class*="sub"], .option-desc, small'
            )
            .forEach((x: any) => x.remove());
          const mainText = clone.textContent?.trim();
          return mainText === text;
        }

        // Look for options within this combobox's dropdown
        const opts = el.querySelectorAll('[role="option"], [role="menuitem"]');
        for (const opt of opts) {
          if (matchOpt(opt)) {
            (opt as HTMLElement).click();
            return true;
          }
        }
        // Also check aria-controls / aria-owns popup
        const ctrlId =
          el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
        if (ctrlId) {
          const popup = document.getElementById(ctrlId);
          if (popup) {
            for (const opt of popup.querySelectorAll(
              '[role="option"], [role="menuitem"]'
            )) {
              if (matchOpt(opt)) {
                (opt as HTMLElement).click();
                return true;
              }
            }
          }
        }
        return false;
      },
      { ffId: cb.id, text: optionText }
    );

    if (!clicked) {
      // Fallback: use Playwright role locator scoped to visible options
      for (const role of ["option", "menuitem"] as const) {
        const opt = page.getByRole(role, { name: optionText, exact: true });
        if (await opt.isVisible().catch(() => false)) {
          await opt.click();
          await page.waitForTimeout(150);
          return;
        }
      }
      // Last resort: press Escape so we don't leave a dropdown open
      await page.keyboard.press("Escape");
      console.error(`  [warn] Could not select "${optionText}" in ${cb.label}`);
    }
  }
  await page.waitForTimeout(150);
}

export async function resetProbeTarget(page: Page, cb: ComboboxInfo): Promise<void> {
  if (cb.kind === "toggle" || cb.kind === "checkbox") {
    // Toggle/checkbox: click again to revert
    await page.evaluate((ffId) => {
      const el = document.querySelector(`[data-ff-id="${ffId}"]`) as any;
      if (el) el.click();
    }, cb.id);
    await page.waitForTimeout(300);
    return;
  }

  if (cb.kind === "radio-group") {
    // Radio groups can't really be "unselected" — just leave current selection.
    // The next option select will overwrite it.
    return;
  }

  if (cb.isNative) {
    await page.selectOption(`[data-ff-id="${cb.id}"]`, { index: 0 });
  } else {
    try {
      await clickComboboxTrigger(page, cb.id);
      // Click the first option within this combobox's dropdown
      const reset = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return false;
        const firstOpt = el.querySelector('[role="option"], [role="menuitem"]');
        if (firstOpt) {
          (firstOpt as HTMLElement).click();
          return true;
        }
        // Check aria-controls popup
        const ctrlId =
          el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
        if (ctrlId) {
          const popup = document.getElementById(ctrlId);
          const opt = popup?.querySelector('[role="option"], [role="menuitem"]');
          if (opt) {
            (opt as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, cb.id);
      if (!reset) {
        await page.keyboard.press("Escape");
      }
    } catch {
      await page.keyboard.press("Escape");
    }
  }
  await page.waitForTimeout(150);
}

// ── Conditional discovery ────────────────────────────────────

export async function discoverConditionals(page: Page) {
  const rules = new Map<string, ConditionChain[]>();
  const fieldDetails = new Map<string, FormField>(); // id → field info
  const probed = new Set<string>();
  const discoveredOptions = new Map<string, string[]>(); // id → options found by probing

  async function probe(parentChain: ConditionChain) {
    const comboboxes = await findVisibleProbeTargets(page, probed);

    // Mark all as probed upfront
    const toProbe: ComboboxInfo[] = [];
    const sampleProbe: ComboboxInfo[] = []; // large dropdowns to sample
    for (const cb of comboboxes) {
      if (!probed.has(cb.id)) {
        probed.add(cb.id);
        // Save discovered options for merging back into field output
        if (cb.options.length > 0) {
          discoveredOptions.set(cb.id, cb.options);
        }
        // Skip unnamed comboboxes — they're usually language switchers or other chrome
        if (!cb.label) continue;
        if (cb.options.length <= MAX_PROBE_OPTIONS) {
          toProbe.push(cb);
        } else {
          // Large dropdown — sample a few options to detect conditionals
          sampleProbe.push(cb);
        }
      }
    }

    // Sample-probe large dropdowns first (e.g., Country with 250 options).
    // Pick a few non-placeholder options spread across the list.
    // Skip hierarchical dropdowns (options contain " > ") — their selection needs special handling.
    for (const cb of sampleProbe) {
      const candidates = cb.options.filter(
        (o) => !PLACEHOLDER_RE.test(o) && !o.includes(" > ")
      );
      if (candidates.length === 0) continue;
      // Pick evenly spaced samples from the option list
      const step = Math.max(1, Math.floor(candidates.length / SAMPLE_PROBE_COUNT));
      const samples: string[] = [];
      for (let i = 0; i < candidates.length && samples.length < SAMPLE_PROBE_COUNT; i += step) {
        samples.push(candidates[i]);
      }

      console.error(`  sampling ${samples.length} of ${candidates.length} options for "${cb.label}"…`);

      // Remember original value so we can restore it
      const originalValue = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`) as HTMLElement;
        return el?.textContent?.trim() || "";
      }, cb.id);

      for (const optionText of samples) {
        const hasHelpers = await page.evaluate(() => !!(window as any).__ff).catch(() => false);
        if (!hasHelpers) await injectHelpers(page);

        const before = await tagAndSnapshot(page);

        // For Workday buttons (aria-haspopup="listbox"), use portal-based selection
        const isWorkdayButton = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          return el?.tagName === "BUTTON" && el?.getAttribute("aria-haspopup") === "listbox";
        }, cb.id);

        let selected = false;
        if (isWorkdayButton) {
          // Click the button to open dropdown
          await page.click(`[data-ff-id="${cb.id}"]`).catch(() => {});
          await page.waitForTimeout(500);
          // Workday dropdowns are virtualized — type to search first
          const searchInput = page.locator('[data-automation-id="searchBox"] input, [data-automation-id="activeListContainer"] input[type="text"]');
          if (await searchInput.count() > 0) {
            await searchInput.fill(optionText);
            await page.waitForTimeout(400);
          }
          selected = await clickActiveListOption(page, optionText);
          await page.waitForTimeout(500);
        } else {
          try {
            await selectOption(page, cb, optionText);
            selected = true;
          } catch {
            selected = false;
          }
        }

        if (!selected) {
          console.error(`  [warn] Could not select "${optionText}" for sample probe in ${cb.label}`);
          // Dismiss any open dropdown
          await page.keyboard.press("Escape").catch(() => {});
          await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
          await page.waitForTimeout(200);
          continue;
        }

        await page.waitForTimeout(300);

        // Re-inject helpers if DOM was re-rendered
        const hasHelpers2 = await page.evaluate(() => !!(window as any).__ff).catch(() => false);
        if (!hasHelpers2) await injectHelpers(page);

        const after = await tagAndSnapshot(page);

        const appeared = Object.keys(after).filter(
          (id) => after[id] && !before[id]
        );

        if (appeared.length > 0) {
          // Record dependency as "any value" — the exact value doesn't matter
          const chain: ConditionChain = [
            ...parentChain,
            { field: cb.label, equals: "*" },
          ];

          const revealedFields = await extractFields(page);
          for (const ffId of appeared) {
            if (!rules.has(ffId)) rules.set(ffId, []);
            // Only add the wildcard rule once per field
            const existing = rules.get(ffId)!;
            if (!existing.some((c) => c.length === chain.length && c[c.length - 1]?.equals === "*" && c[c.length - 1]?.field === cb.label)) {
              existing.push(chain);
            }

            if (!fieldDetails.has(ffId)) {
              const detail = revealedFields.find((f) => f.id === ffId);
              if (detail) {
                detail.visibleByDefault = false;
                fieldDetails.set(ffId, detail);
              }
            }
          }
        }

        // Reset: select back the original value
        if (isWorkdayButton && originalValue && originalValue !== optionText) {
          await page.click(`[data-ff-id="${cb.id}"]`).catch(() => {});
          await page.waitForTimeout(500);
          const searchInput2 = page.locator('[data-automation-id="searchBox"] input, [data-automation-id="activeListContainer"] input[type="text"]');
          if (await searchInput2.count() > 0) {
            await searchInput2.fill(originalValue);
            await page.waitForTimeout(400);
          }
          const restored = await clickActiveListOption(page, originalValue);
          if (!restored) {
            await page.keyboard.press("Escape").catch(() => {});
          }
          await page.waitForTimeout(500);
        } else {
          await resetProbeTarget(page, cb);
        }

        // Re-inject helpers after possible DOM changes
        const hasHelpers3 = await page.evaluate(() => !!(window as any).__ff).catch(() => false);
        if (!hasHelpers3) await injectHelpers(page);
      }
    }

    for (const cb of toProbe) {
      for (const optionText of cb.options) {
        if (PLACEHOLDER_RE.test(optionText)) continue;

        // Re-inject helpers if lost (e.g., page reload from language switch)
        const hasHelpers = await page.evaluate(() => !!(window as any).__ff).catch(() => false);
        if (!hasHelpers) await injectHelpers(page);

        const before = await tagAndSnapshot(page);
        await selectOption(page, cb, optionText);
        // Extra settle time for slow frameworks (Workday, React)
        await page.waitForTimeout(300);
        const after = await tagAndSnapshot(page);

        // Fields that went from hidden/absent → visible
        const appeared = Object.keys(after).filter(
          (id) => after[id] && !before[id]
        );

        if (appeared.length > 0) {
          const chain: ConditionChain = [
            ...parentChain,
            { field: cb.label, equals: optionText },
          ];

          // Extract field details while visible
          const revealedFields = await extractFields(page);
          for (const ffId of appeared) {
            if (!rules.has(ffId)) rules.set(ffId, []);
            rules.get(ffId)!.push(chain);

            if (!fieldDetails.has(ffId)) {
              const detail = revealedFields.find((f) => f.id === ffId);
              if (detail) {
                detail.visibleByDefault = false;
                fieldDetails.set(ffId, detail);
              }
            }
          }

          // Recurse for newly visible comboboxes
          await probe(chain);
        }

        await resetProbeTarget(page, cb);
      }
    }
  }

  await probe([]);
  return { rules, fieldDetails, discoveredOptions };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const input = process.argv[2] || path.join(__dirname, "index.html");
  const url = resolveUrl(input);
  console.error(`Loading: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle" });
  await injectHelpers(page);

  // 0. Reveal all multi-step/accordion/tab sections so we can see all fields
  await page.evaluate(() => {
    // Multi-step forms: make all sections visible
    const hiddenSections = document.querySelectorAll(
      '[data-section], .form-section, .form-step, .step-content, ' +
      '.tab-pane, .accordion-content, .panel-body, [role="tabpanel"]'
    );
    hiddenSections.forEach((el: any) => {
      el.style.display = '';
      el.classList.add('active');
      el.removeAttribute('hidden');
      el.setAttribute('aria-hidden', 'false');
    });
  });

  // 1. Extract all fields (visible and hidden)
  let fields = await extractFields(page);

  // 2. Probe comboboxes for conditionals
  console.error("Probing comboboxes for conditional fields…");
  const { rules, fieldDetails, discoveredOptions } = await discoverConditionals(page);

  // Mark fields with conditions
  for (const f of fields) {
    const chains = rules.get(f.id);
    if (chains?.length) {
      f.visibleByDefault = false;
      f.visibleWhen = chains;
    }
  }

  // Merge discovered options into fields that had none initially
  // (e.g. React Select comboboxes whose options load dynamically on click)
  for (const f of fields) {
    if (f.type === "select" && !f.options?.length) {
      const opts = discoveredOptions.get(f.id);
      if (opts?.length) {
        f.options = opts;
      }
    }
  }

  // Add conditional-only fields not in initial extraction
  const existingIds = new Set(fields.map((f) => f.id));
  for (const [id, detail] of fieldDetails) {
    if (!existingIds.has(id)) {
      detail.visibleWhen = rules.get(id);
      fields.push(detail);
    }
  }

  // 3. Build output (strip internal fields and unnamed/junk fields)
  fields = fields.filter((f) => {
    if (!f.name) return false;
    // Workday internal elements (multi-select pill display, etc.)
    if (f.name === "items selected") return false;
    return true;
  });

  const title = await page.title();
  const result: FormStructure = {
    url,
    title,
    fields: fields.map(({ id, isNative, ...rest }) => rest),
  };

  console.log(JSON.stringify(result, null, 2));

  // 4. Generate self-contained visualization HTML
  const vizTemplate = fs.readFileSync(
    path.join(__dirname, "visualize.html"),
    "utf-8"
  );
  const vizHtml = vizTemplate.replace(
    "if (window.__FORM_DATA__) {",
    `window.__FORM_DATA__ = ${JSON.stringify(result)};\n    if (window.__FORM_DATA__) {`
  );
  const outPath = path.join(__dirname, "structure-view.html");
  fs.writeFileSync(outPath, vizHtml);
  console.error(`\nVisualization written to: ${outPath}`);

  // Auto-open in browser (macOS)
  const { spawn } = await import("child_process");
  spawn("open", [outPath], { stdio: "ignore", detached: true }).unref();

  await browser.close();
}

// Only run main() when this file is the entry point (not when imported)
const _isMain = !process.argv[1] || process.argv[1].includes("extract-form-structure");
if (_isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
