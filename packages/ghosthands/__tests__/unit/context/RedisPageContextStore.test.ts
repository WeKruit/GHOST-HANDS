import { describe, expect, it } from 'bun:test';
import { RedisPageContextStore } from '../../../src/context/RedisPageContextStore';
import { createEmptySession } from '../../../src/context/PageContextReducer';

describe('RedisPageContextStore', () => {
  it('rejects stale writes in the in-memory fallback store', async () => {
    const store = new RedisPageContextStore(null, 'job-store');
    const session = createEmptySession('job-store', 'run-store');

    await store.write({ ...session, version: 1 });
    const staleWrite = await store.write({ ...session, version: 1 }, 0);

    expect(staleWrite.saved).toBe(false);
    expect(staleWrite.current?.version).toBe(1);
  });
});
