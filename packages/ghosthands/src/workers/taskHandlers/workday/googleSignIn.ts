/**
 * Google sign-in handling for Workday application flows.
 *
 * Handles Google's account chooser, email entry, password entry, and
 * unknown Google pages. Uses DOM-based interactions to avoid LLM exposure
 * to credentials.
 */

import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import { buildGoogleSignInFallbackPrompt } from './workdayPrompts.js';
import { getLogger } from '../../../monitoring/logger.js';

/**
 * Handle Google sign-in page interactions.
 * Detects which sub-page we're on (account chooser, email entry, password entry)
 * and handles each case with DOM clicks to prevent the LLM from navigating
 * into CAPTCHA pages.
 *
 * SECURITY: Passwords are filled via DOM manipulation only — never exposed to LLM.
 */
export async function handleGoogleSignIn(
  adapter: BrowserAutomationAdapter,
  email: string,
): Promise<void> {
  const password = process.env.TEST_GMAIL_PASSWORD || '';

  const logger = getLogger();
  logger.info('On Google sign-in page', { email });

  // Detect which Google sub-page we're on via DOM
  // IMPORTANT: Google puts HIDDEN input[type="password"] on the email page
  // (aria-hidden="true", tabindex="-1") so we must check VISIBILITY, not just presence.
  // Also check password BEFORE account_chooser since password pages have [data-email].
  // Use string-based evaluate to avoid bundler injecting __name into browser context
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
  `) as { type: string; found: boolean };

  switch (googlePageType.type) {
    case 'account_chooser': {
      // Click the account via DOM — do NOT use act() which would let the LLM
      // navigate through CAPTCHA/challenge pages
      logger.info('Account chooser detected, clicking account via DOM');
      const clicked = await adapter.page.evaluate((targetEmail: string) => {
        // Try data-email attribute first
        const byAttr = document.querySelector(`[data-email="${targetEmail}" i], [data-identifier="${targetEmail}" i]`);
        if (byAttr) { (byAttr as HTMLElement).click(); return true; }

        // Try finding by email text content
        const allClickable = document.querySelectorAll('div[role="link"], li[role="option"], a, div[tabindex], li[data-email]');
        for (const el of allClickable) {
          if (el.textContent?.toLowerCase().includes(targetEmail.toLowerCase())) {
            (el as HTMLElement).click();
            return true;
          }
        }

        // Broader fallback: any element containing the email
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
        logger.warn('Could not click account in chooser, falling back to LLM');
        await adapter.act(`Click on the account "${email}" to sign in with it.`);
      }

      // Return immediately — the main loop will re-detect the page.
      // If a CAPTCHA appears, detectPage() will catch it and route to handlePhone2FA.
      await adapter.page.waitForTimeout(2000);
      return;
    }

    case 'email_entry': {
      logger.info('Email entry page, typing email via DOM');
      // Use :visible pseudo-class to skip hidden inputs Google puts in the DOM
      const emailInput = adapter.page.locator('input[type="email"]:visible').first();
      await emailInput.fill(email);
      await adapter.page.waitForTimeout(300);
      // Click "Next" button
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
      logger.info('Password entry page, typing password via DOM');
      // Use :visible pseudo-class to skip hidden inputs Google puts in the DOM
      const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
      await passwordInput.fill(password);
      await adapter.page.waitForTimeout(300);
      // Click "Next" button
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
      // Unknown Google page — try DOM-based password fill first (safe),
      // then fall back to LLM for email/account selection only.
      // SECURITY: Never pass passwords to LLM prompts — LLM providers log
      // prompts and completions, so credentials would be exposed.
      logger.info('Unknown Google page, trying DOM password fill then LLM fallback');

      // Attempt DOM-based password entry (handles cases the detector missed)
      const passwordField = adapter.page.locator('input[type="password"]:visible').first();
      const hasPasswordField = await passwordField.isVisible({ timeout: 1000 }).catch(() => false);
      if (hasPasswordField && password) {
        logger.info('Found visible password field, filling via DOM');
        await passwordField.fill(password);
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
      } else {
        // No password field visible — safe to use LLM for email/account actions
        await adapter.act(buildGoogleSignInFallbackPrompt(email));
      }

      await adapter.page.waitForTimeout(2000);
      return;
    }
  }
}
