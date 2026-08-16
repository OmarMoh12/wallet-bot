import type { DashboardDto } from '@wallet/shared';
import { relativeTimeKey } from '@wallet/shared';
import type { ServiceContext } from './base.js';
import { AnalyticsService } from './analytics.js';
import { PlanningService } from './planning.js';
import { PortfolioService } from './portfolio.js';
import { TransactionService } from './transactions.js';

/**
 * The home screen.
 *
 * Composes the other services into a single payload so the Mini App's first paint is one
 * round trip rather than six — which matters a lot on a phone opening a Telegram WebView.
 */
export class DashboardService {
  constructor(
    private readonly portfolio = new PortfolioService(),
    private readonly transactions = new TransactionService(),
    private readonly planning = new PlanningService(),
    private readonly analytics = new AnalyticsService(),
  ) {}

  async load(context: ServiceContext): Promise<DashboardDto> {
    const [summary, recentTransactions, upcomingIncome, upcomingPayments, goals] =
      await Promise.all([
        this.portfolio.summary(context),
        this.transactions.recent(context, 6),
        this.planning.listExpectedIncome(context, { statuses: ['pending', 'delayed'] }),
        this.planning.listScheduledPayments(context),
        this.planning.listGoals(context),
      ]);

    const alerts: DashboardDto['alerts'] = [];

    // Surface anything that makes the numbers above less trustworthy, rather than hiding it.
    if (summary.partial) {
      alerts.push({ key: 'dashboard.partialValuation', severity: 'warning' });
    }
    if (summary.rate?.isStale) {
      const age = relativeTimeKey(new Date(summary.rate.updatedAt));
      alerts.push({
        key: 'alert.rateStale',
        severity: 'warning',
        params: { age: context.t(age.key, age.params) },
      });
    }

    const overdue = upcomingIncome.filter((entry) => entry.isOverdue);
    if (overdue.length > 0) {
      alerts.push({
        key: 'alert.incomeOverdue',
        severity: 'info',
        params: { count: String(overdue.length) },
      });
    }

    if (upcomingPayments.some((payment) => payment.status === 'failed')) {
      alerts.push({ key: 'alert.scheduleFailed', severity: 'critical' });
    }

    if (context.app.config.safeMode || context.app.config.chain.env === 'testnet') {
      alerts.push({ key: 'alert.safeMode', severity: 'info' });
    }

    return {
      summary,
      recentTransactions,
      // Nearest first, capped — the dashboard is a glance, not a list page.
      upcomingIncome: upcomingIncome.slice(0, 3),
      upcomingPayments: upcomingPayments
        .filter((payment) => payment.status === 'scheduled' || payment.status === 'failed')
        .slice(0, 3),
      goals: goals.slice(0, 3),
      alerts,
    };
  }

  /** Convenience for the bot's `/balance` command. */
  async botSummary(context: ServiceContext) {
    const summary = await this.portfolio.summary(context);
    return summary;
  }

  analyticsService(): AnalyticsService {
    return this.analytics;
  }
}
