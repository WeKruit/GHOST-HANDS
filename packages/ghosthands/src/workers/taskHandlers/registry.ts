import type { TaskHandler } from './types.js';

export class TaskHandlerRegistry {
  private handlers = new Map<string, TaskHandler>();

  register(handler: TaskHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`TaskHandler already registered for type: ${handler.type}`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: string): TaskHandler | undefined {
    return this.handlers.get(type);
  }

  getOrThrow(type: string): TaskHandler {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No TaskHandler registered for type: ${type}. Available: ${this.listTypes().join(', ')}`);
    }
    return handler;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  listTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  list(): TaskHandler[] {
    return Array.from(this.handlers.values());
  }
}

/** Singleton registry instance */
export const taskHandlerRegistry = new TaskHandlerRegistry();
