/**
 * fill-form.ts
 *
 * Extracts form structure, then asks Claude Haiku 4.5 to decide what value
 * to put in each field. Falls back to sensible defaults for field types
 * the LLM doesn't cover.
 *
 * No probing phase — just fills visible fields, then iteratively fills
 * any newly revealed conditional fields until the form stabilizes.
 *
 * Usage:
 *   bun toy-job-app/fill-form.ts [url-or-file]
 */

import { chromium, type Page } from "playwright";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";

import {
  type FormField,
  resolveUrl,
  injectHelpers,
  extractFields,
  clickComboboxTrigger,
  readActiveListOptions,
  clickActiveListOption,
  PLACEHOLDER_RE,
} from "./extract-form-structure";

// ── Types & Constants ────────────────────────────────────────

/** Map of field name → desired value. Checked case-insensitively. */
export type AnswerMap = Record<string, string>;

const RESUME_PATH = path.resolve(__dirname, "..", "resumeTemp.pdf");

function defaultValue(field: FormField): string {
  switch (field.type) {
    case "email":
      return "a@a.com";
    case "tel":
      return "1234567890";
    case "url":
      return "https://a.com";
    case "number":
      return "1";
    case "date":
      return "2025-01-01";
    default:
      return "A";
  }
}

/** Normalize a field name for matching: strip trailing *, trim whitespace. */
function normalizeName(s: string): string {
  return s.replace(/\s*\*+\s*$/, "").trim().toLowerCase();
}

/** Look up an answer for a field, case-insensitive, ignoring trailing * markers. */
function getAnswer(answers: AnswerMap, field: FormField): string | undefined {
  // Try exact match first
  if (field.name in answers) return answers[field.name];
  // Normalized match (case-insensitive, strip trailing *)
  const norm = normalizeName(field.name);
  for (const [key, val] of Object.entries(answers)) {
    if (normalizeName(key) === norm) return val;
  }
  return undefined;
}

// ── LLM answer generation ───────────────────────────────────

const SAMPLE_PROFILE = `
Name: Alexander Chen
Email: alex.chen@gmail.com
Phone: (415) 555-0173
Location: San Francisco, CA
LinkedIn: https://linkedin.com/in/alexchen
Portfolio: https://alexchen.dev
GitHub: https://github.com/alexchen

Current Role: Senior Software Engineer at Stripe (3 years)
Previous: Software Engineer at Dropbox (2 years)
Education: B.S. Computer Science, UC Berkeley, 2018

Skills: TypeScript, Python, React, Node.js, PostgreSQL, AWS, Docker, Kubernetes
Interests: distributed systems, developer tools, AI/ML applications

Work authorization: US Citizen
Willing to relocate: No
Open to remote: Yes
Desired salary: $180,000

Demographics:
Gender: Male
Ethnicity: Asian (Chinese-American)
Not Hispanic/Latino
Veteran status: Not a veteran
Disability: No disability
Date of birth: 1996-03-15
Languages spoken: English (native), Mandarin Chinese (conversational)
`;

/** Open each custom dropdown briefly to discover its options at fill-time.
 *  For hierarchical Workday dropdowns (with chevron sub-categories),
 *  drills into each category and stores options as "Category > SubOption". */
async function discoverDropdownOptions(page: Page, fields: FormField[]): Promise<void> {
  for (const f of fields) {
    if (f.type !== "select" || f.isNative || (f.options && f.options.length > 0)) continue;
    if (!f.name) continue; // skip unnamed fields (language switchers, etc.)

    try {
      // Dismiss any lingering dropdown portal before opening next
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
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
              const setsize = parseInt(items[0]?.getAttribute("aria-setsize") || "0", 10);
              const texts = Array.from(items)
                .filter((o: any) => o.getBoundingClientRect().height > 0)
                .map((o: any) => (o.textContent || "").trim())
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
                if (newCount === 0) break;
              }
            }

            for (const sub of allSubs) {
              allOptions.push(`${category} > ${sub}`);
            }

            // Close and dismiss before next category
            await page.keyboard.press("Escape");
            await page.waitForTimeout(200);
            await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
            await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
            await page.waitForTimeout(200);
          }

          f.options = allOptions;
          console.error(`  discovered ${allOptions.length} hierarchical options for "${f.name}"`);
        } else {
          // Flat dropdown — use top-level options directly
          f.options = topLevel;
          console.error(`  discovered ${topLevel.length} options for "${f.name}"`);
        }
      } else {
        // No activeListContainer — fall back to standard option extraction
        const options = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return [];
          const results: string[] = [];

          function collect(container: Element) {
            const opts = container.querySelectorAll('[role="option"], [role="menuitem"], li');
            for (const o of opts) {
              const r = o.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const t = o.textContent?.trim();
              if (t && t.length < 200) results.push(t);
            }
          }

          collect(el);
          const ctrlId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
          if (ctrlId) {
            const popup = document.getElementById(ctrlId);
            if (popup) collect(popup);
          }
          if (el.tagName === "INPUT") {
            const container = el.closest('[class*="select"], [class*="combobox"], .form-group');
            if (container) collect(container);
          }
          // Workday button dropdowns: UL[role="listbox"]
          const listboxes = document.querySelectorAll('[role="listbox"]');
          for (const lb of listboxes) {
            const r = (lb as HTMLElement).getBoundingClientRect();
            if (r.height > 0) collect(lb);
          }
          return [...new Set(results)];
        }, f.id);

        if (options.length > 0) {
          f.options = options;
          console.error(`  discovered ${options.length} options for "${f.name}" (fallback)`);
        }
      }

      // Ensure dropdown is fully closed
      await page.keyboard.press("Escape");
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
      await page.waitForTimeout(300);
    } catch {
      // Ignore — some fields won't open
    }
  }
}

async function generateAnswers(fields: FormField[]): Promise<AnswerMap> {
  const client = new Anthropic();

  // Build a compact description of each field for the prompt
  const fieldDescriptions = fields.map((f) => {
    let desc = `- "${f.name}" (type: ${f.type})`;
    if (f.options?.length) desc += ` options: [${f.options.join(", ")}]`;
    if (f.choices?.length) desc += ` choices: [${f.choices.join(", ")}]`;
    if (f.section) desc += ` [section: ${f.section}]`;
    return desc;
  }).join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: `You are filling out a job application form on behalf of an applicant. Here is their profile:

${SAMPLE_PROFILE}

Here are the form fields to fill:

${fieldDescriptions}

Rules:
- For each field, decide what value to put based on the profile.
- If the profile doesn't have enough info, make up a plausible value.
- For dropdowns/radio groups with listed options, you MUST pick the EXACT text of one of the available options.
- For dropdowns WITHOUT listed options, provide your best guess for the value.
- For checkboxes/toggles, respond with "checked"/"unchecked" or "on"/"off".
- For file upload fields, skip them (don't include in output).
- For demographic/EEO fields (gender, race, ethnicity, veteran, disability), use the applicant's actual demographic info from their profile. Pick the option that best matches.
- You MUST respond with ONLY a valid JSON object. No explanation, no commentary, no markdown fences.

Example response:
{"First Name": "Alexander", "Last Name": "Chen", "Email": "alex.chen@gmail.com"}`,
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  console.error("\nLLM response:\n" + text + "\n");

  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    const parsed = JSON.parse(cleaned) as AnswerMap;
    // Flatten any array values to comma-separated strings
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) (parsed as any)[k] = v.join(",");
      else if (typeof v === "number") (parsed as any)[k] = String(v);
    }
    return parsed;
  } catch (e) {
    console.error("Failed to parse LLM response as JSON, using empty answers");
    return {};
  }
}

// ── Fill a single field ─────────────────────────────────────

async function fillField(page: Page, field: FormField, answers: AnswerMap = {}): Promise<boolean> {
  const sel = `[data-ff-id="${field.id}"]`;
  const tag = `[${field.name || field.type}]`;

  // Check element actually exists and is visible
  // (file inputs may be hidden behind upload UIs — check container visibility)
  const exists = await page.evaluate(({ ffId, type }) => {
    const ff = (window as any).__ff;
    const el = document.querySelector(`[data-ff-id="${ffId}"]`);
    if (!el) return false;
    if (ff.isVisible(el)) return true;
    if (type === "file") {
      const container = el.closest("[class*=upload], [class*=drop], .form-group, .field");
      return container ? ff.isVisible(container) : false;
    }
    return false;
  }, { ffId: field.id, type: field.type });
  if (!exists) return false;

  switch (field.type) {
    case "text":
    case "email":
    case "tel":
    case "url":
    case "number":
    case "password":
    case "search": {
      // Detect searchable dropdowns (Workday selectinput, comboboxes, etc.)
      const searchDropdown = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return false;
        return (
          el.getAttribute("role") === "combobox" ||
          el.getAttribute("data-uxi-widget-type") === "selectinput" ||
          el.getAttribute("data-automation-id") === "searchBox" ||
          (el.getAttribute("autocomplete") === "off" && el.getAttribute("aria-controls"))
        );
      }, field.id);

      if (searchDropdown) {
        const val = getAnswer(answers, field);
        if (!val) {
          console.error(`  skip ${tag} (searchable dropdown, no answer)`);
          return false;
        }
        try {
          // Click to open the dropdown
          await page.click(sel, { timeout: 2000 });
          await page.waitForTimeout(400);

          // Type to search — this filters the cascading dropdown
          await page.fill(sel, "", { timeout: 1000 }).catch(() => {});
          await page.type(sel, val, { delay: 30 });
          await page.waitForTimeout(1500);

          // Try to click a matching element — scan broadly
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
              const t = (o.textContent || "").trim().toLowerCase();
              if (t === lowerText || t.includes(lowerText)) {
                (o as HTMLElement).click();
                return (o.textContent || "").trim();
              }
            }

            // Strategy 2: Any visible element whose DIRECT text matches (not just textContent of children)
            // This catches Workday's custom divs/spans that serve as clickable items
            const allVisible = document.querySelectorAll(
              'div[tabindex], div[data-automation-id], span[data-automation-id], ' +
              'li, a, button, [role="button"]'
            );
            for (const o of allVisible) {
              const rect = o.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              // Use direct childNodes text to avoid matching parent containers
              let directText = "";
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
            console.error(`  search-select ${tag} → "${clicked}"`);
            await page.waitForTimeout(300);
            return true;
          }

          // Last resort: press down arrow + enter to select first search result
          await page.keyboard.press("ArrowDown");
          await page.waitForTimeout(200);
          await page.keyboard.press("Enter");
          console.error(`  search-select ${tag} → first result (keyboard)`);
          await page.waitForTimeout(300);
          return true;
        } catch (e: any) {
          console.error(`  skip ${tag} (searchable dropdown failed: ${e.message?.slice(0, 60)})`);
          return false;
        }
      }

      const val = getAnswer(answers, field) ?? defaultValue(field);
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.error(`  fill ${tag} = "${val}"`);
        return true;
      } catch {
        console.error(`  skip ${tag} (not fillable)`);
        return false;
      }
    }

    case "date": {
      const val = getAnswer(answers, field) ?? "2025-01-01";
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.error(`  fill ${tag} = "${val}"`);
        return true;
      } catch {
        console.error(`  skip ${tag} (not fillable)`);
        return false;
      }
    }

    case "textarea": {
      const val = getAnswer(answers, field) ?? "A";
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.error(`  fill ${tag} = "${val}"`);
        return true;
      } catch {
        console.error(`  skip ${tag} (not fillable)`);
        return false;
      }
    }

    case "select": {
      const answer = getAnswer(answers, field);

      if (field.isNative) {
        try {
          if (answer) {
            try {
              await page.selectOption(sel, { label: answer }, { timeout: 2000 });
              console.error(`  select ${tag} → "${answer}"`);
            } catch {
              // Exact label failed — try fuzzy match on native <option> text
              const matched = await page.evaluate(
                ({ ffId, text }) => {
                  const el = document.querySelector(`[data-ff-id="${ffId}"]`) as HTMLSelectElement;
                  if (!el) return null;
                  const lower = text.toLowerCase();
                  for (const opt of el.options) {
                    const t = opt.textContent?.trim().toLowerCase() || "";
                    if (t.startsWith(lower) || lower.startsWith(t) || t.includes(lower)) {
                      return opt.value;
                    }
                  }
                  return null;
                },
                { ffId: field.id, text: answer }
              );
              if (matched) {
                await page.selectOption(sel, matched, { timeout: 2000 });
                console.error(`  select ${tag} → "${answer}" (fuzzy)`);
              } else {
                await page.selectOption(sel, { index: 1 }, { timeout: 2000 });
                console.error(`  select ${tag} → option index 1 (answer "${answer}" not found)`);
              }
            }
          } else {
            await page.selectOption(sel, { index: 1 }, { timeout: 2000 });
            console.error(`  select ${tag} → option index 1`);
          }
          return true;
        } catch {
          console.error(`  skip ${tag} (native select failed)`);
          return false;
        }
      }

      // Hierarchical dropdown: "Category > SubOption" path
      if (answer && answer.includes(" > ")) {
        const [category, value] = answer.split(" > ", 2);
        try {
          // Dismiss any open dropdowns first
          await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
          await page.click("body", { position: { x: 0, y: 0 }, force: true }).catch(() => {});
          await page.waitForTimeout(200);

          // Open the dropdown
          await page.click(sel, { timeout: 2000 }).catch(async () => {
            await clickComboboxTrigger(page, field.id);
          });
          await page.waitForTimeout(500);

          // Click the category
          const catClicked = await page.evaluate((text) => {
            const container = document.querySelector('[data-automation-id="activeListContainer"]') || document;
            const opts = container.querySelectorAll('[role="option"]');
            for (const o of opts) {
              const t = (o.textContent || "").trim();
              if (t === text || t.toLowerCase().includes(text.toLowerCase())) {
                (o as HTMLElement).click();
                return true;
              }
            }
            return false;
          }, category);

          if (!catClicked) {
            console.error(`  skip ${tag} (category "${category}" not found)`);
            await page.keyboard.press("Escape");
            return false;
          }
          await page.waitForTimeout(600);

          // Click the sub-option
          const subClicked = await page.evaluate((text) => {
            const container = document.querySelector('[data-automation-id="activeListContainer"]') || document;
            const opts = container.querySelectorAll('[role="option"]');
            const lower = text.toLowerCase();
            for (const o of opts) {
              const t = (o.textContent || "").trim();
              if (t === text || t.toLowerCase() === lower || t.toLowerCase().includes(lower)) {
                (o as HTMLElement).click();
                return t;
              }
            }
            return null;
          }, value);

          if (subClicked) {
            console.error(`  select ${tag} → "${category} > ${subClicked}"`);
            return true;
          }
          console.error(`  skip ${tag} (sub-option "${value}" not found in "${category}")`);
          await page.keyboard.press("Escape");
          return false;
        } catch (e: any) {
          console.error(`  skip ${tag} (hierarchical select failed: ${e.message?.slice(0, 50)})`);
          return false;
        }
      }

      // Custom dropdown: use answer if provided, else first non-placeholder
      const opt = answer
        ?? field.options?.find((o) => !PLACEHOLDER_RE.test(o))
        ?? field.options?.[0];

      if (!opt) {
        // No options known — try clicking to discover them on the fly
        try {
          await clickComboboxTrigger(page, field.id);
          const clicked = await page.evaluate((ffId) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return false;
            const ff = (window as any).__ff;
            // Find first visible option anywhere inside or in aria-controls
            function tryClick(container: Element): boolean {
              const opts = container.querySelectorAll('[role="option"], [role="menuitem"]');
              for (const o of opts) {
                if (ff.isVisible(o)) {
                  (o as HTMLElement).click();
                  return true;
                }
              }
              return false;
            }
            if (tryClick(el)) return true;
            const ctrlId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
            if (ctrlId) {
              const popup = document.getElementById(ctrlId);
              if (popup && tryClick(popup)) return true;
            }
            // For <input> comboboxes, look in ancestor
            if (el.tagName === "INPUT") {
              const container = el.closest('[class*="select"], [class*="combobox"], .form-group');
              if (container && tryClick(container)) return true;
            }
            // Workday: options in portal
            const portal = document.querySelector('[data-automation-id="activeListContainer"]');
            if (portal && tryClick(portal)) return true;
            return false;
          }, field.id);
          if (clicked) {
            console.error(`  select ${tag} → first available option`);
            return true;
          }
          await page.keyboard.press("Escape");
          console.error(`  skip ${tag} (no options found)`);
          return false;
        } catch {
          console.error(`  skip ${tag} (no options)`);
          return false;
        }
      }

      try {
        await clickComboboxTrigger(page, field.id);
        const hasAnswer = !!answer; // LLM gave us a specific answer
        const clicked = await page.evaluate(
          ({ ffId, text, strict }) => {
            const el = document.querySelector(`[data-ff-id="${ffId}"]`);
            if (!el) return false;
            const lowerText = text.toLowerCase();

            function getOptionText(o: Element): string {
              const clone = o.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('[class*="desc"], [class*="sub"], .option-desc, small')
                .forEach((x: any) => x.remove());
              return clone.textContent?.trim() || "";
            }

            function findAndClick(container: Element): boolean {
              const opts = container.querySelectorAll('[role="option"], [role="menuitem"]');
              // Try exact match first
              for (const o of opts) {
                if (getOptionText(o) === text) {
                  (o as HTMLElement).click();
                  return true;
                }
              }
              // Try case-insensitive startsWith match (LLM said "No" but option is "No, I do not…")
              for (const o of opts) {
                const t = getOptionText(o).toLowerCase();
                if (t.startsWith(lowerText) || lowerText.startsWith(t)) {
                  (o as HTMLElement).click();
                  return true;
                }
              }
              // Try substring/includes match
              for (const o of opts) {
                const t = getOptionText(o).toLowerCase();
                if (t.includes(lowerText) || lowerText.includes(t)) {
                  (o as HTMLElement).click();
                  return true;
                }
              }
              // Only fall back to first visible if we DON'T have an explicit LLM answer
              if (!strict) {
                for (const o of opts) {
                  const s = window.getComputedStyle(o as HTMLElement);
                  if (s.display !== "none" && s.visibility !== "hidden") {
                    (o as HTMLElement).click();
                    return true;
                  }
                }
              }
              return false;
            }

            if (findAndClick(el)) return true;
            const ctrlId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
            if (ctrlId) {
              const popup = document.getElementById(ctrlId);
              if (popup && findAndClick(popup)) return true;
            }
            // For multi-selects
            const dropdown = el.querySelector('[class*="dropdown"], [role="listbox"]');
            if (dropdown && findAndClick(dropdown)) return true;
            // Workday: options appear in a portal (activeListContainer) at body level
            const portal = document.querySelector('[data-automation-id="activeListContainer"]');
            if (portal && findAndClick(portal)) return true;
            // Workday button dropdowns: UL[role="listbox"] sibling/nearby
            const listboxes = document.querySelectorAll('[role="listbox"]');
            for (const lb of listboxes) {
              const r = (lb as HTMLElement).getBoundingClientRect();
              if (r.height > 0 && findAndClick(lb)) return true;
            }
            return false;
          },
          { ffId: field.id, text: opt, strict: hasAnswer }
        );
        if (clicked) {
          console.error(`  select ${tag} → "${opt}"`);
          return true;
        }
        await page.keyboard.press("Escape");
        console.error(`  skip ${tag} (could not click option)`);
        return false;
      } catch (e: any) {
        console.error(`  skip ${tag} (${e.message?.slice(0, 50)})`);
        return false;
      }
    }

    case "radio-group": {
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
              if (itemText === text || itemText?.includes(text)) {
                (item as HTMLElement).click();
                return true;
              }
            }
          }
          // Fallback: click first
          if (items.length > 0) {
            (items[0] as HTMLElement).click();
            return true;
          }
          return false;
        },
        { ffId: field.id, text: choice || "" }
      );
      if (clicked) {
        console.error(`  radio ${tag} → "${choice || "first"}"`);
        return true;
      }
      console.error(`  skip ${tag} (no radio items)`);
      return false;
    }

    case "checkbox-group": {
      const clicked = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return false;
        const group = el.closest('.checkbox-group, [role="group"]') || el;
        const cb = group.querySelector('input[type="checkbox"]') || group.querySelector('[role="checkbox"]');
        if (cb) { (cb as HTMLElement).click(); return true; }
        return false;
      }, field.id);
      console.error(clicked ? `  check ${tag} → first` : `  skip ${tag}`);
      return clicked;
    }

    case "checkbox": {
      const val = getAnswer(answers, field);
      if (val === "false" || val === "unchecked") {
        console.error(`  check ${tag} → skip (answer=unchecked)`);
        return true;
      }
      try {
        await page.click(sel, { timeout: 2000 });
        console.error(`  check ${tag}`);
        return true;
      } catch {
        const clicked = await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          if (!el) return false;
          const label = el.closest("label") || el;
          (label as HTMLElement).click();
          return true;
        }, field.id);
        console.error(clicked ? `  check ${tag}` : `  skip ${tag}`);
        return clicked;
      }
    }

    case "toggle": {
      const val = getAnswer(answers, field);
      if (val === "off" || val === "false") {
        console.error(`  toggle ${tag} → skip (answer=off)`);
        return true;
      }
      await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`) as any;
        if (el) el.click();
      }, field.id);
      console.error(`  toggle ${tag} → on`);
      return true;
    }

    case "file": {
      const filePath = getAnswer(answers, field)
        ? path.resolve(getAnswer(answers, field)!)
        : RESUME_PATH;
      try {
        await page.setInputFiles(sel, filePath, { timeout: 2000 });
        console.error(`  upload ${tag} → ${path.basename(filePath)}`);
        return true;
      } catch {
        console.error(`  skip ${tag} (file input failed)`);
        return false;
      }
    }

    default:
      console.error(`  skip ${tag} (unhandled type: ${field.type})`);
      return false;
  }
}

// ── Multi-page navigation ────────────────────────────────────

const MAX_PAGES = 20;

interface NavigationState {
  hasNextButton: boolean;
  hasSubmitButton: boolean;
  nextButtonSelector: string | null;
}

async function detectNavigationButtons(page: Page): Promise<NavigationState> {
  return page.evaluate(() => {
    // Clear stale nav markers from previous pages
    document.querySelectorAll('[data-ff-nav]').forEach(el => el.removeAttribute('data-ff-nav'));

    const NEXT_RE = /^(next|continue|proceed|save and continue|save & continue)/i;
    const NEXT_PREFIX_RE = /^next:/i;
    const SUBMIT_RE = /^(submit|apply|apply now|send application|submit application)/i;
    const SUBMIT_INCLUDES_RE = /submit|apply now|send application/i;

    const buttons = Array.from(document.querySelectorAll<HTMLElement>(
      'button, [role="button"], input[type="submit"], a.btn, a[class*="btn"]'
    ));

    let hasNextButton = false;
    let hasSubmitButton = false;
    let nextButtonSelector: string | null = null;

    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(btn);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const text = (btn.textContent || (btn as HTMLInputElement).value || "").trim();

      // Check submit first
      if (btn.getAttribute("type") === "submit" || SUBMIT_RE.test(text) || SUBMIT_INCLUDES_RE.test(text)) {
        hasSubmitButton = true;
        continue;
      }

      // Check next
      if (NEXT_RE.test(text) || NEXT_PREFIX_RE.test(text)) {
        hasNextButton = true;
        btn.setAttribute("data-ff-nav", "next");
        nextButtonSelector = '[data-ff-nav="next"]';
      }
    }

    return { hasNextButton, hasSubmitButton, nextButtonSelector };
  });
}

async function waitForPageTransition(page: Page, urlBefore: string): Promise<"same_page" | "new_page" | "new_url"> {
  await page.waitForTimeout(500);
  const urlAfter = page.url();

  if (urlAfter !== urlBefore) {
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    return "new_url";
  }

  await page.waitForTimeout(300);
  return "new_page"; // assume in-page JS navigation worked
}

async function isMultiPageForm(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sections = document.querySelectorAll(
      ".form-section, .form-step, [data-section], .step-content"
    );
    if (sections.length <= 1) return false;

    let hiddenCount = 0;
    for (const s of sections) {
      const style = window.getComputedStyle(s as HTMLElement);
      if (style.display === "none" || s.getAttribute("aria-hidden") === "true") {
        hiddenCount++;
      }
    }
    return hiddenCount >= 1;
  });
}

// ── Fill current page ────────────────────────────────────────

async function fillCurrentPage(page: Page, existingAnswers: AnswerMap = {}): Promise<AnswerMap> {
  // Re-inject helpers if page navigated to a new URL
  const hasHelpers = await page.evaluate(() => !!(window as any).__ff).catch(() => false);
  if (!hasHelpers) {
    await injectHelpers(page);
  }

  console.error("Extracting form fields…");
  const allFields = await extractFields(page);
  const visibleFields = allFields.filter((f) => f.visibleByDefault);
  console.error(`Found ${visibleFields.length} visible fields.`);

  if (visibleFields.length === 0) {
    console.error("No visible fields on this page.");
    return existingAnswers;
  }

  // Discover dropdown options (only for visible fields — skip hidden conditionals)
  console.error("Discovering dropdown options…");
  await discoverDropdownOptions(page, visibleFields);

  // Only ask LLM about visible, named fields it hasn't answered yet
  const unanswered = visibleFields.filter(
    (f) => f.name && getAnswer(existingAnswers, f) === undefined && f.type !== "file"
  );

  const answers = { ...existingAnswers };
  if (unanswered.length > 0) {
    console.error(`\nAsking LLM for ${unanswered.length} new fields…\n`);
    const newAnswers = await generateAnswers(unanswered);
    Object.assign(answers, newAnswers);
    console.error(`LLM provided ${Object.keys(newAnswers).length} answers.\n`);
  } else {
    console.error("All fields already answered from previous pages.\n");
  }

  // Iterative fill loop
  const filled = new Set<string>();
  let round = 0;

  while (round < 10) {
    round++;
    const fields = await extractFields(page);
    const visible = fields.filter((f) => f.visibleByDefault && f.name);
    const toFill = visible.filter((f) => !filled.has(f.id));
    if (toFill.length === 0) break;

    const unseen = toFill.filter(
      (f) => getAnswer(answers, f) === undefined && f.type !== "file"
    );
    if (unseen.length > 0 && round > 1) {
      console.error(`\n${unseen.length} new fields discovered — asking LLM…`);
      const extra = await generateAnswers(unseen);
      Object.assign(answers, extra);
    }

    console.error(`\nRound ${round}: ${toFill.length} new fields to fill…`);
    for (const field of toFill) {
      filled.add(field.id);
      await fillField(page, field, answers);
    }
    await page.waitForTimeout(400);
  }

  console.error(`\nPage fill complete. ${filled.size} fields in ${round} round(s).`);
  return answers;
}

// ── Multi-page orchestration ─────────────────────────────────

async function fillMultiPageForm(page: Page): Promise<void> {
  let answers: AnswerMap = {};
  let pageNum = 0;

  while (pageNum < MAX_PAGES) {
    pageNum++;
    console.error(`\n${"=".repeat(60)}`);
    console.error(`PAGE ${pageNum}`);
    console.error(`${"=".repeat(60)}\n`);

    answers = await fillCurrentPage(page, answers);

    const navState = await detectNavigationButtons(page);

    if (navState.hasSubmitButton && !navState.hasNextButton) {
      console.error(`\n${"=".repeat(60)}`);
      console.error("FINAL PAGE — Submit button detected.");
      console.error("NOT clicking Submit. Review and submit manually.");
      console.error(`${"=".repeat(60)}\n`);
      console.error(`Done! Processed ${pageNum} page(s).`);
      return;
    }

    if (navState.hasNextButton && navState.nextButtonSelector) {
      const urlBefore = page.url();
      try {
        // Try Playwright click first, fall back to JS .click() if it fails
        try {
          await page.click(navState.nextButtonSelector, { timeout: 3000 });
        } catch {
          // Playwright click failed (overlay, scroll, etc.) — force via JS
          const clicked = await page.evaluate((sel) => {
            const btn = document.querySelector<HTMLElement>(sel);
            if (!btn) return false;
            btn.click();
            return true;
          }, navState.nextButtonSelector);
          if (!clicked) throw new Error("Button not found");
        }
        console.error("\n  Clicked Next button.");
      } catch {
        console.error("\n  Could not click Next button. Stopping.");
        return;
      }

      const transition = await waitForPageTransition(page, urlBefore);
      console.error(`  Page transition: ${transition}`);

      if (transition === "new_url") {
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      }
      continue;
    }

    // No navigation buttons — form is done or single-page
    console.error("\nNo navigation buttons found. Form may be complete.");
    console.error(`Done! Processed ${pageNum} page(s).`);
    return;
  }

  console.error(`Reached max page limit (${MAX_PAGES}). Stopping.`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const input = process.argv[2] || path.join(__dirname, "index.html");
  const url = resolveUrl(input);
  console.error(`Loading: ${url}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  // Wait for form fields to render (Workday/React SPAs need extra time)
  await page.waitForSelector(
    'input, select, textarea, [role="textbox"], [role="combobox"], [data-uxi-widget-type]',
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(1000); // Extra settle for React hydration
  await injectHelpers(page);

  const multiPage = await isMultiPageForm(page);
  console.error(`Form type: ${multiPage ? "multi-page" : "single-page"}\n`);

  if (multiPage) {
    await fillMultiPageForm(page);
  } else {
    // Single-page: reveal all accordion/tab sections
    await page.evaluate(() => {
      document
        .querySelectorAll(
          '[data-section], .form-section, .form-step, .step-content, ' +
            '.tab-pane, .accordion-content, .panel-body, [role="tabpanel"]'
        )
        .forEach((el: any) => {
          el.style.display = "";
          el.classList.add("active");
          el.removeAttribute("hidden");
          el.setAttribute("aria-hidden", "false");
        });
    });

    await fillCurrentPage(page);
  }

  console.error("\nDone! Browser left open for inspection. Close the tab or press Ctrl+C to exit.");

  // Exit when the user closes the page/tab or after 5 minutes
  await Promise.race([
    page.waitForEvent("close").catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 300_000)),
  ]);
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
