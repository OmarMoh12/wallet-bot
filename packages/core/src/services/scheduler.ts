import {
  AppError,
  DEFAULT_LOCALE,
  TokenAmount,
  addSeconds,
  backoffDelayMs,
  createTranslator,
  isLocale,
  notificationKey,
  scheduledExecutionKey,
} from '@wallet/shared';
import { validateAddress } from '@wallet/blockchain';
import {
  opsRepo,
  planningRepo,
  sendRepo,
  usersRepo,
  walletsRepo,
  type ScheduledPaymentRow,
} from '@wallet/db';
import type { AppContext } from '../context.js';
import type { AuthenticatedActor } from '../auth/service.js';
import { asSystem, type ServiceContext } from './base.js';
import { NotificationService } from './notifications.js';
import type { SendService } from './send.js';
import { quoteFingerprint } from '../auth/tokens.js';

/**
 * Scheduled-payment execution.
 *
 * The safety property: **if anything is uncertain, nothing is sent.** Every pre-flight check
 * failure moves the row to `failed` with a reason code and notifies the user, rather than
 * retrying blindly against a state we do not understand.
 *
 * With `SENDING_ENABLED=false` — the default — the very first check fails, so a freshly
 * deployed system cannot move funds no matter what is scheduled.
 */
export class SchedulerService {
  constructor(
    private readonly send: SendService,
    private readonly notifications = new NotificationService(),
  ) {}

  /** Build a per-user service context for a worker acting on someone's behalf. */
  private async contextFor(
    app: AppContext,
    userId: string,
    requestId: string,
  ): Promise<ServiceContext> {
    const user = await asSystem(app, (tx) => usersRepo.findUserById(tx, userId));
    if (!user) throw new AppError('NOT_FOUND', { internal: `user ${userId} not found` });

    const settings = await asSystem(app, (tx) => usersRepo.getUserSettings(tx, userId));
    const locale = isLocale(settings?.locale) ? settings.locale : DEFAULT_LOCALE;

    const actor: AuthenticatedActor = {
      userId,
      telegramId: BigInt(user.telegram_id),
      // A scheduled job never runs with admin authority, whatever the owner's role.
      isAdmin: false,
      sessionId: 'system',
      locale,
    };

    return {
      app,
      actor,
      requestId,
      t: createTranslator(locale),
      ip: null,
      userAgent: 'worker/scheduler',
    };
  }

  /**
   * Claim and execute due payments.
   *
   * `claimDueScheduledPayments` takes a lease with `FOR UPDATE SKIP LOCKED`, so N workers
   * never take the same row and a crashed worker's claim expires rather than sticking.
   */
  async tick(
    app: AppContext,
    options: { worker: string; limit?: number; requestId: string },
  ): Promise<{ claimed: number; executed: number; failed: number }> {
    const enabledInDb = await asSystem(app, (tx) =>
      opsRepo.getAppSetting<boolean>(tx, 'scheduled_payments_enabled', true),
    );
    if (!enabledInDb) return { claimed: 0, executed: 0, failed: 0 };

    const due = await asSystem(app, (tx) =>
      planningRepo.claimDueScheduledPayments(tx, {
        worker: options.worker,
        limit: options.limit ?? 5,
        leaseSeconds: 120,
      }),
    );

    let executed = 0;
    let failed = 0;

    for (const row of due) {
      try {
        await this.executeOne(app, row, options.requestId);
        executed += 1;
      } catch (error) {
        failed += 1;
        const code = AppError.is(error) ? error.code : 'INTERNAL_ERROR';
        app.logger.warn('scheduled payment did not execute', {
          operation: 'schedule.execute',
          scheduledPaymentId: row.id,
          code,
        });
        await this.markFailed(app, row, code);
      }
    }

    return { claimed: due.length, executed, failed };
  }

  /**
   * Execute one claimed payment.
   *
   * Pre-flight order is deliberate: cheapest and most decisive checks first, so a disabled
   * system never touches a provider, and an invalid recipient is caught before any fee
   * estimation.
   */
  private async executeOne(
    app: AppContext,
    row: ScheduledPaymentRow,
    requestId: string,
  ): Promise<void> {
    // --- 1. Global kill switch -----------------------------------------------
    if (!app.config.sending.enabled) {
      throw new AppError('SENDING_DISABLED', {
        internal: 'SENDING_ENABLED is false; scheduled payment prepared but not sent',
      });
    }
    const dbEnabled = await asSystem(app, (tx) =>
      opsRepo.getAppSetting<boolean>(tx, 'sending_enabled', false),
    );
    if (!dbEnabled) throw new AppError('SENDING_DISABLED');

    const context = await this.contextFor(app, row.user_id, requestId);

    // --- 2. Wallet and asset still valid -------------------------------------
    const { wallet, asset } = await asSystem(app, async (tx) => {
      const walletRow = await walletsRepo.findWalletById(tx, row.wallet_id);
      if (!walletRow || walletRow.deleted_at) throw new AppError('WALLET_NOT_FOUND');
      if (!walletRow.is_active) throw new AppError('WALLET_INACTIVE');
      const assetRow = await opsRepo.findAsset(tx, row.asset_id);
      if (!assetRow) throw new AppError('ASSET_NOT_FOUND');
      return { wallet: walletRow, asset: assetRow };
    });

    // --- 3. Recipient still valid --------------------------------------------
    const validation = validateAddress(wallet.network, row.to_address);
    if (!validation.valid) throw new AppError('INVALID_ADDRESS');
    if (validation.canonical === wallet.address_canonical) {
      throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    }

    // --- 4. Quote (balance, fee, limits) -------------------------------------
    // Reusing the manual send pipeline means scheduled transfers inherit every control
    // that protects an interactive one — including the spend caps and the fee check.
    const amount = TokenAmount.fromRaw(row.raw_amount, {
      assetKey: asset.id,
      symbol: asset.symbol,
      decimals: asset.decimals,
    });

    const idempotencyKey = scheduledExecutionKey(row.id, row.attempts);

    const quote = await this.send.quote(context, {
      walletId: wallet.id,
      assetId: asset.id,
      toAddress: row.to_address,
      amount: amount.toDecimalString(),
      ...(row.memo ? { memo: row.memo } : {}),
      idempotencyKey,
    });

    // --- 5. Confirm using the fingerprint we just produced --------------------
    // No PIN: the user already authorised this when scheduling it. That is exactly why
    // scheduling is itself a PIN-gated action.
    const confirmed = await asSystem(app, (tx) =>
      sendRepo.confirmSendRequest(tx, {
        userId: row.user_id,
        id: quote.sendRequestId,
        fingerprint: quote.fingerprint,
      }),
    );
    if (!confirmed) {
      throw new AppError('SEND_QUOTE_EXPIRED', {
        internal: 'could not claim the scheduled quote (already claimed or fingerprint changed)',
      });
    }

    // Link the send request back to the schedule for the audit trail.
    await asSystem(app, async (tx) => {
      await tx`
        UPDATE send_requests SET scheduled_payment_id = ${row.id}, updated_at = now()
        WHERE id = ${quote.sendRequestId}
      `;
    });

    // --- 6. Execute -----------------------------------------------------------
    const result = await this.send.execute(context, quote.sendRequestId);

    await asSystem(app, async (tx) => {
      await planningRepo.setScheduledPaymentStatus(tx, row.id, 'completed', {
        executedTransactionId: result.transactionId,
        sendRequestId: quote.sendRequestId,
        releaseLock: true,
      });

      await opsRepo.writeAudit(tx, {
        userId: row.user_id,
        actorType: 'system',
        action: 'schedule.executed',
        entityType: 'scheduled_payment',
        entityId: row.id,
        requestId,
        metadata: { txHash: result.txHash, simulated: result.simulated },
      });

      await this.notifications.queueInTransaction(tx, {
        userId: row.user_id,
        type: 'scheduled_payment_executed',
        dedupeKey: notificationKey({
          type: 'scheduled_payment_executed',
          subjectId: row.id,
          variant: String(row.attempts),
        }),
        payload: {
          amount: `${amount.toDisplayString()} ${asset.symbol}`,
          address: row.to_address,
          transactionId: result.transactionId,
          explorerUrl: result.explorerUrl ?? '',
        },
      });
    });
  }

  /**
   * Record a failure.
   *
   * Retries only for genuinely transient causes; anything that indicates a *decision*
   * (disabled, invalid address, over limit) stops and asks the user. Silently retrying a
   * payment the system already refused once is how surprises happen.
   */
  private async markFailed(app: AppContext, row: ScheduledPaymentRow, code: string): Promise<void> {
    const transient = new Set([
      'NETWORK_UNAVAILABLE',
      'PROVIDER_ERROR',
      'TIMEOUT',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      'EXCHANGE_RATE_UNAVAILABLE',
      'PRICE_UNAVAILABLE',
    ]);

    const canRetry = transient.has(code) && row.attempts < row.max_attempts;

    await asSystem(app, async (tx) => {
      if (canRetry) {
        // Back to `scheduled` with a backoff. Nothing was sent.
        await planningRepo.setScheduledPaymentStatus(tx, row.id, 'scheduled', {
          errorCode: code,
          nextAttemptAt: addSeconds(new Date(), Math.ceil(backoffDelayMs(row.attempts + 1) / 1000)),
          releaseLock: true,
        });
        return;
      }

      await planningRepo.setScheduledPaymentStatus(tx, row.id, 'failed', {
        errorCode: code,
        releaseLock: true,
      });

      await opsRepo.writeAudit(tx, {
        userId: row.user_id,
        actorType: 'system',
        action: 'schedule.failed',
        entityType: 'scheduled_payment',
        entityId: row.id,
        metadata: { code },
      });

      const asset = await opsRepo.findAsset(tx, row.asset_id);
      await this.notifications.queueInTransaction(tx, {
        userId: row.user_id,
        type: 'scheduled_payment_failed',
        dedupeKey: notificationKey({
          type: 'scheduled_payment_failed',
          subjectId: row.id,
          variant: String(row.attempts),
        }),
        payload: {
          amount: asset
            ? `${TokenAmount.fromRaw(row.raw_amount, {
                assetKey: asset.id,
                symbol: asset.symbol,
                decimals: asset.decimals,
              }).toDisplayString()} ${asset.symbol}`
            : row.raw_amount,
          address: row.to_address,
          // A CODE, not a message: the bot translates it into the user's language.
          reasonCode: code,
          scheduledPaymentId: row.id,
        },
      });
    });
  }

  /** Warn shortly before a scheduled payment runs, so it is never a surprise. */
  async notifyUpcoming(
    app: AppContext,
    options: { withinSeconds?: number; limit?: number } = {},
  ): Promise<{ notified: number }> {
    const rows = await asSystem(app, (tx) =>
      planningRepo.listUpcomingScheduledPayments(tx, {
        withinSeconds: options.withinSeconds ?? 3600,
        limit: options.limit ?? 25,
      }),
    );

    let notified = 0;
    for (const row of rows) {
      await asSystem(app, async (tx) => {
        const asset = await opsRepo.findAsset(tx, row.asset_id);
        const wallet = await walletsRepo.findWalletById(tx, row.wallet_id);
        await this.notifications.queueInTransaction(tx, {
          userId: row.user_id,
          type: 'scheduled_payment_upcoming',
          dedupeKey: notificationKey({
            type: 'scheduled_payment_upcoming',
            subjectId: row.id,
          }),
          payload: {
            amount: asset
              ? `${TokenAmount.fromRaw(row.raw_amount, {
                  assetKey: asset.id,
                  symbol: asset.symbol,
                  decimals: asset.decimals,
                }).toDisplayString()} ${asset.symbol}`
              : row.raw_amount,
            address: row.to_address,
            network: wallet?.network.toUpperCase() ?? '',
            time: row.scheduled_at.toISOString(),
            scheduledPaymentId: row.id,
          },
        });
        await planningRepo.markScheduledUpcomingNotified(tx, row.id);
      });
      notified += 1;
    }

    return { notified };
  }
}

export { quoteFingerprint };
