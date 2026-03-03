/**
 * Browser Session Registry — in-memory singleton tracking the active browser session.
 *
 * Only one job runs per GH worker at a time, so this registry holds at most one entry.
 * The REST endpoint (/internal/browser-session) reads the public snapshot.
 * The CDP proxy WebSocket reads the internal cdpWsUrl (never exposed via REST).
 */

import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'browser-session-registry' });

export interface BrowserSession {
  jobId: string;
  workerId: string;
  engine: 'chromium'; // v1 only — "adspower" future
  cdpWsUrl: string;   // ws://127.0.0.1:{port}/devtools/browser/{id}
  debugPort: number;
  pausedForHuman: boolean;
  pauseReason?: string; // "waiting_human" | "awaiting_user_review"
  activeTargetId?: string;
  pageUrl?: string;
  pageTitle?: string;
  viewport?: { width: number; height: number };
  updatedAt: number;
}

/** Public snapshot — everything EXCEPT cdpWsUrl */
export type BrowserSessionSnapshot = Omit<BrowserSession, 'cdpWsUrl'>;

class BrowserSessionRegistry {
  private sessions = new Map<string, BrowserSession>();

  /** Register or update a browser session for a job */
  register(session: BrowserSession): void {
    this.sessions.set(session.jobId, { ...session, updatedAt: Date.now() });
    logger.info('Browser session registered', { jobId: session.jobId, engine: session.engine, debugPort: session.debugPort });
  }

  /** Get the full session (including cdpWsUrl) by jobId — internal use only */
  get(jobId: string): BrowserSession | undefined {
    return this.sessions.get(jobId);
  }

  /** Get the single current session (one job per worker) */
  getCurrent(): BrowserSession | undefined {
    // There should be at most one entry; return the first
    for (const session of this.sessions.values()) {
      return session;
    }
    return undefined;
  }

  /** Update pause state for a job */
  setPausedForHuman(jobId: string, paused: boolean, reason?: string): void {
    const session = this.sessions.get(jobId);
    if (!session) return;
    session.pausedForHuman = paused;
    session.pauseReason = paused ? reason : undefined;
    session.updatedAt = Date.now();
    logger.info('Browser session pause state updated', { jobId, paused, reason });
  }

  /** Update page metadata (URL, title) for a job */
  updatePageMeta(jobId: string, url?: string, title?: string): void {
    const session = this.sessions.get(jobId);
    if (!session) return;
    if (url !== undefined) session.pageUrl = url;
    if (title !== undefined) session.pageTitle = title;
    session.updatedAt = Date.now();
  }

  /** Remove session on job completion/failure/resume */
  clear(jobId: string): void {
    const deleted = this.sessions.delete(jobId);
    if (deleted) {
      logger.info('Browser session cleared', { jobId });
    }
  }

  /** Return session data WITHOUT cdpWsUrl — safe for REST responses */
  getPublicSnapshot(): (BrowserSessionSnapshot & { available: true }) | { available: false; reason: string } {
    const session = this.getCurrent();
    if (!session) {
      return { available: false, reason: 'no_session' };
    }
    if (!session.pausedForHuman) {
      return { available: false, reason: 'not_paused' };
    }
    // Engine check: v1 is chromium-only
    if (session.engine !== 'chromium') {
      return { available: false, reason: 'unsupported_engine' };
    }

    // Strip cdpWsUrl — NEVER include in public snapshot
    const { cdpWsUrl: _excluded, ...publicFields } = session;
    return {
      available: true,
      ...publicFields,
      updatedAt: session.updatedAt,
    };
  }
}

/** Module-level singleton */
export const browserSessionRegistry = new BrowserSessionRegistry();
