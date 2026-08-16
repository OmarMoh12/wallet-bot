import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainEventKey } from '@wallet/shared';
import { opsRepo, transactionsRepo, walletsRepo, withSystem, withUser, type Sql } from '@wallet/db';
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
 * Idempotency and duplicate prevention.
 *
 * Blockchain indexers replay. Clients retry. Workers race. None of that may produce a second
 * ledger row or a double-counted balance — and the guarantee has to come from the database,
 * not from application-level checks that lose to concurrency.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] idempotency integration tests: TEST_DATABASE_URL is not reachable');
}

describeIf('idempotency', () => {
  let sql: Sql;
  let user: TestUser;
  let walletId: string;
  let assetId: string;

  beforeAll(async () => {
    sql = getSql();
    user = await createTestUser(sql);
    const asset = await findTestAsset(sql, 'USDT');
    assetId = asset.id;

    await withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
      const wallet = await walletsRepo.createWallet(tx, {
        userId: user.id,
        name: 'Wallet',
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

  function chainInput(txHash: string, logIndex = 0) {
    return {
      userId: user.id,
      type: 'income' as const,
      direction: 'in' as const,
      status: 'detected' as const,
      source: 'chain' as const,
      title: 'Received',
      description: null,
      categoryId: null,
      occurredAt: new Date(),
      walletId,
      assetId,
      rawAmount: 5_000_000n,
      network: 'tron' as const,
      env: 'testnet' as const,
      txHash,
      logIndex,
      counterpartyAddress: TRON_ADDRESS_B,
      memo: null,
      feeAssetId: null,
      feeRawAmount: null,
      confirmations: 0,
      requiredConfirmations: 19,
      blockNumber: null,
      blockTime: null,
      valueUsdMinor: 500n,
      valueIlsMinor: 1850n,
      usdIlsRate: '3.7',
      unitPriceUsd: '1.0',
    };
  }

  it('ingests the same chain event only once', async () => {
    const hash = uniqueKey('h').padEnd(64, '0').slice(0, 64);

    const first = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.insertChainTransactionIfNew(tx, chainInput(hash)),
    );
    const second = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.insertChainTransactionIfNew(tx, chainInput(hash)),
    );

    expect(first).not.toBeNull();
    // Null, not a duplicate row: the unique index decided, not a prior SELECT.
    expect(second).toBeNull();
  });

  it('treats separate log indices in one transaction as separate movements', async () => {
    const hash = uniqueKey('h').padEnd(64, '0').slice(0, 64);

    const first = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.insertChainTransactionIfNew(tx, chainInput(hash, 0)),
    );
    const second = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.insertChainTransactionIfNew(tx, chainInput(hash, 1)),
    );

    // A batched payout must not collapse into one row, or the balance understates.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  it('survives concurrent ingestion of the same event', async () => {
    const hash = uniqueKey('h').padEnd(64, '0').slice(0, 64);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
          transactionsRepo.insertChainTransactionIfNew(tx, chainInput(hash)),
        ).catch(() => null),
      ),
    );

    expect(results.filter(Boolean).length).toBe(1);
  });

  it('claims a replay-protection event exactly once', async () => {
    const key = chainEventKey({
      network: 'tron',
      env: 'testnet',
      txHash: uniqueKey('evt'),
      logIndex: 0,
    });

    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        withSystem(sql, (tx) => opsRepo.claimEvent(tx, { scope: 'chain', key })).catch(() => false),
      ),
    );

    expect(claims.filter(Boolean).length).toBe(1);
  });

  it('returns the original row for a repeated client idempotency key', async () => {
    const key = uniqueKey('idem');

    const create = () =>
      withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
        const account = await tx<Array<{ id: string }>>`
          INSERT INTO cash_accounts (user_id, name, currency)
          VALUES (${user.id}, ${'Cash'}, ${'ILS'})
          RETURNING id
        `;
        return transactionsRepo.createCashTransaction(tx, {
          userId: user.id,
          type: 'income',
          direction: 'in',
          status: 'confirmed',
          source: 'manual',
          title: 'Payment',
          description: null,
          notes: null,
          categoryId: null,
          occurredAt: new Date(),
          cashAccountId: account[0]?.id as string,
          currency: 'ILS',
          amountMinor: 50_000n,
          valueUsdMinor: 13_500n,
          valueIlsMinor: 50_000n,
          usdIlsRate: '3.7',
          externalRef: null,
          idempotencyKey: key,
        });
      });

    const first = await create();
    await expect(create()).rejects.toThrow();

    const found = await withUser(sql, { userId: user.id, isAdmin: false }, (tx) =>
      transactionsRepo.findByIdempotencyKey(tx, user.id, key),
    );
    expect(found?.id).toBe(first.id);
  });

  it('deduplicates notifications for the same logical event', async () => {
    const dedupeKey = uniqueKey('notify');

    const first = await withSystem(sql, (tx) =>
      opsRepo.enqueueNotification(tx, {
        userId: user.id,
        type: 'crypto_received',
        payload: { amount: '1 USDT' },
        dedupeKey,
      }),
    );
    const second = await withSystem(sql, (tx) =>
      opsRepo.enqueueNotification(tx, {
        userId: user.id,
        type: 'crypto_received',
        payload: { amount: '1 USDT' },
        dedupeKey,
      }),
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('collapses equivalent queued jobs into one', async () => {
    const dedupeKey = uniqueKey('job');

    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        withSystem(sql, (tx) =>
          opsRepo.enqueueJob(tx, { type: 'chain.scan', payload: { walletId }, dedupeKey }),
        ),
      ),
    );

    expect(new Set(ids).size).toBe(1);
  });
});
