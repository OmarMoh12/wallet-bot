import { randomUUID } from 'node:crypto';
import { createDatabase, migrateUp, withSystem, type Sql } from '@wallet/db';

/**
 * Integration-test database helpers.
 *
 * Two connections, deliberately:
 *
 *   * `migrationSql` connects as the owner and applies migrations;
 *   * `sql` connects as `app_user`, a **non-superuser** role — which is the only way to
 *     verify Row Level Security at all. A superuser bypasses every policy, so a test that
 *     connects as `postgres` would pass whether or not RLS worked.
 *
 * If the database is unreachable, `describeIntegration` skips the suite with a message
 * rather than failing, so `pnpm test` is still green on a fresh clone.
 */

let cachedSql: Sql | null = null;
let available: boolean | null = null;

export function getSql(): Sql {
  if (!cachedSql) {
    cachedSql = createDatabase({
      url: process.env.DATABASE_URL as string,
      ssl: false,
      maxConnections: 5,
      statementTimeoutMs: 15_000,
      idleTimeoutSeconds: 5,
      connectTimeoutSeconds: 5,
      applicationName: 'wallet-test',
    });
  }
  return cachedSql;
}

/** Probe the database once per process, and apply migrations on first contact. */
export async function isDatabaseAvailable(): Promise<boolean> {
  if (available !== null) return available;

  const migrationUrl = process.env.DATABASE_MIGRATION_URL as string;
  const migrationSql = createDatabase({
    url: migrationUrl,
    ssl: false,
    maxConnections: 2,
    statementTimeoutMs: 120_000,
    idleTimeoutSeconds: 2,
    connectTimeoutSeconds: 4,
    applicationName: 'wallet-test-migrate',
  });

  try {
    await migrationSql`SELECT 1`;
    await migrateUp(migrationSql);
    // Migrations create the role and its grants; make sure it can actually log in here.
    await migrationSql.unsafe(
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
           EXECUTE 'ALTER ROLE app_user LOGIN';
         END IF;
       END $$;`,
    );
    available = true;
  } catch {
    available = false;
  } finally {
    await migrationSql.end({ timeout: 5 }).catch(() => {});
  }

  return available;
}

export async function closeSql(): Promise<void> {
  if (cachedSql) {
    await cachedSql.end({ timeout: 5 }).catch(() => {});
    cachedSql = null;
  }
}

export interface TestUser {
  id: string;
  telegramId: bigint;
}

/**
 * Create an isolated user.
 *
 * Every integration test works against its own user, so suites cannot see each other's rows
 * and no cleanup is needed between them. Telegram ids are random within a wide range to
 * avoid collisions across parallel runs.
 */
export async function createTestUser(
  sql: Sql,
  options: { admin?: boolean } = {},
): Promise<TestUser> {
  const telegramId = BigInt(Math.floor(Math.random() * 900_000_000) + 100_000_000);

  const id = await withSystem(sql, async (tx) => {
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO users (telegram_id, first_name, is_admin)
      VALUES (${telegramId.toString()}, ${'Test'}, ${options.admin ?? false})
      RETURNING id
    `;
    const created = rows[0];
    if (!created) throw new Error('could not create test user');

    await tx`INSERT INTO user_settings (user_id) VALUES (${created.id}) ON CONFLICT DO NOTHING`;
    await tx`
      INSERT INTO notification_preferences (user_id) VALUES (${created.id}) ON CONFLICT DO NOTHING
    `;
    return created.id;
  });

  return { id, telegramId };
}

/** Look up a seeded asset by symbol on the test chain environment. */
export async function findTestAsset(
  sql: Sql,
  symbol: string,
  network: 'tron' | 'ton' = 'tron',
): Promise<{ id: string; decimals: number; symbol: string; contract: string | null }> {
  const rows = await withSystem(
    sql,
    (tx) =>
      tx<Array<{ id: string; decimals: number; symbol: string; contract_address: string | null }>>`
      SELECT id, decimals, symbol, contract_address FROM assets
      WHERE symbol = ${symbol} AND network = ${network} AND env = 'testnet'
      LIMIT 1
    `,
  );
  const row = rows[0];
  if (!row) throw new Error(`test asset ${symbol} not seeded`);
  return { id: row.id, decimals: row.decimals, symbol: row.symbol, contract: row.contract_address };
}

/** A syntactically valid TRON address, for tests that need one. */
export const TRON_ADDRESS_A = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TRON_ADDRESS_B = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8';

export function uniqueKey(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '')}`;
}
