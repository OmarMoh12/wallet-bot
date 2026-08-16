'use client';

import { useState } from 'react';
import type { PortfolioSummaryDto } from '@wallet/shared';
import { Icon } from '@/components/ui/Icon';
import { Skeleton, cx } from '@/components/ui/primitives';
import { fiat } from '@/lib/format';
import { haptics } from '@/lib/telegram';
import { useApp } from '@/providers/AppProvider';

/**
 * The hero balance card.
 *
 * Two decisions worth stating:
 *
 *   1. **A missing total renders as "—", never as a number.** When any holding could not be
 *      priced the server marks the summary `partial` and returns nulls; showing a plausible
 *      but incomplete figure would be worse than showing nothing, because it looks correct.
 *   2. **The primary figure is tappable to switch currency.** USD is the natural unit for
 *      crypto and ILS for cash, and the person using this holds both.
 */
export function BalanceCard({
  summary,
  loading,
  hidden,
  onToggleHidden,
}: {
  summary: PortfolioSummaryDto | null;
  loading: boolean;
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  const { t, locale } = useApp();
  const [primary, setPrimary] = useState<'USD' | 'ILS'>('USD');

  const total = primary === 'USD' ? summary?.totalUsd : summary?.totalIls;
  const secondary = primary === 'USD' ? summary?.totalIls : summary?.totalUsd;

  return (
    <section
      className="relative overflow-hidden rounded-[26px] border border-border p-5"
      style={{
        background:
          'linear-gradient(160deg, color-mix(in srgb, var(--color-accent) 20%, var(--color-surface)) 0%, var(--color-surface) 62%)',
      }}
      aria-label={t('dashboard.totalAssets')}
    >
      <div className="flex items-start justify-between">
        <p className="text-[13px] font-medium text-muted">{t('dashboard.totalAssets')}</p>
        <button
          type="button"
          onClick={() => {
            haptics.selection();
            onToggleHidden();
          }}
          aria-label={t('a11y.toggleBalance')}
          aria-pressed={hidden}
          className="-me-1 -mt-1 flex h-9 w-9 items-center justify-center rounded-full text-muted active:bg-surface-raised"
        >
          <Icon name={hidden ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>

      {loading ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-4 w-28" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            haptics.selection();
            setPrimary((current) => (current === 'USD' ? 'ILS' : 'USD'));
          }}
          className="mt-2 block w-full text-start"
          aria-label={t('dashboard.totalAssets')}
        >
          <p className="numeric text-[38px] font-bold leading-tight text-text">
            <span className="bidi-isolate">{fiat(total ?? null, locale, { hidden })}</span>
          </p>
          <p className="numeric mt-0.5 text-[15px] font-medium text-muted">
            <span className="bidi-isolate">{fiat(secondary ?? null, locale, { hidden })}</span>
          </p>
        </button>
      )}

      {/* Cash / crypto split. Cash never depends on an exchange rate, so it always shows. */}
      <div className="mt-5 grid grid-cols-2 gap-2.5">
        <SplitTile
          label={t('dashboard.cash')}
          value={fiat(summary?.cash.native ?? null, locale, { hidden })}
          loading={loading}
          tone="neutral"
        />
        <SplitTile
          label={t('dashboard.crypto')}
          value={fiat(summary?.crypto.usd ?? null, locale, { hidden })}
          loading={loading}
          tone="accent"
        />
      </div>

      {summary?.partial ? (
        <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-warning">
          <Icon name="warning" size={14} className="mt-px shrink-0" />
          {t('dashboard.partialValuation')}
        </p>
      ) : null}
    </section>
  );
}

function SplitTile({
  label,
  value,
  loading,
  tone,
}: {
  label: string;
  value: string;
  loading: boolean;
  tone: 'neutral' | 'accent';
}) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-border px-3.5 py-3',
        tone === 'accent' ? 'bg-accent/8' : 'bg-surface-sunken/60',
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-5 w-20" />
      ) : (
        <p className="numeric mt-1 text-[17px] font-semibold text-text">
          <span className="bidi-isolate">{value}</span>
        </p>
      )}
    </div>
  );
}
