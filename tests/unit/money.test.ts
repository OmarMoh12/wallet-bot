import { describe, expect, it } from 'vitest';
import {
  AssetPrice,
  ExchangeRate,
  FiatAmount,
  MoneyError,
  TokenAmount,
  divideRounded,
  formatDecimal,
  formatFiat,
  formatToken,
  mulDiv,
  parseDecimal,
  parseIntegerString,
} from '@wallet/shared';

/**
 * Money arithmetic.
 *
 * These are the tests that matter most in the whole suite: everything else can be wrong in
 * a way someone notices, but a rounding error compounds silently.
 */

describe('fixed-point primitives', () => {
  it('rounds half-even without bias', () => {
    // 2.5 -> 2, 3.5 -> 4: ties go to the even neighbour, so repeated rounding does not drift.
    expect(divideRounded(5n, 2n, 'half-even')).toBe(2n);
    expect(divideRounded(7n, 2n, 'half-even')).toBe(4n);
    expect(divideRounded(-5n, 2n, 'half-even')).toBe(-2n);
    expect(divideRounded(-7n, 2n, 'half-even')).toBe(-4n);
  });

  it('rounds half-up away from zero', () => {
    expect(divideRounded(5n, 2n, 'half-up')).toBe(3n);
    expect(divideRounded(-5n, 2n, 'half-up')).toBe(-3n);
  });

  it('floors and ceils across the sign boundary', () => {
    expect(divideRounded(-1n, 2n, 'floor')).toBe(-1n);
    expect(divideRounded(1n, 2n, 'floor')).toBe(0n);
    expect(divideRounded(-1n, 2n, 'ceil')).toBe(0n);
    expect(divideRounded(1n, 2n, 'ceil')).toBe(1n);
    expect(divideRounded(-1n, 2n, 'trunc')).toBe(0n);
  });

  it('refuses to divide by zero', () => {
    expect(() => divideRounded(1n, 0n)).toThrow(MoneyError);
  });

  it('mulDiv keeps full precision through the intermediate product', () => {
    // Done naively as (a/c)*b this loses everything; the exact answer is 1.
    expect(mulDiv(10n ** 30n, 1n, 10n ** 30n)).toBe(1n);
    expect(mulDiv(7n, 1_000_000n, 3n, 'floor')).toBe(2_333_333n);
  });

  it('parses decimals exactly and rejects excess precision', () => {
    expect(parseDecimal('1.23', 2)).toBe(123n);
    expect(parseDecimal('0.01', 2)).toBe(1n);
    expect(parseDecimal('-5', 2)).toBe(-500n);
    // Silently dropping a digit from a money value is how people lose money.
    expect(() => parseDecimal('1.234', 2)).toThrow(MoneyError);
    expect(() => parseDecimal('1e5', 2)).toThrow(MoneyError);
    expect(() => parseDecimal('1,000', 2)).toThrow(MoneyError);
    expect(() => parseDecimal('', 2)).toThrow(MoneyError);
  });

  it('formats without exponent notation at any magnitude', () => {
    expect(formatDecimal(123n, 2)).toBe('1.23');
    expect(formatDecimal(-123n, 2)).toBe('-1.23');
    expect(formatDecimal(1n, 18)).toBe('0.000000000000000001');
    expect(formatDecimal(0n, 2)).toBe('0.00');
  });

  it('rejects unsafe numeric input from the driver', () => {
    expect(parseIntegerString('42')).toBe(42n);
    expect(parseIntegerString(42)).toBe(42n);
    expect(() => parseIntegerString('4.2')).toThrow(MoneyError);
    expect(() => parseIntegerString(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('FiatAmount', () => {
  it('adds without floating-point error', () => {
    // The canonical 0.1 + 0.2 !== 0.3 case, which is exact here.
    const a = FiatAmount.parse('0.10', 'USD');
    const b = FiatAmount.parse('0.20', 'USD');
    expect(a.plus(b).toDecimalString()).toBe('0.30');
  });

  it('refuses to mix currencies', () => {
    const usd = FiatAmount.parse('1.00', 'USD');
    const ils = FiatAmount.parse('1.00', 'ILS');
    expect(() => usd.plus(ils)).toThrow(MoneyError);
  });

  it('allocates without losing or inventing a cent', () => {
    const total = FiatAmount.parse('10.00', 'USD');
    const parts = total.allocate(3);
    expect(parts.map((part) => part.toDecimalString())).toEqual(['3.34', '3.33', '3.33']);
    const sum = parts.reduce((acc, part) => acc.plus(part), FiatAmount.zero('USD'));
    expect(sum.equals(total)).toBe(true);
  });

  it('allocates negative totals symmetrically', () => {
    const total = FiatAmount.parse('-10.00', 'USD');
    const parts = total.allocate(3);
    const sum = parts.reduce((acc, part) => acc.plus(part), FiatAmount.zero('USD'));
    expect(sum.equals(total)).toBe(true);
  });
});

describe('TokenAmount', () => {
  const usdt = { assetKey: 'usdt', symbol: 'USDT', decimals: 6 };
  const ton = { assetKey: 'ton', symbol: 'TON', decimals: 9 };

  it('keeps base units exact', () => {
    expect(TokenAmount.parse('125.5', usdt).raw).toBe(125_500_000n);
    expect(TokenAmount.parse('1', ton).raw).toBe(1_000_000_000n);
  });

  it('refuses to combine different assets', () => {
    const a = TokenAmount.parse('1', usdt);
    const b = TokenAmount.parse('1', ton);
    expect(() => a.plus(b)).toThrow(MoneyError);
  });

  it('trims display precision without touching the stored value', () => {
    const amount = TokenAmount.fromRaw(1_234_567n, usdt);
    expect(amount.toDecimalString()).toBe('1.234567');
    expect(amount.toDisplayString(2)).toBe('1.23');
    expect(amount.raw).toBe(1_234_567n);
  });

  it('rejects amounts with more precision than the token has', () => {
    expect(() => TokenAmount.parse('1.1234567', usdt)).toThrow(MoneyError);
  });
});

describe('ExchangeRate', () => {
  const rate = ExchangeRate.fromDecimalString({
    base: 'USD',
    quote: 'ILS',
    value: '3.7412',
    asOf: new Date('2026-08-16T00:00:00Z'),
    source: 'test',
  });

  it('converts across currencies exactly', () => {
    const usd = FiatAmount.parse('100.00', 'USD');
    expect(rate.convert(usd).toDecimalString()).toBe('374.12');
  });

  it('refuses an amount in the wrong currency', () => {
    expect(() => rate.convert(FiatAmount.parse('1', 'ILS'))).toThrow(MoneyError);
  });

  it('round-trips through inversion within one minor unit', () => {
    const usd = FiatAmount.parse('100.00', 'USD');
    const ils = rate.convert(usd);
    const back = rate.invert().convert(ils);
    const drift = back.minus(usd).abs();
    expect(drift.minor <= 1n).toBe(true);
  });

  it('rejects a non-positive rate', () => {
    expect(() =>
      ExchangeRate.fromScaled({
        base: 'USD',
        quote: 'ILS',
        scaled: 0n,
        asOf: new Date(),
        source: 'test',
      }),
    ).toThrow(MoneyError);
  });
});

describe('AssetPrice', () => {
  it('values a holding in fiat with a single rounding step', () => {
    const price = AssetPrice.fromDecimalString({
      assetKey: 'usdt',
      symbol: 'USDT',
      quote: 'USD',
      value: '0.9998',
      asOf: new Date(),
      source: 'test',
    });
    const amount = TokenAmount.parse('125.5', { assetKey: 'usdt', symbol: 'USDT', decimals: 6 });
    // 125.5 * 0.9998 = 125.4749 -> 125.47
    expect(price.value(amount).toDecimalString()).toBe('125.47');
  });

  it('values high-decimal tokens without overflow', () => {
    const price = AssetPrice.fromDecimalString({
      assetKey: 'ton',
      symbol: 'TON',
      quote: 'USD',
      value: '5.4321',
      asOf: new Date(),
      source: 'test',
    });
    const amount = TokenAmount.parse('4.72', { assetKey: 'ton', symbol: 'TON', decimals: 9 });
    expect(price.value(amount).toDecimalString()).toBe('25.64');
  });
});

describe('formatting', () => {
  it('renders fiat with grouping and an explicit sign when asked', () => {
    const amount = FiatAmount.parse('1842.32', 'USD');
    expect(formatFiat(amount, { locale: 'en' })).toBe('$1,842.32');
    expect(formatFiat(amount, { locale: 'en', signDisplay: 'always' })).toBe('+$1,842.32');
    expect(formatFiat(amount.negate(), { locale: 'en' })).toBe('-$1,842.32');
  });

  it('compacts large values without misstating them', () => {
    const amount = FiatAmount.parse('1250000.00', 'USD');
    expect(formatFiat(amount, { locale: 'en', compact: true })).toBe('$1.3M');
  });

  it('renders tokens with the symbol and trimmed zeros', () => {
    const amount = TokenAmount.parse('125.500000', { assetKey: 'x', symbol: 'USDT', decimals: 6 });
    expect(formatToken(amount, { locale: 'en' })).toBe('125.5 USDT');
  });
});
