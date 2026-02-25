/**
 * LocalManualStore — File-system-based cookbook store for the desktop app.
 *
 * Stores ActionManual JSON files in the app's userData directory.
 * Replaces the Supabase-backed ManualStore used by the server.
 */

import { app } from 'electron';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { ActionManual } from './types';

export class LocalManualStore {
  private dir: string;

  constructor() {
    this.dir = join(app.getPath('userData'), 'manuals');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.seedBundled();
  }

  /**
   * Auto-seed bundled cookbooks from the source tree on first run.
   * Looks for cookbooks/ directory relative to the app root.
   * Only copies files that don't already exist in the store.
   */
  private seedBundled(): void {
    // In dev: __dirname is packages/desktop/out/main/ → go up to packages/desktop/
    // In prod: app.getAppPath() points to the app root
    const candidates = [
      join(dirname(dirname(__dirname)), 'cookbooks'),         // dev: out/main/ → ../../cookbooks
      join(app.getAppPath(), 'cookbooks'),                    // prod: app root
      join(dirname(dirname(dirname(__dirname))), 'cookbooks'), // fallback
    ];

    for (const cookbookDir of candidates) {
      if (!existsSync(cookbookDir)) continue;

      let files: string[];
      try {
        files = readdirSync(cookbookDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        try {
          const raw = readFileSync(join(cookbookDir, file), 'utf-8');
          const manual = JSON.parse(raw) as ActionManual;
          const destPath = join(this.dir, `${manual.id}.json`);
          if (!existsSync(destPath)) {
            writeFileSync(destPath, raw, 'utf-8');
          }
        } catch {
          // Skip invalid files
        }
      }
      break; // Stop after first valid cookbooks directory
    }
  }

  /**
   * Look up the best-matching manual for a URL and task type.
   * Returns the manual with the highest health score among matches, or null.
   */
  lookup(url: string, taskType: string, platform?: string): ActionManual | null {
    const manuals = this.getAll();

    const candidates = manuals
      .filter((m) => m.task_pattern === taskType)
      .filter((m) => !platform || m.platform === platform || m.platform === 'other')
      .filter((m) => m.health_score > 0)
      .filter((m) => LocalManualStore.urlMatchesPattern(url, m.url_pattern))
      .sort((a, b) => b.health_score - a.health_score);

    return candidates[0] ?? null;
  }

  /** Save an ActionManual to disk as {id}.json. */
  save(manual: ActionManual): void {
    const filePath = join(this.dir, `${manual.id}.json`);
    writeFileSync(filePath, JSON.stringify(manual, null, 2), 'utf-8');
  }

  /** Load all manuals from disk. */
  getAll(): ActionManual[] {
    const manuals: ActionManual[] = [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), 'utf-8');
        manuals.push(JSON.parse(raw) as ActionManual);
      } catch {
        // Skip corrupted files
      }
    }

    return manuals;
  }

  /** Remove a manual by ID. */
  remove(id: string): boolean {
    const filePath = join(this.dir, `${id}.json`);
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ── Static URL matching helpers (from ManualStore) ────────────────────

  /**
   * Convert a concrete URL into a glob-style pattern.
   *
   * Example: https://acme.myworkdayjobs.com/en-US/careers/job/NYC/apply
   *       -> *.myworkdayjobs.com/[star]/careers/job/[star]/apply
   */
  static urlToPattern(url: string): string {
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
  }

  /**
   * Test whether a URL matches a glob-style pattern.
   * '*' matches any single path segment or subdomain part.
   */
  static urlMatchesPattern(url: string, pattern: string): boolean {
    try {
      const parsed = new URL(url);
      const urlStr = parsed.hostname + parsed.pathname.replace(/\/$/, '');
      const patternStr = pattern.replace(/\/$/, '');

      const regexStr = '^' + patternStr
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]+')
        + '$';

      return new RegExp(regexStr).test(urlStr);
    } catch {
      return false;
    }
  }
}
