import { Context, Next } from 'hono';
import { ZodSchema, ZodError } from 'zod';

/**
 * Creates middleware that validates the request body against a Zod schema.
 * Parsed data is stored in c.set('validatedBody', data).
 */
export function validateBody(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: 'bad_request', message: 'Invalid JSON body' },
        400,
      );
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      return c.json(
        {
          error: 'validation_error',
          details: formatZodError(result.error),
        },
        422,
      );
    }

    c.set('validatedBody', result.data);
    return next();
  };
}

/**
 * Creates middleware that validates query params against a Zod schema.
 * Parsed data is stored in c.set('validatedQuery', data).
 */
export function validateQuery(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    const raw = c.req.query();
    const result = schema.safeParse(raw);

    if (!result.success) {
      return c.json(
        {
          error: 'validation_error',
          details: formatZodError(result.error),
        },
        422,
      );
    }

    c.set('validatedQuery', result.data);
    return next();
  };
}

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}
