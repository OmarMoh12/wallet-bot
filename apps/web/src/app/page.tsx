'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { DashboardDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { BalanceCard } from '@/components/dashboard/BalanceCard';
import { QuickActions } from '@/components/dashboard/QuickActions';
import { AssetRow } from '@/components/dashboard/AssetRow';
import { TransactionRow } from '@/components/transactions/TransactionRow';
import { Card, Divider, EmptyState, SectionHeader, Skeleton, cx } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { useApiQuery } from '@/hooks/useApi';
import { fiat, formatDate, relativeTime } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

/**
 * Home.
 *
 * One request (`/api/dashboard`) fills the whole screen. On a phone opening a Telegram
 * WebView, the difference between one round trip and six is the difference between "instant"
 * and "loading".
 */
export default function HomePage() {
  const { t, locale, settings, refreshSettings } = useApp();
  const { data, loading } = useApiQuery<DashboardDto>('/api/dashboard');
  const [hidden, setHidden] = useState(false);

  // Seed the privacy toggle from the saved preference.
  useEffect(() => {
    if (settings) setHidden(settings.hideBalances);
  }, [settings]);

  const summary = data?.summary ?? null;

  return (
    <Screen>
      <div className="space-y-5 pt-1">
        {/* Anything that makes the numbers below less trustworthy is surfaced first. */}
        {data?.alerts.length ? (
          <div className="space-y-2">
            {data.alerts.map((alert) => (
              <AlertBanner
                key={alert.key}
                severity={alert.severity}
                message={t(alert.key, alert.params)}
              />
            ))}
          </div>
        ) : null}

        <BalanceCard
          summary={summary}
          loading={loading}
          hidden={hidden}
          onToggleHidden={() => {
            setHidden((value) => !value);
            void refreshSettings();
          }}
        />

        <QuickActions />

        {/* ---------------------------------------------------------- assets -- */}
        {summary && summary.assets.length > 0 ? (
          <section>
            <SectionHeader title={t('dashboard.crypto')} />
            <Card>
              {summary.assets.map((entry, index) => (
                <div key={entry.asset.id}>
                  {index > 0 ? <Divider /> : null}
                  <AssetRow
                    asset={entry.asset}
                    value={entry.value}
                    hidden={hidden}
                    shareBps={entry.shareBps}
                  />
                </div>
              ))}
            </Card>
          </section>
        ) : null}

        {/* -------------------------------------------------------- activity -- */}
        <section>
          <SectionHeader title={t('dashboard.recentActivity')} />
          <Card>
            {loading ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : data && data.recentTransactions.length > 0 ? (
              <>
                {data.recentTransactions.map((transaction, index) => (
                  <div key={transaction.id}>
                    {index > 0 ? <Divider /> : null}
                    <TransactionRow transaction={transaction} />
                  </div>
                ))}
                <Divider />
                <Link
                  href="/activity"
                  className="row-press flex items-center justify-center gap-1 py-3 text-[14px] font-medium text-link"
                >
                  {t('common.showAll')}
                  <Icon name="chevron" size={15} className="rtl:rotate-180" />
                </Link>
              </>
            ) : (
              <EmptyState
                icon="activity"
                title={t('dashboard.emptyActivity')}
                hint={t('dashboard.emptyActivityHint')}
              />
            )}
          </Card>
        </section>

        {/* --------------------------------------------------------- income -- */}
        {data && data.upcomingIncome.length > 0 ? (
          <section>
            <SectionHeader title={t('dashboard.upcomingIncome')} />
            <Card>
              {data.upcomingIncome.map((entry, index) => (
                <div key={entry.id}>
                  {index > 0 ? <Divider /> : null}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={cx(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                        entry.isOverdue
                          ? 'bg-warning/15 text-warning'
                          : 'bg-surface-raised text-muted',
                      )}
                      aria-hidden="true"
                    >
                      <Icon name="clock" size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium text-text">{entry.name}</p>
                      <p className="truncate text-[12.5px] text-muted">
                        {entry.isOverdue
                          ? t('common.overdueDays', { count: Math.abs(entry.daysUntil) })
                          : entry.daysUntil === 0
                            ? t('common.today')
                            : formatDate(entry.expectedDate, locale)}
                      </p>
                    </div>
                    <p className="numeric shrink-0 text-[15px] font-semibold text-text">
                      <span className="bidi-isolate">{fiat(entry.amount, locale, { hidden })}</span>
                    </p>
                  </div>
                </div>
              ))}
            </Card>
          </section>
        ) : null}

        {/* ------------------------------------------------------ scheduled -- */}
        {data && data.upcomingPayments.length > 0 ? (
          <section>
            <SectionHeader title={t('dashboard.scheduledPayments')} />
            <Card>
              {data.upcomingPayments.map((payment, index) => (
                <div key={payment.id}>
                  {index > 0 ? <Divider /> : null}
                  <Link href="/payments" className="row-press flex items-center gap-3 px-4 py-3">
                    <span
                      className={cx(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                        payment.status === 'failed'
                          ? 'bg-negative/12 text-negative'
                          : 'bg-surface-raised text-muted',
                      )}
                      aria-hidden="true"
                    >
                      <Icon name="calendar" size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="numeric truncate text-[15px] font-medium text-text">
                        <span className="bidi-isolate">
                          {payment.amount.decimal} {payment.amount.symbol}
                        </span>
                      </p>
                      <p className="truncate text-[12.5px] text-muted">
                        {t(`schedule.status.${payment.status}`)} ·{' '}
                        {relativeTime(payment.scheduledAt, t)}
                      </p>
                    </div>
                    <Icon
                      name="chevron"
                      size={16}
                      className="shrink-0 text-subtle rtl:rotate-180"
                    />
                  </Link>
                </div>
              ))}
            </Card>
          </section>
        ) : null}

        {/* ---------------------------------------------------------- goals -- */}
        {data && data.goals.length > 0 ? (
          <section>
            <SectionHeader title={t('dashboard.goals')} action={t('common.showAll')} />
            <div className="space-y-2">
              {data.goals.map((goal) => (
                <Card key={goal.id} className="p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-[15px] font-medium text-text">{goal.name}</p>
                    <p className="numeric shrink-0 text-[13px] text-muted">
                      <span className="bidi-isolate">
                        {fiat(goal.current, locale, { hidden })} /{' '}
                        {fiat(goal.target, locale, { hidden })}
                      </span>
                    </p>
                  </div>
                  <div
                    className="mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
                    role="progressbar"
                    aria-valuenow={goal.progressPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={goal.name}
                  >
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-500"
                      style={{ width: `${goal.progressPercent}%` }}
                    />
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {/* ------------------------------------------------------ fx footer -- */}
        {summary?.rate ? (
          <p className="px-1 pb-2 text-center text-[12px] text-subtle">
            <span className="numeric bidi-isolate">USD/ILS {summary.rate.rate}</span> ·{' '}
            {t('common.updatedAgo', { time: relativeTime(summary.rate.updatedAt, t) })}
            {summary.rate.isManual ? ` · ${t('settings.fxMode.manual')}` : ''}
          </p>
        ) : null}
      </div>
    </Screen>
  );
}

function AlertBanner({
  severity,
  message,
}: {
  severity: 'info' | 'warning' | 'critical';
  message: string;
}) {
  const tone = {
    info: 'bg-accent/10 text-accent border-accent/20',
    warning: 'bg-warning/10 text-warning border-warning/25',
    critical: 'bg-negative/10 text-negative border-negative/25',
  }[severity];

  return (
    <div
      className={cx('flex items-start gap-2 rounded-2xl border px-3.5 py-2.5 text-[13px]', tone)}
      role={severity === 'critical' ? 'alert' : 'status'}
    >
      <Icon name={severity === 'info' ? 'info' : 'warning'} size={16} className="mt-px shrink-0" />
      <span className="leading-snug">{message}</span>
    </div>
  );
}
