import {
  FiatAmount,
  changeBps,
  periodRange,
  shareBps,
  toIsoDate,
  type AnalyticsDto,
  type AnalyticsPointDto,
  type AnalyticsQuery,
  type CategoryDto,
  type FiatCurrency,
} from '@wallet/shared';
import { accountsRepo, transactionsRepo, type FiatCode } from '@wallet/db';
import { asUser, type ServiceContext } from './base.js';
import { toCategoryDto, toFiatDto } from '../mappers.js';
import { PortfolioService } from './portfolio.js';

/**
 * Financial analytics.
 *
 * Aggregates read the **stored valuation snapshots** (`value_usd_minor` / `value_ils_minor`)
 * rather than re-converting historical amounts at today's rate. A report for last month
 * should not change because the shekel moved this morning.
 */
export class AnalyticsService {
  constructor(private readonly portfolio = new PortfolioService()) {}

  async overview(context: ServiceContext, query: AnalyticsQuery): Promise<AnalyticsDto> {
    const currency: FiatCurrency = query.currency ?? 'ILS';
    const range = periodRange(query.period);

    const [current, previous, series, incomeByCategory, cashRows] = await Promise.all([
      asUser(context, (tx) =>
        transactionsRepo.periodTotals(tx, context.actor.userId, {
          from: range.start,
          to: range.end,
          currency: currency as FiatCode,
        }),
      ),
      asUser(context, (tx) =>
        transactionsRepo.periodTotals(tx, context.actor.userId, {
          from: range.previousStart,
          to: range.previousEnd,
          currency: currency as FiatCode,
        }),
      ),
      asUser(context, (tx) =>
        transactionsRepo.periodSeries(tx, context.actor.userId, {
          from: range.start,
          to: range.end,
          currency: currency as FiatCode,
          bucket: range.bucket,
        }),
      ),
      asUser(context, (tx) =>
        transactionsRepo.categoryTotals(tx, context.actor.userId, {
          from: range.start,
          to: range.end,
          currency: currency as FiatCode,
          direction: 'out',
        }),
      ),
      asUser(context, (tx) => accountsRepo.cashTotals(tx, context.actor.userId)),
    ]);

    const income = FiatAmount.fromMinor(current.incomeMinor, currency);
    const expense = FiatAmount.fromMinor(current.expenseMinor, currency);
    const net = income.minus(expense);

    const points: AnalyticsPointDto[] = series.map((bucket) => {
      const bucketIncome = BigInt(bucket.income_minor);
      const bucketExpense = BigInt(bucket.expense_minor);
      return {
        date: toIsoDate(bucket.bucket),
        incomeMinor: bucketIncome.toString(),
        expenseMinor: bucketExpense.toString(),
        netMinor: (bucketIncome - bucketExpense).toString(),
      };
    });

    const categoryTotal = incomeByCategory.reduce(
      (total, row) => total + BigInt(row.amount_minor),
      0n,
    );

    const byCategory = incomeByCategory.map((row) => {
      const amountMinor = BigInt(row.amount_minor);
      const category: CategoryDto | null = row.category_id
        ? toCategoryDto(
            {
              id: row.category_id,
              key: row.category_key,
              name: row.category_name,
              kind: 'expense',
              icon: row.category_icon,
              color: row.category_color,
              is_system: Boolean(row.category_key),
            },
            (key) => context.t(key),
          )
        : null;
      return {
        category,
        amount: toFiatDto(FiatAmount.fromMinor(amountMinor, currency)),
        shareBps: shareBps(amountMinor, categoryTotal),
      };
    });

    // Crypto value is a point-in-time figure, so it comes from the live portfolio rather
    // than from period aggregates.
    const summary = await this.portfolio.summary(context);

    const cashInCurrency = cashRows.find((row) => row.currency === currency);
    const cashBalance = FiatAmount.fromMinor(cashInCurrency?.total_minor ?? 0n, currency);

    return {
      currency,
      period: query.period,
      income: toFiatDto(income),
      expense: toFiatDto(expense),
      net: toFiatDto(net),
      previousIncome: toFiatDto(FiatAmount.fromMinor(previous.incomeMinor, currency)),
      previousExpense: toFiatDto(FiatAmount.fromMinor(previous.expenseMinor, currency)),
      incomeChangeBps: changeBps(current.incomeMinor, previous.incomeMinor),
      expenseChangeBps: changeBps(current.expenseMinor, previous.expenseMinor),
      series: points,
      byCategory,
      cryptoValueUsd: summary.crypto.usd,
      cashBalance: toFiatDto(cashBalance),
    };
  }
}
