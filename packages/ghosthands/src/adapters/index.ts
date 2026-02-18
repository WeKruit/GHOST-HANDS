export type {
  BrowserAutomationAdapter,
  HitlCapableAdapter,
  AdapterStartOptions,
  ActionContext,
  ActionResult,
  TokenUsage,
  AdapterType,
  AdapterEvent,
  ObservedElement,
  ObservationResult,
  ObservationBlocker,
  BlockerCategory,
  ResolutionContext,
  LLMConfig,
  BrowserLaunchOptions,
} from './types';
export { MagnitudeAdapter } from './magnitude';
export { MockAdapter, type MockAdapterConfig, type MockBlockerConfig } from './mock';

import type { HitlCapableAdapter, AdapterType } from './types';
import { MagnitudeAdapter } from './magnitude';
import { MockAdapter } from './mock';

const HITL_METHODS = ['observe', 'pause', 'resume', 'isPaused', 'screenshot', 'getCurrentUrl', 'observeWithBlockerDetection'] as const;

/**
 * Validate that an adapter implements all required HitlCapableAdapter methods.
 * Throws if any method is missing.
 */
function assertHitlCapable(adapter: unknown, type: string): asserts adapter is HitlCapableAdapter {
  for (const method of HITL_METHODS) {
    if (typeof (adapter as any)[method] !== 'function') {
      throw new Error(`Adapter '${type}' does not implement required HITL method: ${method}`);
    }
  }
}

export function createAdapter(type: AdapterType = 'magnitude'): HitlCapableAdapter {
  let adapter: HitlCapableAdapter;
  switch (type) {
    case 'magnitude':
      adapter = new MagnitudeAdapter();
      break;
    case 'mock':
      adapter = new MockAdapter();
      break;
    case 'stagehand':
      throw new Error('Stagehand adapter not yet implemented. Install @browserbasehq/stagehand and create StagehandAdapter.');
    case 'actionbook':
      throw new Error('Actionbook adapter not yet implemented. Install @actionbookdev/js-sdk and create ActionbookAdapter.');
    case 'hybrid':
      throw new Error('Hybrid adapter not yet implemented. Requires a primary adapter + Actionbook.');
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
  assertHitlCapable(adapter, type);
  return adapter;
}
