import { randomUUID } from 'node:crypto';
import { pino, type Logger as PinoLogger } from 'pino';
import { redact } from '@wallet/shared';
import type { ServerConfig } from './config.js';

/**
 * Structured logging.
 *
 * Two layers of secret protection:
 *   1. pino's own `redact` paths, which cover the obvious header/body shapes;
 *   2. our `redact()` helper, applied to every object we log, which is deny-by-pattern on
 *      key names *and* scans string values for things that look like bot tokens, long key
 *      blobs, or Postgres URLs with credentials.
 *
 * The second layer exists because the first only protects fields you remembered to list.
 */

export interface LogContext {
  requestId?: string;
  userId?: string;
  service?: string;
  operation?: string;
  [key: string]: unknown;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-telegram-bot-api-secret-token"]',
  'res.headers["set-cookie"]',
  'botToken',
  'token',
  'initData',
  'pin',
  'privateKey',
  'secret',
  '*.botToken',
  '*.token',
  '*.secret',
  '*.privateKey',
];

class PinoAdapter implements Logger {
  constructor(private readonly base: PinoLogger) {}

  private emit(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    context?: LogContext,
  ): void {
    if (context) {
      this.base[level](redact(context) as object, message);
    } else {
      this.base[level](message);
    }
  }

  trace(message: string, context?: LogContext): void {
    this.emit('trace', message, context);
  }
  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }
  fatal(message: string, context?: LogContext): void {
    this.emit('fatal', message, context);
  }

  child(context: LogContext): Logger {
    return new PinoAdapter(this.base.child(redact(context) as object));
  }
}

export function createLogger(
  config: Pick<ServerConfig, 'log' | 'appEnv' | 'version'>,
  service: string,
): Logger {
  const base = pino({
    level: config.log.level,
    base: { service, env: config.appEnv, version: config.version },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    ...(config.log.pretty
      ? {
          transport: {
            target: 'pino/file',
            options: { destination: 1 },
          },
        }
      : {}),
  });

  return new PinoAdapter(base);
}

/** A logger that discards everything. Used in unit tests. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

/**
 * Request correlation id.
 *
 * Accepts a client-supplied `x-request-id` only if it looks like an id — otherwise a
 * caller could inject newlines into log lines (log forging) or blow up log volume with a
 * megabyte header.
 */
export function resolveRequestId(headerValue: string | null | undefined): string {
  if (headerValue && /^[A-Za-z0-9_-]{8,64}$/.test(headerValue)) return headerValue;
  return randomUUID();
}
