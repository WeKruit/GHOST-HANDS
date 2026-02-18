import { Context, Next } from 'hono';
import { createClient } from '@supabase/supabase-js';

export interface AuthContext {
  type: 'service' | 'user';
  userId?: string;
}

/**
 * Authentication middleware supporting two flows:
 * 1. Service-to-service: X-GH-Service-Key header matches GH_SERVICE_SECRET
 * 2. User JWT: Authorization Bearer token validated via Supabase Auth
 */
export async function authMiddleware(c: Context, next: Next) {
  const serviceKey = c.req.header('X-GH-Service-Key');
  const authHeader = c.req.header('Authorization');

  // Service-to-service authentication
  if (serviceKey) {
    const expectedSecret = process.env.GH_SERVICE_SECRET;
    if (!expectedSecret) {
      return c.json({ error: 'server_config_error', message: 'Service secret not configured' }, 500);
    }

    if (serviceKey !== expectedSecret) {
      return c.json({ error: 'unauthorized', message: 'Invalid service key' }, 401);
    }

    c.set('auth', { type: 'service' } satisfies AuthContext);
    return next();
  }

  // User JWT authentication
  if (authHeader?.startsWith('Bearer ')) {
    const jwt = authHeader.slice(7);

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return c.json({ error: 'server_config_error', message: 'Supabase not configured' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: { user }, error } = await supabase.auth.getUser(jwt);

    if (error || !user) {
      return c.json({ error: 'unauthorized', message: 'Invalid or expired token' }, 401);
    }

    c.set('auth', { type: 'user', userId: user.id } satisfies AuthContext);
    return next();
  }

  return c.json({ error: 'unauthorized', message: 'Missing authentication credentials' }, 401);
}

/** Helper to get the authenticated context from a request */
export function getAuth(c: Context): AuthContext {
  return c.get('auth') as AuthContext;
}

/**
 * Resolve the effective user_id for a request.
 * - Service callers can specify any user_id in the body.
 * - User callers are scoped to their own user_id (body user_id is ignored).
 */
export function resolveUserId(c: Context, bodyUserId?: string): string | null {
  const auth = getAuth(c);
  if (auth.type === 'service') {
    return bodyUserId || null;
  }
  return auth.userId || null;
}
