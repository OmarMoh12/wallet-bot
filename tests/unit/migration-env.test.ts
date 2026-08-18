import { describe, expect, it } from 'vitest';
import { MissingMigrationUrlError, describeConnection, migrationUrlFromEnv } from '@wallet/db';

/**
 * Migration connection resolution.
 *
 * `migrationUrlFromEnv` used to be `requireEnv('DATABASE_MIGRATION_URL', 'DATABASE_URL')` —
 * a silent fallback to the runtime role. Because the runtime role (`app_user`) deliberately
 * holds no CREATE privilege on any schema, that fallback could never do useful work; it
 * could only convert "you forgot a variable" into "permission denied for schema public",
 * reported against whichever service happened to run the command.
 *
 * That is exactly what happened to the bot service, so the no-fallback property is pinned
 * here rather than left to the CLI.
 */
describe('migrationUrlFromEnv', () => {
  it('returns DATABASE_MIGRATION_URL when set', () => {
    const url = 'postgresql://migrator:pw@db.example.com:5432/wallet';
    expect(migrationUrlFromEnv({ DATABASE_MIGRATION_URL: url })).toBe(url);
  });

  it('throws when DATABASE_MIGRATION_URL is absent', () => {
    expect(() => migrationUrlFromEnv({})).toThrow(MissingMigrationUrlError);
  });

  it('does NOT fall back to DATABASE_URL', () => {
    // The regression in one assertion.
    expect(() =>
      migrationUrlFromEnv({ DATABASE_URL: 'postgresql://app_user:pw@db.example.com:5432/wallet' }),
    ).toThrow(MissingMigrationUrlError);
  });

  it('names the missing variable and explains the absent fallback', () => {
    let message = '';
    try {
      migrationUrlFromEnv({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('DATABASE_MIGRATION_URL');
    expect(message).toContain('DATABASE_URL');
  });

  it('treats an empty string as absent', () => {
    expect(() => migrationUrlFromEnv({ DATABASE_MIGRATION_URL: '' })).toThrow(
      MissingMigrationUrlError,
    );
  });
});

/**
 * Diagnostics must be able to name the role and host that failed without ever printing the
 * password — the reason the original failure had to be diagnosed without knowing which
 * credentials were even in use.
 */
describe('describeConnection', () => {
  it('masks the password but keeps role, host, port and database', () => {
    const described = describeConnection(
      'postgresql://app_user:sup3r-s3cret@db.abcdef.supabase.co:6543/postgres',
    );
    expect(described).toBe('postgresql://app_user:***@db.abcdef.supabase.co:6543/postgres');
    expect(described).not.toContain('sup3r-s3cret');
  });

  it('never leaks a password given in the query string', () => {
    const described = describeConnection(
      'postgresql://app_user@db.example.com:5432/postgres?password=sup3r-s3cret&sslmode=require',
    );
    expect(described).not.toContain('sup3r-s3cret');
    expect(described).not.toContain('password=');
  });

  it('defaults the port when the URL omits it', () => {
    expect(describeConnection('postgresql://app_user:pw@db.example.com/postgres')).toBe(
      'postgresql://app_user:***@db.example.com:5432/postgres',
    );
  });

  it('handles a URL with no credentials', () => {
    expect(describeConnection('postgresql://db.example.com:5432/postgres')).toBe(
      'postgresql://(no role)@db.example.com:5432/postgres',
    );
  });

  it('does not echo an unparseable string back', () => {
    // Whatever failed to parse might itself be the secret.
    const described = describeConnection('this-is-not-a-url-but-might-be-a-secret');
    expect(described).toBe('(unparseable connection string)');
    expect(described).not.toContain('secret');
  });
});
