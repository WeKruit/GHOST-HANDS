/**
 * ManualStore — CRUD for gh_action_manuals (cookbooks).
 *
 * Manages lookup, creation, and health scoring of action manuals.
 * URL matching uses glob-style patterns (e.g. [star].workday.com/[star]/apply/[star]).
 *
 * Health score lives in the DB on a 0-100 scale (REAL):
 *   - Recorded manuals start at 100
 *   - ActionBook manuals start at 80
 *   - Each failure: -5 (or -15 after 5+ failures)
 *   - Each success: +2 (capped at 100)
 *
 * ActionManual types use a 0-1 scale; this store converts at the boundary.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionManual, ManualStep, ManualSource } from './types';

// ── Constants ────────────────────────────────────────────────────────────

const TABLE = 'gh_action_manuals';

const INITIAL_HEALTH: Record<ManualSource, number> = {
  recorded: 100,
  actionbook: 80,
  template: 100,
};

const SUCCESS_BONUS = 2;
const FAILURE_PENALTY = 5;
const SEVERE_FAILURE_PENALTY = 15;
const SEVERE_FAILURE_THRESHOLD = 5;
const MAX_HEALTH = 100;
const MIN_HEALTH = 0;

// ── Types ────────────────────────────────────────────────────────────────

export interface ManualStoreConfig {
  supabase: SupabaseClient;
}

export interface SaveFromTraceMetadata {
  url: string;
  taskType: string;
  platform?: string;
}

export interface SaveFromActionBookMetadata {
  /** Pre-built glob pattern (preferred for ActionBook imports) */
  urlPattern?: string;
  /** Concrete URL to convert into a pattern (used when urlPattern not available) */
  url?: string;
  taskType: string;
  platform?: string;
}

/** Raw row shape from the DB (health_score on 0-100 scale). */
interface ManualRow {
  id: string;
  url_pattern: string;
  task_pattern: string;
  platform: string | null;
  steps: unknown;
  health_score: number;
  source: string | null;
  success_count: number;
  failure_count: number;
  last_used: string | null;
  created_at: string;
  updated_at: string;
}

// ── Implementation ──────────────────────────────────────────────────────

export class ManualStore {
  private supabase: SupabaseClient;

  constructor(configOrClient: ManualStoreConfig | SupabaseClient) {
    this.supabase = 'from' in configOrClient
      ? configOrClient
      : configOrClient.supabase;
  }

  /**
   * Look up the best-matching manual for a URL and task type.
   *
   * Returns the manual with the highest health score among matches,
   * or null if no manuals match.
   */
  async lookup(
    url: string,
    taskType: string,
    platform?: string,
  ): Promise<ActionManual | null> {
    let query = this.supabase
      .from(TABLE)
      .select('*')
      .eq('task_pattern', taskType)
      .gt('health_score', 0)
      .order('health_score', { ascending: false })
      .limit(10);

    if (platform) {
      query = query.eq('platform', platform);
    }

    const { data, error } = await query;

    if (error || !data || data.length === 0) {
      return null;
    }

    // Find best match: check url_pattern against the provided URL
    for (const row of data as ManualRow[]) {
      if (ManualStore.urlMatchesPattern(url, row.url_pattern)) {
        return ManualStore.rowToManual(row);
      }
    }

    return null;
  }

  /**
   * Retrieve a manual by ID.
   * Returns null if not found.
   */
  async get(manualId: string): Promise<ActionManual | null> {
    const row = await this.getRow(manualId);
    if (!row) return null;
    return ManualStore.rowToManual(row);
  }

  /**
   * Save a manual from a recorded trace (live run).
   * Health score starts at 100.
   */
  async saveFromTrace(
    steps: ManualStep[],
    metadata: SaveFromTraceMetadata,
  ): Promise<ActionManual> {
    const urlPattern = ManualStore.urlToPattern(metadata.url);
    return this.insertManual({
      urlPattern,
      taskType: metadata.taskType,
      platform: metadata.platform ?? 'other',
      steps,
      source: 'recorded',
    });
  }

  /**
   * Save a manual from an ActionBook result.
   * Health score starts at 80.
   */
  async saveFromActionBook(
    steps: ManualStep[],
    metadata: SaveFromActionBookMetadata,
  ): Promise<ActionManual> {
    const urlPattern = metadata.urlPattern
      ?? (metadata.url ? ManualStore.urlToPattern(metadata.url) : '*');
    return this.insertManual({
      urlPattern,
      taskType: metadata.taskType,
      platform: metadata.platform ?? 'other',
      steps,
      source: 'actionbook',
    });
  }

  /**
   * Record a successful use of a manual.
   * Increments success_count, adds +2 to health (cap 100), updates last_used.
   */
  async recordSuccess(manualId: string): Promise<void> {
    const row = await this.getRow(manualId);
    if (!row) return;

    const newHealth = Math.min(MAX_HEALTH, row.health_score + SUCCESS_BONUS);

    await this.supabase
      .from(TABLE)
      .update({
        success_count: row.success_count + 1,
        health_score: newHealth,
        last_used: new Date().toISOString(),
      })
      .eq('id', manualId);
  }

  /**
   * Record a failed use of a manual.
   * Increments failure_count, degrades health (-5, or -15 after 5+ failures).
   */
  async recordFailure(manualId: string): Promise<void> {
    const row = await this.getRow(manualId);
    if (!row) return;

    const newFailureCount = row.failure_count + 1;
    const penalty = newFailureCount > SEVERE_FAILURE_THRESHOLD
      ? SEVERE_FAILURE_PENALTY
      : FAILURE_PENALTY;
    const newHealth = Math.max(MIN_HEALTH, row.health_score - penalty);

    await this.supabase
      .from(TABLE)
      .update({
        failure_count: newFailureCount,
        health_score: newHealth,
      })
      .eq('id', manualId);
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private async insertManual(params: {
    urlPattern: string;
    taskType: string;
    platform: string;
    steps: ManualStep[];
    source: ManualSource;
  }): Promise<ActionManual> {
    const now = new Date().toISOString();
    const health = INITIAL_HEALTH[params.source];

    const { data, error } = await this.supabase
      .from(TABLE)
      .insert({
        url_pattern: params.urlPattern,
        task_pattern: params.taskType,
        platform: params.platform,
        steps: params.steps,
        health_score: health,
        source: params.source,
        success_count: 0,
        failure_count: 0,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`ManualStore.insert failed: ${error.message}`);
    }

    return ManualStore.rowToManual(data as ManualRow);
  }

  private async getRow(manualId: string): Promise<ManualRow | null> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select('*')
      .eq('id', manualId)
      .single();

    if (error || !data) return null;
    return data as ManualRow;
  }

  // ── Static helpers ────────────────────────────────────────────────────

  /**
   * Convert a DB row (health 0-100) to an ActionManual (health 0-1).
   */
  static rowToManual(row: ManualRow): ActionManual {
    return {
      id: row.id,
      url_pattern: row.url_pattern,
      task_pattern: row.task_pattern,
      platform: row.platform ?? 'other',
      steps: row.steps as ManualStep[],
      health_score: row.health_score / 100,
      source: (row.source ?? 'recorded') as ManualSource,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Convert a concrete URL into a glob-style pattern.
   *
   * Example: https://acme.myworkdayjobs.com/en-US/careers/job/NYC/apply
   *       -> [star].myworkdayjobs.com/[star]/careers/job/[star]/apply
   */
  static urlToPattern(url: string): string {
    const parsed = new URL(url);
    const hostParts = parsed.hostname.split('.');

    // Wildcard the subdomain if there are 3+ parts
    let hostPattern: string;
    if (hostParts.length >= 3) {
      hostPattern = '*.' + hostParts.slice(-2).join('.');
    } else {
      hostPattern = parsed.hostname;
    }

    // Wildcard path segments that look dynamic (UUIDs, IDs, locale codes)
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const patternSegments = pathSegments.map((seg) => {
      // UUID pattern
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return '*';
      // Numeric ID
      if (/^\d+$/.test(seg)) return '*';
      // Short locale codes (e.g. en-US)
      if (/^[a-z]{2}(-[A-Z]{2})?$/.test(seg)) return '*';
      return seg;
    });

    return hostPattern + '/' + patternSegments.join('/');
  }

  /**
   * Test whether a URL matches a glob-style pattern.
   *
   * '*' matches any single path segment or subdomain part.
   */
  static urlMatchesPattern(url: string, pattern: string): boolean {
    const parsed = new URL(url);
    const urlStr = parsed.hostname + parsed.pathname.replace(/\/$/, '');
    const patternStr = pattern.replace(/\/$/, '');

    // Convert glob pattern to regex
    const regexStr = '^' + patternStr
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex specials (not *)
      .replace(/\*/g, '[^/]+')                  // * matches one segment
      + '$';

    return new RegExp(regexStr).test(urlStr);
  }

  /**
   * Compute the new health score given current state and an outcome.
   * Exported for testability.
   */
  static computeHealth(
    currentHealth: number,
    failureCount: number,
    outcome: 'success' | 'failure',
  ): number {
    if (outcome === 'success') {
      return Math.min(MAX_HEALTH, currentHealth + SUCCESS_BONUS);
    }
    const newFailureCount = failureCount + 1;
    const penalty = newFailureCount > SEVERE_FAILURE_THRESHOLD
      ? SEVERE_FAILURE_PENALTY
      : FAILURE_PENALTY;
    return Math.max(MIN_HEALTH, currentHealth - penalty);
  }

  /** Convenience: compute health after a single success. */
  static computeHealthAfterSuccess(currentHealth: number): number {
    return ManualStore.computeHealth(currentHealth, 0, 'success');
  }

  /** Convenience: compute health after a single failure at the given failure count. */
  static computeHealthAfterFailure(currentHealth: number, failureCount: number): number {
    return ManualStore.computeHealth(currentHealth, failureCount, 'failure');
  }
}
