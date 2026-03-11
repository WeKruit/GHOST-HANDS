import { describe, expect, test } from 'bun:test';
import { StagehandPageCompat as AdapterStagehandPageCompat } from '../../adapters/stagehandCompat.js';
import { StagehandPageCompat as EngineStagehandPageCompat } from '../../engine/v3/StagehandCompat.js';

describe('StagehandPageCompat', () => {
  test('delegates bringToFront to the underlying Stagehand page in both compat layers', async () => {
    let callCount = 0;
    const rawPage = {
      bringToFront: async () => {
        callCount += 1;
      },
    };
    const stagehand = {} as any;

    await new AdapterStagehandPageCompat(rawPage, stagehand).bringToFront();
    await new EngineStagehandPageCompat(rawPage, stagehand).bringToFront();

    expect(callCount).toBe(2);
  });
});
