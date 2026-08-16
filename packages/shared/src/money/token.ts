import {
  MoneyError,
  formatDecimal,
  parseDecimal,
  pow10,
  rescale,
  type RoundingMode,
} from './fixed-point.js';

/**
 * An exact quantity of a crypto asset, stored in the token's own base units
 * (e.g. USDT-TRC20 has 6 decimals, so 1 USDT === 1_000_000n). Immutable.
 *
 * `decimals` travels with the amount so it is impossible to add USDT (6) to TON (9)
 * by accident, or to render base units as if they were whole tokens.
 */
export class TokenAmount {
  /** Stable identifier of the asset, e.g. "tron:mainnet:TR7NH...". */
  readonly assetKey: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly raw: bigint;

  private constructor(assetKey: string, symbol: string, decimals: number, raw: bigint) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new MoneyError(`TokenAmount: unsupported decimals ${decimals}`);
    }
    this.assetKey = assetKey;
    this.symbol = symbol;
    this.decimals = decimals;
    this.raw = raw;
    Object.freeze(this);
  }

  static fromRaw(
    raw: bigint | string | number,
    meta: { assetKey: string; symbol: string; decimals: number },
  ): TokenAmount {
    let value: bigint;
    if (typeof raw === 'bigint') value = raw;
    else if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw)) {
        throw new MoneyError(`TokenAmount.fromRaw: unsafe numeric base units ${raw}`);
      }
      value = BigInt(raw);
    } else {
      const trimmed = raw.trim();
      if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new MoneyError(`TokenAmount.fromRaw: not an integer string "${raw}"`);
      }
      value = BigInt(trimmed);
    }
    return new TokenAmount(meta.assetKey, meta.symbol, meta.decimals, value);
  }

  /** Parse a human decimal string such as "125.5" into base units. */
  static parse(
    input: string,
    meta: { assetKey: string; symbol: string; decimals: number },
  ): TokenAmount {
    return new TokenAmount(
      meta.assetKey,
      meta.symbol,
      meta.decimals,
      parseDecimal(input, meta.decimals),
    );
  }

  static zero(meta: { assetKey: string; symbol: string; decimals: number }): TokenAmount {
    return new TokenAmount(meta.assetKey, meta.symbol, meta.decimals, 0n);
  }

  private assertSameAsset(other: TokenAmount): void {
    if (other.assetKey !== this.assetKey || other.decimals !== this.decimals) {
      throw new MoneyError(`Asset mismatch: ${this.assetKey} vs ${other.assetKey}`);
    }
  }

  private withRaw(raw: bigint): TokenAmount {
    return new TokenAmount(this.assetKey, this.symbol, this.decimals, raw);
  }

  plus(other: TokenAmount): TokenAmount {
    this.assertSameAsset(other);
    return this.withRaw(this.raw + other.raw);
  }

  minus(other: TokenAmount): TokenAmount {
    this.assertSameAsset(other);
    return this.withRaw(this.raw - other.raw);
  }

  negate(): TokenAmount {
    return this.withRaw(-this.raw);
  }

  abs(): TokenAmount {
    return this.raw < 0n ? this.negate() : this;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }
  isPositive(): boolean {
    return this.raw > 0n;
  }
  isNegative(): boolean {
    return this.raw < 0n;
  }

  gte(other: TokenAmount): boolean {
    this.assertSameAsset(other);
    return this.raw >= other.raw;
  }

  compare(other: TokenAmount): -1 | 0 | 1 {
    this.assertSameAsset(other);
    if (this.raw < other.raw) return -1;
    if (this.raw > other.raw) return 1;
    return 0;
  }

  equals(other: TokenAmount): boolean {
    return this.assetKey === other.assetKey && this.raw === other.raw;
  }

  /** Full-precision decimal string, e.g. "125.500000". */
  toDecimalString(): string {
    return formatDecimal(this.raw, this.decimals);
  }

  /**
   * Display string with trailing zeros trimmed and precision capped.
   * Presentation only — never feed the result back into arithmetic.
   */
  toDisplayString(maxFractionDigits = 6, mode: RoundingMode = 'half-up'): string {
    const targetDecimals = Math.min(this.decimals, maxFractionDigits);
    const scaled = rescale(this.raw, this.decimals, targetDecimals, mode);
    return formatDecimal(scaled, targetDecimals, { trimTrailingZeros: true, minFractionDigits: 0 });
  }

  /** The value of one whole token in base units. */
  get oneUnit(): bigint {
    return pow10(this.decimals);
  }

  toJSON(): { assetKey: string; symbol: string; decimals: number; raw: string } {
    return {
      assetKey: this.assetKey,
      symbol: this.symbol,
      decimals: this.decimals,
      raw: this.raw.toString(),
    };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.symbol}`;
  }
}
