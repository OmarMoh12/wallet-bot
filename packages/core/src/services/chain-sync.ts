import {
  AppError,
  FiatAmount,
  TokenAmount,
  assetKey,
  chainEventKey,
  notificationKey,
} from '@wallet/shared';
import type { ChainTransfer } from '@wallet/blockchain';
import { transactionUrl } from '@wallet/blockchain';
import { opsRepo, transactionsRepo, walletsRepo, type AssetRow, type WalletRow } from '@wallet/db';
import type { AppContext } from '../context.js';
import { asSystem } from './base.js';
import { NotificationService } from './notifications.js';

/**
 * Blockchain ingestion.
 *
 * The contract with the outside world is **at-least-once delivery, exactly-once effect**.
 * Indexers replay, paginate imprecisely, and occasionally return the same transfer twice;
 * several workers may scan the same wallet concurrently. None of that may produce a
 * duplicate ledger row or a double-counted balance.
 *
 * Two independent gates enforce that:
 *   1. `processed_events` — an insert-and-check-rowcount claim on
 *      `chain:<network>:<env>:<hash>:<logIndex>`. Race-free because uniqueness is decided by
 *      the index, never by a preceding SELECT.
 *   2. the `(network, env, tx_hash, log_index)` unique index on `transactions`.
 *
 * Everything for one transfer — the claim, the row, the balance delta, the queued
 * notification — happens in ONE database transaction, so a crash mid-way leaves no partial
 * state.
 */

/** Transfers pulled per scan pass. */
const SCAN_PAGE_SIZE = 50;

export interface ScanResult {
  walletId: string;
  seen: number;
  ingested: number;
  skippedUnknownAsset: number;
  skippedDuplicate: number;
  cursorAdvanced: boolean;
}

export class ChainSyncService {
  constructor(private readonly notifications = new NotificationService()) {}

  /**
   * Scan one wallet.
   *
   * Runs unbound (system context): the worker acts on behalf of the platform, not a
   * session. Ownership is resolved from the wallet row itself.
   */
  async scanWallet(app: AppContext, walletId: string): Promise<ScanResult> {
    const wallet = await asSystem(app, (tx) => walletsRepo.findWalletById(tx, walletId));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    const provider = app.providers.get(wallet.network);
    const scan = await asSystem(app, (tx) =>
      walletsRepo.startScan(tx, {
        walletId: wallet.id,
        provider: provider.name,
        cursorBefore: wallet.scan_cursor,
      }),
    );

    const result: ScanResult = {
      walletId: wallet.id,
      seen: 0,
      ingested: 0,
      skippedUnknownAsset: 0,
      skippedDuplicate: 0,
      cursorAdvanced: false,
    };

    try {
      const page = await provider.listTransfers(wallet.address, wallet.scan_cursor, SCAN_PAGE_SIZE);
      result.seen = page.transfers.length;

      // Asset registry for this network/env. Anything not in it is ignored — see below.
      const assets = await asSystem(app, (tx) =>
        tx<AssetRow[]>`
          SELECT * FROM assets WHERE network = ${wallet.network} AND env = ${wallet.env}
        `.then((rows) => [...rows]),
      );

      const byContract = new Map<string, AssetRow>();
      let nativeAsset: AssetRow | undefined;
      for (const asset of assets) {
        if (asset.contract_address) byContract.set(asset.contract_address, asset);
        else nativeAsset = asset;
      }

      for (const transfer of page.transfers) {
        // A failed on-chain transaction moved no value; recording it as income would be a
        // real financial error.
        if (!transfer.succeeded) continue;

        const asset = transfer.contractAddress
          ? byContract.get(transfer.contractAddress)
          : nativeAsset;

        if (!asset) {
          // Unknown contract. Deliberately ignored rather than recorded: anyone can airdrop
          // a token that claims to be USDT, and displaying it would misstate the portfolio.
          result.skippedUnknownAsset += 1;
          app.logger.debug('ignoring transfer of unregistered asset', {
            operation: 'chain.scan',
            walletId: wallet.id,
            contract: transfer.contractAddress,
          });
          continue;
        }

        const ingested = await this.ingestTransfer(
          app,
          wallet,
          asset,
          transfer,
          provider.requiredConfirmations,
        );
        if (ingested) result.ingested += 1;
        else result.skippedDuplicate += 1;
      }

      await asSystem(app, async (tx) => {
        await walletsRepo.markScanSuccess(tx, wallet.id, page.cursor);
        await walletsRepo.finishScan(tx, scan.id, {
          status: 'ok',
          transfersSeen: result.seen,
          transfersNew: result.ingested,
          cursorAfter: page.cursor,
        });
      });
      result.cursorAdvanced = true;

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await asSystem(app, async (tx) => {
        await walletsRepo.markScanFailure(tx, wallet.id, message);
        await walletsRepo.finishScan(tx, scan.id, {
          status: 'failed',
          transfersSeen: result.seen,
          transfersNew: result.ingested,
          cursorAfter: null,
          error: message,
        });
      });
      throw error;
    }
  }

  /**
   * Ingest one transfer. Returns true if it produced a new ledger row.
   *
   * Valuation happens BEFORE the database transaction so no network call is made while
   * holding locks — prices are cached, but "cached" is not "guaranteed instant".
   */
  private async ingestTransfer(
    app: AppContext,
    wallet: WalletRow,
    asset: AssetRow,
    transfer: ChainTransfer,
    requiredConfirmations: number,
  ): Promise<boolean> {
    const amount = TokenAmount.fromRaw(transfer.rawAmount, {
      assetKey: assetKey({
        network: asset.network,
        env: asset.env,
        contractAddress: asset.contract_address,
        symbol: asset.symbol,
      }),
      symbol: asset.symbol,
      decimals: asset.decimals,
    });

    // Value the movement at ingest time and store the snapshot, so history does not change
    // when today's price does.
    let valueUsdMinor: bigint | null = null;
    let valueIlsMinor: bigint | null = null;
    let usdIlsRate: string | null = null;
    let unitPriceUsd: string | null = null;

    try {
      const prices = await app.currency.getPrices([
        { id: asset.id, symbol: asset.symbol, priceId: asset.price_id },
      ]);
      const price = prices.get(asset.id);
      if (price) {
        unitPriceUsd = price.toDecimalString(10);
        const usd = price.value(amount);
        valueUsdMinor = usd.minor;
        const ils = await app.currency.convert(usd, 'ILS');
        if (ils) {
          valueIlsMinor = ils.amount.minor;
          usdIlsRate = ils.rate.rate.toDecimalString(10);
        }
      }
    } catch (error) {
      // Valuation is best-effort: a pricing outage must not stop us recording that money
      // moved. The row simply carries no valuation, and totals report as partial.
      app.logger.warn('could not value chain transfer at ingest time', {
        operation: 'chain.ingest',
        walletId: wallet.id,
        assetId: asset.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    const eventKey = chainEventKey({
      network: wallet.network,
      env: wallet.env,
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
    });

    const inserted = await asSystem(app, async (tx) => {
      // Gate 1: claim the event. Losing this race means another worker already handled it.
      const claimed = await opsRepo.claimEvent(tx, {
        scope: 'chain',
        key: eventKey,
        metadata: { walletId: wallet.id },
      });
      if (!claimed) return null;

      const incoming = transfer.direction === 'in';

      // Gate 2: the unique index. Returns null if the row somehow already exists.
      const created = await transactionsRepo.insertChainTransactionIfNew(tx, {
        userId: wallet.user_id,
        type: incoming ? 'income' : 'expense',
        direction: incoming ? 'in' : 'out',
        // Chain rows start at `detected` and are walked to `confirmed` by chain.confirm.
        status: 'detected',
        source: 'chain',
        title: incoming
          ? `Received ${amount.abs().toDisplayString()} ${asset.symbol}`
          : `Sent ${amount.abs().toDisplayString()} ${asset.symbol}`,
        description: null,
        categoryId: null,
        occurredAt: transfer.blockTime ?? new Date(),
        walletId: wallet.id,
        assetId: asset.id,
        rawAmount: transfer.rawAmount,
        network: wallet.network,
        env: wallet.env,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        counterpartyAddress: transfer.counterparty,
        memo: transfer.memo,
        feeAssetId: null,
        feeRawAmount: transfer.feeRawAmount,
        confirmations: transfer.confirmations ?? 0,
        requiredConfirmations,
        blockNumber: transfer.blockNumber,
        blockTime: transfer.blockTime,
        valueUsdMinor: valueUsdMinor === null ? null : incoming ? valueUsdMinor : -valueUsdMinor,
        valueIlsMinor: valueIlsMinor === null ? null : incoming ? valueIlsMinor : -valueIlsMinor,
        usdIlsRate,
        unitPriceUsd,
      });

      if (!created) return null;

      // Reflect the movement in the cached balance immediately; the periodic reconcile job
      // re-derives it from the chain and heals any drift.
      await walletsRepo.adjustWalletBalance(tx, {
        walletId: wallet.id,
        assetId: asset.id,
        delta: transfer.rawAmount,
        source: 'chain-event',
      });

      await this.notifications.queueInTransaction(tx, {
        userId: wallet.user_id,
        type: incoming ? 'crypto_received' : 'crypto_sent',
        dedupeKey: notificationKey({
          type: incoming ? 'crypto_received' : 'crypto_sent',
          subjectId: created.id,
        }),
        payload: {
          amount: `${amount.abs().toDisplayString()} ${asset.symbol}`,
          wallet: wallet.name,
          network: wallet.network.toUpperCase(),
          address: transfer.counterparty ?? '',
          value:
            valueUsdMinor === null
              ? '—'
              : FiatAmount.fromMinor(
                  valueUsdMinor < 0n ? -valueUsdMinor : valueUsdMinor,
                  'USD',
                ).toDecimalString(),
          transactionId: created.id,
          explorerUrl: transactionUrl(wallet.network, wallet.env, transfer.txHash) ?? '',
        },
      });

      return created;
    });

    return inserted !== null;
  }

  /**
   * Walk in-flight transactions toward finality.
   *
   * Runs as its own job so a slow chain does not hold up scanning. Only on reaching the
   * network's confirmation threshold does the row become `confirmed` and count toward
   * settled balances.
   */
  async trackConfirmations(
    app: AppContext,
    options: { limit?: number; olderThanSeconds?: number } = {},
  ): Promise<{ checked: number; confirmed: number; failed: number }> {
    const rows = await asSystem(app, (tx) =>
      transactionsRepo.listInFlightChainTransactions(tx, {
        limit: options.limit ?? 25,
        // A short settle delay by default, so a row is not queried the instant it is
        // written. Callers that know better (a manual refresh, a test) can pass 0.
        olderThanSeconds: options.olderThanSeconds ?? 20,
      }),
    );

    let confirmed = 0;
    let failed = 0;

    for (const row of rows) {
      if (!row.tx_hash || !row.network) continue;

      // A simulated send has no chain presence; confirm it locally so the UI settles.
      if (row.tx_hash.startsWith('sim-') || row.tx_hash.startsWith('mock-')) {
        await asSystem(app, (tx) =>
          transactionsRepo.updateChainTransactionStatus(tx, row.id, {
            status: 'confirmed',
            confirmations: row.required_confirmations ?? 1,
          }),
        );
        confirmed += 1;
        continue;
      }

      const provider = app.providers.get(row.network);
      try {
        const status = await provider.getTransactionStatus(row.tx_hash);
        if (!status.found) continue;

        const required = row.required_confirmations ?? provider.requiredConfirmations;
        const nextStatus = !status.succeeded
          ? 'failed'
          : status.confirmations >= required
            ? 'confirmed'
            : 'confirming';

        await asSystem(app, async (tx) => {
          const updated = await transactionsRepo.updateChainTransactionStatus(tx, row.id, {
            status: nextStatus,
            confirmations: status.confirmations,
            blockNumber: status.blockNumber,
          });

          if (updated && nextStatus === 'confirmed' && row.status !== 'confirmed') {
            await this.notifications.queueInTransaction(tx, {
              userId: row.user_id,
              type: 'crypto_confirmed',
              dedupeKey: notificationKey({
                type: 'crypto_confirmed',
                subjectId: row.id,
              }),
              payload: {
                amount: row.raw_amount ?? '',
                network: row.network?.toUpperCase() ?? '',
                transactionId: row.id,
                explorerUrl:
                  row.network && row.env && row.tx_hash
                    ? (transactionUrl(row.network, row.env, row.tx_hash) ?? '')
                    : '',
              },
            });
          }

          if (updated && nextStatus === 'failed') {
            await this.notifications.queueInTransaction(tx, {
              userId: row.user_id,
              type: 'crypto_failed',
              dedupeKey: notificationKey({ type: 'crypto_failed', subjectId: row.id }),
              payload: {
                amount: row.raw_amount ?? '',
                network: row.network?.toUpperCase() ?? '',
                transactionId: row.id,
              },
            });
          }
        });

        if (nextStatus === 'confirmed') confirmed += 1;
        if (nextStatus === 'failed') failed += 1;
      } catch (error) {
        app.logger.warn('confirmation check failed', {
          operation: 'chain.confirm',
          transactionId: row.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    return { checked: rows.length, confirmed, failed };
  }

  /**
   * Re-read balances from the chain.
   *
   * The ledger is authoritative for history; the chain is authoritative for "what do I hold
   * right now". A wallet can have activity that predates being added here, so periodic
   * reconciliation is what makes the displayed balance correct rather than merely
   * self-consistent.
   */
  async reconcileBalances(app: AppContext, walletId: string): Promise<{ updated: number }> {
    const wallet = await asSystem(app, (tx) => walletsRepo.findWalletById(tx, walletId));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    const provider = app.providers.get(wallet.network);
    const assets = await asSystem(app, (tx) =>
      tx<AssetRow[]>`
        SELECT * FROM assets WHERE network = ${wallet.network} AND env = ${wallet.env} AND is_active
      `.then((rows) => [...rows]),
    );

    const balances = await provider.getTokenBalances(
      wallet.address,
      assets.map((asset) => ({
        id: asset.id,
        symbol: asset.symbol,
        decimals: asset.decimals,
        contractAddress: asset.contract_address,
        kind: asset.kind,
      })),
    );

    let updated = 0;
    await asSystem(app, async (tx) => {
      for (const balance of balances) {
        const asset = balance.contractAddress
          ? assets.find((row) => row.contract_address === balance.contractAddress)
          : assets.find((row) => row.contract_address === null);
        if (!asset) continue;

        await walletsRepo.upsertWalletBalance(tx, {
          walletId: wallet.id,
          assetId: asset.id,
          rawAmount: balance.rawAmount,
          source: `reconcile:${provider.name}`,
        });
        updated += 1;
      }
    });

    return { updated };
  }
}
