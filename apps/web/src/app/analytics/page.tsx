'use client';

import { useState } from 'react';
import type { AnalyticsDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { IncomeExpenseChart } from '@/components/charts/IncomeExpenseChart';
import { Card, EmptyState, Segmented, Skeleton, cx } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { useApiQuery } from '@/hooks/useApi';
import { fiat, formatBps } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

type Period = 'week' | 'month' | 'quarter' | 'year';

/**
 * Analytics.
 *
 * Three stat tiles, one chart, one ranked breakdown — and nothing else. A dashboard that
 * shows six charts to a person checking their phone answers no question at all.
 */
export default function AnalyticsPage() {
  const { t, locale, settings } = useApp();
  const [period, setPeriod] = useState<Period>('month');

  const { data, loading } = useApiQuery<AnalyticsDto>('/api/analytics', {
    period,
    currency: settings?.primaryFiat ?? 'ILS',
  });

  return (
    <Screen title={t('analytics.title')} back>
      <div className="space-y-4">
        <Segmented
          ariaLabel={t('analytics.title')}
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'week', label: t('analytics.thisWeek') },
            { value: 'month', label: t('analytics.thisMonth') },
            { value: 'quarter', label: t('analytics.thisQuarter') },
            { value: 'year', label: t('analytics.thisYear') },
          ]}
        />

        {loading || !data ? (
          <>
            <Skeleton className="h-24 w-full rounded-3xl" />
            <Skeleton className="h-52 w-full rounded-3xl" />
          </>
        ) : (
          <>
            {/* Stat tiles: the headline numbers, exact and unrounded. */}
            <div className="grid grid-cols-3 gap-2">
              <StatTile
                label={t('analytics.income')}
                value={fiat(data.income, locale, { compact: true })}
                delta={formatBps(data.incomeChangeBps, locale)}
                positive
              />
              <StatTile
                label={t('analytics.expense')}
                value={fiat(data.expense, locale, { compact: true })}
                delta={formatBps(data.expenseChangeBps, locale)}
              />
              <StatTile
                label={t('analytics.net')}
                value={fiat(data.net, locale, { compact: true, signDisplay: 'always' })}
                emphasis
              />
            </div>

            <Card className="p-4">
              <IncomeExpenseChart points={data.series} currency={data.currency} />
            </Card>

            {data.byCategory.length > 0 ? (
              <section>
                <p className="px-1 pb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">
                  {t('analytics.byCategory')}
                </p>
                <Card className="p-4">
                  <ul className="space-y-3">
                    {data.byCategory.map((entry, index) => (
                      <li key={entry.category?.id ?? `uncategorised-${index}`}>
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-[14px] text-text">
                            {entry.category?.name ?? t('category.other')}
                          </span>
                          <span className="numeric shrink-0 text-[13.5px] font-medium text-text">
                            <span className="bidi-isolate">{fiat(entry.amount, locale)}</span>
                          </span>
                        </div>
                        {/* Length is the encoding; one flat colour is correct for magnitude. */}
                        <div
                          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                          role="img"
                          aria-label={`${entry.category?.name ?? ''} ${(entry.shareBps / 100).toFixed(0)}%`}
                        >
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.max(2, entry.shareBps / 100)}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            ) : (
              <EmptyState icon="chart" title={t('analytics.empty')} />
            )}

            <div className="grid grid-cols-2 gap-2">
              <Card className="p-4">
                <p className="text-[12px] text-muted">{t('analytics.cashBalance')}</p>
                <p className="numeric mt-1 text-[19px] font-semibold text-text">
                  <span className="bidi-isolate">{fiat(data.cashBalance, locale)}</span>
                </p>
              </Card>
              <Card className="p-4">
                <p className="text-[12px] text-muted">{t('analytics.cryptoValue')}</p>
                <p className="numeric mt-1 text-[19px] font-semibold text-text">
                  <span className="bidi-isolate">{fiat(data.cryptoValueUsd, locale)}</span>
                </p>
              </Card>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

function StatTile({
  label,
  value,
  delta,
  positive,
  emphasis,
}: {
  label: string;
  value: string;
  delta?: string;
  positive?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-border p-3',
        emphasis ? 'bg-accent/8' : 'bg-surface',
      )}
    >
      <p className="truncate text-[11.5px] font-medium text-muted">{label}</p>
      <p className="numeric mt-1 truncate text-[17px] font-bold text-text">
        <span className="bidi-isolate">{value}</span>
      </p>
      {delta && delta !== '—' ? (
        <p
          className={cx(
            'mt-0.5 flex items-center gap-0.5 text-[11px]',
            delta.startsWith('-') === Boolean(positive) ? 'text-negative' : 'text-positive',
          )}
        >
          <Icon name={delta.startsWith('-') ? 'arrow-down' : 'arrow-up'} size={11} />
          <span className="numeric bidi-isolate">{delta.replace('-', '')}</span>
        </p>
      ) : null}
    </div>
  );
}
