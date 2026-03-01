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
 *   npx tsx toy-job-app/fill-form.ts [url-or-file]
 *   npx tsx toy-job-app/fill-form.ts --user-id=<uuid> [--url=<url>]
 *
 * Flags:
 *   --user-id=<uuid>  Load profile from VALET's parsed resume in Supabase
 *   --url=<url>       Override the target URL (default: local index.html)
 */

import type { Page } from "playwright";
import { startBrowserAgent, type BrowserAgent } from "magnitude-core";
import * as path from "path";
import * as fs from "fs";
import Anthropic from "@anthropic-ai/sdk";

// Load .env from packages/ghosthands/
process.loadEnvFile(path.resolve(__dirname, "..", ".env"));

// ── Log file setup ──────────────────────────────────────────
// If GH_LOG_FILE=true in .env, mirror all console.error output to a timestamped log file
let logStream: fs.WriteStream | null = null;
if (process.env.GH_LOG_FILE === "true") {
  const logsDir = path.resolve(__dirname, "..", "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logPath = path.join(logsDir, `fill-form-${timestamp}.txt`);
  logStream = fs.createWriteStream(logPath, { flags: "a" });
  const origError = console.error.bind(console);
  console.error = (...args: any[]) => {
    origError(...args);
    logStream!.write(args.map(String).join(" ") + "\n");
  };
  console.error(`Logging to: ${logPath}`);
}

import { createClient } from "@supabase/supabase-js";
import { ResumeProfileLoader } from "../src/db/resumeProfileLoader";
import { ResumeDownloader } from "../src/workers/resumeDownloader";
import type { WorkdayUserProfile } from "../src/workers/taskHandlers/workday/workdayTypes";

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

let RESUME_PATH = path.resolve(__dirname, "..", "resumeTemp.pdf");

// ── CLI arg parsing (matches staging apply-workday.ts) ──────

function parseArg(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) return null;
  const value = arg.split("=").slice(1).join("=");
  return value || null;
}

// ── Profile text builder ────────────────────────────────────

/** Convert a WorkdayUserProfile into a human-readable profile string for LLM prompts. */
function buildProfileText(p: WorkdayUserProfile): string {
  const lines: string[] = [];

  lines.push(`Name: ${p.first_name} ${p.last_name}`);
  lines.push(`Email: ${p.email}`);
  if (p.phone) lines.push(`Phone: ${p.phone}`);
  if (p.address?.city || p.address?.state) {
    const loc = [p.address.city, p.address.state].filter(Boolean).join(", ");
    if (p.address.zip) lines.push(`Location: ${loc} ${p.address.zip}`);
    else lines.push(`Location: ${loc}`);
  }
  if (p.linkedin_url) lines.push(`LinkedIn: ${p.linkedin_url}`);
  if (p.website_url) lines.push(`Portfolio: ${p.website_url}`);

  // Work experience
  if (p.experience?.length) {
    lines.push("");
    const current = p.experience.find((e) => e.currently_work_here);
    if (current) {
      lines.push(`Current Role: ${current.title} at ${current.company}`);
    }
    for (const job of p.experience) {
      if (job === current) continue;
      const dates = [job.start_date, job.end_date].filter(Boolean).join(" – ");
      lines.push(`Previous: ${job.title} at ${job.company}${dates ? ` (${dates})` : ""}`);
    }
  }

  // Education
  if (p.education?.length) {
    lines.push("");
    for (const edu of p.education) {
      let edLine = `Education: ${edu.degree}`;
      if (edu.field_of_study) edLine += ` in ${edu.field_of_study}`;
      edLine += `, ${edu.school}`;
      if (edu.end_date) edLine += `, ${edu.end_date}`;
      if (edu.gpa) edLine += ` (GPA: ${edu.gpa})`;
      lines.push(edLine);
    }
  }

  // Skills
  if (p.skills?.length) {
    lines.push("");
    lines.push(`Skills: ${p.skills.join(", ")}`);
  }

  // Legal/compliance
  lines.push("");
  lines.push(`Work authorization: ${p.work_authorization || "Yes"}`);
  lines.push(`Visa sponsorship needed: ${p.visa_sponsorship || "No"}`);

  // Demographics
  lines.push("");
  lines.push("Demographics:");
  if (p.gender) lines.push(`Gender: ${p.gender}`);
  if (p.race_ethnicity) lines.push(`Race/Ethnicity: ${p.race_ethnicity}`);
  if (p.veteran_status) lines.push(`Veteran status: ${p.veteran_status}`);
  if (p.disability_status) lines.push(`Disability: ${p.disability_status}`);

  return lines.join("\n");
}

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
    case "textarea":
      return "I am excited about this opportunity and believe my skills and experience make me a strong candidate for this position.";
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

        const collect = (container: Element) => {
          const opts = container.querySelectorAll('[role="option"], [role="menuitem"], li');
          for (const o of opts) {
            const t = o.textContent?.trim();
            if (t && t.length < 200) results.push(t);
          }
        };

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

/** Usage stats returned alongside answers from generateAnswers(). */
interface GenerateResult {
  answers: AnswerMap;
  inputTokens: number;
  outputTokens: number;
}

async function generateAnswers(fields: FormField[], profileText: string): Promise<GenerateResult> {
  const client = new Anthropic();

  // Build a compact description of each field for the prompt
  const fieldDescriptions = fields.map((f) => {
    let desc = `- "${f.name}" (type: ${f.type}`;
    if ((f as any).isMultiSelect) desc += `, multi-select`;
    desc += `)`;
    if (f.options?.length) desc += ` options: [${f.options.join(", ")}]`;
    if (f.choices?.length) desc += ` choices: [${f.choices.join(", ")}]`;
    if (f.section) desc += ` [section: ${f.section}]`;
    return desc;
  }).join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{
      role: "user",
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

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  if (response.stop_reason === "max_tokens") {
    console.error("\nWARNING: LLM response was truncated (hit max_tokens limit). Some fields may be missing answers.\n");
  }
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
    return { answers: parsed, inputTokens, outputTokens };
  } catch (e) {
    console.error("Failed to parse LLM response as JSON, using empty answers");
    return { answers: {}, inputTokens, outputTokens };
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
        // page.fill() can be unreliable for HTML5 date inputs — set value directly
        try {
          await page.evaluate(({ sel, val }) => {
            const el = document.querySelector(sel) as HTMLInputElement;
            if (!el) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, { sel, val });
          console.error(`  fill ${tag} = "${val}" (direct)`);
          return true;
        } catch {
          console.error(`  skip ${tag} (not fillable)`);
          return false;
        }
      }
    }

    case "textarea": {
      const val = getAnswer(answers, field) ?? defaultValue(field);
      try {
        await page.fill(sel, val, { timeout: 2000 });
        console.error(`  fill ${tag} = "${val.slice(0, 80)}${val.length > 80 ? "…" : ""}"`);
        return true;
      } catch {
        // page.fill() fails on contenteditable divs — set innerHTML directly
        try {
          await page.evaluate(({ sel, val }) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) return;
            el.textContent = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }, { sel, val });
          console.error(`  fill ${tag} = "${val.slice(0, 80)}${val.length > 80 ? "…" : ""}" (contenteditable)`);
          return true;
        } catch {
          console.error(`  skip ${tag} (not fillable)`);
          return false;
        }
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

      // Multi-select: click multiple options
      if ((field as any).isMultiSelect && answer) {
        const valuesToSelect = answer.split(",").map((v: string) => v.trim()).filter(Boolean);
        try {
          await clickComboboxTrigger(page, field.id);
          await page.waitForTimeout(200);
          const clickedCount = await page.evaluate(
            ({ ffId, values }) => {
              const el = document.querySelector(`[data-ff-id="${ffId}"]`);
              if (!el) return 0;
              let count = 0;
              // Find all options in the dropdown
              const allOpts = el.querySelectorAll('[role="option"], .multi-select-option');
              for (const val of values) {
                const lowerVal = val.toLowerCase();
                for (const opt of allOpts) {
                  const optText = opt.textContent?.trim().toLowerCase() || "";
                  if (optText === lowerVal || optText.includes(lowerVal) || lowerVal.includes(optText)) {
                    if (opt.getAttribute("aria-selected") !== "true") {
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
          console.error(`  multi-select ${tag} → ${clickedCount}/${valuesToSelect.length} [${valuesToSelect.join(", ")}]`);
          // Close the dropdown after selecting
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
          return clickedCount > 0;
        } catch (e: any) {
          console.error(`  skip ${tag} (multi-select failed: ${e.message?.slice(0, 50)})`);
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
            const tryClick = (container: Element): boolean => {
              const opts = container.querySelectorAll('[role="option"], [role="menuitem"]');
              for (const o of opts) {
                if (ff.isVisible(o)) {
                  (o as HTMLElement).click();
                  return true;
                }
              }
              return false;
            };
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

            const getOptionText = (o: Element): string => {
              const clone = o.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('[class*="desc"], [class*="sub"], .option-desc, small')
                .forEach((x: any) => x.remove());
              return clone.textContent?.trim() || "";
            };

            const findAndClick = (container: Element): boolean => {
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
            };

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
  // ── Parse CLI args ──────────────────────────────────────────
  const userId = parseArg("user-id");
  const urlArg = parseArg("url");
  // Positional arg (first non-flag) as URL fallback
  const positionalArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const input = urlArg || positionalArg || path.join(__dirname, "index.html");
  const url = resolveUrl(input);
  console.error(`Loading: ${url}\n`);

  // ── Load user profile ───────────────────────────────────────
  let profileText = SAMPLE_PROFILE;

  if (userId) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.error("Error: SUPABASE_URL and SUPABASE_SECRET_KEY must be set when using --user-id");
      process.exit(1);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const loader = new ResumeProfileLoader(supabase);

    console.error(`Loading resume profile for user ${userId}…`);
    let result;
    try {
      result = await loader.loadForUser(userId);
    } catch (err) {
      console.error(`Failed to load resume profile: ${err instanceof Error ? err.message : err}`);
      console.error("Ensure a resume has been uploaded and parsed in VALET.");
      process.exit(1);
    }

    const { profile, fileKey, resumeId, parsingConfidence } = result;
    profileText = buildProfileText(profile);

    console.error(`Resume loaded successfully:`);
    console.error(`   Resume ID:    ${resumeId}`);
    console.error(`   Name:         ${profile.first_name} ${profile.last_name}`);
    console.error(`   Email:        ${profile.email}`);
    console.error(`   Education:    ${profile.education.length} entries`);
    console.error(`   Experience:   ${profile.experience.length} entries`);
    console.error(`   Skills:       ${profile.skills.length} skills`);
    console.error(`   Resume file:  ${fileKey || "(none)"}`);
    console.error(`   Confidence:   ${parsingConfidence != null ? `${(parsingConfidence * 100).toFixed(0)}%` : "N/A"}`);

    // Download the resume file from Supabase Storage
    if (fileKey) {
      try {
        const downloader = new ResumeDownloader(supabase);
        RESUME_PATH = await downloader.download({ storage_path: fileKey }, "toy-fill-form");
        console.error(`   Downloaded:   ${RESUME_PATH}`);
      } catch (err) {
        console.error(`   Resume download failed: ${err instanceof Error ? err.message : err}`);
        console.error("   Falling back to local resumeTemp.pdf");
      }
    }

    console.error("");
  } else {
    console.error("No --user-id provided — using built-in sample profile (Alexander Chen).\n");
  }

  // ── Cost tracking ───────────────────────────────────────────
  // Claude Haiku 4.5 pricing: $1.00/M input, $5.00/M output
  const HAIKU_INPUT_COST_PER_TOKEN = 1.00 / 1_000_000;
  const HAIKU_OUTPUT_COST_PER_TOKEN = 5.00 / 1_000_000;

  const cost = {
    // Anthropic SDK (generateAnswers) totals
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmCalls: 0,
    // Magnitude agent.act() totals
    actInputTokens: 0,
    actOutputTokens: 0,
    actInputCost: 0,
    actOutputCost: 0,
    actCalls: 0,
  };

  // Launch Magnitude agent — gives us a Playwright Page for DOM filling
  // AND agent.act() for real visual agent fallback (blue cursor).
  console.error("Starting Magnitude browser agent…");
  const agent = await startBrowserAgent({
    url,
    llm: {
      provider: "anthropic" as any,
      options: {
        model: "claude-haiku-4-5-20251001",
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
    },
    narrate: false,
  });

  // Wire up Magnitude cost tracking — accumulate every tokensUsed event
  agent.events.on('tokensUsed', (usage: any) => {
    cost.actInputTokens += usage.inputTokens ?? 0;
    cost.actOutputTokens += usage.outputTokens ?? 0;
    cost.actInputCost += usage.inputCost ?? (usage.inputTokens ?? 0) * HAIKU_INPUT_COST_PER_TOKEN;
    cost.actOutputCost += usage.outputCost ?? (usage.outputTokens ?? 0) * HAIKU_OUTPUT_COST_PER_TOKEN;
  });

  const page = agent.page;
  await page.waitForLoadState("networkidle");
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
  const genResult = await generateAnswers(allFields, profileText);
  const answers = genResult.answers;
  cost.llmCalls++;
  cost.llmInputTokens += genResult.inputTokens;
  cost.llmOutputTokens += genResult.outputTokens;
  console.error(`LLM provided ${Object.keys(answers).length} answers.\n`);

  // ── Iterative fill loop ───────────────────────────────────
  const attempted = new Set<string>();
  const domFilledOk = new Set<string>(); // fields DOMhand successfully filled
  let round = 0;

  while (round < 10) {
    round++;
    const fields = await extractFields(page);
    const visible = fields.filter((f) => f.visibleByDefault);

    // Find fields we haven't attempted yet
    const toFill = visible.filter((f) => !attempted.has(f.id));
    if (toFill.length === 0) break;

    // If new fields appeared that the LLM hasn't seen, ask again
    const unseen = toFill.filter(
      (f) => getAnswer(answers, f) === undefined && f.type !== "file"
    );
    if (unseen.length > 0 && round > 1) {
      console.error(`\n${unseen.length} new fields discovered — asking LLM…`);
      const extraResult = await generateAnswers(unseen, profileText);
      Object.assign(answers, extraResult.answers);
      cost.llmCalls++;
      cost.llmInputTokens += extraResult.inputTokens;
      cost.llmOutputTokens += extraResult.outputTokens;
    }

    console.error(`\nRound ${round}: ${toFill.length} new fields to fill…`);

    for (const field of toFill) {
      attempted.add(field.id);
      const ok = await fillField(page, field, answers);
      if (ok) domFilledOk.add(field.id);
    }

    // Wait for conditional logic to react
    await page.waitForTimeout(400);
  }

  console.error(`\nDone! Filled ${domFilledOk.size}/${attempted.size} fields in ${round} round(s).`);

  // ── MagnitudeHand Fallback (real Magnitude visual agent) ────
  // Re-extract fields and identify truly unfilled ones. Then use Magnitude's
  // agent.act() with micro-scoped prompts — this shows the real blue cursor
  // and does autonomous screenshot-based interaction for each field.
  {
    await page.waitForTimeout(500); // let conditional UI settle
    const postFields = await extractFields(page);
    const postVisible = postFields.filter((f) => f.visibleByDefault);

    // Robust unfilled detection — handles radio, checkbox, range, contenteditable
    // Skip fields that DOMhand already filled successfully (trust its return value)
    const unfilledFields: FormField[] = [];
    for (const f of postVisible) {
      if (domFilledOk.has(f.id)) continue; // DOMhand succeeded — no need for Magnitude

      const isFilled = await page.evaluate((ffId) => {
        const el = document.querySelector(`[data-ff-id="${ffId}"]`);
        if (!el) return true; // element gone → skip
        const tag = el.tagName;
        const type = (el as HTMLInputElement).type || "";
        const role = el.getAttribute("role") || "";

        // Radio groups: check if any radio in the group is checked
        if (type === "radio") {
          const name = (el as HTMLInputElement).name;
          if (name) {
            const form = el.closest("form") || document;
            const checked = form.querySelector(`input[type="radio"][name="${name}"]:checked`);
            return !!checked;
          }
          return (el as HTMLInputElement).checked;
        }
        if (role === "radiogroup") {
          return !!el.querySelector('input[type="radio"]:checked');
        }

        // Toggle switches (role="switch" on label — data-ff-id is on the label, not the hidden checkbox)
        if (role === "switch") {
          // Check the inner checkbox's checked state
          const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
          if (cb) return true; // toggle exists and has a state — consider filled
          // Fallback: check aria-checked
          return el.getAttribute("aria-checked") === "true";
        }

        // Checkboxes: always have a state, consider filled
        if (type === "checkbox") return true;

        // Range sliders: always have a default value, consider filled
        if (type === "range") return true;

        // File inputs: skip (handled separately)
        if (type === "file") return true;

        // Contenteditable rich text
        if (el.getAttribute("contenteditable") === "true") {
          const text = el.textContent?.trim() || "";
          return text.length > 0;
        }

        // Standard inputs and textareas
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const val = (el as HTMLInputElement).value?.trim() || "";
          return val.length > 0;
        }

        // Native selects
        if (tag === "SELECT") {
          const sel = el as HTMLSelectElement;
          const val = sel.value;
          // Check if a non-placeholder option is selected
          const selectedOpt = sel.options[sel.selectedIndex];
          if (!selectedOpt) return false;
          const text = selectedOpt.textContent?.trim() || "";
          return val !== "" && !/^(select|choose|pick|--|—)/i.test(text);
        }

        // Custom combobox (role="combobox" on a div)
        if (role === "combobox" && tag !== "INPUT" && tag !== "SELECT") {
          // Check trigger text
          const trigger = el.querySelector(".custom-select-trigger span");
          const text = trigger?.textContent?.trim() || "";
          if (text && !/^(select|choose|pick|--|—|start typing)/i.test(text)) return true;
          // Check for selected option
          const selected = el.querySelector(".custom-select-option.selected, [aria-selected='true']");
          return !!selected;
        }

        // Autocomplete/typeahead inputs (role="combobox" on INPUT)
        if (role === "combobox" && tag === "INPUT") {
          return ((el as HTMLInputElement).value?.trim() || "").length > 0;
        }

        // Other elements — check textContent
        const text = el.textContent?.trim() || "";
        return text.length > 0;
      }, f.id);

      if (!isFilled) {
        // If the LLM deliberately returned "" for this field, it's intentionally empty — skip
        const answer = getAnswer(answers, f);
        if (answer !== undefined && answer.trim() === "") {
          // LLM saw this field and chose to leave it empty (e.g., no portfolio URL)
          continue;
        }
        unfilledFields.push(f);
      }
    }

    if (unfilledFields.length > 0) {
      console.error(`\n[MagnitudeHand] ${unfilledFields.length} unfilled field(s) — using REAL Magnitude visual agent (blue cursor)…`);

      let filledCount = 0;

      for (const field of unfilledFields) {
        // Scroll field into view so Magnitude can see it in screenshots
        await page.evaluate((ffId) => {
          const el = document.querySelector(`[data-ff-id="${ffId}"]`);
          el?.scrollIntoView({ block: "center", behavior: "auto" });
        }, field.id);
        await page.waitForTimeout(300);

        // Build a micro-scoped prompt for this single field
        const answer = getAnswer(answers, field);
        let prompt = `You are filling out a job application for this person:\n${profileText.trim()}\n\n`;
        prompt += `Fill the form field labeled "${field.name}"`;
        if (answer) {
          prompt += ` with the value "${answer}"`;
        } else {
          prompt += ` using the applicant's profile above to choose the best value`;
        }

        // Add type-specific hints
        if (field.type === "select") {
          if (field.options?.length) {
            prompt += `. This is a dropdown with options: [${field.options.slice(0, 15).join(", ")}]. Click the dropdown to open it, then click the correct option. If the exact answer is not available, pick the closest matching option.`;
          } else {
            prompt += `. This is a dropdown — click it to open, then select the most appropriate option available.`;
          }
        } else if (field.type === "search" || field.type === "text") {
          const role = await page.evaluate((ffId) => {
            return document.querySelector(`[data-ff-id="${ffId}"]`)?.getAttribute("role") || "";
          }, field.id);
          if (role === "combobox") {
            prompt += `. This is an autocomplete/typeahead field. Type the value, wait for suggestions to appear, then click the matching suggestion from the dropdown.`;
          }
        } else if (field.type === "textarea") {
          prompt += `. This is a text area. Click on it and type the value.`;
        } else if (field.type === "range") {
          prompt += `. This is a slider. Drag it to the desired value.`;
        }

        prompt += ` Focus ONLY on this single field. Do NOT interact with any other fields or buttons.`;

        console.error(`[MagnitudeHand] act() → "${field.name}"…`);
        try {
          cost.actCalls++;
          await agent.act(prompt);
          console.error(`[MagnitudeHand] Filled "${field.name}" OK`);
          filledCount++;
        } catch (e: any) {
          console.error(`[MagnitudeHand] ERROR on "${field.name}": ${e.message?.slice(0, 120)}`);
        }

        // Brief pause between fields
        await page.waitForTimeout(200);
      }

      console.error(`\n[MagnitudeHand] Done! Filled ${filledCount}/${unfilledFields.length} field(s) via visual agent.`);
    } else {
      console.error("\n[MagnitudeHand] No unfilled fields — DOM filler handled everything.");
    }
  }

  // ── Cost Summary ──────────────────────────────────────────
  const llmCostUsd =
    cost.llmInputTokens * HAIKU_INPUT_COST_PER_TOKEN +
    cost.llmOutputTokens * HAIKU_OUTPUT_COST_PER_TOKEN;
  const actCostUsd = cost.actInputCost + cost.actOutputCost;
  const totalCostUsd = llmCostUsd + actCostUsd;

  console.error(`\n── Cost Summary ──────────────────────`);
  console.error(
    `LLM calls (generateAnswers):  ${cost.llmCalls} call(s), ` +
    `${cost.llmInputTokens} in / ${cost.llmOutputTokens} out tokens, ` +
    `$${llmCostUsd.toFixed(4)}`
  );
  console.error(
    `Magnitude act() calls:        ${cost.actCalls} call(s), ` +
    `${cost.actInputTokens} in / ${cost.actOutputTokens} out tokens, ` +
    `$${actCostUsd.toFixed(4)}`
  );
  console.error(
    `Total:                        $${totalCostUsd.toFixed(4)}`
  );
  console.error(`──────────────────────────────────────\n`);

  console.error("Browser left open for inspection. Press Ctrl+C to close.");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
