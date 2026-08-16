import {
  FiatAmount,
  bigintToNumber,
  daysBetween,
  notificationKey,
  type FiatCurrency,
} from '@wallet/shared';
import { opsRepo, planningRepo, usersRepo } from '@wallet/db';
import type { AppContext } from '../context.js';
import { asSystem } from './base.js';
import { NotificationService } from './notifications.js';

/**
 * Time-driven reminders: expected income falling due, overdue payments, and significant FX
 * moves. All of them are idempotent through `notificationKey`, so a job that runs twice
 * still produces one message.
 */
export class ReminderService {
  constructor(private readonly notifications = new NotificationService()) {}

  /** "You have a payment expected today." */
  async remindExpectedIncome(app: AppContext, limit = 50): Promise<{ notified: number }> {
    const rows = await asSystem(app, (tx) => planningRepo.listExpectedIncomeReminders(tx, limit));
    let notified = 0;

    for (const row of rows) {
      await asSystem(app, async (tx) => {
        const amount = FiatAmount.fromMinor(row.amount_minor, row.currency);
        await this.notifications.queueInTransaction(tx, {
          userId: row.user_id,
          type: 'expected_income_due',
          dedupeKey: notificationKey({
            type: 'expected_income_due',
            subjectId: row.id,
            variant: row.expected_date,
          }),
          payload: {
            name: row.name,
            amount: `${amount.toDecimalString()} ${row.currency}`,
            expectedIncomeId: row.id,
          },
        });
        await planningRepo.markExpectedIncomeReminded(tx, row.id, 'reminded_at');
      });
      notified += 1;
    }

    return { notified };
  }

  /**
   * "That payment is overdue."
   *
   * Re-notified at most every three days (enforced by the query), so a long-overdue invoice
   * does not turn into a daily nag.
   */
  async remindOverdueIncome(app: AppContext, limit = 50): Promise<{ notified: number }> {
    const rows = await asSystem(app, (tx) => planningRepo.listOverdueExpectedIncome(tx, limit));
    let notified = 0;
    const today = new Date();

    for (const row of rows) {
      const overdueDays = -daysBetween(today, new Date(`${row.expected_date}T00:00:00Z`));
      await asSystem(app, async (tx) => {
        const amount = FiatAmount.fromMinor(row.amount_minor, row.currency);
        await this.notifications.queueInTransaction(tx, {
          userId: row.user_id,
          type: 'expected_income_overdue',
          dedupeKey: notificationKey({
            type: 'expected_income_overdue',
            subjectId: row.id,
            // A new key per 3-day bucket gives us "remind occasionally" without a counter.
            variant: String(Math.floor(overdueDays / 3)),
          }),
          payload: {
            name: row.name,
            amount: `${amount.toDecimalString()} ${row.currency}`,
            date: row.expected_date,
            expectedIncomeId: row.id,
          },
        });
        await planningRepo.markExpectedIncomeReminded(tx, row.id, 'overdue_notified_at');
      });
      notified += 1;
    }

    return { notified };
  }

  /**
   * Alert on a significant USD/ILS move.
   *
   * Compares the newest rate against the most recent one at least an hour old, and notifies
   * users whose configured threshold is exceeded. Cash held in shekels and reported in
   * dollars makes this a real signal rather than trivia.
   */
  async checkFxAlerts(app: AppContext): Promise<{ notified: number; changeBps: number | null }> {
    const base: FiatCurrency = 'USD';
    const quote: FiatCurrency = 'ILS';

    const history = await asSystem(app, (tx) =>
      opsRepo.exchangeRateHistory(tx, {
        base,
        quote,
        since: new Date(Date.now() - 48 * 3600 * 1000),
        limit: 200,
      }),
    );

    const latest = history[0];
    if (!latest) return { notified: 0, changeBps: null };

    const hourAgo = Date.now() - 3600 * 1000;
    const reference = history.find((row) => row.fetched_at.getTime() <= hourAgo);
    if (!reference) return { notified: 0, changeBps: null };

    // Compare as scaled integers; no floating point in the comparison path.
    const latestScaled = FiatAmount.parse(trimRate(latest.rate), 'USD').minor;
    const referenceScaled = FiatAmount.parse(trimRate(reference.rate), 'USD').minor;
    if (referenceScaled === 0n) return { notified: 0, changeBps: null };

    const deltaBps = ((latestScaled - referenceScaled) * 10000n) / referenceScaled;
    const magnitudeBps = deltaBps < 0n ? -deltaBps : deltaBps;

    const recipients = await asSystem(app, (tx) =>
      tx<Array<{ user_id: string; fx_alert_threshold_bps: number }>>`
        SELECT p.user_id, p.fx_alert_threshold_bps
        FROM notification_preferences p
        JOIN users u ON u.id = p.user_id
        WHERE u.is_active AND u.deleted_at IS NULL
          AND p.fx_alert_threshold_bps > 0
          AND p.fx_alert_threshold_bps <= ${magnitudeBps.toString()}
      `.then((rows) => [...rows]),
    );

    let notified = 0;
    const bucket = latest.fetched_at.toISOString().slice(0, 13); // hourly bucket

    for (const recipient of recipients) {
      await asSystem(app, (tx) =>
        this.notifications.queueInTransaction(tx, {
          userId: recipient.user_id,
          type: 'fx_rate_alert',
          dedupeKey: notificationKey({
            type: 'fx_rate_alert',
            subjectId: `${base}${quote}`,
            variant: bucket,
          }),
          payload: {
            percent: formatBpsAsPercent(deltaBps),
            rate: trimRate(latest.rate),
          },
        }),
      );
      notified += 1;
    }

    return {
      notified,
      changeBps: magnitudeBps > 100_000n ? null : bigintToNumber(magnitudeBps, 'fxChangeBps'),
    };
  }

  /** Ensure every active user has notification preferences (for users created pre-upgrade). */
  async backfillPreferences(app: AppContext): Promise<void> {
    await asSystem(app, async (tx) => {
      const users = await usersRepo.listUsers(tx, { limit: 500, offset: 0 });
      for (const user of users) {
        await tx`
          INSERT INTO notification_preferences (user_id) VALUES (${user.id})
          ON CONFLICT (user_id) DO NOTHING
        `;
      }
    });
  }
}

/** NUMERIC(30,12) arrives with trailing zeros; trim to two decimals for display maths. */
function trimRate(rate: string): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function formatBpsAsPercent(bps: bigint): string {
  const sign = bps < 0n ? '-' : '+';
  const magnitude = bps < 0n ? -bps : bps;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}
