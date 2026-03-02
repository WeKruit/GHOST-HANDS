/** Platform detection from URL patterns. */

const PLATFORM_PATTERNS: Array<{ platform: string; patterns: RegExp[] }> = [
  { platform: 'workday', patterns: [/\.myworkdayjobs\.com/, /\.wd\d\.myworkdaysite\.com/] },
  { platform: 'greenhouse', patterns: [/boards\.greenhouse\.io/, /job-boards\.greenhouse\.io/] },
  { platform: 'lever', patterns: [/jobs\.lever\.co/] },
  { platform: 'icims', patterns: [/\.icims\.com/] },
  { platform: 'taleo', patterns: [/\.taleo\.net/] },
  { platform: 'smartrecruiters', patterns: [/jobs\.smartrecruiters\.com/] },
  { platform: 'linkedin', patterns: [/linkedin\.com\/jobs/] },
];

export function detectPlatform(url: string): string {
  for (const { platform, patterns } of PLATFORM_PATTERNS) {
    if (patterns.some((p) => p.test(url))) return platform;
  }
  return 'other';
}

export function generateUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const hostParts = parsed.hostname.split('.');

    let hostPattern: string;
    if (hostParts.length >= 3) {
      hostPattern = '*.' + hostParts.slice(-2).join('.');
    } else {
      hostPattern = parsed.hostname;
    }

    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const patternSegments = pathSegments.map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return '*';
      if (/^\d+$/.test(seg)) return '*';
      if (/^[a-z]{2}(-[A-Z]{2})?$/.test(seg)) return '*';
      return seg;
    });

    return hostPattern + '/' + patternSegments.join('/');
  } catch {
    return url;
  }
}
