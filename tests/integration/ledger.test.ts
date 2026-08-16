import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsRepo, transactionsRepo, withUser, type Sql } from '@wallet/db';
import {
  closeSql,
  createTestUser,
  getSql,
  isDatabaseAvailable,
  uniqueKey,
  type TestUser,
} from '../setup/db';

/**
 * Ledger invariants.
 *
 * The cached cash balance is maintained by a database trigger rather than by application
 * code, so the property to verify is that it always equals the sum of the confirmed,
 * non-deleted rows that justify it — through inserts, status changes, soft deletes and
 * account moves.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] ledger integration tests: TEST_DATABASE_URL is not reachable');
}

describeIf('cash balance maintenance', () => {
  let sql: Sql;
  let user: TestUser;
  let accountId: string;

  beforeAll(async () => {
    sql = getSql();
    user = await createTestUser(sql);
    await withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
      const account = await accountsRepo.createCashAccount(tx, {
        userId: user.id,
        name: 'Cash',
        currency: 'ILS',
        isDefault: true,
      });
      accountId = account.id;
    });
  });

  afterAll(async () => {
    await closeSql();
  });

  async function balance(): Promise<bigint> {
    const account = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      accountsRepo.findCashAccount(tx, user.id, accountId),
    );
    return BigInt(account?.balance_minor ?? '0');
  }

  async function addTransaction(
    amountMinor: bigint,
    options: { status?: 'confirmed' | 'pending' } = {},
  ): Promise<string> {
    const row = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.createCashTransaction(tx, {
        userId: user.id,
        type: amountMinor >= 0n ? 'income' : 'expense',
        direction: amountMinor >= 0n ? 'in' : 'out',
        status: options.status ?? 'confirmed',
        source: 'manual',
        title: 'Entry',
        description: null,
        notes: null,
        categoryId: null,
        occurredAt: new Date(),
        cashAccountId: accountId,
        currency: 'ILS',
        amountMinor,
        valueUsdMinor: null,
        valueIlsMinor: amountMinor,
        usdIlsRate: null,
        externalRef: null,
        idempotencyKey: uniqueKey('led'),
      }),
    );
    return row.id;
  }

  it('starts at zero', async () => {
    expect(await balance()).toBe(0n);
  });

  it('adds income and subtracts expenses exactly', async () => {
    await addTransaction(50_000n);
    expect(await balance()).toBe(50_000n);

    await addTransaction(-12_000n);
    expect(await balance()).toBe(38_000n);
  });

  it('ignores rows that are not confirmed', async () => {
    const before = await balance();
    await addTransaction(99_900n, { status: 'pending' });
    // A pending entry is not money yet.
    expect(await balance()).toBe(before);
  });

  it('reverses the contribution of a soft-deleted row', async () => {
    const before = await balance();
    const id = await addTransaction(25_000n);
    expect(await balance()).toBe(before + 25_000n);

    await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.softDeleteTransaction(tx, user.id, id),
    );
    expect(await balance()).toBe(before);
  });

  it('applies a pending row once it is confirmed', async () => {
    const before = await balance();
    const id = await addTransaction(7_500n, { status: 'pending' });
    expect(await balance()).toBe(before);

    await withUser(
      sql,
      { userId: user.id, isAdmin: false },
      (tx) => tx`UPDATE transactions SET status = 'confirmed' WHERE id = ${id}`,
    );
    expect(await balance()).toBe(before + 7_500n);
  });

  it('matches a full recomputation from the ledger', async () => {
    const cached = await balance();
    const recomputed = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      accountsRepo.recomputeCashBalance(tx, accountId),
    );
    // The invariant: cache == sum(confirmed, non-deleted).
    expect(recomputed).toBe(cached);
  });

  it('stays consistent under concurrent inserts', async () => {
    const before = await balance();
    await Promise.all(Array.from({ length: 10 }, () => addTransaction(1_000n)));
    expect(await balance()).toBe(before + 10_000n);
  });
});

describeIf('database state machine enforcement', () => {
  let sql: Sql;
  let user: TestUser;
  let accountId: string;
  let transactionId: string;

  beforeAll(async () => {
    sql = getSql();
    user = await createTestUser(sql);
    await withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
      const account = await accountsRepo.createCashAccount(tx, {
        userId: user.id,
        name: 'Cash',
        currency: 'ILS',
        isDefault: true,
      });
      accountId = account.id;

      const row = await transactionsRepo.createCashTransaction(tx, {
        userId: user.id,
        type: 'income',
        direction: 'in',
        status: 'confirmed',
        source: 'manual',
        title: 'Entry',
        description: null,
        notes: null,
        categoryId: null,
        occurredAt: new Date(),
        cashAccountId: accountId,
        currency: 'ILS',
        amountMinor: 1_000n,
        valueUsdMinor: null,
        valueIlsMinor: 1_000n,
        usdIlsRate: null,
        externalRef: null,
        idempotencyKey: uniqueKey('sm'),
      });
      transactionId = row.id;
    });
  });

  afterAll(async () => {
    await closeSql();
  });

  it('rejects an illegal status transition at the database level', async () => {
    // Even a direct UPDATE, bypassing every service, cannot un-confirm a transaction.
    await expect(
      withUser(
        sql,
        { userId: user.id, isAdmin: false },
        (tx) => tx`UPDATE transactions SET status = 'pending' WHERE id = ${transactionId}`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a sign that disagrees with the direction', async () => {
    await expect(
      withUser(
        sql,
        { userId: user.id, isAdmin: false },
        (tx) =>
          tx`
          INSERT INTO transactions
            (user_id, kind, type, direction, status, source, title, cash_account_id,
             fiat_currency, fiat_amount_minor)
          VALUES (${user.id}, 'cash', 'income', 'in', 'confirmed', 'manual', 'Bad',
                  ${accountId}, 'ILS', ${-500})
        `,
      ),
    ).rejects.toThrow();
  });

  it('rejects a crypto row that is missing its asset', async () => {
    await expect(
      withUser(
        sql,
        { userId: user.id, isAdmin: false },
        (tx) =>
          tx`
          INSERT INTO transactions
            (user_id, kind, type, direction, status, source, title, network, env)
          VALUES (${user.id}, 'crypto', 'income', 'in', 'detected', 'chain', 'Bad',
                  'tron', 'testnet')
        `,
      ),
    ).rejects.toThrow();
  });

  it('rejects a chain row with no hash', async () => {
    await expect(
      withUser(
        sql,
        { userId: user.id, isAdmin: false },
        (tx) =>
          tx`
          INSERT INTO transactions
            (user_id, kind, type, direction, status, source, title, cash_account_id,
             fiat_currency, fiat_amount_minor)
          VALUES (${user.id}, 'cash', 'income', 'in', 'confirmed', 'chain', 'Bad',
                  ${accountId}, 'ILS', ${500})
        `,
      ),
    ).rejects.toThrow();
  });
});
