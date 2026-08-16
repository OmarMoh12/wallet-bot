import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '@wallet/blockchain';
import { opsRepo, planningRepo, walletsRepo, withSystem, withUser, type Sql } from '@wallet/db';
import {
  SchedulerService,
  createAppContext,
  createServices,
  type AppContext,
  type ServiceContext,
} from '@wallet/core';
import { createTranslator } from '@wallet/shared';
import {
  closeSql,
  createTestUser,
  findTestAsset,
  getSql,
  isDatabaseAvailable,
  TRON_ADDRESS_A,
  TRON_ADDRESS_B,
  uniqueKey,
  type TestUser,
} from '../setup/db';

/**
 * Scheduled payments.
 *
 * The property that matters most: with sending disabled — which is the default and the
 * shipped configuration — a due payment is claimed, validated, and then **refused**, with
 * nothing broadcast and the user notified. A deployment that has not explicitly configured
 * signing must not be able to move funds, however the schedule is set up.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] scheduled payment tests: TEST_DATABASE_URL is not reachable');
}

describeIf('scheduled payment execution', () => {
  let sql: Sql;
  let app: AppContext;
  let scheduler: SchedulerService;
  let user: TestUser;
  let walletId: string;
  let assetId: string;
  let context: ServiceContext;

  beforeAll(async () => {
    sql = getSql();
    user = await createTestUser(sql);
    const asset = await findTestAsset(sql, 'USDT');
    assetId = asset.id;

    app = createAppContext({ service: 'test', sql });
    app.providers.register(
      'tron',
      new MockProvider({ network: 'tron', env: 'testnet', requiredConfirmations: 19 }),
    );

    const services = createServices(app);
    scheduler = new SchedulerService(services.send, services.notifications);

    context = {
      app,
      actor: {
        userId: user.id,
        telegramId: user.telegramId,
        isAdmin: false,
        sessionId: 'test',
        locale: 'en',
      },
      requestId: 'test',
      t: createTranslator('en'),
      ip: null,
      userAgent: 'test',
    };

    await withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
      const wallet = await walletsRepo.createWallet(tx, {
        userId: user.id,
        name: 'TRON Wallet',
        network: 'tron',
        env: 'testnet',
        address: TRON_ADDRESS_A,
        addressCanonical: TRON_ADDRESS_A,
        type: 'watch_only',
      });
      walletId = wallet.id;
    });
  });

  afterAll(async () => {
    await closeSql();
  });

  async function schedule(when: Date): Promise<string> {
    const row = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      planningRepo.createScheduledPayment(tx, {
        userId: user.id,
        walletId,
        assetId,
        title: 'Rent',
        toAddress: TRON_ADDRESS_B,
        toAddressCanonical: TRON_ADDRESS_B,
        rawAmount: 25_000_000n,
        memo: null,
        scheduledAt: when,
        notes: null,
        idempotencyKey: uniqueKey('sched'),
      }),
    );
    return row.id;
  }

  async function statusOf(id: string): Promise<{ status: string; error: string | null }> {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ status: string; last_error_code: string | null }>>`
        SELECT status, last_error_code FROM scheduled_payments WHERE id = ${id}
      `,
    );
    return { status: rows[0]?.status ?? 'missing', error: rows[0]?.last_error_code ?? null };
  }

  it('confirms sending is disabled by default', () => {
    // The shipped default. If this ever flips, everything below is testing the wrong thing.
    expect(app.config.sending.enabled).toBe(false);
    expect(app.signer.simulated).toBe(true);
  });

  it('leaves a future payment untouched', async () => {
    const id = await schedule(new Date(Date.now() + 3600_000));
    await scheduler.tick(app, { worker: 'test', requestId: 'r1' });

    // Asserted on this row specifically rather than on the tick's total: the scheduler is
    // a worker and legitimately claims due payments belonging to any user, so a global
    // count would be coupled to whatever else the database happens to contain.
    expect((await statusOf(id)).status).toBe('scheduled');
  });

  it('claims a due payment, refuses to send it, and records why', async () => {
    const id = await schedule(new Date(Date.now() - 1000));
    const result = await scheduler.tick(app, { worker: 'test', requestId: 'r2' });

    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.executed).toBe(0);

    const state = await statusOf(id);
    expect(state.status).toBe('failed');
    // Fails closed with a precise, non-retryable reason rather than a generic error.
    expect(state.error).toBe('SENDING_DISABLED');
  });

  it('broadcasts nothing at all', async () => {
    const sends = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ id: string }>>`
        SELECT id FROM send_requests WHERE user_id = ${user.id} AND status IN ('broadcast', 'completed')
      `,
    );
    expect(sends.length).toBe(0);

    const chainRows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ id: string }>>`
        SELECT id FROM transactions WHERE user_id = ${user.id} AND direction = 'out' AND kind = 'crypto'
      `,
    );
    expect(chainRows.length).toBe(0);
  });

  it('notifies the user that the payment needs review', async () => {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM notifications
        WHERE user_id = ${user.id} AND type = 'scheduled_payment_failed'
      `,
    );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The payload carries an error CODE, so the bot renders it in the user's language and
    // no internal message leaks into a chat.
    expect(rows[0]?.payload.reasonCode).toBe('SENDING_DISABLED');
  });

  it('does not retry a decision-type failure', async () => {
    const before = await statusOf(
      (
        await withSystem(
          sql,
          (tx) =>
            tx<Array<{ id: string }>>`
            SELECT id FROM scheduled_payments WHERE user_id = ${user.id} AND status = 'failed' LIMIT 1
          `,
        )
      )[0]?.id as string,
    );
    expect(before.status).toBe('failed');

    // A second tick must not pick a failed payment back up on its own.
    await scheduler.tick(app, { worker: 'test', requestId: 'r3' });
    const failedCount = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM scheduled_payments
        WHERE user_id = ${user.id} AND status = 'processing'
      `,
    );
    expect(failedCount[0]?.count).toBe('0');
  });

  it('never lets two workers claim the same payment', async () => {
    const id = await schedule(new Date(Date.now() - 1000));

    await Promise.all([
      scheduler.tick(app, { worker: 'worker-a', requestId: 'r4' }),
      scheduler.tick(app, { worker: 'worker-b', requestId: 'r5' }),
    ]);

    // Asserted on THIS row's attempt counter rather than on the ticks' totals. The scheduler
    // is a worker and legitimately claims due payments belonging to any user, so a global
    // count is coupled to whatever else the database happens to contain — and would pass or
    // fail depending on test ordering.
    //
    // `attempts` is incremented by the claiming UPDATE itself, so exactly 1 is proof that
    // FOR UPDATE SKIP LOCKED let precisely one worker take it.
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ attempts: number; status: string }>>`
        SELECT attempts, status FROM scheduled_payments WHERE id = ${id}
      `,
    );
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.status).toBe('failed');
  });

  it('respects the database-level scheduled-payments kill switch', async () => {
    await withSystem(sql, (tx) =>
      opsRepo.setAppSetting(tx, 'scheduled_payments_enabled', false, null),
    );

    const id = await schedule(new Date(Date.now() - 1000));
    await scheduler.tick(app, { worker: 'test', requestId: 'r6' });

    // The switch stops the tick before anything is claimed, so the row stays scheduled.
    expect((await statusOf(id)).status).toBe('scheduled');

    await withSystem(sql, (tx) =>
      opsRepo.setAppSetting(tx, 'scheduled_payments_enabled', true, null),
    );
  });

  it('refuses a quote from a watch-only wallet even when asked directly', async () => {
    const services = createServices(app);
    // Every wallet created through the API is watch-only, so this is the normal case.
    await expect(
      services.send.quote(context, {
        walletId,
        assetId,
        toAddress: TRON_ADDRESS_B,
        amount: '1',
        idempotencyKey: uniqueKey('q'),
      }),
    ).rejects.toMatchObject({ code: 'SENDING_DISABLED' });
  });

  it('lets the owner cancel a failed payment', async () => {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ id: string }>>`
        SELECT id FROM scheduled_payments WHERE user_id = ${user.id} AND status = 'failed' LIMIT 1
      `,
    );
    const id = rows[0]?.id as string;

    const cancelled = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      planningRepo.cancelScheduledPayment(tx, user.id, id),
    );
    expect(cancelled?.status).toBe('cancelled');
  });

  it('notifies before a payment is due', async () => {
    const id = await schedule(new Date(Date.now() + 20 * 60 * 1000));
    const result = await scheduler.notifyUpcoming(app, { withinSeconds: 3600 });

    expect(result.notified).toBeGreaterThanOrEqual(1);

    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ upcoming_notified_at: Date | null }>>`
        SELECT upcoming_notified_at FROM scheduled_payments WHERE id = ${id}
      `,
    );
    expect(rows[0]?.upcoming_notified_at).not.toBeNull();
  });
});
