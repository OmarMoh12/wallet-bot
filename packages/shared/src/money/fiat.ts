import {
  MoneyError,
  divideRounded,
  formatDecimal,
  parseDecimal,
  pow10,
  type RoundingMode,
} from './fixed-point.js';

/** Fiat currencies the system knows how to hold and report in. */
export const FIAT_CURRENCIES = ['USD', 'ILS'] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

export interface FiatCurrencyInfo {
  readonly code: FiatCurrency;
  /** Number of minor units per major unit, as a power of ten. */
  readonly decimals: number;
  readonly symbol: string;
  /** Where the symbol sits when rendering in a left-to-right context. */
  readonly symbolPosition: 'prefix' | 'suffix';
}

export const FIAT_CURRENCY_INFO: Readonly<Record<FiatCurrency, FiatCurrencyInfo>> = Object.freeze({
  USD: { code: 'USD', decimals: 2, symbol: '$', symbolPosition: 'prefix' },
  ILS: { code: 'ILS', decimals: 2, symbol: '₪', symbolPosition: 'prefix' },
});

export function isFiatCurrency(value: unknown): value is FiatCurrency {
  return typeof value === 'string' && (FIAT_CURRENCIES as readonly string[]).includes(value);
}

export function fiatDecimals(currency: FiatCurrency): number {
  return FIAT_CURRENCY_INFO[currency].decimals;
}

/**
 * An exact amount of fiat money, stored as signed integer minor units
 * (cents for USD, agorot for ILS). Immutable.
 */
export class FiatAmount {
  readonly currency: FiatCurrency;
  readonly minor: bigint;

  private constructor(currency: FiatCurrency, minor: bigint) {
    this.currency = currency;
    this.minor = minor;
    Object.freeze(this);
  }

  static fromMinor(minor: bigint | number | string, currency: FiatCurrency): FiatAmount {
    if (!isFiatCurrency(currency)) throw new MoneyError(`Unknown fiat currency: ${currency}`);
    let value: bigint;
    if (typeof minor === 'bigint') value = minor;
    else if (typeof minor === 'number') {
      if (!Number.isSafeInteger(minor)) {
        throw new MoneyError(`FiatAmount.fromMinor: non-integer minor units ${minor}`);
      }
      value = BigInt(minor);
    } else {
      if (!/^[+-]?\d+$/.test(minor.trim())) {
        throw new MoneyError(`FiatAmount.fromMinor: not an integer string "${minor}"`);
      }
      value = BigInt(minor.trim());
    }
    return new FiatAmount(currency, value);
  }

  /** Parse a user-facing decimal string such as "1234.56". */
  static parse(input: string, currency: FiatCurrency): FiatAmount {
    if (!isFiatCurrency(currency)) throw new MoneyError(`Unknown fiat currency: ${currency}`);
    return new FiatAmount(currency, parseDecimal(input, fiatDecimals(currency)));
  }

  static zero(currency: FiatCurrency): FiatAmount {
    return new FiatAmount(currency, 0n);
  }

  get decimals(): number {
    return fiatDecimals(this.currency);
  }

  private assertSameCurrency(other: FiatAmount): void {
    if (other.currency !== this.currency) {
      throw new MoneyError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  plus(other: FiatAmount): FiatAmount {
    this.assertSameCurrency(other);
    return new FiatAmount(this.currency, this.minor + other.minor);
  }

  minus(other: FiatAmount): FiatAmount {
    this.assertSameCurrency(other);
    return new FiatAmount(this.currency, this.minor - other.minor);
  }

  negate(): FiatAmount {
    return new FiatAmount(this.currency, -this.minor);
  }

  abs(): FiatAmount {
    return this.minor < 0n ? this.negate() : this;
  }

  /** Multiply by an integer count (e.g. 3 identical instalments). */
  timesInteger(count: bigint | number): FiatAmount {
    const factor = typeof count === 'bigint' ? count : BigInt(count);
    return new FiatAmount(this.currency, this.minor * factor);
  }

  /** Split into `parts` as evenly as possible, distributing the remainder deterministically. */
  allocate(parts: number): FiatAmount[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new MoneyError(`FiatAmount.allocate: parts must be a positive integer, got ${parts}`);
    }
    const base = divideRounded(this.minor, BigInt(parts), 'trunc');
    const remainder = this.minor - base * BigInt(parts);
    const step = remainder < 0n ? -1n : 1n;
    let left = remainder < 0n ? -remainder : remainder;
    const out: FiatAmount[] = [];
    for (let i = 0; i < parts; i += 1) {
      let amount = base;
      if (left > 0n) {
        amount += step;
        left -= 1n;
      }
      out.push(new FiatAmount(this.currency, amount));
    }
    return out;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }

  compare(other: FiatAmount): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  equals(other: FiatAmount): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** Plain decimal string without a currency symbol, e.g. "1234.56". */
  toDecimalString(mode: RoundingMode = 'half-even'): string {
    void mode; // No rounding needed: minor units are already at full scale.
    return formatDecimal(this.minor, this.decimals);
  }

  /** Whole major units, truncated. Useful for chart axes, never for accounting. */
  toMajorUnitsFloor(): bigint {
    return divideRounded(this.minor, pow10(this.decimals), 'floor');
  }

  toJSON(): { currency: FiatCurrency; minor: string } {
    return { currency: this.currency, minor: this.minor.toString() };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }
}

/** Sum amounts of a single currency. Throws on a mixed-currency list. */
export function sumFiat(amounts: readonly FiatAmount[], currency: FiatCurrency): FiatAmount {
  let total = FiatAmount.zero(currency);
  for (const amount of amounts) total = total.plus(amount);
  return total;
}
