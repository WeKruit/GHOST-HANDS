import { Context } from 'hono';
import { getLogger } from '../../monitoring/logger.js';

/**
 * Global error handler for the Hono app. Catches unhandled errors and
 * returns a consistent JSON error response.
 */
export function errorHandler(err: Error, c: Context) {
  getLogger().error('API error', { message: err.message, stack: err.stack });

  // Hono HTTPException
  if ('status' in err && typeof (err as any).status === 'number') {
    const status = (err as any).status as number;
    return c.json(
      {
        error: 'http_error',
        message: err.message,
      },
      status as any,
    );
  }

  return c.json(
    {
      error: 'internal_error',
      message: 'An unexpected error occurred',
    },
    500,
  );
}
