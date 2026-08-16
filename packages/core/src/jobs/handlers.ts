import { z } from 'zod';
import { AppError, jobKey, type JobType } from '@wallet/shared';
import { opsRepo, planningRepo, sendRepo, walletsRepo } from '@wallet/db';
import type { AppContext } from '../context.js';
import { asSystem } from '../services/base.js';
import { AuthService } from '../auth/service.js';
import { ChainSyncService } from '../services/chain-sync.js';
import { NotificationService } from '../services/notifications.js';
import { ReminderService } from '../services/reminders.js';
import { SchedulerService } from '../services/scheduler.js';
import { SendService } from '../services/send.js';

/**
 * Job handlers.
 *
 * Every handler must be **idempotent**: the queue guarantees at-least-once execution, and a
 * lease can expire mid-run, so any handler may execute twice for the same payload. Each one
 * below is either a pure read, or writes through a uniqueness constraint.
 *
 * Payloads are Zod-validated. A queue row is stored data, and stored data is untrusted
 * input — a malformed payload from an older deploy must fail cleanly, not crash the worker.
 */

export interface JobHandlerContext {
  app: AppContext;
  requestId: string;
  worker: string;
}

export type JobHandler = (
  context: JobHandlerContext,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown> | void>;

const walletPayload = z.object({
  walletId: z.string().uuid(),
  reason: z.string().max(40).optional(),
});
const emptyPayload = z.object({}).passthrough();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, payload: unknown, type: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', {
      internal: `job ${type} has an invalid payload: ${result.error.issues[0]?.message ?? 'unknown'}`,
      // Not retryable: the payload will never become valid on its own.
      retryable: false,
    });
  }
  return result.data;
}

/** Built once per worker so services keep their internal caches between jobs. */
export function createJobHandlers(app: AppContext): Record<JobType, JobHandler> {
  const chainSync = new ChainSyncService();
  const notifications = new NotificationService();
  const reminders = new ReminderService();
  const auth = new AuthService({ sql: app.sql, config: app.config, logger: app.logger });
  const send = new SendService(auth);
  const scheduler = new SchedulerService(send);

  return {
    /* --------------------------------------------------------------- chain -- */

    'chain.scan': async (context, payload) => {
      const { walletId } = parse(walletPayload, payload, 'chain.scan');

      const enabled = await asSystem(context.app, (tx) =>
        opsRepo.getAppSetting<boolean>(tx, 'chain_scanning_enabled', true),
      );
      if (!enabled) return { skipped: 'chain_scanning_disabled' };

      const result = await chainSync.scanWallet(context.app, walletId);

      // Chase the next page immediately rather than waiting a full interval, so a wallet
      // with a long backlog catches up quickly.
      if (result.ingested > 0) {
        await asSystem(context.app, (tx) =>
          opsRepo.enqueueJob(tx, {
            type: 'chain.confirm',
            payload: {},
            dedupeKey: jobKey('chain.confirm', 'sweep'),
            priority: 40,
          }),
        );
      }
      return { ...result };
    },

    'chain.confirm': async (context) => {
      const result = await chainSync.trackConfirmations(context.app, { limit: 25 });
      return { ...result };
    },

    'chain.reconcile': async (context, payload) => {
      const { walletId } = parse(walletPayload, payload, 'chain.reconcile');
      const result = await chainSync.reconcileBalances(context.app, walletId);
      return { ...result };
    },

    /* -------------------------------------------------------------- market -- */

    'fx.refresh': async (context) => {
      const enabled = await asSystem(context.app, (tx) =>
        opsRepo.getAppSetting<boolean>(tx, 'fx_auto_refresh_enabled', true),
      );
      if (!enabled) return { skipped: 'fx_auto_refresh_disabled' };

      const result = await context.app.currency.refreshRate('USD', 'ILS');
      // A fresh rate is exactly when a significant move becomes detectable.
      await asSystem(context.app, (tx) =>
        opsRepo.enqueueJob(tx, {
          type: 'alerts.evaluate',
          payload: {},
          dedupeKey: jobKey('alerts.evaluate', 'fx'),
          priority: 80,
        }),
      );
      return { rate: result.rate.toDecimalString(6), source: result.rate.source };
    },

    'price.refresh': async (context) => {
      const assets = await asSystem(context.app, (tx) =>
        opsRepo.listAssets(tx, { env: context.app.config.chain.env }),
      );
      const prices = await context.app.currency.getPrices(
        assets.map((asset) => ({
          id: asset.id,
          symbol: asset.symbol,
          priceId: asset.price_id,
        })),
      );
      return { requested: assets.length, priced: prices.size };
    },

    /* --------------------------------------------------------- notifications -- */

    'notify.dispatch': async (context) => {
      const enabled = await asSystem(context.app, (tx) =>
        opsRepo.getAppSetting<boolean>(tx, 'notifications_enabled', true),
      );
      if (!enabled) return { skipped: 'notifications_disabled' };

      const result = await notifications.dispatch(context.app, {
        limit: 25,
        worker: context.worker,
      });
      return { ...result };
    },

    /* ------------------------------------------------------------ scheduling -- */

    'schedule.tick': async (context) => {
      const result = await scheduler.tick(context.app, {
        worker: context.worker,
        limit: 5,
        requestId: context.requestId,
      });
      return { ...result };
    },

    'schedule.execute': async (context, payload) => {
      // Explicit single-payment execution, used by "run now". Claiming still goes through
      // the same lease, so this cannot race the periodic tick.
      const { scheduledPaymentId } = parse(
        z.object({ scheduledPaymentId: z.string().uuid() }),
        payload,
        'schedule.execute',
      );
      const rows = await asSystem(context.app, (tx) =>
        planningRepo.claimDueScheduledPayments(tx, {
          worker: context.worker,
          limit: 1,
          leaseSeconds: 120,
        }),
      );
      const target = rows.find((row) => row.id === scheduledPaymentId);
      if (!target) return { skipped: 'not-due-or-claimed-elsewhere' };

      const result = await scheduler.tick(context.app, {
        worker: context.worker,
        limit: 1,
        requestId: context.requestId,
      });
      return { ...result };
    },

    /* --------------------------------------------------------------- reminders -- */

    'income.remind': async (context) => {
      const due = await reminders.remindExpectedIncome(context.app);
      const overdue = await reminders.remindOverdueIncome(context.app);
      const upcoming = await scheduler.notifyUpcoming(context.app, { withinSeconds: 3600 });
      return {
        dueNotified: due.notified,
        overdueNotified: overdue.notified,
        upcomingNotified: upcoming.notified,
      };
    },

    'alerts.evaluate': async (context) => {
      const fx = await reminders.checkFxAlerts(context.app);
      return { fxNotified: fx.notified, changeBps: fx.changeBps };
    },

    /* ---------------------------------------------------------------- cleanup -- */

    'cleanup.expire': async (context) => {
      parse(emptyPayload, {}, 'cleanup.expire');

      const expiredQuotes = await asSystem(context.app, (tx) =>
        sendRepo.expireStaleQuotes(tx, 100),
      );
      const reclaimed = await asSystem(context.app, (tx) => opsRepo.reclaimStuckJobs(tx, 30));
      const cleaned = await asSystem(context.app, (tx) => opsRepo.cleanupExpired(tx, 14));

      return { expiredQuotes, reclaimed, ...cleaned };
    },
  };
}

/**
 * Recurring work.
 *
 * Enqueued by the worker's tick loop rather than by a cron service, so the schedule lives
 * with the code that implements it. Every entry carries a `dedupeKey`, so a restart storm
 * or two replicas ticking together still produce one queued job.
 */
export interface RecurringJob {
  type: JobType;
  intervalSeconds: number;
  dedupeKey: string;
  priority: number;
}

export function recurringJobs(app: AppContext): RecurringJob[] {
  return [
    {
      type: 'chain.confirm',
      intervalSeconds: 30,
      dedupeKey: jobKey('chain.confirm', 'sweep'),
      priority: 40,
    },
    {
      type: 'notify.dispatch',
      intervalSeconds: 10,
      dedupeKey: jobKey('notify.dispatch', 'sweep'),
      priority: 20,
    },
    {
      type: 'schedule.tick',
      intervalSeconds: 60,
      dedupeKey: jobKey('schedule.tick', 'sweep'),
      priority: 30,
    },
    {
      type: 'fx.refresh',
      intervalSeconds: app.config.market.fxRefreshSeconds,
      dedupeKey: jobKey('fx.refresh', 'usd-ils'),
      priority: 60,
    },
    {
      type: 'price.refresh',
      intervalSeconds: app.config.market.priceRefreshSeconds,
      dedupeKey: jobKey('price.refresh', 'all'),
      priority: 60,
    },
    {
      type: 'income.remind',
      intervalSeconds: 900,
      dedupeKey: jobKey('income.remind', 'sweep'),
      priority: 70,
    },
    {
      type: 'cleanup.expire',
      intervalSeconds: 3600,
      dedupeKey: jobKey('cleanup.expire', 'sweep'),
      priority: 90,
    },
  ];
}

/** Enqueue a scan for every wallet whose last check is older than the interval. */
export async function enqueueDueWalletScans(
  app: AppContext,
  options: { limit?: number } = {},
): Promise<number> {
  const wallets = await asSystem(app, (tx) =>
    walletsRepo.listWalletsDueForScan(tx, {
      intervalSeconds: app.config.worker.chainScanIntervalSeconds,
      limit: options.limit ?? 25,
      env: app.config.chain.env,
    }),
  );

  await asSystem(app, async (tx) => {
    for (const wallet of wallets) {
      await opsRepo.enqueueJob(tx, {
        type: 'chain.scan',
        payload: { walletId: wallet.id, reason: 'interval' },
        dedupeKey: jobKey('chain.scan', wallet.id),
        priority: 50,
      });
    }
  });

  return wallets.length;
}
