/**
 * Minimal logger for the desktop Workday pipeline.
 *
 * Matches the staging getLogger() API so copied files need zero changes
 * to their logging calls. Wraps console with a [Workday] prefix.
 */

const PREFIX = '[Workday]';

const logger = {
  debug(msg: string, meta?: Record<string, unknown>) {
    console.debug(PREFIX, msg, meta ?? '');
  },
  info(msg: string, meta?: Record<string, unknown>) {
    console.log(PREFIX, msg, meta ?? '');
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    console.warn(PREFIX, msg, meta ?? '');
  },
  error(msg: string, meta?: Record<string, unknown>) {
    console.error(PREFIX, msg, meta ?? '');
  },
};

export function getLogger() {
  return logger;
}
