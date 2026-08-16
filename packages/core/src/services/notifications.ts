import {
  DEFAULT_LOCALE,
  addSeconds,
  backoffDelayMs,
  isLocale,
  isWithinQuietHours,
  minutesInTimezone,
  notificationKey,
  type Network,
  type NetworkEnv,
  type NotificationType,
} from '@wallet/shared';
import { transactionUrl } from '@wallet/blockchain';
import { opsRepo, type TransactionSql } from '@wallet/db';
import { TelegramApiError, renderNotification } from '@wallet/telegram';
import type { AppContext } from '../context.js';
import { asSystem, asUser, type ServiceContext } from './base.js';

/**
 * Notification queueing and delivery.
 *
 * Queueing writes a row; delivery drains it. Because delivery is a database row rather than
 * an in-memory event, notifications survive restarts, work while the Mini App is closed,
 * and retry with backoff.
 *
 * Anti-spam comes from `dedupe_key`: `UNIQUE (user_id, dedupe_key)` means re-processing the
 * same chain event — or two workers racing on it — produces exactly one message.
 */

/** Delivery attempts before a notification is abandoned. */
const MAX_ATTEMPTS = 6;

export interface QueueParams {
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  dedupeKey: string;
  deliverAfter?: Date;
}

export class NotificationService {
  /** Queue inside an existing transaction, so it commits with the change it announces. */
  async queueInTransaction(tx: TransactionSql, params: QueueParams): Promise<void> {
    await opsRepo.enqueueNotification(tx, {
      userId: params.userId,
      type: params.type,
      payload: params.payload,
      dedupeKey: params.dedupeKey,
      ...(params.deliverAfter ? { deliverAfter: params.deliverAfter } : {}),
    });
  }

  async queueOutgoing(
    context: ServiceContext,
    params: {
      transactionId: string | null;
      amountText: string;
      address: string;
      walletName: string;
      network: Network;
      env: NetworkEnv;
      txHash: string;
    },
  ): Promise<void> {
    await asUser(context, (tx) =>
      this.queueInTransaction(tx, {
        userId: context.actor.userId,
        type: 'crypto_sent',
        dedupeKey: notificationKey({
          type: 'crypto_sent',
          subjectId: params.transactionId ?? params.txHash,
        }),
        payload: {
          amount: params.amountText,
          address: shorten(params.address),
          wallet: params.walletName,
          network: params.network.toUpperCase(),
          transactionId: params.transactionId,
          explorerUrl: transactionUrl(params.network, params.env, params.txHash) ?? '',
        },
      }),
    );
  }

  /**
   * Deliver queued notifications.
   *
   * Called by the bot process (and by the worker's `notify.dispatch` job). Returns counts so
   * the caller can log and expose them on the health endpoint.
   */
  async dispatch(
    app: AppContext,
    options: { limit?: number; worker?: string } = {},
  ): Promise<{ sent: number; failed: number; suppressed: number; deferred: number }> {
    const limit = options.limit ?? 25;
    const worker = options.worker ?? 'dispatcher';
    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    let deferred = 0;

    if (!app.telegram) {
      app.logger.warn('notification dispatch skipped: no Telegram client configured', {
        operation: 'notify.dispatch',
      });
      return { sent, failed, suppressed, deferred };
    }

    const pending = await asSystem(app, (tx) => opsRepo.claimNotifications(tx, { limit, worker }));

    for (const row of pending) {
      const locale = isLocale(row.locale) ? row.locale : DEFAULT_LOCALE;

      // Per-type preference. Absent means enabled — new notification types are opt-out.
      const enabled = row.enabled_types?.[row.type];
      if (enabled === false) {
        await asSystem(app, (tx) => opsRepo.suppressNotification(tx, row.id, 'type disabled'));
        suppressed += 1;
        continue;
      }

      // Quiet hours: postpone rather than drop, unless it is a security alert.
      if (row.type !== 'security_alert' && row.quiet_hours_start && row.quiet_hours_end) {
        const minutes = minutesInTimezone(new Date(), row.timezone || 'UTC');
        if (isWithinQuietHours(minutes, row.quiet_hours_start, row.quiet_hours_end)) {
          await asSystem(app, (tx) =>
            opsRepo.deferNotification(tx, row.id, addSeconds(new Date(), 15 * 60)),
          );
          deferred += 1;
          continue;
        }
      }

      const rendered = renderNotification(row.type, row.payload, {
        locale,
        links: {
          botUsername: app.config.telegram.botUsername,
          ...(app.config.telegram.miniAppShortName
            ? { appShortName: app.config.telegram.miniAppShortName }
            : {}),
        },
      });

      try {
        const result = await app.telegram.sendMessage({
          chatId: row.telegram_id,
          text: rendered.text,
          keyboard: rendered.keyboard,
        });
        await asSystem(app, (tx) => opsRepo.markNotificationSent(tx, row.id, result.messageId));
        sent += 1;
      } catch (error) {
        const permanent = error instanceof TelegramApiError ? error.permanent : false;
        const retryAfter =
          error instanceof TelegramApiError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1000
            : backoffDelayMs(row.attempts + 1);

        const giveUp = permanent || row.attempts + 1 >= MAX_ATTEMPTS;
        await asSystem(app, (tx) =>
          opsRepo.markNotificationFailed(
            tx,
            row.id,
            error instanceof Error ? error.message : 'unknown error',
            giveUp ? null : addSeconds(new Date(), Math.ceil(retryAfter / 1000)),
          ),
        );
        failed += 1;

        app.logger.warn('notification delivery failed', {
          operation: 'notify.dispatch',
          notificationId: row.id,
          type: row.type,
          permanent,
          attempts: row.attempts + 1,
        });
      }
    }

    return { sent, failed, suppressed, deferred };
  }
}

/** Middle-ellipsis for addresses inside notification text. */
function shorten(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}
