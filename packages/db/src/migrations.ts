import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Sql } from './client.js';

/**
 * A deliberately small, dependency-free migration runner.
 *
 * Rules it enforces:
 *   * migrations run in filename order, exactly once, inside a transaction each;
 *   * an advisory lock serialises concurrent deployers, so two Railway instances booting
 *     at the same moment cannot interleave DDL;
 *   * an already-applied file whose contents changed is a hard error, because silently
 *     diverging schemas between environments is how data gets corrupted.
 */

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Arbitrary but fixed: identifies *this* application's migration lock.
const ADVISORY_LOCK_KEY = 8_675_309;

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

/** Find `supabase/migrations` by walking up from a starting directory. */
export function findMigrationsDir(startDir: string = process.cwd()): string {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv) {
    const absolute = resolve(fromEnv);
    if (!existsSync(absolute)) {
      throw new Error(`MIGRATIONS_DIR does not exist: ${absolute}`);
    }
    return absolute;
  }

  let current = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'supabase', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Could not locate supabase/migrations starting from ${startDir}. Set MIGRATIONS_DIR.`,
  );
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];

  for (const entry of entries.sort()) {
    const match = MIGRATION_FILE.exec(entry);
    if (!match) continue;
    const path = join(dir, entry);
    const sql = await readFile(path, 'utf8');
    files.push({
      version: match[1] as string,
      name: entry.replace(/\.sql$/, ''),
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  if (files.length === 0) throw new Error(`No migration files found in ${dir}`);
  return files;
}

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    );
  `);
}

export async function appliedMigrations(sql: Sql): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(sql);
  const rows = await sql<AppliedMigration[]>`
    SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version
  `;
  return [...rows];
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrateUp(
  sql: Sql,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const dir = options.dir ?? findMigrationsDir();
  const log = options.log ?? (() => {});
  const files = await loadMigrations(dir);

  await ensureMigrationsTable(sql);

  // Serialise deployers. Released automatically when the session ends.
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    const applied = await appliedMigrations(sql);
    const byVersion = new Map(applied.map((row) => [row.version, row]));

    const result: MigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      const previous = byVersion.get(file.version);
      if (previous) {
        if (previous.checksum !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was already applied with a different checksum. ` +
              `Migrations are immutable — add a new one instead of editing ${file.path}.`,
          );
        }
        result.skipped.push(file.name);
        continue;
      }

      log(`applying ${file.name}`);
      const startedAt = Date.now();
      // Each migration is one transaction: it either lands whole or not at all.
      await sql.begin(async (tx) => {
        await tx.unsafe(file.sql);
        await tx`
          INSERT INTO schema_migrations (version, name, checksum, duration_ms)
          VALUES (${file.version}, ${file.name}, ${file.checksum}, ${Date.now() - startedAt})
        `;
      });
      result.applied.push(file.name);
    }

    return result;
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

export interface MigrationStatus {
  version: string;
  name: string;
  applied: boolean;
  appliedAt: Date | null;
  checksumMatches: boolean | null;
}

export async function migrationStatus(
  sql: Sql,
  options: { dir?: string } = {},
): Promise<MigrationStatus[]> {
  const dir = options.dir ?? findMigrationsDir();
  const files = await loadMigrations(dir);
  const applied = await appliedMigrations(sql);
  const byVersion = new Map(applied.map((row) => [row.version, row]));

  return files.map((file) => {
    const previous = byVersion.get(file.version);
    return {
      version: file.version,
      name: file.name,
      applied: Boolean(previous),
      appliedAt: previous?.applied_at ?? null,
      checksumMatches: previous ? previous.checksum === file.checksum : null,
    };
  });
}

/**
 * Drop and recreate the public schema, then re-run every migration.
 *
 * Guarded twice: refuses unless APP_ENV is `development` or `test`, AND the caller passes
 * `confirm: true`. There is no code path that can reset a production database by accident.
 */
export async function resetDatabase(
  sql: Sql,
  options: { dir?: string; confirm: boolean; appEnv: string; log?: (message: string) => void },
): Promise<MigrationResult> {
  if (!options.confirm) throw new Error('resetDatabase requires confirm: true');
  if (options.appEnv !== 'development' && options.appEnv !== 'test') {
    throw new Error(`Refusing to reset database: APP_ENV is "${options.appEnv}"`);
  }
  const log = options.log ?? (() => {});
  log('dropping schemas public + app');
  await sql.unsafe(
    'DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
  );
  return migrateUp(sql, { dir: options.dir ?? undefined, log });
}
