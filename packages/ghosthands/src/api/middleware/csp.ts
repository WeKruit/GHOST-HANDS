/**
 * S9: Content Security Policy middleware
 *
 * Sets strict CSP headers on all API responses to prevent XSS attacks
 * via injected scripts. Also sets additional security headers recommended
 * by OWASP.
 *
 * Security report references: S9 (Section 6.1.2, mitigation 2)
 */

import { Context, Next } from 'hono';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CSPConfig {
  /** Override the default CSP directives. */
  directives?: Partial<CSPDirectives>;
  /** Report-only mode (logs violations without blocking). */
  reportOnly?: boolean;
  /** Report URI for CSP violation reports. */
  reportUri?: string;
}

interface CSPDirectives {
  'default-src': string[];
  'script-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'connect-src': string[];
  'frame-src': string[];
  'object-src': string[];
  'base-uri': string[];
  'form-action': string[];
  'frame-ancestors': string[];
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_DIRECTIVES: CSPDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"], // Inline styles often needed for UI frameworks
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'connect-src': ["'self'"],
  'frame-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

// ── CSP header builder ─────────────────────────────────────────────────────

function buildCSPHeader(directives: CSPDirectives, reportUri?: string): string {
  const parts: string[] = [];

  for (const [directive, values] of Object.entries(directives)) {
    if (values.length > 0) {
      parts.push(`${directive} ${values.join(' ')}`);
    }
  }

  if (reportUri) {
    parts.push(`report-uri ${reportUri}`);
  }

  return parts.join('; ');
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * CSP middleware for Hono.
 * Sets Content-Security-Policy and additional security headers.
 */
export function cspMiddleware(config: CSPConfig = {}) {
  const directives: CSPDirectives = {
    ...DEFAULT_DIRECTIVES,
    ...config.directives,
  };

  const cspHeader = buildCSPHeader(directives, config.reportUri);
  const headerName = config.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';

  return async (c: Context, next: Next) => {
    await next();

    // CSP header
    c.header(headerName, cspHeader);

    // Additional security headers (OWASP recommendations)
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-XSS-Protection', '0'); // Disabled per OWASP: modern CSP is preferred
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // Prevent MIME-type sniffing for API responses
    if (!c.res.headers.get('Content-Type')) {
      c.header('Content-Type', 'application/json; charset=utf-8');
    }
  };
}

/**
 * Create a strict CSP middleware suitable for the GhostHands API.
 * No inline scripts, no eval(), no external frames.
 */
export function strictCSP(reportUri?: string) {
  return cspMiddleware({
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
    reportUri,
  });
}
