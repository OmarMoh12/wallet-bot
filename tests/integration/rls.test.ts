import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transactionsRepo, walletsRepo, withSystem, withUser, type Sql } from '@wallet/db';
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
 * Row Level Security.
 *
 * The property under test: **the application's own code cannot read another user's data,
 * even when it asks for it directly by id.** These tests connect as `app_user`, a
 * non-superuser role, because a superuser bypasses every policy — a test that connected as
 * `postgres` would pass whether or not RLS was working.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] RLS integration tests: TEST_DATABASE_URL is not reachable');
}

describeIf('row level security', () => {
  let sql: Sql;
  let alice: TestUser;
  let mallory: TestUser;
  let aliceWalletId: string;
  let aliceTransactionId: string;

  beforeAll(async () => {
    sql = getSql();
    alice = await createTestUser(sql);
    mallory = await createTestUser(sql);

    const asset = await findTestAsset(sql, 'USDT');

    await withUser(sql, { userId: alice.id, isAdmin: false }, async (tx) => {
      const wallet = await walletsRepo.createWallet(tx, {
        userId: alice.id,
        name: 'Alice TRON',
        network: 'tron',
        env: 'testnet',
        address: TRON_ADDRESS_A,
        addressCanonical: TRON_ADDRESS_A,
        type: 'watch_only',
      });
      aliceWalletId = wallet.id;

      const created = await transactionsRepo.insertChainTransactionIfNew(tx, {
        userId: alice.id,
        type: 'income',
        direction: 'in',
        status: 'detected',
        source: 'chain',
        title: 'Received 10 USDT',
        description: null,
        categoryId: null,
        occurredAt: new Date(),
        walletId: wallet.id,
        assetId: asset.id,
        rawAmount: 10_000_000n,
        network: 'tron',
        env: 'testnet',
        txHash: uniqueKey('hash').padEnd(64, '0').slice(0, 64),
        logIndex: 0,
        counterpartyAddress: TRON_ADDRESS_B,
        memo: null,
        feeAssetId: null,
        feeRawAmount: null,
        confirmations: 0,
        requiredConfirmations: 19,
        blockNumber: null,
        blockTime: null,
        valueUsdMinor: 1000n,
        valueIlsMinor: 3700n,
        usdIlsRate: '3.7',
        unitPriceUsd: '1.0',
      });
      if (!created) throw new Error('setup failed to create a transaction');
      aliceTransactionId = created.id;
    });
  });

  afterAll(async () => {
    await closeSql();
  });

  it('lets a user read their own wallet', async () => {
    const wallet = await withUser(sql, { userId: alice.id, isAdmin: false }, (tx) =>
      walletsRepo.findWallet(tx, alice.id, aliceWalletId),
    );
    expect(wallet?.id).toBe(aliceWalletId);
  });

  it("blocks reading another user's wallet even by exact id", async () => {
    // This is the IDOR case: Mallory knows the id and asks for it directly.
    const wallet = await withUser(sql, { userId: mallory.id, isAdmin: false }, (tx) =>
      walletsRepo.findWalletById(tx, aliceWalletId),
    );
    expect(wallet).toBeNull();
  });

  it("blocks reading another user's transaction by exact id", async () => {
    const found = await withUser(sql, { userId: mallory.id, isAdmin: false }, (tx) =>
      transactionsRepo.findTransaction(tx, mallory.id, aliceTransactionId),
    );
    expect(found).toBeNull();
  });

  it('blocks a raw SELECT that omits the ownership filter entirely', async () => {
    // Even with no WHERE clause on user_id, the policy scopes the result set.
    const rows = await withUser(
      sql,
      { userId: mallory.id, isAdmin: false },
      (tx) => tx<Array<{ id: string }>>`SELECT id FROM wallets`,
    );
    expect(rows.some((row) => row.id === aliceWalletId)).toBe(false);
  });

  it("blocks updating another user's wallet", async () => {
    const updated = await withUser(
      sql,
      { userId: mallory.id, isAdmin: false },
      (tx) =>
        tx<Array<{ id: string }>>`
        UPDATE wallets SET name = ${'stolen'} WHERE id = ${aliceWalletId} RETURNING id
      `,
    );
    expect(updated.length).toBe(0);
  });

  it("blocks deleting another user's transaction", async () => {
    const deleted = await withUser(
      sql,
      { userId: mallory.id, isAdmin: false },
      (tx) =>
        tx<Array<{ id: string }>>`
        DELETE FROM transactions WHERE id = ${aliceTransactionId} RETURNING id
      `,
    );
    expect(deleted.length).toBe(0);
  });

  it('prevents reassigning a row to another user', async () => {
    // The UPDATE policy carries both USING and WITH CHECK, so the row cannot be handed
    // over. The WITH CHECK failure raises rather than filtering, which aborts the whole
    // transaction — hence a rejection rather than an empty result.
    await expect(
      withUser(
        sql,
        { userId: alice.id, isAdmin: false },
        (tx) =>
          tx<Array<{ id: string }>>`
          UPDATE wallets SET user_id = ${mallory.id} WHERE id = ${aliceWalletId} RETURNING id
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does not leak identity from one bound transaction into the next', async () => {
    // `set_config(..., true)` is transaction-local. If it were session-local, this second
    // transaction would still be acting as Alice on the same pooled connection — which is
    // precisely the bug that per-connection identity binding causes.
    await withUser(
      sql,
      { userId: alice.id, isAdmin: false },
      (tx) => tx`SELECT id FROM wallets LIMIT 1`,
    );

    const rows = await withUser(
      sql,
      { userId: mallory.id, isAdmin: false },
      (tx) => tx<Array<{ id: string }>>`SELECT id FROM wallets`,
    );
    expect(rows.some((row) => row.id === aliceWalletId)).toBe(false);
  });

  it('resets to an unbound state after a bound transaction', async () => {
    await withUser(
      sql,
      { userId: alice.id, isAdmin: false },
      (tx) => tx`SELECT id FROM wallets LIMIT 1`,
    );

    const [row] = await withSystem(
      sql,
      (tx) => tx<Array<{ bound: string | null }>>`SELECT app.current_user_id()::text AS bound`,
    );
    expect(row?.bound).toBeNull();
  });

  it('grants the worker plane access, and documents that boundary explicitly', async () => {
    // Unbound transactions ARE the system: chain scanning, reminders and notification
    // dispatch operate across users. This is deliberate (migration 0009) and safe because
    // no request handler can produce an unbound transaction — every API route binds the
    // actor resolved from a verified session token before touching user data.
    const rows = await withSystem(
      sql,
      (tx) => tx<Array<{ id: string }>>`SELECT id FROM wallets WHERE id = ${aliceWalletId}`,
    );
    expect(rows.length).toBe(1);
  });

  it('lets an admin read across users but not mutate them', async () => {
    const visible = await withUser(
      sql,
      { userId: mallory.id, isAdmin: true },
      (tx) => tx<Array<{ id: string }>>`SELECT id FROM wallets WHERE id = ${aliceWalletId}`,
    );
    expect(visible.length).toBe(1);

    const mutated = await withUser(sql, { userId: mallory.id, isAdmin: true }, (tx) =>
      tx<Array<{ id: string }>>`
        UPDATE wallets SET name = ${'admin-edit'} WHERE id = ${aliceWalletId} RETURNING id
      `.catch(() => []),
    );
    // Admin policies are SELECT-only on purpose.
    expect(mutated.length).toBe(0);
  });

  it('makes the audit log append-only for the application role', async () => {
    await withUser(
      sql,
      { userId: alice.id, isAdmin: false },
      (tx) =>
        tx`
        INSERT INTO audit_logs (user_id, actor_type, action)
        VALUES (${alice.id}, 'user', 'auth.login')
      `,
    );

    await expect(
      withUser(
        sql,
        { userId: alice.id, isAdmin: false },
        (tx) => tx`UPDATE audit_logs SET action = 'tampered' WHERE user_id = ${alice.id}`,
      ),
    ).rejects.toThrow();
  });
});
