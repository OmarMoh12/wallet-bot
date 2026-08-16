import { FiatAmount, fiatDecimals, type FiatCurrency } from './fiat.js';
import {
  MoneyError,
  formatDecimal,
  mulDiv,
  parseDecimal,
  pow10,
  type RoundingMode,
} from './fixed-point.js';
import { type TokenAmount } from './token.js';

/**
 * Rates and prices are held as integers scaled by 1e12. That is enough headroom for
 * USD/ILS (~3.7) and for low-unit-value tokens, without ever touching a float.
 */
export const RATE_SCALE_DECIMALS = 12;
export const RATE_SCALE = pow10(RATE_SCALE_DECIMALS);

/** An exchange rate: 1 unit of `base` costs `scaled / RATE_SCALE` units of `quote`. */
export class ExchangeRate {
  readonly base: FiatCurrency;
  readonly quote: FiatCurrency;
  readonly scaled: bigint;
  readonly asOf: Date;
  readonly source: string;

  private constructor(
    base: FiatCurrency,
    quote: FiatCurrency,
    scaled: bigint,
    asOf: Date,
    source: string,
  ) {
    if (scaled <= 0n) throw new MoneyError(`ExchangeRate: rate must be positive, got ${scaled}`);
    this.base = base;
    this.quote = quote;
    this.scaled = scaled;
    this.asOf = asOf;
    this.source = source;
    Object.freeze(this);
  }

  static fromScaled(params: {
    base: FiatCurrency;
    quote: FiatCurrency;
    scaled: bigint;
    asOf: Date;
    source: string;
  }): ExchangeRate {
    return new ExchangeRate(params.base, params.quote, params.scaled, params.asOf, params.source);
  }

  /** Build from a decimal string such as "3.7412" as returned by an FX API. */
  static fromDecimalString(params: {
    base: FiatCurrency;
    quote: FiatCurrency;
    value: string;
    asOf: Date;
    source: string;
  }): ExchangeRate {
    const scaled = parseDecimal(params.value, RATE_SCALE_DECIMALS, { allowTruncation: true });
    return new ExchangeRate(params.base, params.quote, scaled, params.asOf, params.source);
  }

  /** The rate in the opposite direction, computed exactly at full scale. */
  invert(): ExchangeRate {
    const inverted = mulDiv(RATE_SCALE, RATE_SCALE, this.scaled, 'half-even');
    return new ExchangeRate(this.quote, this.base, inverted, this.asOf, `${this.source}:inverted`);
  }

  /** Convert an amount denominated in `base` into `quote`. */
  convert(amount: FiatAmount, mode: RoundingMode = 'half-even'): FiatAmount {
    if (amount.currency !== this.base) {
      throw new MoneyError(
        `ExchangeRate.convert: expected ${this.base}, received ${amount.currency}`,
      );
    }
    const fromDecimals = fiatDecimals(this.base);
    const toDecimals = fiatDecimals(this.quote);
    // minor_quote = minor_base * rate * 10^(toDec - fromDec)
    const numerator = amount.minor * this.scaled * pow10(Math.max(0, toDecimals - fromDecimals));
    const denominator = RATE_SCALE * pow10(Math.max(0, fromDecimals - toDecimals));
    return FiatAmount.fromMinor(mulDiv(numerator, 1n, denominator, mode), this.quote);
  }

  toDecimalString(fractionDigits = 4): string {
    const reduced = mulDiv(this.scaled, pow10(fractionDigits), RATE_SCALE, 'half-up');
    return formatDecimal(reduced, fractionDigits);
  }

  ageSeconds(now: Date = new Date()): number {
    return Math.max(0, Math.floor((now.getTime() - this.asOf.getTime()) / 1000));
  }

  toJSON() {
    return {
      base: this.base,
      quote: this.quote,
      scaled: this.scaled.toString(),
      asOf: this.asOf.toISOString(),
      source: this.source,
    };
  }
}

/** The USD spot price of one whole token, scaled by RATE_SCALE. */
export class AssetPrice {
  readonly assetKey: string;
  readonly symbol: string;
  readonly quote: FiatCurrency;
  readonly scaled: bigint;
  readonly asOf: Date;
  readonly source: string;

  private constructor(params: {
    assetKey: string;
    symbol: string;
    quote: FiatCurrency;
    scaled: bigint;
    asOf: Date;
    source: string;
  }) {
    if (params.scaled < 0n) throw new MoneyError('AssetPrice: price cannot be negative');
    this.assetKey = params.assetKey;
    this.symbol = params.symbol;
    this.quote = params.quote;
    this.scaled = params.scaled;
    this.asOf = params.asOf;
    this.source = params.source;
    Object.freeze(this);
  }

  static fromScaled(params: {
    assetKey: string;
    symbol: string;
    quote: FiatCurrency;
    scaled: bigint;
    asOf: Date;
    source: string;
  }): AssetPrice {
    return new AssetPrice(params);
  }

  static fromDecimalString(params: {
    assetKey: string;
    symbol: string;
    quote: FiatCurrency;
    value: string;
    asOf: Date;
    source: string;
  }): AssetPrice {
    return new AssetPrice({
      ...params,
      scaled: parseDecimal(params.value, RATE_SCALE_DECIMALS, { allowTruncation: true }),
    });
  }

  /**
   * Value a token quantity in fiat.
   *
   *   minor = raw * price / 10^tokenDecimals / RATE_SCALE * 10^fiatDecimals
   *
   * evaluated as a single mulDiv so no intermediate rounding occurs.
   */
  value(amount: TokenAmount, mode: RoundingMode = 'half-even'): FiatAmount {
    const fiatDec = fiatDecimals(this.quote);
    const numerator = amount.raw * this.scaled * pow10(fiatDec);
    const denominator = pow10(amount.decimals) * RATE_SCALE;
    return FiatAmount.fromMinor(mulDiv(numerator, 1n, denominator, mode), this.quote);
  }

  toDecimalString(fractionDigits = 6): string {
    const reduced = mulDiv(this.scaled, pow10(fractionDigits), RATE_SCALE, 'half-up');
    return formatDecimal(reduced, fractionDigits);
  }

  ageSeconds(now: Date = new Date()): number {
    return Math.max(0, Math.floor((now.getTime() - this.asOf.getTime()) / 1000));
  }

  toJSON() {
    return {
      assetKey: this.assetKey,
      symbol: this.symbol,
      quote: this.quote,
      scaled: this.scaled.toString(),
      asOf: this.asOf.toISOString(),
      source: this.source,
    };
  }
}
