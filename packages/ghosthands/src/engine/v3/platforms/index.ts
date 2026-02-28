/**
 * Platform handler registry for the v2 hybrid execution engine.
 *
 * Returns the appropriate PlatformHandler for a given platform identifier,
 * or null if the platform is not recognized (falls back to generic matching).
 */

import type { PlatformHandler } from '../v2types';
import { WorkdayPlatformHandler } from './workday';

export function getPlatformHandler(platform: string): PlatformHandler | null {
  switch (platform) {
    case 'workday':
      return new WorkdayPlatformHandler();
    default:
      return null;
  }
}
