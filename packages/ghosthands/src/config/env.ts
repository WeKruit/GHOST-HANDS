import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  GHOSTHANDS_TABLE_PREFIX: z.string().default('gh_'),
  GH_EMAIL_AUTOMATION_ENABLED: z.enum(['true', 'false']).default('false'),
  GH_EMAIL_PROVIDER: z.string().default('gmail_api'),
  GH_GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GH_GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GH_GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  GH_GOOGLE_OAUTH_STATE_SECRET: z.string().optional(),
  GH_EMAIL_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GH_EMAIL_TOKEN_ENCRYPTION_KEY_ID: z.coerce.number().int().positive().default(1),
  GH_GMAIL_VERIFICATION_TIMEOUT_SECONDS: z.coerce.number().positive().default(120),
  GH_GMAIL_VERIFICATION_POLL_SECONDS: z.coerce.number().positive().default(5),
  GH_GMAIL_VERIFICATION_LOOKBACK_MINUTES: z.coerce.number().positive().default(15),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
