#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   node dist/cli/migrate.js up      apply pending migrations
 *   node dist/cli/migrate.js status  show what is applied
 *   node dist/cli/migrate.js reset   drop + recreate (development/test only)
 *
 * Connects with DATABASE_MIGRATION_URL (a privileged role) rather than the runtime
 * DATABASE_URL, so the application's own credentials never need DDL rights.
 *
 * That separation is only real if it is enforced. An earlier version of this file fell back
 * to DATABASE_URL when DATABASE_MIGRATION_URL was unset, which quietly handed migrations to
 * the unprivileged runtime role. Every statement here needs CREATE on a schema that
 * `app_user` deliberately does not have, so the fallback could not succeed — it could only
 * turn a missing variable into `permission denied for schema public`, attributed to the
 * service that happened to run it. There is no fallback now: a missing variable says so.
 */
import {
  createDatabase,
  describeConnection,
  MissingMigrationUrlError,
  migrationUrlFromEnv,
} from '../client.js';
import { migrateUp, migrationStatus, resetDatabase } from '../migrations.js';

/** postgres.js puts the server's error fields on the error, but not all are enumerable. */
interface PostgresErrorFields {
  code?: unknown;
  severity?: unknown;
  detail?: unknown;
  hint?: unknown;
  position?: unknown;
  routine?: unknown;
  schema_name?: unknown;
  table_name?: unknown;
  constraint_name?: unknown;
  query?: unknown;
  parameters?: unknown;
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Print everything the driver knows about a failure.
 *
 * The previous version logged `error.message` alone. That is how a one-line misconfiguration
 * ("permission denied for schema public") became a long hunt: no SQLSTATE, no failing
 * statement, and no indication of which role or host the command had connected as. All three
 * are here now.
 *
 * Bind parameters are reported by count only. Migrations are plain DDL and carry none, but
 * the count keeps a future caller from turning this into a value dump.
 */
function reportFailure(error: unknown, connection: string): void {
  console.error('Migration failed.');
  console.error(`  connection: ${connection}`);

  if (!(error instanceof Error)) {
    console.error(`  error: ${String(error)}`);
    return;
  }

  const fields = error as unknown as PostgresErrorFields;
  console.error(`  message:    ${error.message}`);

  const code = asText(fields.code);
  if (code) console.error(`  sqlstate:   ${code}`);
  for (const [label, value] of [
    ['severity', fields.severity],
    ['detail', fields.detail],
    ['hint', fields.hint],
    ['schema', fields.schema_name],
    ['table', fields.table_name],
    ['constraint', fields.constraint_name],
    ['position', fields.position],
    ['routine', fields.routine],
  ] as const) {
    const text = asText(value);
    if (text) console.error(`  ${label.padEnd(11)} ${text}`);
  }

  const query = asText(fields.query);
  if (query) console.error(`  query:\n${query.replace(/^/gm, '    ')}`);
  if (Array.isArray(fields.parameters)) {
    console.error(`  parameters: ${fields.parameters.length} bind value(s), not shown`);
  }

  if (code === '42501') {
    console.error(
      `\n  SQLSTATE 42501 is a privilege error, not a connectivity or credentials error.\n` +
        `  The connection succeeded; the role above simply may not perform this statement.\n` +
        `  Check that DATABASE_MIGRATION_URL points at the privileged migration role and not\n` +
        `  at the runtime role.`,
    );
  }

  if (error.stack) console.error(`\n${error.stack}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const url = migrationUrlFromEnv();
  const appEnv = process.env.APP_ENV ?? 'development';
  const connection = describeConnection(url);

  console.log(`Migrating as ${connection}`);

  const sql = createDatabase({
    url,
    ssl: process.env.DATABASE_SSL === 'true',
    maxConnections: 2,
    statementTimeoutMs: 120_000,
    idleTimeoutSeconds: 10,
    connectTimeoutSeconds: 15,
    applicationName: 'wallet-migrate',
  });

  try {
    switch (command) {
      case 'up': {
        const result = await migrateUp(sql, { log: (message) => console.log(`  ${message}`) });
        console.log(
          `Applied ${result.applied.length} migration(s); ${result.skipped.length} already up to date.`,
        );
        break;
      }
      case 'status': {
        const rows = await migrationStatus(sql);
        for (const row of rows) {
          const state = row.applied
            ? row.checksumMatches
              ? 'applied'
              : 'APPLIED (checksum mismatch!)'
            : 'pending';
          console.log(`${row.version}  ${row.name.padEnd(32)}  ${state}`);
        }
        break;
      }
      case 'reset': {
        const result = await resetDatabase(sql, {
          confirm: process.env.CONFIRM_RESET === 'yes',
          appEnv,
          log: (message) => console.log(`  ${message}`),
        });
        console.log(`Database reset; applied ${result.applied.length} migration(s).`);
        break;
      }
      default:
        console.error(`Unknown command: ${command}. Use up | status | reset.`);
        process.exitCode = 1;
    }
  } catch (error) {
    reportFailure(error, connection);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error: unknown) => {
  if (error instanceof MissingMigrationUrlError) {
    console.error(error.message);
    process.exit(1);
  }
  // Anything else that escapes `main` happened before a connection existed (bad URL,
  // unreachable host). There is no connection identity beyond what was attempted.
  reportFailure(error, describeConnection(process.env.DATABASE_MIGRATION_URL ?? ''));
  process.exit(1);
});
