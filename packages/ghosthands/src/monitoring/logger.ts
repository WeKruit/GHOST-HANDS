import { getEnv } from '../config/env.js';

// --- Types ---

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  service: string;
  requestId?: string;
  workerId?: string;
  jobId?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  service?: string;
  requestId?: string;
  workerId?: string;
  jobId?: string;
}

// --- Log level ordering ---

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// --- Secret redaction ---

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apiKey',
  'api-key',
  'authorization',
  'cookie',
  'session',
  'credential',
  'private_key',
  'privateKey',
  'cdp_url',
  'cdpUrl',
  'connect_url',
  'connectUrl',
  'connection_string',
  'connectionString',
  'supabase_key',
  'supabaseKey',
  'service_key',
  'serviceKey',
  'service_secret',
  'serviceSecret',
  'encrypted_value',
  'encryptedValue',
  'ssn',
  'social_security',
  'credit_card',
  'card_number',
  'cvv',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
]);

const SENSITIVE_PATTERNS = [
  /(?:sk|pk|key|token|secret|password)[_-]?[a-zA-Z0-9]{16,}/g,
  /(?:eyJ)[a-zA-Z0-9._-]{20,}/g, // JWTs
  /(?:ws|wss):\/\/[^\s"']+/g, // WebSocket URLs (CDP)
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email addresses
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN format (xxx-xx-xxxx)
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, // Credit card numbers
];

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    const lowerKey = key.toLowerCase();
    for (const sensitive of SENSITIVE_KEYS) {
      if (lowerKey.includes(sensitive)) {
        return '[REDACTED]';
      }
    }
    // Redact inline secrets in string values
    let redacted = value;
    for (const pattern of SENSITIVE_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === 'object'
          ? redactObject(item as Record<string, unknown>)
          : redactValue(key, item)
      );
    } else {
      result[key] = redactValue(key, value);
    }
  }
  return result;
}

// --- Logger class ---

export class Logger {
  private level: LogLevel;
  private service: string;
  private context: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    const env = getEnv();
    this.level = opts.level ?? (env.NODE_ENV === 'production' ? 'info' : 'debug');
    this.service = opts.service ?? 'ghosthands';
    this.context = {};

    if (opts.requestId) this.context.requestId = opts.requestId;
    if (opts.workerId) this.context.workerId = opts.workerId;
    if (opts.jobId) this.context.jobId = opts.jobId;
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = new Logger({
      level: this.level,
      service: this.service,
    });
    child.context = { ...this.context, ...bindings };
    return child;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level]) return;

    const entry: LogEntry = {
      level,
      msg,
      timestamp: new Date().toISOString(),
      service: this.service,
      ...this.context,
      ...(data ? redactObject(data) : {}),
    };

    const line = JSON.stringify(entry);

    switch (level) {
      case 'error':
        console.error(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'debug':
        console.debug(line);
        break;
      default:
        console.log(line);
    }
  }
}

// --- Singleton for convenience ---

let _defaultLogger: Logger | null = null;

export function getLogger(opts?: LoggerOptions): Logger {
  if (!_defaultLogger || opts) {
    _defaultLogger = new Logger(opts);
  }
  return _defaultLogger;
}

// --- Hono middleware for request logging ---

export function requestLoggingMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const requestId =
      c.req.header('x-request-id') ?? crypto.randomUUID();
    const start = Date.now();

    // Attach request ID to context for downstream use
    c.set('requestId', requestId);

    const log = getLogger().child({ requestId });

    log.info('request_started', {
      method: c.req.method,
      path: c.req.path,
      userAgent: c.req.header('user-agent'),
    });

    c.header('X-Request-Id', requestId);

    await next();

    const duration = Date.now() - start;
    log.info('request_completed', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: duration,
    });
  };
}
