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
 */
import { createDatabase } from '../client.js';
import { migrateUp, migrationStatus, resetDatabase } from '../migrations.js';

function requireEnv(name: string, fallbackName?: string): string {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const url = requireEnv('DATABASE_MIGRATION_URL', 'DATABASE_URL');
  const appEnv = process.env.APP_ENV ?? 'development';

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
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
