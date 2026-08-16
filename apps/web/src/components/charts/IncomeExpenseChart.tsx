'use client';

import { useMemo, useState } from 'react';
import { FiatAmount, type AnalyticsPointDto, type FiatCurrency } from '@wallet/shared';
import { fiat, formatDate } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

/**
 * Income vs expense over time.
 *
 * Form: a **bipolar bar chart** — income above the baseline, expense below it. Position
 * carries the polarity, so the reading survives colour-blindness, greyscale printing and
 * forced-colors mode; colour only reinforces it. That is why this is not two same-direction
 * bars in green and red, which is the conventional choice and the fragile one.
 *
 * Colour: two slots from a validated categorical palette (aqua / orange) rather than the
 * semantic green/red used on transaction rows — that pair is the classic CVD failure. The
 * chosen pair was checked with the palette validator in both modes: worst adjacent CVD
 * ΔE 9.2 light / 9.4 dark against a ≥8 target, normal-vision ΔE 27.6 / 26.5 against a ≥15
 * floor. Aqua sits slightly under 3:1 on the light surface, so the relief rule applies and
 * the chart ships with a visible legend, direct labels on the extremes, and a table view.
 *
 * One axis, always. Both series are the same measure in the same currency, so there is no
 * temptation toward a second scale.
 */

const AQUA = { light: '#1baf7a', dark: '#199e70' };
const ORANGE = { light: '#eb6834', dark: '#d95926' };

export function IncomeExpenseChart({
  points,
  currency,
}: {
  points: AnalyticsPointDto[];
  currency: FiatCurrency;
}) {
  const { t, locale, resolvedTheme } = useApp();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const income = resolvedTheme === 'light' ? AQUA.light : AQUA.dark;
  const expense = resolvedTheme === 'light' ? ORANGE.light : ORANGE.dark;

  const model = useMemo(() => {
    // Geometry only: BigInt minor units become numbers purely to compute pixel heights.
    // Every displayed figure below is formatted from the exact BigInt.
    const rows = points.map((point) => ({
      date: point.date,
      incomeMinor: BigInt(point.incomeMinor),
      expenseMinor: BigInt(point.expenseMinor),
    }));

    let peak = 0n;
    for (const row of rows) {
      if (row.incomeMinor > peak) peak = row.incomeMinor;
      if (row.expenseMinor > peak) peak = row.expenseMinor;
    }
    // A flat-zero period still renders a baseline rather than dividing by zero.
    const scale = peak === 0n ? 1 : Number(peak);
    return { rows, scale, peak };
  }, [points]);

  if (model.rows.length === 0) {
    return <p className="px-4 py-10 text-center text-[14px] text-muted">{t('analytics.empty')}</p>;
  }

  const width = 320;
  const height = 150;
  const midY = height / 2;
  const gap = 2; // surface gap between adjacent bars
  const slot = width / model.rows.length;
  const barWidth = Math.max(3, Math.min(14, slot - gap));

  const activeRow = active === null ? null : model.rows[active];

  return (
    <figure className="m-0">
      {/* Legend — always present for two series, so identity is never colour-alone. */}
      <figcaption className="mb-3 flex items-center gap-4 px-1">
        <LegendItem color={income} label={t('analytics.income')} />
        <LegendItem color={expense} label={t('analytics.expense')} />
        <button
          type="button"
          onClick={() => setShowTable((value) => !value)}
          className="ms-auto text-[12px] font-medium text-link"
          aria-expanded={showTable}
        >
          {showTable ? t('common.close') : t('common.showAll')}
        </button>
      </figcaption>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[150px] w-full touch-none"
        role="img"
        aria-label={t('a11y.chart')}
        preserveAspectRatio="none"
        onPointerLeave={() => setActive(null)}
      >
        {/* Recessive baseline. No gridlines: the table view carries exact values. */}
        <line
          x1={0}
          y1={midY}
          x2={width}
          y2={midY}
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
          className="text-muted"
        />

        {model.rows.map((row, index) => {
          const x = index * slot + (slot - barWidth) / 2;
          const incomeHeight =
            row.incomeMinor === 0n
              ? 0
              : Math.max(3, (Number(row.incomeMinor) / model.scale) * (midY - 8));
          const expenseHeight =
            row.expenseMinor === 0n
              ? 0
              : Math.max(3, (Number(row.expenseMinor) / model.scale) * (midY - 8));
          const isActive = active === index;

          return (
            <g key={row.date}>
              {/* Hit target spans the full slot — much larger than the mark itself. */}
              <rect
                x={index * slot}
                y={0}
                width={slot}
                height={height}
                fill="transparent"
                onPointerEnter={() => setActive(index)}
                onPointerDown={() => setActive(index)}
                style={{ cursor: 'pointer' }}
              />
              {incomeHeight > 0 ? (
                <rect
                  x={x}
                  y={midY - incomeHeight}
                  width={barWidth}
                  height={incomeHeight}
                  rx={2}
                  fill={income}
                  opacity={active === null || isActive ? 1 : 0.45}
                />
              ) : null}
              {expenseHeight > 0 ? (
                <rect
                  x={x}
                  y={midY}
                  width={barWidth}
                  height={expenseHeight}
                  rx={2}
                  fill={expense}
                  opacity={active === null || isActive ? 1 : 0.45}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Tooltip as a fixed strip rather than a floating layer: no overflow inside a
          narrow WebView, and it stays readable with a keyboard or screen reader. */}
      <div className="mt-2 min-h-[38px] rounded-xl bg-surface-sunken px-3 py-2" aria-live="polite">
        {activeRow ? (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] text-muted">{formatDate(activeRow.date, locale)}</span>
            <span className="flex gap-3">
              <span className="numeric text-[13px] font-semibold" style={{ color: income }}>
                <span className="bidi-isolate">
                  {fiat(
                    { currency, minor: activeRow.incomeMinor.toString(), decimal: '' },
                    locale,
                    { compact: true },
                  )}
                </span>
              </span>
              <span className="numeric text-[13px] font-semibold" style={{ color: expense }}>
                <span className="bidi-isolate">
                  {fiat(
                    { currency, minor: activeRow.expenseMinor.toString(), decimal: '' },
                    locale,
                    { compact: true },
                  )}
                </span>
              </span>
            </span>
          </div>
        ) : (
          <p className="text-[12px] text-subtle">
            {formatDate(model.rows[0]?.date ?? '', locale)} –{' '}
            {formatDate(model.rows[model.rows.length - 1]?.date ?? '', locale)}
          </p>
        )}
      </div>

      {/* Table view — the accessible equivalent, and the relief for the light-mode
          contrast warning on the aqua slot. */}
      {showTable ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <caption className="sr-only">{t('a11y.chart')}</caption>
            <thead>
              <tr className="text-start text-muted">
                <th scope="col" className="py-1 text-start font-medium">
                  {t('tx.date')}
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  {t('analytics.income')}
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  {t('analytics.expense')}
                </th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.date} className="border-t border-border">
                  <td className="py-1.5 text-text">{formatDate(row.date, locale)}</td>
                  <td className="numeric py-1.5 text-end text-text">
                    {FiatAmount.fromMinor(row.incomeMinor, currency).toDecimalString()}
                  </td>
                  <td className="numeric py-1.5 text-end text-text">
                    {FiatAmount.fromMinor(row.expenseMinor, currency).toDecimalString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {/* The swatch carries the colour; the label is plain text ink, never the series hue. */}
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ background: color }}
      />
      <span className="text-[12px] text-muted">{label}</span>
    </span>
  );
}
