'use client';

import {
  FiatAmount,
  TokenAmount,
  formatFiat,
  formatToken,
  relativeTimeKey,
  shortenAddress,
  type FiatMoneyDto,
  type Locale,
  type TokenMoneyDto,
  type TranslationParams,
} from '@wallet/shared';

/**
 * Presentation helpers.
 *
 * Every one of these takes the **exact** fields from a DTO (`minor`, `raw`) and reconstructs
 * the value with the shared money classes before formatting. Nothing here parses the
 * pre-rendered `decimal` string back into a number — that string is for display only.
 */

export function fiat(
  value: FiatMoneyDto | null | undefined,
  locale: Locale,
  options: { signDisplay?: 'auto' | 'always' | 'never'; compact?: boolean; hidden?: boolean } = {},
): string {
  if (options.hidden) return '••••';
  if (!value) return '—';
  return formatFiat(FiatAmount.fromMinor(value.minor, value.currency), {
    locale,
    ...(options.signDisplay ? { signDisplay: options.signDisplay } : {}),
    ...(options.compact ? { compact: true } : {}),
  });
}

export function token(
  value: TokenMoneyDto | null | undefined,
  locale: Locale,
  options: {
    signDisplay?: 'auto' | 'always' | 'never';
    maxFractionDigits?: number;
    hidden?: boolean;
  } = {},
): string {
  if (options.hidden) return '••••';
  if (!value) return '—';
  return formatToken(
    TokenAmount.fromRaw(value.raw, {
      assetKey: value.assetId,
      symbol: value.symbol,
      decimals: value.decimals,
    }),
    {
      locale,
      ...(options.signDisplay ? { signDisplay: options.signDisplay } : {}),
      maxFractionDigits: options.maxFractionDigits ?? 6,
    },
  );
}

/** True when the amount represents money leaving. Drives the colour, never the sign. */
export function isNegativeFiat(value: FiatMoneyDto | null | undefined): boolean {
  return value ? value.minor.startsWith('-') : false;
}

export function relativeTime(
  iso: string,
  t: (key: string, params?: TranslationParams) => string,
): string {
  const result = relativeTimeKey(new Date(iso));
  return t(result.key, result.params);
}

/** Date for a transaction row / detail screen. Locale-aware, no time zone surprises. */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function formatDate(iso: string, locale: Locale): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

/** Day header for grouped transaction lists. */
export function dayLabel(
  iso: string,
  locale: Locale,
  t: (key: string, params?: TranslationParams) => string,
): string {
  const date = new Date(iso);
  const today = new Date();
  const startOf = (value: Date): number =>
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());

  const diffDays = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diffDays === 0) return t('common.today');
  if (diffDays === 1) return t('common.yesterday');
  if (diffDays === -1) return t('common.tomorrow');
  return formatDate(iso, locale);
}

export { shortenAddress };

/** Percentage from basis points, for the analytics deltas. */
export function formatBps(bps: number | null, locale: Locale): string {
  if (bps === null) return '—';
  const value = bps / 100;
  try {
    return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      style: 'percent',
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(value / 100);
  } catch {
    return `${value.toFixed(1)}%`;
  }
}

/** Bidi-safe wrapper for a value rendered inside RTL text. */
export function bidi(value: string): string {
  return value;
}
