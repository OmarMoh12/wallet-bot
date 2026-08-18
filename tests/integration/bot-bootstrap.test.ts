import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAppContext,
  createAppContext,
  createServices,
  healthReport,
  type AppContext,
  type Services,
} from '@wallet/core';
import { PG_ERROR, migrateUp, pgErrorCode, withSystem } from '@wallet/db';
import { resolveBotUser } from '../../apps/bot/src/session.js';
import { closeSql, createTestUser, getSql, isDatabaseAvailable } from '../setup/db';

/**
 * The bot's boot path, against a real database, as the real runtime role.
 *
 * This exists because of an outage that no existing test could have caught. Every integration
 * suite here builds its context with `createAppContext({ sql })` — handing in a pool the test
 * already opened — which skips `createDatabase` and the configuration that feeds it entirely.
 * A `SELECT 1` through a pre-made pool proves nothing about how a service actually starts.
 *
 * So this suite deliberately does NOT pass `sql`. It calls the same bootstrap
 * `apps/bot/src/index.ts` calls, lets it build its own pool from DATABASE_URL, and then runs
 * the queries the bot really issues at boot, in order:
 *
 *   1. `healthReport`      — SELECT 1, then `jobs`, then `exchange_rates`
 *   2. `notifications.dispatch` — claims from `notifications`, `users`, `user_settings`
 *   3. `resolveBotUser`    — the first query any actual bot command triggers
 *
 * The connection is `app_user`, not `postgres`. Connecting as a superuser would bypass both
 * RLS and the grant surface, and would therefore pass whether or not either was correct.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] bot bootstrap tests: TEST_DATABASE_URL is not reachable');
}

describeIf('bot bootstrap', () => {
  let app: AppContext;
  let services: Services;

  beforeAll(() => {
    // No `sql` override: this is the real composition root, building its own connection from
    // configuration exactly as the deployed process does.
    app = createAppContext({ service: 'bot' });
    services = createServices(app);
  });

  afterAll(async () => {
    await closeAppContext(app).catch(() => {});
    await closeSql();
  });

  it('connects as the least-privilege runtime role, not a superuser', async () => {
    const rows = await withSystem(
      app.sql,
      (tx) => tx<Array<{ current_user: string; superuser: boolean }>>`
        SELECT current_user, usesuper AS superuser
        FROM pg_user WHERE usename = current_user
      `,
    );
    // If this ever reports a superuser, every other assertion below becomes meaningless.
    expect(rows[0]?.superuser).toBe(false);
  });

  it('reports a healthy database on the boot health check', async () => {
    const report = await healthReport(app, 'bot');

    const database = report.checks.find((check) => check.name === 'database');
    expect(database?.status).toBe('ok');

    // `jobs` is a separate grant surface from `SELECT 1`, and it is queried on the same
    // request. Railway calls /health before the service takes traffic, so a failure here is
    // a boot failure.
    const jobs = report.checks.find((check) => check.name === 'jobs');
    expect(jobs?.status).not.toBe('down');

    expect(report.status).not.toBe('down');
  });

  it('drains the notification queue, which is what the boot pump does every 5s', async () => {
    // The bot's `pumpNotifications` swallows its own errors, so a permissions failure here
    // would surface only as notifications silently never arriving.
    const result = await services.notifications.dispatch(app, { limit: 5, worker: 'bot-test' });
    expect(result).toMatchObject({
      sent: expect.any(Number),
      failed: expect.any(Number),
      suppressed: expect.any(Number),
      deferred: expect.any(Number),
    });
  });

  it('resolves a user through the same path a /balance command takes', async () => {
    const user = await createTestUser(getSql());

    const resolved = await resolveBotUser(app, user.telegramId);

    expect(resolved).not.toBeNull();
    expect(resolved?.actor.userId).toBe(user.id);
    expect(resolved?.actor.isAdmin).toBe(false);
  });

  it('returns null for an unknown Telegram id rather than throwing', async () => {
    expect(await resolveBotUser(app, 999_999_999_999n)).toBeNull();
  });
});

/**
 * The invariant the removed fallback violated.
 *
 * `DATABASE_MIGRATION_URL` used to fall back to `DATABASE_URL`. This pins down why that could
 * never have worked: the runtime role cannot run migrations at all, so the fallback's only
 * possible outcome was the confusing privilege error that took the bot down.
 */
describeIf('the runtime role cannot run migrations', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('refuses DDL with SQLSTATE 42501, not a connection error', async () => {
    let raised: unknown;
    try {
      // getSql() is the app_user pool — the one a DATABASE_URL fallback would have handed to
      // the migration runner.
      await migrateUp(getSql());
    } catch (error) {
      raised = error;
    }

    expect(raised, 'app_user must not be able to apply migrations').toBeDefined();
    expect(pgErrorCode(raised)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect((raised as Error).message).toContain('permission denied');
  });
});
