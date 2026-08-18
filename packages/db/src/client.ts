import postgres from 'postgres';
import { AppError } from '@wallet/shared';

/**
 * The single database entry point.
 *
 * Two deliberate choices:
 *
 * 1. **postgres.js with tagged templates, not an ORM.** Every interpolation in a
 *    ``sql`...` `` template becomes a bind parameter. There is no string concatenation path
 *    into the planner, so SQL injection is prevented structurally rather than by discipline.
 *    Dynamic identifiers must go through `sql()` helpers, which quote them.
 *
 * 2. **Identity is bound per transaction, not per connection.** `set_config(..., true)` is
 *    transaction-scoped, so a pooled connection cannot carry one request's user into the
 *    next. RLS policies read that setting, which means our own repositories are constrained
 *    by RLS too — a forgotten `WHERE user_id = ...` returns nothing instead of someone
 *    else's money.
 */

export type Sql = postgres.Sql<Record<string, never>>;
export type TransactionSql = postgres.TransactionSql<Record<string, never>>;

/**
 * postgres.js returns `BIGINT` and `NUMERIC` as strings by default, and we rely on that:
 * every money column is typed `string` in `types.ts` and converted with an explicit
 * `BigInt(...)` in the mapping layer. Registering a numeric parser here would silently
 * change that contract, so we deliberately do not.
 */
export type JsonInput = Parameters<Sql['json']>[0];
export const asJson = (value: unknown): JsonInput => value as JsonInput;

export interface DatabaseConfig {
  url: string;
  ssl: boolean;
  maxConnections: number;
  statementTimeoutMs: number;
  idleTimeoutSeconds: number;
  connectTimeoutSeconds: number;
  applicationName: string;
  debug?: boolean;
}

export function createDatabase(config: DatabaseConfig): Sql {
  return postgres(config.url, {
    max: config.maxConnections,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    ssl: config.ssl ? 'require' : false,
    prepare: true,
    // Postgres NOTICE output is noise in application logs and can echo user data.
    onnotice: () => {},
    connection: {
      application_name: config.applicationName,
      // A runaway query must not hold a connection (or a row lock) forever.
      statement_timeout: config.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.statementTimeoutMs * 2,
    },
    transform: { undefined: null },
  }) as Sql;
}

/**
 * A connection string with its credentials removed, safe to put in a log line.
 *
 * Returns `postgresql://role:***@host:port/database`. The password is replaced rather than
 * shortened, and the query string is dropped entirely — connection URLs can carry secrets
 * there too (`?password=`, `?sslcert=`), and no diagnostic needs them.
 *
 * A malformed URL yields a fixed placeholder. It deliberately never echoes the input, since
 * the thing that failed to parse may itself be the secret.
 */
export function describeConnection(url: string): string {
  try {
    const parsed = new URL(url);
    const decode = (value: string): string => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    const role = parsed.username ? decode(parsed.username) : '(no role)';
    const identity = parsed.password ? `${role}:***` : role;
    const port = parsed.port || '5432';
    const database = parsed.pathname.replace(/^\//, '') || '(default database)';
    return `${parsed.protocol}//${identity}@${parsed.hostname}:${port}/${database}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/** Raised when the migration connection string is missing. Carries no secret. */
export class MissingMigrationUrlError extends Error {
  constructor() {
    super(
      'DATABASE_MIGRATION_URL is not set. Migrations require the privileged database role ' +
        '(the one that owns the schema). This does NOT fall back to DATABASE_URL: that is ' +
        'the least-privilege runtime role and has no DDL rights, so the fallback could only ' +
        'fail as "permission denied for schema public", attributed to whichever service ' +
        'happened to run it.',
    );
    this.name = 'MissingMigrationUrlError';
  }
}

/**
 * Resolve the connection string migrations must use.
 *
 * Deliberately total and fallback-free: the runtime role can never be a valid answer here,
 * so treating its presence as a substitute converts a missing-variable error into a
 * privilege error at the first DDL statement — which is a far harder thing to read.
 */
export function migrationUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_MIGRATION_URL;
  if (!url) throw new MissingMigrationUrlError();
  return url;
}

export interface ActingUser {
  userId: string;
  isAdmin: boolean;
}

/** Anything that can run queries: the pool or an open transaction. */
export type Queryable = Sql | TransactionSql;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction bound to `actor`.
 *
 * The user id is validated as a UUID before it reaches `set_config`. It is passed as a bind
 * parameter, so this is defence in depth rather than the primary protection — but a
 * malformed value would otherwise surface as a confusing cast error deep inside a policy.
 */
export async function withUser<T>(
  sql: Sql,
  actor: ActingUser,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(actor.userId)) {
    throw new AppError('INTERNAL_ERROR', { internal: 'withUser called with a non-UUID user id' });
  }
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
    await tx`SELECT set_config('app.is_admin', ${actor.isAdmin ? 'true' : 'false'}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Run `fn` in an unbound (system) transaction: workers, authentication bootstrap, and
 * infrastructure tables. RLS still applies — unbound simply matches the policies written
 * for `app.current_user_id() IS NULL`, which are limited to system-plane tables.
 */
export async function withSystem<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', '', true)`;
    await tx`SELECT set_config('app.is_admin', 'false', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** PostgreSQL error codes we translate into domain errors rather than 500s. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
  INSUFFICIENT_PRIVILEGE: '42501',
} as const;

interface PostgresErrorShape {
  code?: string;
  constraint_name?: string;
  detail?: string;
  message?: string;
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as PostgresErrorShape).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint_name' in error) {
    const name = (error as PostgresErrorShape).constraint_name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (pgErrorCode(error) !== PG_ERROR.UNIQUE_VIOLATION) return false;
  return constraint ? pgConstraint(error) === constraint : true;
}

export function isRetryableDbError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return (
    code === PG_ERROR.SERIALIZATION_FAILURE ||
    code === PG_ERROR.DEADLOCK_DETECTED ||
    code === PG_ERROR.LOCK_NOT_AVAILABLE
  );
}

/**
 * Translate a driver error into an AppError without leaking SQL text or constraint details
 * to the client. The constraint name is kept in `internal` for operators only.
 */
export function translateDbError(error: unknown, fallbackInternal: string): AppError {
  if (AppError.is(error)) return error;
  const code = pgErrorCode(error);
  const constraint = pgConstraint(error);

  switch (code) {
    case PG_ERROR.UNIQUE_VIOLATION:
      return new AppError('CONFLICT', {
        internal: `unique violation on ${constraint ?? 'unknown constraint'}`,
        cause: error,
      });
    case PG_ERROR.FOREIGN_KEY_VIOLATION:
      return new AppError('VALIDATION_ERROR', {
        internal: `foreign key violation on ${constraint ?? 'unknown constraint'}`,
        cause: error,
      });
    case PG_ERROR.CHECK_VIOLATION:
      return new AppError('VALIDATION_ERROR', {
        internal: `check violation on ${constraint ?? 'unknown constraint'}`,
        cause: error,
      });
    case PG_ERROR.QUERY_CANCELED:
      return new AppError('TIMEOUT', { internal: 'statement timeout', cause: error });
    case PG_ERROR.SERIALIZATION_FAILURE:
    case PG_ERROR.DEADLOCK_DETECTED:
      return new AppError('CONFLICT', {
        internal: `concurrency conflict (${code})`,
        cause: error,
        retryable: true,
      });
    case PG_ERROR.INSUFFICIENT_PRIVILEGE:
      return new AppError('FORBIDDEN', {
        internal: 'insufficient database privilege',
        cause: error,
      });
    default:
      return new AppError('INTERNAL_ERROR', { internal: fallbackInternal, cause: error });
  }
}

/**
 * Retry a transaction on transient concurrency failures. Handlers passed here must be
 * idempotent — every caller in this codebase either writes through a unique key or is a
 * pure read.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 25,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableDbError(error) || attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw translateDbError(lastError, 'transaction failed after retries');
}
