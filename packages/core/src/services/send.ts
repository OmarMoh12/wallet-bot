import {
  AppError,
  TokenAmount,
  addSeconds,
  assetKey,
  type SendConfirmRequest,
  type SendQuoteDto,
  type SendQuoteRequest,
  type SendResultDto,
} from '@wallet/shared';
import { transactionUrl, validateAddress, type AssetRef } from '@wallet/blockchain';
import { isEvmNetwork } from '@wallet/shared';
import {
  opsRepo,
  sendRepo,
  transactionsRepo,
  walletsRepo,
  type AssetRow,
  type WalletRow,
} from '@wallet/db';
import { quoteFingerprint } from '../auth/tokens.js';
import { asUser, audit, fxPreference, type ServiceContext } from './base.js';
import { fiatFromMinor, toAssetDto, toTokenDto } from '../mappers.js';
import type { AuthService } from '../auth/service.js';
import { NotificationService } from './notifications.js';

/**
 * Outgoing transfers.
 *
 * Read `docs/security.md` §"Signing architecture" before changing anything here.
 *
 * Layered controls, each independently sufficient to stop a transfer:
 *   1. `SENDING_ENABLED=false` (the default) — refused before any work happens.
 *   2. `app_settings.sending_enabled` — a database kill switch that can only ever *tighten*
 *      the environment setting, never loosen it.
 *   3. The wallet must be `managed`, i.e. a signer has been provisioned with its key
 *      out-of-band. Every wallet created through the API is `watch_only`.
 *   4. PIN required (`SEND_REQUIRE_PIN`, mandatory in production).
 *   5. Per-transaction and rolling-24h USD caps.
 *   6. Quote fingerprint — confirmation must echo the exact numbers the user was shown.
 *   7. Idempotency key — a retry returns the original result rather than sending again.
 *   8. `SIGNER_MODE=mock` (the default) — nothing is broadcast even if all of the above pass.
 */
export class SendService {
  constructor(
    private readonly auth: AuthService,
    private readonly notifications = new NotificationService(),
  ) {}

  /** Gate 1+2: is sending permitted at all right now? */
  private async assertSendingEnabled(context: ServiceContext): Promise<void> {
    if (!context.app.config.sending.enabled) {
      throw new AppError('SENDING_DISABLED', { internal: 'SENDING_ENABLED is false' });
    }
    const dbEnabled = await asUser(context, (tx) =>
      opsRepo.getAppSetting<boolean>(tx, 'sending_enabled', false),
    );
    if (dbEnabled !== true) {
      throw new AppError('SENDING_DISABLED', { internal: 'app_settings.sending_enabled is false' });
    }
  }

  private toAssetRef(asset: AssetRow): AssetRef {
    return {
      id: asset.id,
      symbol: asset.symbol,
      decimals: asset.decimals,
      contractAddress: asset.contract_address,
      kind: asset.kind,
    };
  }

  /**
   * Phase 1 — quote.
   *
   * Validates everything and records a `send_requests` row in `quoted` state. No key
   * material is touched and nothing can move: this only produces numbers to show the user.
   */
  async quote(context: ServiceContext, request: SendQuoteRequest): Promise<SendQuoteDto> {
    await this.assertSendingEnabled(context);

    const { wallet, asset } = await asUser(context, async (tx) => {
      const walletRow = await walletsRepo.findWallet(tx, context.actor.userId, request.walletId);
      if (!walletRow) throw new AppError('WALLET_NOT_FOUND');
      if (!walletRow.is_active) throw new AppError('WALLET_INACTIVE');
      if (walletRow.type !== 'managed') {
        // The expected case for this deployment: watch-only wallets cannot sign.
        throw new AppError('WATCH_ONLY_WALLET', {
          internal: `wallet ${walletRow.id} is watch-only; no signer is provisioned for it`,
        });
      }

      const assetRow = await opsRepo.findAsset(tx, request.assetId);
      if (!assetRow) throw new AppError('ASSET_NOT_FOUND');
      if (assetRow.network !== walletRow.network || assetRow.env !== walletRow.env) {
        throw new AppError('ASSET_NOT_SUPPORTED', {
          details: { reason: 'asset does not belong to the wallet network' },
        });
      }
      return { wallet: walletRow, asset: assetRow };
    });

    const validation = validateAddress(wallet.network, request.toAddress);
    if (!validation.valid) {
      throw new AppError('INVALID_ADDRESS', {
        details: { network: wallet.network, reason: validation.reason },
      });
    }
    if (validation.canonical === wallet.address_canonical) {
      throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    }

    const amount = TokenAmount.parse(request.amount, {
      assetKey: assetKey({
        network: asset.network,
        env: asset.env,
        contractAddress: asset.contract_address,
        symbol: asset.symbol,
      }),
      symbol: asset.symbol,
      decimals: asset.decimals,
    });
    if (!amount.isPositive()) throw new AppError('AMOUNT_TOO_SMALL');

    const provider = context.app.providers.get(wallet.network);

    // --- fee ------------------------------------------------------------------
    const feeEstimate = await provider.estimateFee({
      fromAddress: wallet.address,
      toAddress: validation.canonical,
      asset: this.toAssetRef(asset),
      rawAmount: amount.raw,
      memo: request.memo ?? null,
    });

    const nativeAsset = await asUser(context, (tx) =>
      opsRepo.findAssetByContract(tx, {
        network: wallet.network,
        env: wallet.env,
        contractAddress: null,
        symbol: feeEstimate.symbol,
      }),
    );

    const fee = TokenAmount.fromRaw(feeEstimate.rawAmount, {
      assetKey: nativeAsset?.id ?? `${wallet.network}:native`,
      symbol: feeEstimate.symbol,
      decimals: feeEstimate.decimals,
    });

    // --- balance --------------------------------------------------------------
    const balances = await asUser(context, (tx) => walletsRepo.listWalletBalances(tx, wallet.id));
    const assetBalance = balances.find((row) => row.asset_id === asset.id);
    const held = BigInt(assetBalance?.raw_amount ?? '0');

    const sameAssetAsFee = nativeAsset?.id === asset.id;
    const required = sameAssetAsFee ? amount.raw + fee.raw : amount.raw;

    if (held < required) {
      throw new AppError('INSUFFICIENT_BALANCE', {
        details: {
          required: required.toString(),
          available: held.toString(),
          symbol: asset.symbol,
        },
      });
    }

    // The fee is paid in the native coin. When that is a *different* asset from the one
    // being sent — every ERC-20/TRC-20/jetton transfer — the wallet needs a separate
    // balance to cover it.
    //
    // On EVM chains this is the single most common send failure and has a completely
    // different remedy from a shortfall of the asset itself ("top up BNB", not "send less
    // USDT"), so it gets its own error code and its own message.
    if (!sameAssetAsFee && nativeAsset) {
      const nativeBalance = BigInt(
        balances.find((row) => row.asset_id === nativeAsset.id)?.raw_amount ?? '0',
      );
      if (nativeBalance < fee.raw) {
        throw new AppError(
          isEvmNetwork(wallet.network) ? 'INSUFFICIENT_GAS' : 'INSUFFICIENT_BALANCE',
          {
            details: {
              reason: 'network fee',
              symbol: feeEstimate.symbol,
              required: fee.toDecimalString(),
              available: TokenAmount.fromRaw(nativeBalance, {
                assetKey: nativeAsset.id,
                symbol: nativeAsset.symbol,
                decimals: nativeAsset.decimals,
              }).toDecimalString(),
            },
          },
        );
      }
    }

    // --- valuation and limits --------------------------------------------------
    const preference = await fxPreference(context);
    const prices = await context.app.currency.getPrices([
      { id: asset.id, symbol: asset.symbol, priceId: asset.price_id },
      ...(nativeAsset
        ? [{ id: nativeAsset.id, symbol: nativeAsset.symbol, priceId: nativeAsset.price_id }]
        : []),
    ]);

    const valued = await context.app.currency.valueToken(amount, prices.get(asset.id), preference);
    const valueUsdMinor = valued.usd?.minor ?? null;

    if (valueUsdMinor !== null) {
      if (valueUsdMinor > context.app.config.sending.maxUsdPerTxMinor) {
        throw new AppError('SEND_LIMIT_EXCEEDED', {
          details: {
            limitUsd: (context.app.config.sending.maxUsdPerTxMinor / 100n).toString(),
          },
        });
      }
      const spent = await asUser(context, (tx) =>
        sendRepo.spentUsdMinorInWindow(tx, context.actor.userId, 24 * 3600),
      );
      if (spent + valueUsdMinor > context.app.config.sending.maxUsdPerDayMinor) {
        throw new AppError('SEND_DAILY_LIMIT_EXCEEDED', {
          details: {
            limitUsd: (context.app.config.sending.maxUsdPerDayMinor / 100n).toString(),
            spentUsd: (spent / 100n).toString(),
          },
        });
      }
    } else {
      // Cannot price it, so cannot enforce the cap. Refuse rather than send blind.
      throw new AppError('PRICE_UNAVAILABLE', {
        internal: 'refusing to send an amount that cannot be valued against the spend limits',
      });
    }

    const feeValued = nativeAsset
      ? await context.app.currency.valueToken(fee, prices.get(nativeAsset.id), preference)
      : { usd: null, ils: null, pricedAt: null };

    // --- warnings --------------------------------------------------------------
    const warnings: string[] = [];
    const sentBefore = await asUser(context, (tx) =>
      sendRepo.hasSentToAddressBefore(tx, context.actor.userId, validation.canonical),
    );
    if (!sentBefore) warnings.push('send.warning.newAddress');

    // An EVM address is valid on every EVM chain. Sending BEP-20 USDT to an address the user
    // only controls on Ethereum is a real and unrecoverable mistake, so the confirmation
    // screen says which chain this is going to.
    if (isEvmNetwork(wallet.network)) warnings.push('send.warning.evmSameAddress');
    if (valueUsdMinor > context.app.config.sending.maxUsdPerTxMinor / 2n) {
      warnings.push('send.warning.largeAmount');
    }

    // --- persist the quote ------------------------------------------------------
    const expiresAt = addSeconds(new Date(), context.app.config.sending.confirmTtlSeconds);
    const fingerprint = quoteFingerprint({
      walletId: wallet.id,
      assetId: asset.id,
      to: validation.canonical,
      amount: amount.raw.toString(),
      fee: fee.raw.toString(),
      memo: request.memo ?? '',
      expiresAt: expiresAt.toISOString(),
      idempotencyKey: request.idempotencyKey,
    });

    const { request: row, created } = await asUser(context, async (tx) => {
      const result = await sendRepo.createSendRequest(tx, {
        userId: context.actor.userId,
        walletId: wallet.id,
        assetId: asset.id,
        toAddress: validation.display,
        toAddressCanonical: validation.canonical,
        rawAmount: amount.raw,
        memo: request.memo ?? null,
        quoteFingerprint: fingerprint,
        feeAssetId: nativeAsset?.id ?? null,
        feeRawAmount: fee.raw,
        valueUsdMinor,
        expiresAt,
        simulated: context.app.signer.simulated,
        idempotencyKey: request.idempotencyKey,
      });

      if (result.created) {
        await audit(context, tx, {
          action: 'send.quoted',
          entityType: 'send_request',
          entityId: result.request.id,
          metadata: {
            network: wallet.network,
            symbol: asset.symbol,
            amount: amount.toDecimalString(),
            valueUsdMinor: valueUsdMinor.toString(),
          },
        });
      }
      return result;
    });

    // Replaying the same idempotency key returns the ORIGINAL quote, not a new one.
    const total = sameAssetAsFee ? amount.raw + fee.raw : amount.raw;

    return {
      sendRequestId: row.id,
      status: row.status,
      wallet: {
        id: wallet.id,
        name: wallet.name,
        network: wallet.network,
        env: wallet.env,
        address: wallet.address,
      },
      asset: toAssetDto(asset),
      amount: toTokenDto(amount, asset.id),
      amountUsd: fiatFromMinor(valueUsdMinor, 'USD'),
      toAddress: created ? validation.display : row.to_address,
      memo: row.memo,
      estimatedFee: nativeAsset ? toTokenDto(fee, nativeAsset.id) : null,
      estimatedFeeUsd: feeValued.usd ? fiatFromMinor(feeValued.usd.minor, 'USD') : null,
      total: toTokenDto(
        TokenAmount.fromRaw(total, {
          assetKey: asset.id,
          symbol: asset.symbol,
          decimals: asset.decimals,
        }),
        asset.id,
      ),
      fingerprint: row.quote_fingerprint,
      expiresAt: row.expires_at.toISOString(),
      simulated: row.simulated,
      warnings,
    };
  }

  /**
   * Phase 2 — confirm and execute.
   *
   * The critical step is the conditional `quoted → confirmed` UPDATE: it succeeds for
   * exactly one caller. Two concurrent confirmations of the same quote cannot both proceed,
   * which is what makes double-spending impossible at this layer.
   */
  async confirm(context: ServiceContext, request: SendConfirmRequest): Promise<SendResultDto> {
    await this.assertSendingEnabled(context);

    if (context.app.config.sending.requirePin) {
      await this.auth.requirePin(context.actor, request.pin, context.requestId);
    }

    const existing = await asUser(context, (tx) =>
      sendRepo.findSendRequest(tx, context.actor.userId, request.sendRequestId),
    );
    if (!existing) throw new AppError('NOT_FOUND');

    // Idempotent replay of an already-executed confirmation.
    if (existing.status === 'completed' || existing.status === 'broadcast') {
      return this.toResult(
        existing.id,
        existing.status,
        existing.tx_hash,
        existing.transaction_id,
        {
          network: existing.wallet.network,
          env: existing.wallet.env,
          simulated: existing.simulated,
        },
      );
    }
    if (existing.status !== 'quoted') {
      throw new AppError(
        existing.status === 'expired' ? 'SEND_QUOTE_EXPIRED' : 'SEND_ALREADY_CONFIRMED',
      );
    }
    if (existing.expires_at.getTime() <= Date.now()) {
      throw new AppError('SEND_QUOTE_EXPIRED');
    }

    // Atomic claim. Only one caller can move quoted -> confirmed.
    const claimed = await asUser(context, (tx) =>
      sendRepo.confirmSendRequest(tx, {
        userId: context.actor.userId,
        id: request.sendRequestId,
        fingerprint: request.quoteFingerprint,
      }),
    );
    if (!claimed) {
      // Either the fingerprint did not match (the quote changed under the user) or someone
      // else already claimed it. Both must fail closed.
      throw new AppError('SEND_QUOTE_EXPIRED', {
        internal: 'quote fingerprint mismatch or already claimed',
      });
    }

    await asUser(context, (tx) =>
      audit(context, tx, {
        action: 'send.confirmed',
        entityType: 'send_request',
        entityId: claimed.id,
      }),
    );

    return this.execute(context, claimed.id);
  }

  /**
   * Build → sign → broadcast → record.
   *
   * Shared by the manual send flow and the scheduled-payment executor, so both get exactly
   * the same guarantees.
   */
  async execute(context: ServiceContext, sendRequestId: string): Promise<SendResultDto> {
    const row = await asUser(context, (tx) =>
      sendRepo.findSendRequest(tx, context.actor.userId, sendRequestId),
    );
    if (!row) throw new AppError('NOT_FOUND');
    if (row.status !== 'confirmed') {
      throw new AppError('INVALID_STATE_TRANSITION', {
        details: { entity: 'send_request', from: row.status, to: 'signing' },
      });
    }

    const wallet: WalletRow = row.wallet;
    const asset: AssetRow = row.asset;
    const provider = context.app.providers.get(wallet.network);

    const amount = TokenAmount.fromRaw(row.raw_amount, {
      assetKey: asset.id,
      symbol: asset.symbol,
      decimals: asset.decimals,
    });

    try {
      await asUser(context, (tx) => sendRepo.setSendRequestStatus(tx, row.id, 'signing'));

      // Build the unsigned transaction. This process cannot sign it.
      const unsigned = await provider.buildTransfer({
        fromAddress: wallet.address,
        toAddress: row.to_address_canonical,
        asset: this.toAssetRef(asset),
        rawAmount: amount.raw,
        memo: row.memo,
      });

      const signed = await context.app.signer.sign({
        sendRequestId: row.id,
        idempotencyKey: row.idempotency_key,
        unsigned,
        valueUsdMinor: row.value_usd_minor ? BigInt(row.value_usd_minor) : null,
      });

      const broadcast = signed.simulated
        ? // Mock mode never reaches a network, but still produces a stable hash so the whole
          // downstream pipeline (records, notifications, confirmation tracking) is exercised.
          { txHash: `sim-${unsigned.digest.slice(0, 40)}`, accepted: true }
        : await provider.broadcast(signed.signed);

      const transaction = await asUser(context, async (tx) => {
        const created = await transactionsRepo.insertChainTransactionIfNew(tx, {
          userId: context.actor.userId,
          type: 'expense',
          direction: 'out',
          status: signed.simulated ? 'pending' : 'detected',
          source: row.scheduled_payment_id ? 'scheduled' : 'manual',
          title: context.t('send.title'),
          description: null,
          categoryId: null,
          occurredAt: new Date(),
          walletId: wallet.id,
          assetId: asset.id,
          rawAmount: -amount.raw,
          network: wallet.network,
          env: wallet.env,
          txHash: broadcast.txHash,
          logIndex: -1,
          counterpartyAddress: row.to_address,
          memo: row.memo,
          feeAssetId: row.fee_asset_id,
          feeRawAmount: row.fee_raw_amount ? BigInt(row.fee_raw_amount) : null,
          confirmations: 0,
          requiredConfirmations: provider.requiredConfirmations,
          blockNumber: null,
          blockTime: null,
          valueUsdMinor: row.value_usd_minor ? -BigInt(row.value_usd_minor) : null,
          valueIlsMinor: null,
          usdIlsRate: null,
          unitPriceUsd: null,
          sendRequestId: row.id,
          scheduledPaymentId: row.scheduled_payment_id,
        });

        await sendRepo.setSendRequestStatus(tx, row.id, 'broadcast', {
          txHash: broadcast.txHash,
          transactionId: created?.id ?? null,
        });

        await audit(context, tx, {
          action: 'send.broadcast',
          entityType: 'send_request',
          entityId: row.id,
          metadata: {
            txHash: broadcast.txHash,
            simulated: signed.simulated,
            signerRef: signed.signerRef,
          },
        });

        return created;
      });

      await this.notifications.queueOutgoing(context, {
        transactionId: transaction?.id ?? null,
        amountText: `${amount.toDisplayString()} ${asset.symbol}`,
        address: row.to_address,
        walletName: wallet.name,
        network: wallet.network,
        env: wallet.env,
        txHash: broadcast.txHash,
      });

      return this.toResult(row.id, 'broadcast', broadcast.txHash, transaction?.id ?? null, {
        network: wallet.network,
        env: wallet.env,
        simulated: signed.simulated,
      });
    } catch (error) {
      const code = AppError.is(error) ? error.code : 'INTERNAL_ERROR';
      await asUser(context, async (tx) => {
        await sendRepo.setSendRequestStatus(tx, row.id, 'failed', { errorCode: code });
        await audit(context, tx, {
          action: 'send.failed',
          entityType: 'send_request',
          entityId: row.id,
          metadata: { code },
        });
      });
      throw error;
    }
  }

  async cancel(context: ServiceContext, sendRequestId: string): Promise<void> {
    await asUser(context, async (tx) => {
      const row = await sendRepo.findSendRequest(tx, context.actor.userId, sendRequestId);
      if (!row) throw new AppError('NOT_FOUND');
      if (row.status !== 'quoted' && row.status !== 'confirmed') {
        throw new AppError('INVALID_STATE_TRANSITION', {
          details: { entity: 'send_request', from: row.status, to: 'cancelled' },
        });
      }
      await sendRepo.setSendRequestStatus(tx, sendRequestId, 'cancelled');
      await audit(context, tx, {
        action: 'send.cancelled',
        entityType: 'send_request',
        entityId: sendRequestId,
      });
    });
  }

  private toResult(
    id: string,
    status: SendResultDto['status'],
    txHash: string | null,
    transactionId: string | null,
    meta: { network: WalletRow['network']; env: WalletRow['env']; simulated: boolean },
  ): SendResultDto {
    return {
      sendRequestId: id,
      status,
      txHash,
      // A simulated hash is not on any chain, so it gets no explorer link.
      explorerUrl:
        txHash && !meta.simulated ? transactionUrl(meta.network, meta.env, txHash) : null,
      transactionId,
      simulated: meta.simulated,
    };
  }
}
