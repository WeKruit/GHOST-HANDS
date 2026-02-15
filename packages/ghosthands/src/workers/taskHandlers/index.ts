import { taskHandlerRegistry } from './registry.js';
import { ApplyHandler } from './applyHandler.js';
import { ScrapeHandler } from './scrapeHandler.js';
import { FillFormHandler } from './fillFormHandler.js';
import { CustomHandler } from './customHandler.js';

export function registerBuiltinHandlers(): void {
  taskHandlerRegistry.register(new ApplyHandler());
  taskHandlerRegistry.register(new ScrapeHandler());
  taskHandlerRegistry.register(new FillFormHandler());
  taskHandlerRegistry.register(new CustomHandler());
}

export { taskHandlerRegistry } from './registry.js';
export type { TaskHandler, TaskContext, TaskResult, ValidationResult, AutomationJob } from './types.js';
