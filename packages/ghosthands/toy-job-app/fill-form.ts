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

/** Look up an answer for a field, case-insensitive on field name. */
function getAnswer(answers: AnswerMap, field: FormField): string | undefined {
  // Try exact match first
  if (field.name in answers) return answers[field.name];
  // Case-insensitive match
  const lower = field.name.toLowerCase();
  for (const [key, val] of Object.entries(answers)) {
    if (key.toLowerCase() === lower) return val;
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

/** Open each custom dropdown briefly to discover its options at fill-time. */
async function discoverDropdownOptions(page: Page, fields: FormField[]): Promise<void> {
  for (const f of fields) {
    if (f.type !== "select" || f.isNative || (f.options && f.options.length > 0)) continue;

    try {
      await clickComboboxTrigger(page, f.id);
      await page.waitForTimeout(300);

      const options = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return [];
        const results: string[] = [];

        function collect(container: Element) {
          const opts = container.querySelectorAll('[role="option"], [role="menuitem"], li');
          for (const o of opts) {
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
        return results;
      }, f.id);

      if (options.length > 0) {
        f.options = options;
        console.error(`  discovered ${options.length} options for "${f.name}"`);
      }

      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
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
      // Skip combobox inputs — they look like text but are actually dropdown triggers
      const isCombobox = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        return el?.getAttribute("role") === "combobox";
      }, field.id);
      if (isCombobox) return false;

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

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const input = process.argv[2] || path.join(__dirname, "index.html");
  const url = resolveUrl(input);
  console.error(`Loading: ${url}\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await injectHelpers(page);

  // Reveal all multi-step/accordion sections
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

  // ── Extract fields and ask LLM for answers ─────────────────
  console.error("Extracting form fields…");
  const allFields = await extractFields(page);
  const visibleFields = allFields.filter((f) => f.visibleByDefault);
  console.error(`Found ${visibleFields.length} visible fields.`);

  // Open custom dropdowns briefly to discover their options
  console.error("Discovering dropdown options…");
  await discoverDropdownOptions(page, allFields);

  console.error("\nAsking LLM for answers…\n");

  // Send ALL fields (including hidden conditional ones) so the LLM can
  // answer them if they appear later
  const answers = await generateAnswers(allFields);
  console.error(`LLM provided ${Object.keys(answers).length} answers.\n`);

  // ── Iterative fill loop ───────────────────────────────────
  const filled = new Set<string>();
  let round = 0;

  while (round < 10) {
    round++;
    const fields = await extractFields(page);
    const visible = fields.filter((f) => f.visibleByDefault);

    // Find fields we haven't filled yet
    const toFill = visible.filter((f) => !filled.has(f.id));
    if (toFill.length === 0) break;

    // If new fields appeared that the LLM hasn't seen, ask again
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

    // Wait for conditional logic to react
    await page.waitForTimeout(400);
  }

  console.error(`\nDone! Filled ${filled.size} fields in ${round} round(s).`);
  console.error("Browser left open for inspection. Press Ctrl+C to close.");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
