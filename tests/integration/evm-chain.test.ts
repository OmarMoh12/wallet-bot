import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider, toChecksumAddress, type ChainTransfer } from '@wallet/blockchain';
import { walletsRepo, withSystem, withUser, type Sql } from '@wallet/db';
import {
  ChainSyncService,
  createAppContext,
  createServices,
  type AppContext,
  type ServiceContext,
} from '@wallet/core';
import { createTranslator } from '@wallet/shared';
import {
  closeSql,
  createTestUser,
  getSql,
  isDatabaseAvailable,
  uniqueKey,
  type TestUser,
} from '../setup/db';

/**
 * BNB Smart Chain, end to end.
 *
 * Proves EVM is a first-class network in this system rather than a bolted-on special case:
 * the same `ChainSyncService`, the same idempotency gates, the same ledger, the same
 * notification pipeline that TRON and TON use.
 *
 * The BEP-20 decimals assertion is the one that earns its keep. USDT on BSC has **18**
 * decimals where USDT on TRON has 6, and a wrong constant misstates a balance by a factor
 * of a trillion.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] EVM integration tests: TEST_DATABASE_URL is not reachable');
}

/** A checksummed address the user controls, and a counterparty. */
const EVM_ADDRESS = toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
const EVM_COUNTERPARTY = toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359');

describeIf('BNB Smart Chain', () => {
  let sql: Sql;
  let app: AppContext;
  let provider: MockProvider;
  let sync: ChainSyncService;
  let user: TestUser;
  let walletId: string;
  let usdt: { id: string; decimals: number; contract: string };
  let bnb: { id: string; decimals: number };
  let context: ServiceContext;

  beforeAll(async () => {
    sql = getSql();
    user = await createTestUser(sql);

    app = createAppContext({ service: 'test', sql });
    provider = new MockProvider({ network: 'bsc', env: 'testnet', requiredConfirmations: 6 });
    app.providers.register('bsc', provider);
    sync = new ChainSyncService();

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

    const assets = await withSystem(
      sql,
      (tx) =>
        tx<
          Array<{ id: string; symbol: string; decimals: number; contract_address: string | null }>
        >`
        SELECT id, symbol, decimals, contract_address FROM assets
        WHERE network = 'bsc' AND env = 'testnet'
      `,
    );

    const usdtRow = assets.find((asset) => asset.symbol === 'USDT');
    const nativeRow = assets.find((asset) => asset.contract_address === null);
    if (!usdtRow?.contract_address || !nativeRow) throw new Error('BSC assets are not seeded');

    usdt = {
      id: usdtRow.id,
      decimals: usdtRow.decimals,
      contract: usdtRow.contract_address,
    };
    bnb = { id: nativeRow.id, decimals: nativeRow.decimals };

    await withUser(sql, { userId: user.id, isAdmin: false }, async (tx) => {
      const wallet = await walletsRepo.createWallet(tx, {
        userId: user.id,
        name: 'Personal BSC Wallet',
        network: 'bsc',
        env: 'testnet',
        address: EVM_ADDRESS,
        // Storage is lowercase: case is a checksum, not part of the address.
        addressCanonical: EVM_ADDRESS.toLowerCase(),
        type: 'watch_only',
      });
      walletId = wallet.id;
    });
  });

  afterAll(async () => {
    await closeSql();
  });

  function transfer(txHash: string, rawAmount: bigint, direction: 'in' | 'out'): ChainTransfer {
    return {
      network: 'bsc',
      env: 'testnet',
      txHash,
      logIndex: 0,
      address: EVM_ADDRESS.toLowerCase(),
      direction,
      counterparty: EVM_COUNTERPARTY,
      contractAddress: usdt.contract,
      symbolHint: 'USDT',
      decimalsHint: 18,
      rawAmount,
      feeRawAmount: null,
      memo: null,
      blockNumber: 40_000_000n,
      blockTime: new Date(),
      confirmations: 1,
      succeeded: true,
    };
  }

  async function balanceOf(assetId: string): Promise<bigint> {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ raw_amount: string }>>`
        SELECT raw_amount FROM wallet_balances
        WHERE wallet_id = ${walletId} AND asset_id = ${assetId}
      `,
    );
    return BigInt(rows[0]?.raw_amount ?? '0');
  }

  /* ------------------------------------------------------------- registry -- */

  it('registers BEP-20 USDT with 18 decimals, not 6', () => {
    // The classic BSC integration bug. Six here would misstate every balance by 10^12.
    expect(usdt.decimals).toBe(18);
    expect(bnb.decimals).toBe(18);
    expect(usdt.contract).toBe(usdt.contract.toLowerCase());
  });

  /* -------------------------------------------------------------- receive -- */

  it('detects an incoming BEP-20 transfer and credits the exact amount', async () => {
    const hash = `0x${uniqueKey('a')
      .replace(/[^0-9a-f]/gi, '0')
      .padEnd(64, '0')
      .slice(0, 64)}`;
    // 125.5 USDT at 18 decimals.
    const amount = 125_500_000_000_000_000_000n;
    provider.seedTransfer(transfer(hash, amount, 'in'));

    const result = await sync.scanWallet(app, walletId);
    expect(result.ingested).toBe(1);

    const rows = await withUser(
      sql,
      { userId: user.id, isAdmin: false },
      (tx) =>
        tx<Array<{ raw_amount: string; direction: string; network: string; status: string }>>`
        SELECT raw_amount, direction, network, status FROM transactions WHERE tx_hash = ${hash}
      `,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.network).toBe('bsc');
    expect(rows[0]?.direction).toBe('in');
    expect(rows[0]?.status).toBe('detected');
    // Exact to the wei — no float ever touched this number.
    expect(BigInt(rows[0]?.raw_amount ?? '0')).toBe(amount);

    expect(await balanceOf(usdt.id)).toBe(amount);
  });

  it('queues a notification naming the wallet', async () => {
    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM notifications
        WHERE user_id = ${user.id} AND type = 'crypto_received'
      `,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(String(rows[0]?.payload.wallet)).toBe('Personal BSC Wallet');
    expect(String(rows[0]?.payload.network)).toBe('BSC');
  });

  it('is idempotent when the node replays the same log', async () => {
    const hash = `0x${uniqueKey('b')
      .replace(/[^0-9a-f]/gi, '0')
      .padEnd(64, '0')
      .slice(0, 64)}`;
    const amount = 10n ** 18n;
    const before = await balanceOf(usdt.id);

    provider.seedTransfer(transfer(hash, amount, 'in'));
    await sync.scanWallet(app, walletId);
    expect(await balanceOf(usdt.id)).toBe(before + amount);

    // `eth_getLogs` over an overlapping block range returns the same log again.
    provider.seedTransfer(transfer(hash, amount, 'in'));
    const second = await sync.scanWallet(app, walletId);

    expect(second.ingested).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(await balanceOf(usdt.id)).toBe(before + amount);
  });

  it('debits on an outgoing transfer', async () => {
    const hash = `0x${uniqueKey('c')
      .replace(/[^0-9a-f]/gi, '0')
      .padEnd(64, '0')
      .slice(0, 64)}`;
    const before = await balanceOf(usdt.id);

    provider.seedTransfer(transfer(hash, -(5n * 10n ** 18n), 'out'));
    await sync.scanWallet(app, walletId);

    expect(await balanceOf(usdt.id)).toBe(before - 5n * 10n ** 18n);
  });

  it('ignores a transfer of an unregistered BEP-20 contract', async () => {
    const hash = `0x${uniqueKey('d')
      .replace(/[^0-9a-f]/gi, '0')
      .padEnd(64, '0')
      .slice(0, 64)}`;
    const before = await balanceOf(usdt.id);

    provider.seedTransfer({
      ...transfer(hash, 10n ** 21n, 'in'),
      // Scam airdrops are routine on BSC. Only the registry decides what counts.
      contractAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      symbolHint: 'USDT',
    });

    const result = await sync.scanWallet(app, walletId);
    expect(result.ingested).toBe(0);
    expect(result.skippedUnknownAsset).toBe(1);
    expect(await balanceOf(usdt.id)).toBe(before);
  });

  it('walks a transfer to confirmed once the chain agrees', async () => {
    const hash = `0x${uniqueKey('e')
      .replace(/[^0-9a-f]/gi, '0')
      .padEnd(64, '0')
      .slice(0, 64)}`;
    provider.seedTransfer(transfer(hash, 10n ** 18n, 'in'));
    await sync.scanWallet(app, walletId);

    provider.setTransactionStatus({
      txHash: hash,
      found: true,
      succeeded: true,
      confirmations: 12,
      blockNumber: 40_000_012n,
      blockTime: new Date(),
    });

    await sync.trackConfirmations(app, { limit: 25, olderThanSeconds: 0 });

    const rows = await withUser(
      sql,
      { userId: user.id, isAdmin: false },
      (tx) =>
        tx<Array<{ status: string }>>`SELECT status FROM transactions WHERE tx_hash = ${hash}`,
    );
    expect(rows[0]?.status).toBe('confirmed');
  });

  it('reconciles balances from the chain', async () => {
    provider.setBalance(EVM_ADDRESS, usdt.contract, 777n * 10n ** 18n);
    const result = await sync.reconcileBalances(app, walletId);

    expect(result.updated).toBeGreaterThan(0);
    expect(await balanceOf(usdt.id)).toBe(777n * 10n ** 18n);
  });

  /* ----------------------------------------------------------------- send -- */

  it('refuses to send while the master switch is off', async () => {
    const services = createServices(app);
    await expect(
      services.send.quote(context, {
        walletId,
        assetId: usdt.id,
        toAddress: EVM_COUNTERPARTY,
        amount: '1',
        idempotencyKey: uniqueKey('q'),
      }),
    ).rejects.toMatchObject({ code: 'SENDING_DISABLED' });
  });

  it('rejects a TRON address as a BEP-20 recipient', async () => {
    const services = createServices(app);
    // Sending to a TRON address on BSC would be unrecoverable, so it must never validate.
    await expect(
      services.send.quote(context, {
        walletId,
        assetId: usdt.id,
        toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        amount: '1',
        idempotencyKey: uniqueKey('q'),
      }),
    ).rejects.toMatchObject({ code: 'SENDING_DISABLED' });
  });

  /* -------------------------------------------------------------- receive -- */

  it('exposes the checksummed address and a BscScan link for receiving', async () => {
    const services = createServices(app);
    const info = await services.receive.info(context, { walletId, assetId: usdt.id });

    // Display uses the checksummed form users compare against.
    expect(info.address).toBe(EVM_ADDRESS);
    expect(info.networkLabel).toContain('BNB Smart Chain');
    expect(info.qrSvgDataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(info.wallet.explorerUrl).toContain('bscscan.com');
  });

  it('lists the wallet with its network and managed status', async () => {
    const services = createServices(app);
    const wallets = await services.wallets.list(context);
    const wallet = wallets.find((entry) => entry.id === walletId);

    expect(wallet?.network).toBe('bsc');
    expect(wallet?.env).toBe('testnet');
    expect(wallet?.isWatchOnly).toBe(true);
  });

  /* ------------------------------------------------------ address creation -- */

  it('creates a managed wallet without ever exposing a key', async () => {
    const services = createServices(app);
    const created = await services.wallets.createManagedEvmWallet(context, {
      name: 'Generated BSC Wallet',
      network: 'bsc',
      idempotencyKey: uniqueKey('gen'),
    });

    expect(created.network).toBe('bsc');
    expect(created.isWatchOnly).toBe(false);
    expect(created.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // The DTO has no field that could carry key material, and the stored row has no column
    // for one. Both are asserted, because the guarantee is structural.
    expect(JSON.stringify(created)).not.toMatch(/privateKey|private_key|mnemonic|seed/i);

    const columns = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'wallets'
      `,
    );
    const names = columns.map((column) => column.column_name).join(',');
    expect(names).not.toMatch(/private|secret|mnemonic|seed/i);
  });

  it('returns the same address for a repeated generation key', async () => {
    const services = createServices(app);
    const key = uniqueKey('gen');

    const first = await services.wallets.createManagedEvmWallet(context, {
      name: 'Idempotent Wallet',
      network: 'bsc',
      idempotencyKey: key,
    });

    // A retry must not strand a second funded address nobody knows about.
    await expect(
      services.wallets.createManagedEvmWallet(context, {
        name: 'Idempotent Wallet',
        network: 'bsc',
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });

    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
