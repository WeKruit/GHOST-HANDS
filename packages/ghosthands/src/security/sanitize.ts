/**
 * S9: Input sanitization for XSS and injection prevention
 *
 * All user input entering the system (resume fields, QA answers, job URLs)
 * is sanitized at the API boundary. This module provides:
 *
 *   1. HTML entity encoding (prevents stored XSS)
 *   2. SQL injection pattern detection (defence-in-depth alongside Drizzle ORM parameterization)
 *   3. XSS payload detection and stripping
 *   4. URL validation for job URLs
 *   5. General string sanitization
 *
 * Security report references: S9 (Section 6.1.2, mitigation 1), S15 (Section 6.1.3)
 */

// ── HTML entity encoding ──────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#96;',
};

const HTML_ENTITY_REGEX = /[&<>"'`/]/g;

/**
 * Encode HTML entities in a string to prevent XSS when rendered in a browser.
 */
export function encodeHTML(input: string): string {
  return input.replace(HTML_ENTITY_REGEX, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Strip all HTML tags from a string. Leaves the text content.
 */
export function stripHTML(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

// ── XSS detection ─────────────────────────────────────────────────────────

const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on\w+\s*=/i, // onclick=, onerror=, onload=, etc.
  /data\s*:\s*text\/html/i,
  /vbscript\s*:/i,
  /expression\s*\(/i, // CSS expression()
  /url\s*\(\s*['"]?\s*javascript/i,
  /<!--/,
  /<iframe/i,
  /<object/i,
  /<embed/i,
  /<form/i,
  /<meta/i,
  /<link[\s>]/i,
  /<base[\s>]/i,
  /<svg[\s>]/i,
];

/**
 * Check if a string contains potential XSS payloads.
 */
export function containsXSS(input: string): boolean {
  return XSS_PATTERNS.some((pattern) => pattern.test(input));
}

/**
 * Remove potential XSS payloads from a string.
 * Strips HTML tags and encodes remaining entities.
 */
export function sanitizeXSS(input: string): string {
  return encodeHTML(stripHTML(input));
}

// ── SQL injection detection ───────────────────────────────────────────────

const SQL_INJECTION_PATTERNS = [
  /('\s*(OR|AND)\s+')/i,
  /('\s*;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|EXEC)\s)/i,
  /(UNION\s+(ALL\s+)?SELECT)/i,
  /(--.*)$/m,
  /(\/\*[\s\S]*?\*\/)/,
  /(\bSLEEP\s*\()/i,
  /(\bBENCHMARK\s*\()/i,
  /(\bWAITFOR\s+DELAY)/i,
  /(;\s*SHUTDOWN)/i,
  /(\bEXEC\s*\()/i,
  /(\bxp_\w+)/i,
];

/**
 * Check if a string contains potential SQL injection patterns.
 * This is defence-in-depth; the primary protection is Drizzle ORM's
 * parameterized queries.
 */
export function containsSQLInjection(input: string): boolean {
  return SQL_INJECTION_PATTERNS.some((pattern) => pattern.test(input));
}

// ── URL validation ────────────────────────────────────────────────────────

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validate a URL for safe navigation.
 * Rejects javascript:, data:, vbscript:, and other dangerous protocols.
 */
export function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return ALLOWED_URL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Sanitize a URL string. Returns null if the URL is invalid or uses a
 * dangerous protocol.
 */
export function sanitizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!isValidUrl(trimmed)) return null;
  return trimmed;
}

// ── General string sanitization ───────────────────────────────────────────

export interface SanitizeOptions {
  /** Maximum allowed string length. Default 10000. */
  maxLength?: number;
  /** Strip HTML tags. Default true. */
  stripHtml?: boolean;
  /** Encode HTML entities. Default true (applied after stripHtml if both enabled). */
  encodeEntities?: boolean;
  /** Check for SQL injection patterns. Default true. */
  checkSqlInjection?: boolean;
  /** Trim whitespace. Default true. */
  trim?: boolean;
  /** Normalize unicode. Default true. */
  normalizeUnicode?: boolean;
}

const DEFAULT_OPTIONS: Required<SanitizeOptions> = {
  maxLength: 10_000,
  stripHtml: true,
  encodeEntities: true,
  checkSqlInjection: true,
  trim: true,
  normalizeUnicode: true,
};

export interface SanitizeResult {
  /** The sanitized string. */
  value: string;
  /** Whether the input was modified. */
  modified: boolean;
  /** Warnings about the input (e.g. XSS detected, SQL injection detected). */
  warnings: string[];
}

/**
 * Sanitize a user-provided string value.
 *
 * Applies the full sanitization pipeline:
 *   1. Trim whitespace
 *   2. Normalize unicode
 *   3. Truncate to max length
 *   4. Strip HTML tags
 *   5. Encode HTML entities
 *   6. Detect SQL injection patterns
 *
 * Returns the sanitized value along with any warnings.
 */
export function sanitizeString(input: string, options?: SanitizeOptions): SanitizeResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];
  let value = input;
  let modified = false;

  // 1. Trim
  if (opts.trim) {
    const trimmed = value.trim();
    if (trimmed !== value) modified = true;
    value = trimmed;
  }

  // 2. Normalize unicode
  if (opts.normalizeUnicode) {
    const normalized = value.normalize('NFC');
    if (normalized !== value) modified = true;
    value = normalized;
  }

  // 3. Truncate
  if (value.length > opts.maxLength) {
    value = value.slice(0, opts.maxLength);
    modified = true;
    warnings.push(`Input truncated to ${opts.maxLength} characters`);
  }

  // 4. Check for XSS before stripping
  if (containsXSS(value)) {
    warnings.push('Potential XSS payload detected and removed');
  }

  // 5. Strip HTML tags
  if (opts.stripHtml) {
    const stripped = stripHTML(value);
    if (stripped !== value) modified = true;
    value = stripped;
  }

  // 6. Encode HTML entities
  if (opts.encodeEntities) {
    const encoded = encodeHTML(value);
    if (encoded !== value) modified = true;
    value = encoded;
  }

  // 7. Detect SQL injection (warning only -- Drizzle ORM parameterizes)
  if (opts.checkSqlInjection && containsSQLInjection(input)) {
    warnings.push('Potential SQL injection pattern detected in input');
  }

  return { value, modified, warnings };
}

/**
 * Sanitize all string values in a plain object (one level deep).
 * Non-string values are passed through unchanged.
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  options?: SanitizeOptions,
): { sanitized: T; warnings: string[] } {
  const sanitized = { ...obj };
  const allWarnings: string[] = [];

  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'string') {
      const result = sanitizeString(value, options);
      (sanitized as Record<string, unknown>)[key] = result.value;
      for (const w of result.warnings) {
        allWarnings.push(`${key}: ${w}`);
      }
    }
  }

  return { sanitized, warnings: allWarnings };
}
