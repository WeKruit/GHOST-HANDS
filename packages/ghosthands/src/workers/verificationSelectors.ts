/**
 * Canonical selectors used to detect verification code inputs across flows.
 * Keep this list centralized so blocker detection, page classification,
 * and manual code injection stay consistent.
 */
export const VERIFICATION_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="totp" i]',
  'input[id*="totp" i]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="token" i]',
  'input[id*="token" i]',
  'input[name*="2fa" i]',
  'input[id*="2fa" i]',
  'input[name*="mfa" i]',
  'input[id*="mfa" i]',
  'input[type="tel"][maxlength="6"]',
  'input[type="number"][maxlength="6"]',
  'input[inputmode="numeric"]',
] as const;

export const VERIFICATION_INPUT_SELECTOR_QUERY = VERIFICATION_INPUT_SELECTORS.join(', ');
