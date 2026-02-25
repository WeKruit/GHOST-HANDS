"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const zod = require("zod");
const path = require("node:path");
const fs = require("node:fs");
class DesktopAdapterShim {
  agent;
  constructor(agent) {
    this.agent = agent;
  }
  async act(instruction) {
    const start = Date.now();
    try {
      await this.agent.act(instruction);
      return { success: true, message: "ok", durationMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message, durationMs: Date.now() - start };
    }
  }
  async extract(instruction, schema) {
    return this.agent.extract(instruction, schema);
  }
  async getCurrentUrl() {
    return this.agent.page.url();
  }
  async navigate(url) {
    await this.agent.nav(url);
  }
  get page() {
    return this.agent.page;
  }
}
function mapDesktopProfileToWorkday(profile, resumePath) {
  return {
    // Personal
    first_name: profile.firstName,
    last_name: profile.lastName,
    email: profile.email,
    phone: profile.phone,
    phone_device_type: "Mobile",
    phone_country_code: "+1",
    address: {
      street: profile.address || "",
      city: profile.city || "",
      state: profile.state || "",
      zip: profile.zipCode || "",
      country: "United States"
    },
    // Professional links
    linkedin_url: profile.linkedIn || void 0,
    // Education
    education: profile.education.map((edu) => ({
      school: edu.school,
      degree: edu.degree,
      field_of_study: edu.field,
      start_date: String(edu.startYear),
      end_date: edu.endYear ? String(edu.endYear) : ""
    })),
    // Experience
    experience: profile.experience.map((exp) => ({
      company: exp.company,
      title: exp.title,
      currently_work_here: !exp.endDate,
      start_date: exp.startDate,
      end_date: exp.endDate || "",
      description: exp.description
    })),
    // Skills
    skills: [],
    // Resume
    resume_path: resumePath,
    // Legal/compliance
    work_authorization: "Yes",
    visa_sponsorship: "No",
    // Voluntary self-identification defaults
    gender: "Male",
    race_ethnicity: "Asian",
    veteran_status: "I am not a protected veteran",
    disability_status: "I do not wish to answer"
  };
}
const PHONE_2FA_TIMEOUT_MS = 18e4;
const PHONE_2FA_POLL_INTERVAL_MS = 5e3;
const PAGE_TRANSITION_WAIT_MS = 3e3;
const MAX_FORM_PAGES = 30;
const PageStateSchema = zod.z.object({
  page_type: zod.z.enum([
    "job_listing",
    "login",
    "google_signin",
    "verification_code",
    "phone_2fa",
    "account_creation",
    "personal_info",
    "experience",
    "resume_upload",
    "questions",
    "voluntary_disclosure",
    "self_identify",
    "review",
    "confirmation",
    "error",
    "unknown"
  ]),
  page_title: zod.z.string().optional().default("").catch(""),
  has_apply_button: zod.z.boolean().optional().default(false).catch(false),
  has_next_button: zod.z.boolean().optional().default(false).catch(false),
  has_submit_button: zod.z.boolean().optional().default(false).catch(false),
  has_sign_in_with_google: zod.z.boolean().optional().default(false).catch(false),
  error_message: zod.z.string().optional().default("").catch("")
});
const PREFIX = "[Workday]";
const logger = {
  debug(msg, meta) {
    console.debug(PREFIX, msg, meta ?? "");
  },
  info(msg, meta) {
    console.log(PREFIX, msg, meta ?? "");
  },
  warn(msg, meta) {
    console.warn(PREFIX, msg, meta ?? "");
  },
  error(msg, meta) {
    console.error(PREFIX, msg, meta ?? "");
  }
};
function getLogger() {
  return logger;
}
async function detectPage(adapter) {
  const currentUrl = await adapter.getCurrentUrl();
  if (currentUrl.includes("accounts.google.com")) {
    if (currentUrl.includes("/pwd") || currentUrl.includes("/identifier")) {
      return { page_type: "google_signin", page_title: "Google Sign-In (password)" };
    }
    if (currentUrl.includes("/challenge/")) {
      const challengeType = currentUrl.includes("recaptcha") ? "CAPTCHA" : currentUrl.includes("ipp") ? "Phone/SMS verification" : currentUrl.includes("dp") ? "Device prompt" : "Google challenge";
      return { page_type: "phone_2fa", page_title: `${challengeType} (manual solve required)` };
    }
    return { page_type: "google_signin", page_title: "Google Sign-In" };
  }
  const domSignals = await adapter.page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    const html = document.body.innerHTML.toLowerCase();
    return {
      hasSignInWithGoogle: bodyText.includes("sign in with google") || bodyText.includes("continue with google") || html.includes("google") && bodyText.includes("sign in"),
      hasSignIn: bodyText.includes("sign in") || bodyText.includes("log in"),
      hasApplyButton: bodyText.includes("apply") && !bodyText.includes("application questions"),
      hasSubmitApplication: bodyText.includes("submit application") || bodyText.includes("submit your application")
    };
  });
  if (domSignals.hasSignInWithGoogle || domSignals.hasSignIn && !domSignals.hasApplyButton && !domSignals.hasSubmitApplication) {
    getLogger().info("DOM detected sign-in page");
    return { page_type: "login", page_title: "Workday Sign-In", has_sign_in_with_google: domSignals.hasSignInWithGoogle };
  }
  try {
    const urlHints = [];
    if (currentUrl.includes("signin") || currentUrl.includes("login")) urlHints.push("This appears to be a login page.");
    if (currentUrl.includes("myworkdayjobs.com") && currentUrl.includes("/job/")) urlHints.push("This appears to be a Workday job listing.");
    const urlContext = urlHints.length > 0 ? `URL context: ${urlHints.join(" ")} ` : "";
    return await adapter.extract(
      `${urlContext}Analyze the current page and determine what type of page this is in a Workday job application process.

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
IMPORTANT: If a page has BOTH "Sign In" and "Create Account" options, classify as "login" (NOT "account_creation").`,
      PageStateSchema
    );
  } catch (error) {
    getLogger().warn("Page detection failed", { error: error instanceof Error ? error.message : String(error) });
    if (currentUrl.includes("myworkdayjobs.com") && (currentUrl.includes("login") || currentUrl.includes("signin"))) {
      return { page_type: "login", page_title: "Workday Login" };
    }
    const domFallback = await classifyPageFromDOM(adapter);
    if (domFallback !== "unknown") {
      getLogger().info("DOM fallback classified page", { pageType: domFallback });
    }
    return { page_type: domFallback, page_title: domFallback === "unknown" ? "N/A" : domFallback };
  }
}
async function classifyPageFromDOM(adapter) {
  return adapter.page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-automation-id*="pageHeader"]'));
    const headingText = headings.map((h) => h.textContent?.toLowerCase() || "").join(" ");
    const hasSelectOneDropdowns = Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").trim() === "Select One");
    const hasFormInputs = document.querySelectorAll('input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]').length > 0;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const buttonTexts = buttons.map((b) => (b.textContent || "").trim().toLowerCase());
    const hasSubmitButton = buttonTexts.some((t) => t === "submit" || t === "submit application");
    const hasSaveAndContinue = buttonTexts.some((t) => t.includes("save and continue"));
    if (!hasSelectOneDropdowns && !hasFormInputs && !hasSaveAndContinue && hasSubmitButton) return "review";
    if (headingText.includes("review") && !hasSelectOneDropdowns && !hasFormInputs) return "review";
    if (headingText.includes("application questions") || headingText.includes("additional questions")) return "questions";
    if (headingText.includes("voluntary disclosures") || headingText.includes("voluntary self")) return "voluntary_disclosure";
    if (headingText.includes("self identify") || headingText.includes("self-identify")) return "self_identify";
    if (headingText.includes("my experience") || headingText.includes("work experience")) return "experience";
    if (headingText.includes("my information") || headingText.includes("personal info")) return "personal_info";
    const bodyStart = bodyText.substring(0, 2e3);
    if (bodyStart.includes("application questions") || bodyStart.includes("additional questions")) return "questions";
    if (bodyStart.includes("voluntary disclosures")) return "voluntary_disclosure";
    if (bodyStart.includes("self identify") || bodyStart.includes("self-identify") || bodyStart.includes("disability status")) return "self_identify";
    if (bodyStart.includes("my experience") || bodyStart.includes("resume")) return "experience";
    if (bodyStart.includes("my information")) return "personal_info";
    return "unknown";
  });
}
async function isActuallyReview(adapter) {
  return adapter.page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
    const isReviewHeading = headings.some((h) => (h.textContent || "").toLowerCase().includes("review"));
    const buttons = Array.from(document.querySelectorAll("button"));
    const hasSubmit = buttons.some((b) => (b.textContent?.trim().toLowerCase() || "") === "submit");
    const hasSaveAndContinue = buttons.some((b) => (b.textContent?.trim().toLowerCase() || "").includes("save and continue"));
    const hasSelectOne = buttons.some((b) => (b.textContent?.trim() || "") === "Select One");
    const hasEditableInputs = document.querySelectorAll(
      'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
    ).length > 0;
    return isReviewHeading && hasSubmit && !hasSaveAndContinue && !hasSelectOne && !hasEditableInputs;
  });
}
async function fillDropdownsProgrammatically(adapter, fullQAMap) {
  const dropdownInfos = await adapter.page.evaluate(`
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

        // Strategy 4 (NEW): Find the nearest ancestor that acts as a "question container"
        // by walking up until we find one that has exactly one "Select One" button.
        // That ancestor's text content (minus the button text) is the question label.
        // This is the most reliable strategy for Application Questions pages where
        // each question is wrapped in a container div with nested sub-divs.
        if (!labelText) {
          var ancestor = btn.parentElement;
          for (var up = 0; up < 12 && ancestor; up++) {
            // Count how many "Select One" buttons are inside this ancestor
            var selectBtns = ancestor.querySelectorAll('button');
            var selectOneCount = 0;
            for (var sb = 0; sb < selectBtns.length; sb++) {
              if ((selectBtns[sb].textContent || '').trim() === 'Select One') selectOneCount++;
            }
            // If this ancestor contains exactly 1 "Select One" button (ours),
            // its text is likely the question + "Select One" + maybe "Required"
            if (selectOneCount === 1) {
              var fullText = (ancestor.textContent || '').trim();
              // Remove "Select One", "Required", asterisks
              var cleaned = fullText
                .replace(/Select One/g, '')
                .replace(/Required/gi, '')
                .replace(/[*]/g, '')
                .trim();
              // Only accept if there's meaningful question text remaining
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

        // Strategy 6: Look at all text in parent divs (up to 6 levels), skipping
        // any text that belongs to other dropdown buttons
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

        // Strategy 7: Relaxed container search — accept containers with 2-3 "Select One"
        // buttons and look at text that appears BEFORE this specific button in DOM order.
        // Also check for Workday's aria-describedby or aria-labelledby references.
        if (!labelText) {
          // Try aria-describedby / aria-labelledby on the button
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
          // Walk up further (up to 15 levels) and find any container with
          // meaningful text before this button
          var anc = btn.parentElement;
          for (var w = 0; w < 15 && anc; w++) {
            var ancText = (anc.textContent || '');
            // Must have substantial text beyond just button/boilerplate text
            var stripped = ancText
              .replace(/Select One/g, '')
              .replace(/Required/gi, '')
              .replace(/[*]/g, '')
              .trim();
            if (stripped.length > 15 && stripped.length < 2000) {
              // Extract just the first substantial sentence/question
              var sentences = stripped.split(/[.?!\\n]/).filter(function(s) { return s.trim().length > 10; });
              if (sentences.length > 0) {
                labelText = sentences[0].trim();
                break;
              }
            }
            anc = anc.parentElement;
          }
        }

        // Strategy 8: Positional — find text blocks geometrically ABOVE the button.
        // This catches cases where the question text is in a separate div/paragraph
        // that is NOT an ancestor of the dropdown button (e.g. Workday Application Questions).
        if (!labelText) {
          var btnRect = btn.getBoundingClientRect();
          var bestDist = 9999;
          var bestText = '';
          // Check all block-level text elements
          var textEls = document.querySelectorAll('p, div, span, label, h1, h2, h3, h4, h5, li');
          for (var te = 0; te < textEls.length; te++) {
            var tel = textEls[te];
            // Skip if it contains or is the button
            if (tel.contains(btn) || tel === btn) continue;
            // Skip if it's inside any dropdown
            if (tel.closest('[role="listbox"]')) continue;
            var telRect = tel.getBoundingClientRect();
            // Must be above or at the same level as the button (within 300px)
            if (telRect.bottom > btnRect.top) continue;
            var dist = btnRect.top - telRect.bottom;
            if (dist > 300) continue;
            var telText = (tel.textContent || '').trim();
            // Skip boilerplate
            if (!telText || telText.length < 10 || telText === 'Select One' || telText === 'Required') continue;
            // Skip if this element has children with more specific text (avoid grabbing huge parent text)
            if (tel.children.length > 5) continue;
            // Prefer the closest text block above the button
            if (dist < bestDist) {
              bestDist = dist;
              bestText = telText;
            }
          }
          if (bestText) {
            labelText = bestText;
          }
        }

        // Clean up: remove trailing asterisks, "Required", excess whitespace
        labelText = labelText
          .replace(/\\s*\\*\\s*/g, ' ')
          .replace(/\\s*Required\\s*/gi, '')
          .replace(/\\s+/g, ' ')
          .replace(/Select One/g, '')
          .trim();
        // Truncate very long labels (keep first 200 chars for matching)
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
  const logger2 = getLogger();
  logger2.debug("Found unfilled dropdowns", { count: dropdownInfos.length, dropdowns: dropdownInfos.map((i) => ({ index: i.index, label: i.label || "(empty)" })) });
  let filled = 0;
  for (const info of dropdownInfos) {
    const answer = findBestDropdownAnswer(info.label, fullQAMap);
    if (!answer) {
      logger2.debug("No answer matched for dropdown", { label: info.label });
      continue;
    }
    const btn = adapter.page.locator(`button[data-gh-dropdown-idx="${info.index}"]`);
    const stillUnfilled = await btn.textContent().catch(() => "");
    if (!stillUnfilled?.includes("Select One")) continue;
    logger2.debug("Programmatically filling dropdown", { label: info.label, answer });
    await btn.scrollIntoViewIfNeeded();
    await adapter.page.waitForTimeout(200);
    await btn.click();
    await adapter.page.waitForTimeout(600);
    let clicked = await clickDropdownOption(adapter, answer);
    if (!clicked) {
      await adapter.page.keyboard.press("Escape");
      await adapter.page.waitForTimeout(300);
      logger2.debug("Retrying dropdown with dispatchEvent", { label: info.label });
      await adapter.page.evaluate((idx) => {
        const el = document.querySelector(`button[data-gh-dropdown-idx="${idx}"]`);
        if (el) {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
      }, String(info.index));
      await adapter.page.waitForTimeout(600);
      clicked = await clickDropdownOption(adapter, answer);
    }
    if (clicked) {
      filled++;
      await adapter.page.waitForTimeout(500);
    } else {
      await adapter.page.keyboard.press("Escape");
      await adapter.page.waitForTimeout(300);
      logger2.warn("Dropdown option not found", { answer, label: info.label });
    }
  }
  await adapter.page.evaluate(() => {
    document.querySelectorAll("[data-gh-dropdown-idx]").forEach((el) => {
      el.removeAttribute("data-gh-dropdown-idx");
    });
  });
  return filled;
}
async function clickDropdownOption(adapter, targetAnswer) {
  await adapter.page.waitForSelector(
    '[role="listbox"], [role="option"], [data-automation-id*="promptOption"]',
    { timeout: 3e3 }
  ).catch(() => {
  });
  let searchText = targetAnswer;
  if (targetAnswer.includes("→")) {
    searchText = targetAnswer.split("→")[0].trim();
  }
  const directClick = await adapter.page.evaluate((target) => {
    const targetLower = target.toLowerCase();
    const options = document.querySelectorAll(
      '[role="option"], [role="listbox"] li, [data-automation-id*="promptOption"], [data-automation-id*="selectOption"]'
    );
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || "";
      if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
        opt.click();
        return true;
      }
    }
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || "";
      if (text.length > 2 && targetLower.includes(text)) {
        opt.click();
        return true;
      }
    }
    return false;
  }, searchText);
  if (directClick) return true;
  getLogger().debug("Dropdown: typing search text and pressing Enter", { searchText });
  await adapter.page.keyboard.type(searchText, { delay: 50 });
  await adapter.page.keyboard.press("Enter");
  await adapter.page.waitForTimeout(1e3);
  const typedMatch = await adapter.page.evaluate((target) => {
    const targetLower = target.toLowerCase();
    const options = document.querySelectorAll(
      '[role="option"], [role="listbox"] li, [data-automation-id*="promptOption"], [data-automation-id*="selectOption"]'
    );
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || "";
      if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
        opt.click();
        return true;
      }
    }
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || "";
      if (text.length > 2 && targetLower.includes(text)) {
        opt.click();
        return true;
      }
    }
    return false;
  }, searchText);
  if (typedMatch) return true;
  getLogger().debug("Dropdown option not found after search, using LLM to scroll", { searchText });
  const llmScrollPrompt = [
    `A dropdown menu is currently open on the page.`,
    `I need to find and select the option "${searchText}" (or the closest match).`,
    `The correct option is NOT currently visible in the dropdown list.`,
    `SCROLL through the dropdown options by clicking the dropdown's scrollbar or dragging it downward to reveal more options.`,
    `After scrolling, look for "${searchText}" and click on it when you find it.`,
    `If you reach the end of the list without finding an exact match, click the closest matching option.`,
    `Do NOT click outside the dropdown or close it — only scroll within it and select the correct option.`
  ].join("\n");
  try {
    await adapter.act(llmScrollPrompt);
    await adapter.page.waitForTimeout(500);
    const dropdownClosed = await adapter.page.evaluate(() => {
      const listbox = document.querySelector('[role="listbox"]');
      if (!listbox) return true;
      const rect = listbox.getBoundingClientRect();
      return rect.width === 0 || rect.height === 0;
    });
    if (dropdownClosed) {
      getLogger().debug("Dropdown LLM scroll+select succeeded");
      return true;
    }
  } catch (err) {
    getLogger().warn("Dropdown LLM scroll attempt failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return false;
}
async function fillDateFieldsProgrammatically(adapter) {
  const dateFields = await adapter.page.evaluate(`
    (() => {
      var results = [];
      // Workday date fields have input[placeholder*="MM"] or input[data-automation-id*="date"]
      var dateInputs = document.querySelectorAll(
        'input[placeholder*="MM"], input[data-automation-id*="dateSectionMonth"], input[aria-label*="Month"], input[aria-label*="date"]'
      );
      for (var i = 0; i < dateInputs.length; i++) {
        var inp = dateInputs[i];
        var rect = inp.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        // Check if the date field is empty (MM part hasn't been filled)
        if (inp.value && inp.value.trim() !== '' && inp.value !== 'MM') continue;
        // Tag it for Playwright locator
        inp.setAttribute('data-gh-date-idx', String(i));
        // Try to find the label text for this date field
        var label = '';
        var ancestor = inp.parentElement;
        for (var up = 0; up < 8 && ancestor; up++) {
          var labels = ancestor.querySelectorAll('label, [data-automation-id*="formLabel"]');
          for (var l = 0; l < labels.length; l++) {
            var t = (labels[l].textContent || '').trim();
            if (t && t.length > 3) { label = t; break; }
          }
          if (label) break;
          // Also check text content of ancestor if it's small enough
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
  `);
  if (dateFields.length === 0) return 0;
  const now = /* @__PURE__ */ new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const todayDigits = `${mm}${dd}${yyyy}`;
  let filled = 0;
  for (const field of dateFields) {
    const labelLower = field.label.toLowerCase();
    let dateValue = todayDigits;
    if (labelLower.includes("graduation") || labelLower.includes("expected")) {
      dateValue = "05012027";
    } else if (labelLower.includes("start")) {
      dateValue = "08012023";
    } else if (labelLower.includes("end")) {
      dateValue = "05012027";
    }
    getLogger().debug("Filling date field", { label: field.label || "date field", date: `${dateValue.substring(0, 2)}/${dateValue.substring(2, 4)}/${dateValue.substring(4)}` });
    const clicked = await adapter.page.evaluate((idx) => {
      const el = document.querySelector(`input[data-gh-date-idx="${idx}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.focus();
      el.click();
      return true;
    }, String(field.index));
    if (!clicked) {
      getLogger().warn("Could not find date input", { fieldIndex: field.index });
      continue;
    }
    await adapter.page.waitForTimeout(300);
    await adapter.page.keyboard.type(dateValue, { delay: 80 });
    await adapter.page.waitForTimeout(200);
    await adapter.page.keyboard.press("Tab");
    await adapter.page.waitForTimeout(200);
    filled++;
  }
  await adapter.page.evaluate(() => {
    document.querySelectorAll("[data-gh-date-idx]").forEach((el) => {
      el.removeAttribute("data-gh-date-idx");
    });
  });
  return filled;
}
async function checkRequiredCheckboxes(adapter) {
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
        // Check if this is a required/important checkbox
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
  `);
  if (checked > 0) {
    getLogger().debug("Checked required checkboxes", { count: checked });
  }
  return checked;
}
async function hasEmptyVisibleFields(adapter) {
  const result = await adapter.page.evaluate(() => {
    const emptyFields = [];
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
    );
    for (const input of inputs) {
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (input.disabled || input.readOnly) continue;
      if (input.type === "hidden") continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const placeholder = input.placeholder?.toUpperCase() || "";
      if (placeholder === "MM" || placeholder === "DD" || placeholder === "YYYY") continue;
      const inDropdown = input.closest('[role="listbox"], [role="combobox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]');
      if (inDropdown) continue;
      if (rect.width < 20 || rect.height < 10) continue;
      if (input.getAttribute("aria-hidden") === "true") continue;
      const style = window.getComputedStyle(input);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const automationId = input.getAttribute("data-automation-id") || "";
      const fieldName = input.name || input.id || "";
      const fieldLabel = input.getAttribute("aria-label") || "";
      const fieldIdentifier = (automationId + " " + fieldName + " " + fieldLabel).toLowerCase();
      if (fieldIdentifier.includes("extension") || fieldIdentifier.includes("countryphone") || fieldIdentifier.includes("country-phone") || fieldIdentifier.includes("phonecode") || fieldIdentifier.includes("middlename") || fieldIdentifier.includes("middle-name") || fieldIdentifier.includes("middle name")) continue;
      if (!input.value || input.value.trim() === "") {
        const label = input.getAttribute("aria-label") || input.getAttribute("data-automation-id") || input.name || input.id || `${input.tagName}[${input.type || "text"}]`;
        emptyFields.push(label);
      }
    }
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = btn.textContent?.trim();
      if (text !== "Select One") continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      emptyFields.push(`dropdown:"Select One"`);
    }
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (cb.checked) continue;
      const rect = cb.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const parent = cb.closest("div, label, fieldset");
      const parentText = (parent?.textContent || "").toLowerCase();
      if (parentText.includes("acknowledge") || parentText.includes("terms") || parentText.includes("agree") || parentText.includes("privacy") || parentText.includes("required") || parentText.includes("*")) {
        emptyFields.push(`checkbox:"${parentText.substring(0, 60)}..."`);
      }
    }
    const radioGroups = /* @__PURE__ */ new Set();
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      if (r.name) radioGroups.add(r.name);
    });
    for (const groupName of radioGroups) {
      const radios = document.querySelectorAll(`input[type="radio"][name="${groupName}"]`);
      const anyChecked = Array.from(radios).some((r) => r.checked);
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
    getLogger().debug("Found empty visible fields", { count: result.length, fields: result });
    return true;
  }
  return false;
}
async function centerNextEmptyField(adapter) {
  const centered = await adapter.page.evaluate(`
    (() => {
      var vh = window.innerHeight;

      // 1. Empty text inputs / textareas
      var inputs = document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea'
      );
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.disabled || inp.readOnly) continue;
        if (inp.type === 'hidden') continue;
        var rect = inp.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Only consider fields in or near the current viewport
        if (!(rect.bottom > 0 && rect.top < vh * 1.2)) continue;
        // Skip date segment inputs
        var ph = (inp.placeholder || '').toUpperCase();
        if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
        // Skip internal dropdown inputs
        if (inp.closest('[role="listbox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]')) continue;
        // Skip hidden via CSS
        var style = window.getComputedStyle(inp);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (inp.getAttribute('aria-hidden') === 'true') continue;
        // Skip optional internal fields
        var ident = ((inp.getAttribute('data-automation-id') || '') + ' ' + (inp.name || '') + ' ' + (inp.getAttribute('aria-label') || '')).toLowerCase();
        if (ident.includes('extension') || ident.includes('countryphone') || ident.includes('phonecode') || ident.includes('middlename') || ident.includes('middle name') || ident.includes('middle-name')) continue;

        if (!inp.value || inp.value.trim() === '') {
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      // 2. Unfilled dropdowns ("Select One" buttons)
      var buttons = document.querySelectorAll('button');
      for (var j = 0; j < buttons.length; j++) {
        var btn = buttons[j];
        var text = (btn.textContent || '').trim();
        if (text !== 'Select One') continue;
        var bRect = btn.getBoundingClientRect();
        if (bRect.width === 0 || bRect.height === 0) continue;
        if (!(bRect.bottom > 0 && bRect.top < vh * 1.2)) continue;
        var bStyle = window.getComputedStyle(btn);
        if (bStyle.display === 'none' || bStyle.visibility === 'hidden') continue;
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }

      // 3. Unchecked required checkboxes
      var checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
      for (var k = 0; k < checkboxes.length; k++) {
        var cb = checkboxes[k];
        var cRect = cb.getBoundingClientRect();
        if (cRect.width === 0 && cRect.height === 0) continue;
        if (!(cRect.bottom > 0 && cRect.top < vh * 1.2)) continue;
        var parent = cb.closest('div, label, fieldset');
        var parentText = (parent ? parent.textContent : '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('required') || parentText.includes('*')) {
          cb.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      return false;
    })()
  `);
  if (centered) {
    await adapter.page.waitForTimeout(300);
  }
  return centered;
}
function findBestDropdownAnswer(label, qaMap) {
  if (!label) return null;
  const labelLower = label.toLowerCase().replace(/\*/g, "").trim();
  if (labelLower.length < 2) return null;
  for (const [q, a] of Object.entries(qaMap)) {
    if (q.toLowerCase() === labelLower) return a;
  }
  for (const [q, a] of Object.entries(qaMap)) {
    if (labelLower.includes(q.toLowerCase())) return a;
  }
  for (const [q, a] of Object.entries(qaMap)) {
    if (q.toLowerCase().includes(labelLower) && labelLower.length > 3) return a;
  }
  const labelWords = new Set(labelLower.split(/\s+/).filter((w) => w.length > 3));
  let bestMatch = null;
  for (const [q, a] of Object.entries(qaMap)) {
    const qWords = q.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const overlap = qWords.filter((w) => labelWords.has(w)).length;
    if (overlap >= 3 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { answer: a, overlap };
    }
  }
  if (bestMatch) return bestMatch.answer;
  const stem = (word) => word.replace(/(ating|ting|ing|tion|sion|ment|ness|able|ible|ed|ly|er|est|ies|es|s)$/i, "");
  const labelStems = new Set(
    labelLower.split(/\s+/).filter((w) => w.length > 3).map(stem)
  );
  bestMatch = null;
  for (const [q, a] of Object.entries(qaMap)) {
    const qStems = q.toLowerCase().split(/\s+/).filter((w) => w.length > 3).map(stem);
    const overlap = qStems.filter((s) => labelStems.has(s)).length;
    if (overlap >= 2 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { answer: a, overlap };
    }
  }
  if (bestMatch) return bestMatch.answer;
  return null;
}
async function waitForPageLoad(adapter) {
  try {
    await adapter.page.waitForLoadState("networkidle", { timeout: 1e4 }).catch(() => {
    });
    await adapter.page.waitForTimeout(PAGE_TRANSITION_WAIT_MS);
  } catch {
  }
}
async function clickSaveAndContinueDOM(adapter) {
  const result = await adapter.page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const safePriorities = ["save and continue", "next", "continue"];
    for (const target of safePriorities) {
      const btn = buttons.find((b) => (b.textContent?.trim().toLowerCase() || "") === target);
      if (btn) {
        btn.click();
        return "clicked";
      }
    }
    const fallback = buttons.find((b) => {
      const text = b.textContent?.trim().toLowerCase() || "";
      return text.includes("save and continue") || text.includes("next");
    });
    if (fallback) {
      fallback.click();
      return "clicked";
    }
    const submitBtn = buttons.find((b) => {
      const text = b.textContent?.trim().toLowerCase() || "";
      return text === "submit" || text === "submit application";
    });
    if (submitBtn) {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
      const isReviewHeading = headings.some((h) => (h.textContent || "").toLowerCase().includes("review"));
      const hasEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
      ).length > 0;
      const hasSelectOne = buttons.some((b) => (b.textContent?.trim() || "") === "Select One");
      const hasUncheckedRequired = document.querySelectorAll('input[type="checkbox"]:not(:checked)').length > 0;
      if (isReviewHeading || !hasEditableInputs && !hasSelectOne && !hasUncheckedRequired) {
        return "review_detected";
      }
      submitBtn.click();
      return "clicked";
    }
    return "not_found";
  });
  if (result === "review_detected") {
    getLogger().info("Review page detected, not clicking Submit");
    return;
  }
  if (result === "not_found") {
    getLogger().warn("DOM click failed, falling back to LLM act()");
    await adapter.act(
      'Click the "Save and Continue" button. Click ONLY that button and then STOP. Do absolutely nothing else. Do NOT click "Submit" or "Submit Application".'
    );
  }
}
async function clickNextWithErrorRecovery(adapter, fillPrompt, pageLabel, fullQAMap) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await adapter.page.waitForTimeout(800);
    getLogger().debug("Clicking Save and Continue", { pageLabel, attempt });
    await clickSaveAndContinueDOM(adapter);
    await adapter.page.waitForTimeout(2e3);
    const hasErrors = await adapter.page.evaluate(() => {
      const errorBanner = document.querySelector(
        '[data-automation-id="errorMessage"], [role="alert"], .css-1fdonr0, [class*="WJLK"]'
      );
      if (errorBanner && errorBanner.textContent?.toLowerCase().includes("error")) return true;
      const allText = document.body.innerText;
      return allText.includes("Errors Found") || allText.includes("Error -");
    });
    if (!hasErrors) {
      getLogger().info("Save and Continue succeeded", { pageLabel });
      await waitForPageLoad(adapter);
      return;
    }
    getLogger().info("Validation errors detected, clicking error jump links", { pageLabel });
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);
    const errorLinks = await adapter.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll(
        '[data-automation-id="errorMessage"] a, [role="alert"] a, [class*="error"] a, [class*="WJLK"] a'
      ));
      const allLinks = document.querySelectorAll("a");
      for (const a of allLinks) {
        const text = (a.textContent || "").trim();
        const parent = a.closest('[data-automation-id="errorMessage"], [role="alert"]');
        if (parent && text.length > 5) links.push(a);
      }
      return links.length;
    });
    if (errorLinks > 0) {
      getLogger().info("Found error links, clicking each one", { pageLabel, errorLinks });
      for (let linkIdx = 0; linkIdx < errorLinks; linkIdx++) {
        await adapter.page.evaluate((idx) => {
          const links = Array.from(document.querySelectorAll(
            '[data-automation-id="errorMessage"] a, [role="alert"] a'
          ));
          if (links[idx]) links[idx].click();
        }, linkIdx);
        await adapter.page.waitForTimeout(800);
        if (Object.keys(fullQAMap).length > 0) {
          await fillDropdownsProgrammatically(adapter, fullQAMap);
        }
        await fillDateFieldsProgrammatically(adapter);
      }
    }
    await adapter.act(
      `There are validation errors on this page. Look for any error messages or fields highlighted in red. If you see clickable error links at the top of the page, click on each one — they will jump you directly to the missing field. Then fill in the correct value. For each missing/invalid field:
1. CLICK on the error link to jump to it, OR click directly on the field.
2. Fill in the correct value or select the correct option.
3. CLICK on empty whitespace to deselect.

${fillPrompt}`
    );
    for (let scrollPass = 0; scrollPass < 5; scrollPass++) {
      const before = await adapter.page.evaluate(() => window.scrollY);
      const max = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );
      if (before >= max - 10) break;
      await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
      await adapter.page.waitForTimeout(800);
      const after = await adapter.page.evaluate(() => window.scrollY);
      if (after <= before) break;
      if (Object.keys(fullQAMap).length > 0) {
        await fillDropdownsProgrammatically(adapter, fullQAMap);
      }
      const hasEmpty = await hasEmptyVisibleFields(adapter);
      if (hasEmpty) {
        await adapter.act(
          `If there are any EMPTY required fields visible on screen (marked with * or highlighted in red), CLICK on each one and fill it with the correct value. If ALL visible fields are already filled, do NOTHING — just stop immediately.

${fillPrompt}`
        );
      }
    }
  }
  getLogger().warn("Still has errors after max retries, proceeding", { pageLabel, maxRetries: MAX_RETRIES });
  await waitForPageLoad(adapter);
}
const WORKDAY_BASE_RULES = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. I handle all scrolling myself.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: Before interacting with ANY field, check that you can see the ENTIRE perimeter of its input box — all four edges (top, bottom, left, right) must be fully visible on screen. If even one edge of the box is cut off or hidden by the top or bottom of the screen, that field is OFF LIMITS. Do not click it, do not type in it, do not try to expand it, do not click anywhere near it — pretend it does not exist. Only interact with fields where you can see the complete box with space around it. When you run out of fully visible fields, STOP immediately and do nothing more. I will scroll the page for you and call you again.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field. Typing into the same field multiple times causes duplicate text (e.g. "WuWuWu" instead of "Wu").

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill. Tab can jump to the wrong field.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any button that navigates to another page. When you are done filling visible fields, simply STOP taking actions. I handle all navigation myself.`;
const FIELD_FILL_RULES = `1. If the field already has ANY value (even if formatted differently), SKIP IT entirely.
2. Phone numbers like "(408) 555-1234" are CORRECTLY formatted by Workday — do NOT re-enter them.
3. If the field is truly empty (blank/no text): CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.`;
const DROPDOWN_RULES = `DROPDOWNS: Fill ONLY ONE dropdown per turn. After completing one dropdown, STOP and do nothing more — I will call you again for the next one. Follow these steps:
  Step 1: CLICK the dropdown button to open it.
  Step 2: TYPE your desired answer (e.g. "No", "Yes", "Male", "Website"). You MUST type — never skip this step.
  Step 3: WAIT 3 seconds. Do nothing during this time — let the dropdown filter and update.
  Step 4: A dropdown LIST appears BELOW the button you clicked. Look inside that list for the option with a SOLID BLUE FILLED BACKGROUND — this is your match. Do NOT click the dropdown button again. The blue-filled option is BELOW the button, inside the popup list. Click that blue-filled option. Then click on empty whitespace to deselect.
  Step 5: STOP. You are done for this turn. Do not fill any more fields — I will call you again.
  TRUST THE DROPDOWN: When you click a dropdown and options appear, those options ALWAYS belong to the dropdown you just clicked — even if the popup visually overlaps with other questions above or below. Do NOT second-guess which question the options belong to. Be confident and click your answer. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.`;
const DATE_FIELD_RULES = (todayDate, todayFormatted) => `DATE FIELDS (MM/DD/YYYY): Click on the MM (month) part FIRST, then type the full date as continuous digits with NO slashes (e.g. "${todayDate}" for ${todayFormatted}). For "today's date" or "signature date", type "${todayDate}". For "expected graduation date" use 05012027.`;
const CHECKBOX_RULES = `CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.`;
const STOP_IF_DONE = `If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.`;
function buildPersonalInfoPrompt(dataBlock) {
  const todayDate = getTodayDateDigits();
  const todayFormatted = getTodayFormatted();
  return `${WORKDAY_BASE_RULES}

Fill any EMPTY form fields that are FULLY visible on screen, from TOP to BOTTOM:
${FIELD_FILL_RULES}
4. ${DROPDOWN_RULES}
5. ${DATE_FIELD_RULES(todayDate, todayFormatted)}
6. ${CHECKBOX_RULES}

${STOP_IF_DONE}

${dataBlock}`;
}
function buildFormPagePrompt(pageDescription, dataPrompt) {
  const todayDate = getTodayDateDigits();
  const todayFormatted = getTodayFormatted();
  return `${WORKDAY_BASE_RULES}

You are on a "${pageDescription}" form page. Fill any EMPTY questions/fields that are FULLY visible on screen, from top to bottom:
${FIELD_FILL_RULES}
4. ${DROPDOWN_RULES}
5. ${DATE_FIELD_RULES(todayDate, todayFormatted)}
6. ${CHECKBOX_RULES}

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataPrompt}`;
}
function buildExperiencePrompt(dataBlock) {
  return `${WORKDAY_BASE_RULES}

This is the "My Experience" page. Fill any EMPTY fields/sections that are FULLY visible on screen.

IMPORTANT INTERACTION PATTERNS:
1. "Add" BUTTONS: ONLY click "Add" under "Work Experience" and "Education" sections. Do NOT click "Add" under "Websites" or "Certifications" — those must stay empty. If the form fields are already expanded (you can see Job Title, Company, etc.), do NOT click Add again.
2. ${DROPDOWN_RULES}
3. TYPEAHEAD FIELDS (e.g. Field of Study, Skills): Type the value, then press Enter to trigger the dropdown. WAIT 2-3 seconds for the suggestions to load. Then CLICK on the matching option in the dropdown list. If the correct option is not visible, click the dropdown scrollbar to scroll through the options until you find it.
4. DATE FIELDS (MM/YYYY): Look for the text "MM" on screen — it is a tiny input box. Click DIRECTLY on the letters "MM". Do NOT click the calendar icon or the box showing "YYYY". After clicking "MM", type the digits continuously (e.g. "012026") and Workday auto-advances to YYYY. If the date shows "1900" or an error, do this recovery: click on the "MM" box, press Delete 6 times to clear it, then type the date digits again.
5. ${CHECKBOX_RULES}
6. After filling each field, CLICK on empty whitespace to deselect before moving to the next field.

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;
}
function buildVoluntaryDisclosurePrompt() {
  return `${WORKDAY_BASE_RULES}

This is a voluntary self-identification page. Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Gender → type "Male"
   - Race/Ethnicity → type "Asian"
   - Veteran Status → type "not a protected"
   - Disability → type "do not wish"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. ${CHECKBOX_RULES}

If ALL visible questions already have answers, STOP IMMEDIATELY.`;
}
function buildSelfIdentifyPrompt() {
  return `${WORKDAY_BASE_RULES}

This is a self-identification page (often about disability status). Fill any UNANSWERED questions that are FULLY visible on screen:
1. If a field/dropdown already has an answer selected, SKIP IT.
2. If empty: CLICK the dropdown, then TYPE the desired answer to filter:
   - Disability Status → type "do not wish"
   - Any other question → type "Decline"
   The popup menu that appears ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions.
3. If typing doesn't produce a match, click whitespace to close, re-click the dropdown, and try a shorter keyword. NEVER use arrow keys. NEVER mouse-scroll inside dropdowns.
4. ${CHECKBOX_RULES}

If ALL visible questions already have answers, STOP IMMEDIATELY.`;
}
function buildGenericPagePrompt(dataPrompt) {
  return `${WORKDAY_BASE_RULES}

Look at this page. Fill any EMPTY form fields that are FULLY visible, from top to bottom:
1. If a field already has ANY value, SKIP IT — do not re-enter or "fix" it.
2. If truly empty: CLICK the field, type/select the correct value, CLICK whitespace to deselect.
3. ${DROPDOWN_RULES}
4. ${CHECKBOX_RULES}

If ALL fields already have values or no form fields exist, STOP IMMEDIATELY.

${dataPrompt}`;
}
function buildGoogleSignInFallbackPrompt(email) {
  return `This is a Google sign-in page. Do exactly ONE of these actions, then STOP:
1. If you see an existing account for "${email}", click on it.
2. If you see an "Email or phone" field, type "${email}" and click "Next".
3. If you see a "Password" field, STOP immediately — do NOT type anything into it.
Do NOT interact with CAPTCHAs, reCAPTCHAs, or image challenges. If you see one, STOP immediately.`;
}
function getTodayDateDigits() {
  const now = /* @__PURE__ */ new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  return `${mm}${dd}${yyyy}`;
}
function getTodayFormatted() {
  const now = /* @__PURE__ */ new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  return `${mm}/${dd}/${yyyy}`;
}
async function handleGoogleSignIn(adapter, email) {
  const password = process.env.TEST_GMAIL_PASSWORD || "";
  const logger2 = getLogger();
  logger2.info("On Google sign-in page", { email });
  const googlePageType = await adapter.page.evaluate(`
    (() => {
      const targetEmail = ${JSON.stringify(email)}.toLowerCase();
      const bodyText = document.body.innerText.toLowerCase();

      // Check visibility: skip aria-hidden, display:none, zero-size elements
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

      // Password page first (password pages also have data-email attributes)
      if (hasVisiblePassword) return { type: 'password_entry', found: true };
      if (hasVisibleEmail) return { type: 'email_entry', found: true };

      // Account chooser
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
  `);
  switch (googlePageType.type) {
    case "account_chooser": {
      logger2.info("Account chooser detected, clicking account via DOM");
      const clicked = await adapter.page.evaluate((targetEmail) => {
        const byAttr = document.querySelector(`[data-email="${targetEmail}" i], [data-identifier="${targetEmail}" i]`);
        if (byAttr) {
          byAttr.click();
          return true;
        }
        const allClickable = document.querySelectorAll('div[role="link"], li[role="option"], a, div[tabindex], li[data-email]');
        for (const el of allClickable) {
          if (el.textContent?.toLowerCase().includes(targetEmail.toLowerCase())) {
            el.click();
            return true;
          }
        }
        const allEls = document.querySelectorAll("*");
        for (const el of allEls) {
          const text = el.textContent?.toLowerCase() || "";
          if (text.includes(targetEmail.toLowerCase()) && el.children.length < 5) {
            el.click();
            return true;
          }
        }
        return false;
      }, email);
      if (!clicked) {
        logger2.warn("Could not click account in chooser, falling back to LLM");
        await adapter.act(`Click on the account "${email}" to sign in with it.`);
      }
      await adapter.page.waitForTimeout(2e3);
      return;
    }
    case "email_entry": {
      logger2.info("Email entry page, typing email via DOM");
      const emailInput = adapter.page.locator('input[type="email"]:visible').first();
      await emailInput.fill(email);
      await adapter.page.waitForTimeout(300);
      const nextClicked = await adapter.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          if (btn.textContent?.trim().toLowerCase().includes("next")) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (!nextClicked) {
        await adapter.act('Click the "Next" button.');
      }
      await adapter.page.waitForTimeout(2e3);
      return;
    }
    case "password_entry": {
      logger2.info("Password entry page, typing password via DOM");
      const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
      await passwordInput.fill(password);
      await adapter.page.waitForTimeout(300);
      const nextClicked = await adapter.page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          if (btn.textContent?.trim().toLowerCase().includes("next")) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (!nextClicked) {
        await adapter.act('Click the "Next" button.');
      }
      await adapter.page.waitForTimeout(2e3);
      return;
    }
    default: {
      logger2.info("Unknown Google page, trying DOM password fill then LLM fallback");
      const passwordField = adapter.page.locator('input[type="password"]:visible').first();
      const hasPasswordField = await passwordField.isVisible({ timeout: 1e3 }).catch(() => false);
      if (hasPasswordField && password) {
        logger2.info("Found visible password field, filling via DOM");
        await passwordField.fill(password);
        await adapter.page.waitForTimeout(300);
        const nextClicked = await adapter.page.evaluate(() => {
          const buttons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            if (btn.textContent?.trim().toLowerCase().includes("next")) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (!nextClicked) {
          await adapter.act('Click the "Next" button.');
        }
      } else {
        await adapter.act(buildGoogleSignInFallbackPrompt(email));
      }
      await adapter.page.waitForTimeout(2e3);
      return;
    }
  }
}
async function fillWithSmartScroll(adapter, fillPrompt, pageLabel, fullQAMap) {
  const logger2 = getLogger();
  const MAX_SCROLL_ROUNDS = 10;
  const MAX_LLM_CALLS = 20;
  let llmCallCount = 0;
  if (await isActuallyReview(adapter)) {
    logger2.info("Review page detected, skipping fill logic", { pageLabel });
    return "review_detected";
  }
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);
  await adapter.page.evaluate(() => {
    const errorBanners = document.querySelectorAll(
      '[data-automation-id="errorMessage"], [role="alert"]'
    );
    errorBanners.forEach((el) => el.style.display = "none");
    const errorSections = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => el.textContent?.includes("Errors Found"));
    errorSections.forEach((el) => el.click());
  });
  await adapter.page.waitForTimeout(300);
  logger2.debug("Round 1: DOM fill pass", { pageLabel });
  if (Object.keys(fullQAMap).length > 0) {
    const programmaticFilled = await fillDropdownsProgrammatically(adapter, fullQAMap);
    if (programmaticFilled > 0) {
      logger2.debug("Programmatically filled dropdowns", { pageLabel, count: programmaticFilled });
    }
  }
  await fillDateFieldsProgrammatically(adapter);
  await checkRequiredCheckboxes(adapter);
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(400);
  const needsLLM = await hasEmptyVisibleFields(adapter);
  if (needsLLM && llmCallCount < MAX_LLM_CALLS) {
    await centerNextEmptyField(adapter);
    logger2.debug("LLM filling remaining fields", { pageLabel, round: 1, llmCall: llmCallCount + 1, maxLlmCalls: MAX_LLM_CALLS });
    await adapter.act(fillPrompt);
    llmCallCount++;
  } else if (llmCallCount >= MAX_LLM_CALLS) {
    logger2.debug("LLM call limit reached, skipping", { pageLabel, maxLlmCalls: MAX_LLM_CALLS });
  } else {
    logger2.debug("All visible fields filled, skipping LLM", { pageLabel });
  }
  for (let round = 2; round <= MAX_SCROLL_ROUNDS; round++) {
    const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
    const scrollMax = await adapter.page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    if (scrollBefore >= scrollMax - 10) {
      logger2.debug("Reached bottom of page", { pageLabel });
      break;
    }
    await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
    await adapter.page.waitForTimeout(800);
    const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
    if (scrollAfter <= scrollBefore) {
      logger2.debug("Cannot scroll further", { pageLabel });
      break;
    }
    logger2.debug("Scrolled page", { pageLabel, scrollY: scrollAfter, round });
    if (Object.keys(fullQAMap).length > 0) {
      const programmaticFilled = await fillDropdownsProgrammatically(adapter, fullQAMap);
      if (programmaticFilled > 0) {
        logger2.debug("Programmatically filled dropdowns", { pageLabel, count: programmaticFilled });
      }
    }
    await fillDateFieldsProgrammatically(adapter);
    await checkRequiredCheckboxes(adapter);
    if (llmCallCount >= MAX_LLM_CALLS) {
      logger2.debug("LLM call limit reached, skipping round", { pageLabel, maxLlmCalls: MAX_LLM_CALLS, round });
      continue;
    }
    const stillNeedsLLM = await hasEmptyVisibleFields(adapter);
    if (stillNeedsLLM) {
      await centerNextEmptyField(adapter);
      logger2.debug("LLM filling remaining fields", { pageLabel, round, llmCall: llmCallCount + 1, maxLlmCalls: MAX_LLM_CALLS });
      await adapter.act(fillPrompt);
      llmCallCount++;
    } else {
      logger2.debug("All visible fields filled, skipping LLM", { pageLabel });
    }
  }
  logger2.info("Page complete", { pageLabel, totalLlmCalls: llmCallCount });
  await clickNextWithErrorRecovery(adapter, fillPrompt, pageLabel, fullQAMap);
  return "done";
}
async function handleJobListing(adapter, pageState) {
  const logger2 = getLogger();
  logger2.info("On job listing page, clicking Apply");
  const result = await adapter.act(
    'Click the "Apply" button to start the job application. Look for buttons labeled "Apply", "Apply Now", "Apply for this job", or similar. If there are multiple apply buttons, click the main/primary one.'
  );
  if (!result.success) {
    throw new Error(`Failed to click Apply button: ${result.message}`);
  }
  await waitForPageLoad(adapter);
}
async function handleLogin(adapter, pageState, userProfile) {
  const currentUrl = await adapter.getCurrentUrl();
  const email = userProfile.email;
  if (currentUrl.includes("accounts.google.com")) {
    await handleGoogleSignIn(adapter, email);
    return;
  }
  const logger2 = getLogger();
  logger2.info("On login page, clicking Sign in with Google");
  let clicked = false;
  const googleBtnSelectors = [
    'button:has-text("Sign in with Google")',
    'button:has-text("Continue with Google")',
    'a:has-text("Sign in with Google")',
    '[data-automation-id*="google" i]'
  ];
  for (const sel of googleBtnSelectors) {
    try {
      const btn = adapter.page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1e3 }).catch(() => false)) {
        await btn.click();
        clicked = true;
        logger2.info("Clicked Sign in with Google via Playwright locator");
        break;
      }
    } catch {
    }
  }
  if (!clicked) {
    const result = await adapter.act(
      'Look for a "Sign in with Google" button, a Google icon/logo button, or a "Continue with Google" option and click it. If there is no Google sign-in option, look for "Sign In" or "Log In" button instead.'
    );
    if (!result.success) {
      logger2.warn("Google sign-in button not found, trying generic sign-in", { message: result.message });
      await adapter.act('Click the "Sign In", "Log In", or "Create Account" button.');
    }
  }
  await waitForPageLoad(adapter);
}
async function handleVerificationCode(adapter) {
  const logger2 = getLogger();
  logger2.info("Verification code required, checking Gmail for code");
  const currentUrl = await adapter.getCurrentUrl();
  await adapter.navigate("https://mail.google.com");
  await waitForPageLoad(adapter);
  const codeResult = await adapter.extract(
    "Find the most recent email that contains a verification code, security code, or one-time password (OTP). Extract the numeric or alphanumeric code from it.",
    zod.z.object({
      code: zod.z.string(),
      found: zod.z.boolean()
    })
  );
  if (!codeResult.found || !codeResult.code) {
    throw new Error("Could not find verification code in Gmail");
  }
  logger2.info("Found verification code");
  await adapter.navigate(currentUrl);
  await waitForPageLoad(adapter);
  const enterResult = await adapter.act(
    `Enter the verification code "${codeResult.code}" into the verification code input field and click the "Next", "Verify", "Continue", or "Submit" button.`
  );
  if (!enterResult.success) {
    throw new Error(`Failed to enter verification code: ${enterResult.message}`);
  }
  await waitForPageLoad(adapter);
}
async function handlePhone2FA(adapter) {
  const logger2 = getLogger();
  const currentUrl = await adapter.getCurrentUrl();
  const isGoogleChallenge = currentUrl.includes("accounts.google.com") && currentUrl.includes("/challenge/");
  const challengeType = currentUrl.includes("recaptcha") ? "CAPTCHA" : currentUrl.includes("ipp") ? "SMS/Phone verification" : "Google security challenge";
  logger2.info("Manual action required", { challengeType, url: currentUrl, timeoutSeconds: PHONE_2FA_TIMEOUT_MS / 1e3 });
  const startTime = Date.now();
  const startUrl = currentUrl;
  while (Date.now() - startTime < PHONE_2FA_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, PHONE_2FA_POLL_INTERVAL_MS));
    const nowUrl = await adapter.getCurrentUrl();
    const elapsed = Math.round((Date.now() - startTime) / 1e3);
    if (nowUrl !== startUrl) {
      logger2.info("Challenge resolved", { elapsedSeconds: elapsed });
      return;
    }
    if (isGoogleChallenge) {
      logger2.debug("Still waiting for manual action", { elapsedSeconds: elapsed });
      continue;
    }
    const pageCheck = await adapter.extract(
      "Is there still a 2FA/two-factor authentication prompt on this page asking the user to approve on their phone?",
      zod.z.object({ still_waiting: zod.z.boolean() })
    );
    if (!pageCheck.still_waiting) {
      logger2.info("Challenge resolved", { elapsedSeconds: elapsed });
      return;
    }
    logger2.debug("Still waiting for manual action", { elapsedSeconds: elapsed });
  }
  throw new Error("Phone 2FA timed out after 3 minutes. Please try again.");
}
async function handleAccountCreation(adapter, userProfile, dataPrompt) {
  getLogger().info("Account creation page detected, filling in details");
  const result = await adapter.act(
    `Fill out the account creation form with the provided user information, then click "Create Account", "Register", "Continue", or "Next". ${dataPrompt}`
  );
  if (!result.success) {
    throw new Error(`Failed to create account: ${result.message}`);
  }
  await waitForPageLoad(adapter);
}
async function handlePersonalInfoPage(adapter, profile, qaOverrides, fullQAMap) {
  getLogger().info("Filling personal info page with smart scroll");
  const qaList = Object.entries(qaOverrides).map(([q, a]) => `"${q}" → ${a}`).join("\n  ");
  const dataBlock = `DATA:
  First Name: ${profile.first_name}
  Last Name: ${profile.last_name}
  Email: ${profile.email}
  Phone: ${profile.phone} (device type: Mobile, country code: +1 United States)
  Country: ${profile.address.country}
  Street Address: ${profile.address.street}
  City: ${profile.address.city}
  State: ${profile.address.state}
  Postal Code: ${profile.address.zip}

SCREENING QUESTIONS (if any appear on this page):
  ${qaList}
  For any question not listed, pick the most reasonable answer.`;
  const fillPrompt = buildPersonalInfoPrompt(dataBlock);
  await fillWithSmartScroll(adapter, fillPrompt, "personal info", fullQAMap);
}
async function handleFormPage(adapter, pageDescription, dataPrompt, fullQAMap) {
  getLogger().info("Filling form page", { pageDescription });
  const fillPrompt = buildFormPagePrompt(pageDescription, dataPrompt);
  return fillWithSmartScroll(adapter, fillPrompt, pageDescription, fullQAMap);
}
async function handleExperiencePage(adapter, userProfile, fullQAMap) {
  const logger2 = getLogger();
  logger2.info("On My Experience page, uploading resume via DOM then LLM fills sections");
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);
  if (userProfile.resume_path) {
    logger2.info("Uploading resume via DOM");
    const resumePath = path.isAbsolute(userProfile.resume_path) ? userProfile.resume_path : path.resolve(process.cwd(), userProfile.resume_path);
    if (!fs.existsSync(resumePath)) {
      logger2.warn("Resume not found, skipping upload", { resumePath });
    } else {
      const alreadyUploaded = await adapter.page.evaluate(`
        (() => {
          // Workday shows the uploaded filename near the file input area
          var fileArea = document.querySelector('[data-automation-id="resumeSection"], [data-automation-id="attachmentsSection"], [data-automation-id="fileUploadSection"]');
          var searchArea = fileArea || document.body;
          var text = searchArea.innerText || '';
          // Look for common resume file extensions in visible text
          if (/\\.(pdf|docx?|rtf|txt)/i.test(text)) return true;
          // Look for a delete/remove button near file inputs (Workday shows X next to uploaded files)
          var deleteBtn = searchArea.querySelector('[data-automation-id="delete-file"], button[aria-label*="delete" i], button[aria-label*="remove" i]');
          if (deleteBtn) return true;
          // Check if there's a visible filename element near the file input
          var fileNames = searchArea.querySelectorAll('[data-automation-id="fileName"], [data-automation-id="file-name"], .file-name');
          for (var i = 0; i < fileNames.length; i++) {
            if ((fileNames[i].textContent || '').trim().length > 2) return true;
          }
          return false;
        })()
      `);
      if (alreadyUploaded) {
        logger2.info("Resume already uploaded, skipping");
      } else try {
        const fileInput = adapter.page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(resumePath);
        logger2.info("Resume file set via DOM file input");
        await adapter.page.waitForTimeout(5e3);
        const uploadOk = await adapter.page.evaluate(() => {
          return document.body.innerText.toLowerCase().includes("successfully uploaded") || document.body.innerText.toLowerCase().includes("successfully");
        });
        if (uploadOk) {
          logger2.info("Resume upload confirmed");
        } else {
          logger2.warn("Resume upload status unclear, continuing");
        }
      } catch (err) {
        logger2.warn("Resume upload failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
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
      const parts = exp.start_date.split("-");
      return parts.length >= 2 ? `${parts[1]}/${parts[0]}` : exp.start_date;
    })() : "";
    dataBlock += `
WORK EXPERIENCE (click "Add" under Work Experience section first):
  Job Title: ${exp.title}
  Company: ${exp.company}
  Location: ${exp.location || ""}
  I currently work here: ${exp.currently_work_here ? "YES — check the checkbox" : "No"}
  From date: ${fromDate} — Look for the text "MM" on screen and click DIRECTLY on the letters "MM". Do NOT click the calendar icon or the "YYYY" box. After clicking "MM", type "${fromDate.replace("/", "")}" as continuous digits — Workday auto-advances to YYYY. If you see "1900" or an error, click the "YYYY" box, press Delete 6 times to clear it, then retype "${fromDate.replace("/", "")}".
  Role Description: ${exp.description}
`;
  }
  if (edu) {
    dataBlock += `
EDUCATION (click "Add" under Education section first):
  School or University: ${edu.school}
  Degree: ${edu.degree} (this is a DROPDOWN — click it, then type "${edu.degree}" to filter and select)
  Field of Study: ${edu.field_of_study} (this is a TYPEAHEAD — follow these steps exactly:
    1. Click the Field of Study input.
    2. Type "${edu.field_of_study}" into the input.
    3. Press Enter to trigger the dropdown to update.
    4. Wait a moment for the options to load.
    5. Look through the visible options for "${edu.field_of_study}" and click it.
    6. If the correct option is NOT visible in the dropdown, scroll through the dropdown list by clicking the scrollbar on the side of the dropdown to find and click the correct option.
  )
`;
  }
  if (userProfile.skills && userProfile.skills.length > 0) {
    dataBlock += `
SKILLS (find the skills input field, usually has placeholder "Type to Add Skills"):
  For EACH skill below: click the skills input, type the skill name, press Enter to trigger the dropdown, WAIT for the autocomplete dropdown to appear, then CLICK the matching option from the dropdown. If the correct option is not visible, scroll the dropdown to find it. After selecting, click on empty whitespace to dismiss the dropdown before typing the next skill.
  Skills to add: ${userProfile.skills.map((s) => `"${s}"`).join(", ")}
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
  const MAX_SCROLL_ROUNDS = 8;
  const MAX_LLM_CALLS = 6;
  let llmCallCount = 0;
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(400);
  for (let round = 1; round <= MAX_SCROLL_ROUNDS; round++) {
    if (llmCallCount < MAX_LLM_CALLS) {
      await centerNextEmptyField(adapter);
      logger2.debug("MyExperience LLM fill round", { round, llmCall: llmCallCount + 1, maxLlmCalls: MAX_LLM_CALLS });
      await adapter.act(fillPrompt);
      llmCallCount++;
      await adapter.page.waitForTimeout(1e3);
    }
    const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
    const scrollMax = await adapter.page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    if (scrollBefore >= scrollMax - 10) {
      logger2.debug("MyExperience reached bottom of page");
      break;
    }
    await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
    await adapter.page.waitForTimeout(800);
    const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
    if (scrollAfter <= scrollBefore) {
      logger2.debug("MyExperience cannot scroll further");
      break;
    }
    logger2.debug("MyExperience scrolled", { scrollY: scrollAfter, round });
  }
  logger2.info("MyExperience page complete", { totalLlmCalls: llmCallCount });
  await clickNextWithErrorRecovery(adapter, fillPrompt, "my experience", fullQAMap);
}
async function handleVoluntaryDisclosure(adapter, dataPrompt, fullQAMap) {
  getLogger().info("Filling voluntary self-identification page");
  const fillPrompt = buildVoluntaryDisclosurePrompt();
  return fillWithSmartScroll(adapter, fillPrompt, "voluntary disclosure", fullQAMap);
}
async function handleSelfIdentify(adapter, dataPrompt, fullQAMap) {
  getLogger().info("Filling self-identification page");
  const fillPrompt = buildSelfIdentifyPrompt();
  return fillWithSmartScroll(adapter, fillPrompt, "self-identify", fullQAMap);
}
async function handleGenericPage(adapter, dataPrompt, fullQAMap) {
  getLogger().info("Handling generic/unknown page");
  const fillPrompt = buildGenericPagePrompt(dataPrompt);
  await fillWithSmartScroll(adapter, fillPrompt, "generic", fullQAMap);
}
async function runWorkdayPipeline(agent, profile, emit, resumePath) {
  const logger2 = getLogger();
  const adapter = new DesktopAdapterShim(agent);
  const workdayProfile = mapDesktopProfileToWorkday(profile, resumePath);
  const qaOverrides = profile.qaAnswers || {};
  const dataPrompt = buildDataPrompt(workdayProfile, qaOverrides);
  const fullQAMap = buildFullQAMap(workdayProfile, qaOverrides);
  let pagesProcessed = 0;
  emit("status", "Workday pipeline started — detecting page type...");
  while (pagesProcessed < MAX_FORM_PAGES) {
    pagesProcessed++;
    await waitForPageLoad(adapter);
    let pageState = await detectPage(adapter);
    logger2.info("Processing page", { page: pagesProcessed, pageType: pageState.page_type, title: pageState.page_title || "N/A" });
    emit("status", `Page ${pagesProcessed}: ${pageState.page_type}`);
    switch (pageState.page_type) {
      case "job_listing":
        await handleJobListing(adapter);
        break;
      case "login":
      case "google_signin":
        emit("status", "Handling login...");
        await handleLogin(adapter, pageState, workdayProfile);
        break;
      case "verification_code":
        emit("status", "Retrieving verification code...");
        await handleVerificationCode(adapter);
        break;
      case "phone_2fa":
        emit("status", "Waiting for manual 2FA (up to 3 min)...");
        await handlePhone2FA(adapter);
        break;
      case "account_creation":
        emit("status", "Creating account...");
        await handleAccountCreation(adapter, workdayProfile, dataPrompt);
        break;
      case "personal_info":
        emit("status", "Filling personal information...");
        await handlePersonalInfoPage(adapter, workdayProfile, qaOverrides, fullQAMap);
        break;
      case "experience":
      case "resume_upload":
        emit("status", "Filling experience & uploading resume...");
        await handleExperiencePage(adapter, workdayProfile, fullQAMap);
        break;
      case "questions": {
        emit("status", "Answering application questions...");
        const qResult = await handleFormPage(adapter, "application questions", dataPrompt, fullQAMap);
        if (qResult === "review_detected") {
          pageState = { page_type: "review", page_title: "Review" };
          continue;
        }
        break;
      }
      case "voluntary_disclosure": {
        emit("status", "Filling voluntary disclosures...");
        const vResult = await handleVoluntaryDisclosure(adapter, dataPrompt, fullQAMap);
        if (vResult === "review_detected") {
          pageState = { page_type: "review", page_title: "Review" };
          continue;
        }
        break;
      }
      case "self_identify": {
        emit("status", "Filling self-identification...");
        const sResult = await handleSelfIdentify(adapter, dataPrompt, fullQAMap);
        if (sResult === "review_detected") {
          pageState = { page_type: "review", page_title: "Review" };
          continue;
        }
        break;
      }
      case "review":
        emit("status", "Reached review page — stopping before submission");
        logger2.info("Application filled, stopped at review page", { pagesProcessed });
        return;
      case "confirmation":
        logger2.warn("Unexpected: landed on confirmation page");
        emit("status", "Application appears to have been submitted (unexpected)");
        return;
      case "error":
        throw new Error(`Workday error page: ${pageState.error_message || "Unknown error"}`);
      case "unknown":
      default:
        emit("status", "Unknown page — attempting generic fill...");
        await handleGenericPage(adapter, dataPrompt, fullQAMap);
        break;
    }
  }
  logger2.warn("Reached max page limit without finding review page", { maxPages: MAX_FORM_PAGES, pagesProcessed });
  emit("status", `Processed ${pagesProcessed} pages — browser open for manual review`);
}
function buildFullQAMap(profile, qaOverrides) {
  return {
    "Gender": profile.gender || "I do not wish to answer",
    "Race/Ethnicity": profile.race_ethnicity || "I do not wish to answer",
    "Race": profile.race_ethnicity || "I do not wish to answer",
    "Ethnicity": profile.race_ethnicity || "I do not wish to answer",
    "Veteran Status": profile.veteran_status || "I am not a protected veteran",
    "Are you a protected veteran": profile.veteran_status || "I am not a protected veteran",
    "Disability": profile.disability_status || "I do not wish to answer",
    "Disability Status": profile.disability_status || "I do not wish to answer",
    "Please indicate if you have a disability": profile.disability_status || "I do not wish to answer",
    "Country": profile.address.country,
    "Country/Territory": profile.address.country,
    "State": profile.address.state,
    "State/Province": profile.address.state,
    "Phone Device Type": profile.phone_device_type || "Mobile",
    "Phone Type": profile.phone_device_type || "Mobile",
    "Please enter your name": `${profile.first_name} ${profile.last_name}`,
    "Please enter your name:": `${profile.first_name} ${profile.last_name}`,
    "Enter your name": `${profile.first_name} ${profile.last_name}`,
    "Your name": `${profile.first_name} ${profile.last_name}`,
    "Full name": `${profile.first_name} ${profile.last_name}`,
    "Signature": `${profile.first_name} ${profile.last_name}`,
    "Name": `${profile.first_name} ${profile.last_name}`,
    "What is your desired salary?": "Open to discussion",
    "Desired salary": "Open to discussion",
    ...qaOverrides
  };
}
function buildDataPrompt(profile, qaOverrides) {
  const parts = [
    "FIELD-TO-VALUE MAPPING — read each field label and match it to the correct value:",
    "",
    "--- NAME FIELDS ---",
    `If the label says "First Name" or "Legal First Name" → type: ${profile.first_name}`,
    `If the label says "Last Name" or "Legal Last Name" → type: ${profile.last_name}`,
    "",
    "--- CONTACT FIELDS ---",
    `If the label says "Email" or "Email Address" → type: ${profile.email}`,
    `If the label says "Phone Number" or "Phone" → type: ${profile.phone}`,
    `If the label says "Phone Device Type" → select: ${profile.phone_device_type || "Mobile"}`,
    `If the label says "Country Phone Code" or "Phone Country Code" → select: ${profile.phone_country_code || "+1"} (United States)`,
    "",
    "--- ADDRESS FIELDS ---",
    `If the label says "Country" or "Country/Territory" → select from dropdown: ${profile.address.country}`,
    `If the label says "Address Line 1" or "Street" → type: ${profile.address.street}`,
    `If the label says "City" → type: ${profile.address.city}`,
    `If the label says "State" or "State/Province" → select from dropdown: ${profile.address.state}`,
    `If the label says "Postal Code" or "ZIP" or "ZIP Code" → type: ${profile.address.zip}`
  ];
  if (profile.linkedin_url) {
    parts.push("");
    parts.push("--- LINKS ---");
    parts.push(`If the label says "LinkedIn" → type: ${profile.linkedin_url}`);
    if (profile.website_url) parts.push(`If the label says "Website" → type: ${profile.website_url}`);
  }
  if (profile.education?.length > 0) {
    const edu = profile.education[0];
    parts.push("");
    parts.push("--- EDUCATION ---");
    parts.push(`School/University → ${edu.school}`);
    parts.push(`Degree → ${edu.degree}`);
    parts.push(`Field of Study → ${edu.field_of_study}`);
    if (edu.gpa) parts.push(`GPA → ${edu.gpa}`);
    parts.push(`Start Date → ${edu.start_date}`);
    parts.push(`End Date → ${edu.end_date}`);
  }
  if (Object.keys(qaOverrides).length > 0) {
    parts.push("");
    parts.push("--- SCREENING QUESTIONS — match the question text and select/type the answer ---");
    for (const [question, answer] of Object.entries(qaOverrides)) {
      parts.push(`If the question asks "${question}" → answer: ${answer}`);
    }
  }
  parts.push("");
  parts.push("--- GENERAL RULES ---");
  parts.push(`Work Authorization → ${profile.work_authorization}`);
  parts.push(`Visa Sponsorship → ${profile.visa_sponsorship}`);
  parts.push('For self-identification: Gender → select "Male". Race/Ethnicity → select "Asian (Not Hispanic or Latino)". Veteran Status → select "I am not a protected veteran". Disability → select "I do not wish to answer".');
  parts.push("For any question not listed above, select the most reasonable/common answer.");
  parts.push('DROPDOWN TECHNIQUE: After clicking a dropdown, ALWAYS TYPE your desired answer first (e.g. "No", "Yes", "Male", "Website") to filter the list. If a matching option appears, click it. If typing does not produce a match, click whitespace to close the dropdown, then re-click it and try typing a shorter keyword. The popup menu that appears after clicking a dropdown ALWAYS belongs to the dropdown you just clicked, even if it visually overlaps with other questions. NEVER use arrow keys inside dropdowns. NEVER use mouse scroll inside dropdowns.');
  parts.push('NESTED DROPDOWNS: Some dropdowns have sub-menus. After selecting a category (e.g. "Website"), a second list appears with specific options (e.g. "workday.com"). Select the sub-option. Do NOT click any back arrow or "← Category" button — that navigates backwards.');
  parts.push(`DATE FIELDS: Workday date fields have separate MM/DD/YYYY parts. ALWAYS click on the MM (month) part FIRST, then type the full date as continuous digits WITHOUT slashes or dashes (e.g. for 02/18/2026, click on MM and type "02182026"). Workday auto-advances from month to day to year. For "today's date" or "signature date", type "02182026" (which is 02/18/2026). For "expected graduation date", use 05012027.`);
  parts.push('NEVER click "Submit Application" or "Submit".');
  return parts.join("\n");
}
exports.runWorkdayPipeline = runWorkdayPipeline;
