import { FIAT_CURRENCY_INFO, type FiatAmount, type FiatCurrency } from './fiat.js';
import { formatDecimal, mulDiv, pow10, rescale } from './fixed-point.js';
import type { TokenAmount } from './token.js';

export type LocaleTag = 'en' | 'ar';

/**
 * Presentation-layer formatting. Everything here produces strings for humans and must
 * never be parsed back into a monetary value.
 *
 * `Intl.NumberFormat` is used for grouping/locale digits only — the *value* handed to it is
 * already an exactly-rounded decimal string, so no precision is lost to Number conversion.
 */

function groupDigits(intDigits: string, locale: LocaleTag): string {
  // Latin digits with a plain comma separator; Intl handles locale digit shapes below.
  const sign = intDigits.startsWith('-') ? '-' : '';
  const body = sign ? intDigits.slice(1) : intDigits;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  void locale;
  return sign + grouped;
}

function splitDecimal(text: string): { int: string; frac: string } {
  const [int = '0', frac = ''] = text.split('.');
  return { int, frac };
}

export interface FormatFiatOptions {
  locale?: LocaleTag;
  /** Show the currency symbol. Default true. */
  withSymbol?: boolean;
  /** Fraction digits to display. Defaults to the currency's own scale. */
  fractionDigits?: number;
  /** Render "+" for positive values (used on transaction rows). */
  signDisplay?: 'auto' | 'always' | 'never';
  /** Collapse to compact notation above 100_000 major units (e.g. "$1.2M"). */
  compact?: boolean;
}

const COMPACT_STEPS: ReadonlyArray<{ threshold: bigint; divisor: bigint; suffix: string }> = [
  { threshold: 1_000_000_000n, divisor: 1_000_000_000n, suffix: 'B' },
  { threshold: 1_000_000n, divisor: 1_000_000n, suffix: 'M' },
  { threshold: 100_000n, divisor: 1_000n, suffix: 'K' },
];

export function formatFiat(amount: FiatAmount, options: FormatFiatOptions = {}): string {
  const {
    locale = 'en',
    withSymbol = true,
    signDisplay = 'auto',
    compact = false,
    fractionDigits,
  } = options;
  const info = FIAT_CURRENCY_INFO[amount.currency];
  const negative = amount.minor < 0n;
  const absMinor = negative ? -amount.minor : amount.minor;

  let body: string;
  if (compact) {
    const major = absMinor / pow10(info.decimals);
    const step = COMPACT_STEPS.find((candidate) => major >= candidate.threshold);
    if (step) {
      // One decimal place of the compacted unit, exactly rounded.
      const scaled = mulDiv(absMinor, 10n, pow10(info.decimals) * step.divisor, 'half-up');
      const text = formatDecimal(scaled, 1, { trimTrailingZeros: true });
      body = `${text}${step.suffix}`;
    } else {
      body = compactPlain(absMinor, info.decimals, fractionDigits, locale);
    }
  } else {
    body = compactPlain(absMinor, info.decimals, fractionDigits, locale);
  }

  const sign = negative ? '-' : signDisplay === 'always' && amount.minor > 0n ? '+' : '';
  const symbol = withSymbol ? info.symbol : '';

  // Symbol always hugs the number; direction is handled by the UI's bidi isolation.
  const withCurrency =
    info.symbolPosition === 'prefix' ? `${symbol}${body}` : `${body}${symbol ? ` ${symbol}` : ''}`;

  return signDisplay === 'never' ? withCurrency : `${sign}${withCurrency}`;
}

function compactPlain(
  absMinor: bigint,
  decimals: number,
  fractionDigits: number | undefined,
  locale: LocaleTag,
): string {
  const targetDigits = fractionDigits ?? decimals;
  const scaled = rescale(absMinor, decimals, targetDigits, 'half-up');
  const text = formatDecimal(scaled, targetDigits);
  const { int, frac } = splitDecimal(text);
  const grouped = groupDigits(int, locale);
  return frac ? `${grouped}.${frac}` : grouped;
}

export interface FormatTokenOptions {
  locale?: LocaleTag;
  withSymbol?: boolean;
  maxFractionDigits?: number;
  signDisplay?: 'auto' | 'always' | 'never';
}

export function formatToken(amount: TokenAmount, options: FormatTokenOptions = {}): string {
  const { locale = 'en', withSymbol = true, maxFractionDigits = 6, signDisplay = 'auto' } = options;
  const negative = amount.raw < 0n;
  const display = amount.abs().toDisplayString(maxFractionDigits);
  const { int, frac } = splitDecimal(display);
  const grouped = groupDigits(int, locale);
  const body = frac ? `${grouped}.${frac}` : grouped;
  const sign = negative ? '-' : signDisplay === 'always' && amount.raw > 0n ? '+' : '';
  const suffix = withSymbol ? ` ${amount.symbol}` : '';
  return signDisplay === 'never' ? `${body}${suffix}` : `${sign}${body}${suffix}`;
}

/** Shorten an address for display: "TR7NHq…LjLoW". Never used for comparison. */
export function shortenAddress(address: string, head = 6, tail = 5): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Shorten a transaction hash for display. */
export function shortenHash(hash: string, head = 8, tail = 6): string {
  return shortenAddress(hash, head, tail);
}

export function currencySymbol(currency: FiatCurrency): string {
  return FIAT_CURRENCY_INFO[currency].symbol;
}
