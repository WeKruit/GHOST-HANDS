import type Redis from 'ioredis';
import type { PageContextSession } from './types.js';

const DEFAULT_TTL_SECONDS = 60 * 60 * 48;
const RETAIN_TTL_SECONDS = 60 * 60 * 24;

export class RedisPageContextStore {
  private inMemorySession: PageContextSession | null = null;

  constructor(
    private readonly redis: Redis | null,
    private readonly jobId: string,
  ) {}

  sessionKey(mastraRunId: string): string {
    return `gh:pagectx:session:${this.jobId}:${mastraRunId}`;
  }

  lockKey(mastraRunId: string): string {
    return `gh:pagectx:lock:${this.jobId}:${mastraRunId}`;
  }

  async read(mastraRunId: string): Promise<PageContextSession | null> {
    if (!this.redis) {
      return this.inMemorySession;
    }

    const raw = await this.redis.get(this.sessionKey(mastraRunId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PageContextSession;
    } catch {
      return null;
    }
  }

  async write(
    session: PageContextSession,
    expectedVersion?: number,
  ): Promise<{ saved: boolean; current?: PageContextSession | null }> {
    if (!this.redis) {
      if (
        typeof expectedVersion === 'number' &&
        this.inMemorySession &&
        this.inMemorySession.version !== expectedVersion
      ) {
        return { saved: false, current: this.inMemorySession };
      }
      this.inMemorySession = session;
      return { saved: true, current: session };
    }

    const key = this.sessionKey(session.mastraRunId);
    const current = await this.read(session.mastraRunId);
    if (typeof expectedVersion === 'number' && current && current.version !== expectedVersion) {
      return { saved: false, current };
    }

    await this.redis.set(key, JSON.stringify(session), 'EX', DEFAULT_TTL_SECONDS);
    return { saved: true, current: session };
  }

  async retain(session: PageContextSession, keepDebug = false): Promise<void> {
    if (!this.redis) {
      if (!keepDebug) {
        this.inMemorySession = null;
      }
      return;
    }

    const key = this.sessionKey(session.mastraRunId);
    if (keepDebug) {
      await this.redis.expire(key, RETAIN_TTL_SECONDS);
      return;
    }

    await this.redis.del(key);
  }
}
