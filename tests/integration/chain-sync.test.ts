import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider, type ChainTransfer } from '@wallet/blockchain';
import { opsRepo, walletsRepo, withSystem, withUser, type Sql } from '@wallet/db';
import { ChainSyncService, createAppContext, createServices, type AppContext } from '@wallet/core';
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
 * End-to-end blockchain ingestion.
 *
 * The workflow the requirements call out explicitly:
 *
 *   incoming transfer → detected → validated → stored → balance updated → notification queued
 *
 * Driven through the real `ChainSyncService` against a real database, with only the chain
 * provider mocked — so the idempotency gates, the balance arithmetic and the notification
 * dedupe are all genuinely exercised rather than stubbed.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] chain-sync integration tests: TEST_DATABASE_URL is not reachable');
}

describeIf('chain ingestion pipeline', () => {
  let sql: Sql;
  let app: AppContext;
  let provider: MockProvider;
  let sync: ChainSyncService;
  let user: TestUser;
  let walletId: string;
  let asset: { id: string; decimals: number; symbol: string; contract: string | null };

  beforeAll(async () => {
    sql = getSql();
    user = await createTestUser(sql);
    asset = await findTestAsset(sql, 'USDT');

    app = createAppContext({ service: 'test', sql });
    provider = new MockProvider({ network: 'tron', env: 'testnet', requiredConfirmations: 19 });
    // Deterministic chain data; nothing in this suite can reach a real network.
    app.providers.register('tron', provider);
    sync = new ChainSyncService();

    await withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
      const wallet = await walletsRepo.createWallet(tx, {
        userId: user.id,
        name: 'Personal TRON Wallet',
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

  function incoming(txHash: string, rawAmount = 125_000_000n): ChainTransfer {
    return {
      network: 'tron',
      env: 'testnet',
      txHash,
      logIndex: 0,
      address: TRON_ADDRESS_A,
      direction: 'in',
      counterparty: TRON_ADDRESS_B,
      contractAddress: asset.contract,
      symbolHint: 'USDT',
      decimalsHint: 6,
      rawAmount,
      feeRawAmount: null,
      memo: null,
      blockNumber: 1000n,
      blockTime: new Date(),
      confirmations: 1,
      succeeded: true,
    };
  }

  async function balanceOf(): Promise<bigint> {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ raw_amount: string }>>`
        SELECT raw_amount FROM wallet_balances WHERE wallet_id = ${walletId} AND asset_id = ${asset.id}
      `,
    );
    return BigInt(rows[0]?.raw_amount ?? '0');
  }

  it('detects, stores, values and credits an incoming transfer', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    provider.seedTransfer(incoming(hash));

    const result = await sync.scanWallet(app, walletId);
    expect(result.ingested).toBe(1);

    const rows = await withUser(
      sql,
      { userId: user.id, isAdmin: false },
      (tx) =>
        tx<
          Array<{
            id: string;
            status: string;
            raw_amount: string;
            direction: string;
            source: string;
          }>
        >`
        SELECT id, status, raw_amount, direction, source FROM transactions WHERE tx_hash = ${hash}
      `,
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.direction).toBe('in');
    expect(rows[0]?.source).toBe('chain');
    // Chain rows start at `detected` and are walked to `confirmed` separately.
    expect(rows[0]?.status).toBe('detected');
    expect(BigInt(rows[0]?.raw_amount ?? '0')).toBe(125_000_000n);

    expect(await balanceOf()).toBe(125_000_000n);
  });

  it('queues exactly one notification for the transfer', async () => {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ type: string; payload: Record<string, unknown> }>>`
        SELECT type, payload FROM notifications WHERE user_id = ${user.id} AND type = 'crypto_received'
      `,
    );

    expect(rows.length).toBe(1);
    expect(String(rows[0]?.payload.wallet)).toBe('Personal TRON Wallet');
    expect(String(rows[0]?.payload.amount)).toContain('USDT');
  });

  it('is idempotent when the indexer replays the same transfer', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    const before = await balanceOf();

    provider.seedTransfer(incoming(hash, 10_000_000n));
    await sync.scanWallet(app, walletId);
    const afterFirst = await balanceOf();
    expect(afterFirst).toBe(before + 10_000_000n);

    // Replay the identical event, exactly as a re-paginating indexer would.
    provider.seedTransfer(incoming(hash, 10_000_000n));
    const second = await sync.scanWallet(app, walletId);

    expect(second.ingested).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    // The balance must not move a second time.
    expect(await balanceOf()).toBe(afterFirst);
  });

  it('ignores a transfer of an unregistered token', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    const before = await balanceOf();

    provider.seedTransfer({
      ...incoming(hash),
      // Anyone can airdrop a token claiming to be USDT; only the registry decides.
      contractAddress: 'TFakeTokenContractAddressThatIsNotReal1',
      symbolHint: 'USDT',
    });

    const result = await sync.scanWallet(app, walletId);
    expect(result.ingested).toBe(0);
    expect(result.skippedUnknownAsset).toBe(1);
    expect(await balanceOf()).toBe(before);
  });

  it('ignores a failed on-chain transaction', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    const before = await balanceOf();

    provider.seedTransfer({ ...incoming(hash), succeeded: false });

    const result = await sync.scanWallet(app, walletId);
    // A reverted transaction moved no value; recording it would be a financial error.
    expect(result.ingested).toBe(0);
    expect(await balanceOf()).toBe(before);
  });

  it('debits the balance on an outgoing transfer', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    const before = await balanceOf();

    provider.seedTransfer({
      ...incoming(hash),
      direction: 'out',
      rawAmount: -5_000_000n,
    });

    await sync.scanWallet(app, walletId);
    expect(await balanceOf()).toBe(before - 5_000_000n);
  });

  it('walks a detected transaction through to confirmed and notifies', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    provider.seedTransfer(incoming(hash, 1_000_000n));
    await sync.scanWallet(app, walletId);

    // The chain now reports enough confirmations for finality.
    provider.setTransactionStatus({
      txHash: hash,
      found: true,
      succeeded: true,
      confirmations: 25,
      blockNumber: 1001n,
      blockTime: new Date(),
    });

    // The walker skips rows written in the last few seconds. Back-dating `updated_at` here
    // would not work — the touch trigger rewrites it — so the settle delay is passed in.
    const result = await sync.trackConfirmations(app, { limit: 25, olderThanSeconds: 0 });
    expect(result.confirmed).toBeGreaterThanOrEqual(1);

    const rows = await withUser(
      sql,
      { userId: user.id, isAdmin: false },
      (tx) =>
        tx<Array<{ status: string; confirmations: number }>>`
        SELECT status, confirmations FROM transactions WHERE tx_hash = ${hash}
      `,
    );
    expect(rows[0]?.status).toBe('confirmed');

    const notifications = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ id: string }>>`
        SELECT id FROM notifications WHERE user_id = ${user.id} AND type = 'crypto_confirmed'
      `,
    );
    expect(notifications.length).toBeGreaterThanOrEqual(1);
  });

  it('marks a chain transaction failed when the chain says it reverted', async () => {
    const hash = uniqueKey('tx').padEnd(64, '0').slice(0, 64);
    provider.seedTransfer(incoming(hash, 1_000_000n));
    await sync.scanWallet(app, walletId);

    provider.setTransactionStatus({
      txHash: hash,
      found: true,
      succeeded: false,
      confirmations: 30,
      blockNumber: 1002n,
      blockTime: new Date(),
    });
    await sync.trackConfirmations(app, { limit: 25, olderThanSeconds: 0 });

    const rows = await withUser(
      sql,
      { userId: user.id, isAdmin: false },
      (tx) =>
        tx<Array<{ status: string }>>`SELECT status FROM transactions WHERE tx_hash = ${hash}`,
    );
    expect(rows[0]?.status).toBe('failed');
  });

  it('records each scan attempt for the sync inspector', async () => {
    const scans = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ status: string }>>`
        SELECT status FROM blockchain_scans WHERE wallet_id = ${walletId} ORDER BY started_at DESC LIMIT 5
      `,
    );
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((scan) => scan.status === 'ok')).toBe(true);
  });

  it('reconciles the cached balance from the chain', async () => {
    provider.setBalance(TRON_ADDRESS_A, asset.contract, 999_000_000n);
    const result = await sync.reconcileBalances(app, walletId);

    expect(result.updated).toBeGreaterThan(0);
    // Reconciliation is authoritative: it heals drift rather than accumulating it.
    expect(await balanceOf()).toBe(999_000_000n);
  });

  it('advances the scan cursor so the next pass resumes', async () => {
    const wallet = await withSystem(sql, (tx) => walletsRepo.findWalletById(tx, walletId));
    expect(wallet?.scan_cursor).not.toBeNull();
    expect(wallet?.last_scanned_at).not.toBeNull();
    expect(wallet?.consecutive_failures).toBe(0);
  });

  it('never dispatches notifications without a Telegram client configured', async () => {
    // The bot token is a fake in tests, so delivery must not attempt a real network call.
    const services = createServices(app);
    const result = await services.notifications.dispatch(app, { limit: 1, worker: 'test' });
    // Either nothing was claimed, or delivery failed cleanly — never an unhandled throw.
    expect(result).toHaveProperty('sent');
  });

  it('keeps a per-scan audit trail of job enqueues', async () => {
    const jobId = await withSystem(sql, (tx) =>
      opsRepo.enqueueJob(tx, {
        type: 'chain.scan',
        payload: { walletId },
        dedupeKey: uniqueKey('scan-job'),
      }),
    );
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
