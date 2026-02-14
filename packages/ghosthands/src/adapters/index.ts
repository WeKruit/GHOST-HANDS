export type {
  BrowserAutomationAdapter,
  AdapterStartOptions,
  ActionContext,
  ActionResult,
  TokenUsage,
  AdapterType,
  AdapterEvent,
  ObservedElement,
  LLMConfig,
  BrowserLaunchOptions,
} from './types';
export { MagnitudeAdapter } from './magnitude';
export { MockAdapter, type MockAdapterConfig } from './mock';

import type { BrowserAutomationAdapter, AdapterType } from './types';
import { MagnitudeAdapter } from './magnitude';
import { MockAdapter } from './mock';

export function createAdapter(type: AdapterType = 'magnitude'): BrowserAutomationAdapter {
  switch (type) {
    case 'magnitude':
      return new MagnitudeAdapter();
    case 'mock':
      return new MockAdapter();
    case 'stagehand':
      throw new Error('Stagehand adapter not yet implemented. Install @browserbasehq/stagehand and create StagehandAdapter.');
    case 'actionbook':
      throw new Error('Actionbook adapter not yet implemented. Install @actionbookdev/js-sdk and create ActionbookAdapter.');
    case 'hybrid':
      throw new Error('Hybrid adapter not yet implemented. Requires a primary adapter + Actionbook.');
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
