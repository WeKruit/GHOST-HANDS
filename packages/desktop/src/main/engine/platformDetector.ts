/**
 * platformDetector — URL-based ATS platform detection.
 *
 * Pure function, zero dependencies. Copied from PageObserver.ts.
 */

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
