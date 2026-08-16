/**
 * Exact fixed-point arithmetic on BigInt.
 *
 * Every monetary computation in this system routes through this file. There is no
 * floating point anywhere in the money path — not in storage, not in transport, not in
 * intermediate calculations. Rounding happens exactly once, explicitly, at a boundary the
 * caller chooses.
 */

export type RoundingMode =
  /** Round toward negative infinity. */
  | 'floor'
  /** Round toward positive infinity. */
  | 'ceil'
  /** Round toward zero. */
  | 'trunc'
  /** Ties away from zero. The intuitive "school" rounding; default for display. */
  | 'half-up'
  /** Ties to the nearest even. Bias-free over many operations; default for accounting. */
  | 'half-even';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const TEN = 10n;

/** 10^n as a BigInt, memoised for the exponents we actually use. */
const powCache = new Map<number, bigint>();
export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 96) {
    throw new MoneyError(`pow10: exponent out of supported range: ${exponent}`);
  }
  const cached = powCache.get(exponent);
  if (cached !== undefined) return cached;
  let result = 1n;
  for (let i = 0; i < exponent; i += 1) result *= TEN;
  powCache.set(exponent, result);
  return result;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Divide `numerator` by `denominator` with the requested rounding mode.
 * Both operands may be negative; rounding modes are defined on the true mathematical value.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-even',
): bigint {
  if (denominator === 0n) throw new MoneyError('divideRounded: division by zero');

  // Normalise so the denominator is positive; the sign lives on the numerator.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const quotient = n / d; // BigInt division truncates toward zero
  const remainder = n % d;
  if (remainder === 0n) return quotient;

  const negative = n < 0n;

  switch (mode) {
    case 'trunc':
      return quotient;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceil':
      return negative ? quotient : quotient + 1n;
    case 'half-up': {
      const twiceRemainder = absBigInt(remainder) * 2n;
      if (twiceRemainder >= d) return negative ? quotient - 1n : quotient + 1n;
      return quotient;
    }
    case 'half-even': {
      const twiceRemainder = absBigInt(remainder) * 2n;
      if (twiceRemainder > d) return negative ? quotient - 1n : quotient + 1n;
      if (twiceRemainder < d) return quotient;
      // Exact tie: move to the even neighbour.
      if (quotient % 2n === 0n) return quotient;
      return negative ? quotient - 1n : quotient + 1n;
    }
    default: {
      const exhaustive: never = mode;
      throw new MoneyError(`divideRounded: unknown rounding mode ${String(exhaustive)}`);
    }
  }
}

/**
 * `(value * multiplier) / divisor` computed without intermediate precision loss.
 * This is the workhorse for currency conversion and price valuation.
 */
export function mulDiv(
  value: bigint,
  multiplier: bigint,
  divisor: bigint,
  mode: RoundingMode = 'half-even',
): bigint {
  return divideRounded(value * multiplier, divisor, mode);
}

/** Rescale an integer from `fromDecimals` to `toDecimals` places. */
export function rescale(
  value: bigint,
  fromDecimals: number,
  toDecimals: number,
  mode: RoundingMode = 'half-even',
): bigint {
  if (fromDecimals === toDecimals) return value;
  if (toDecimals > fromDecimals) return value * pow10(toDecimals - fromDecimals);
  return divideRounded(value, pow10(fromDecimals - toDecimals), mode);
}

const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a human/API decimal string into a scaled integer with `decimals` places.
 *
 * Deliberately strict: rejects exponent notation, thousands separators, empty strings and
 * anything with more precision than the target scale (silently dropping digits from a money
 * value is how people lose money). Use `allowTruncation` only for display-side helpers.
 */
export function parseDecimal(
  input: string,
  decimals: number,
  options: { allowTruncation?: boolean; mode?: RoundingMode } = {},
): bigint {
  const raw = input.trim();
  if (raw === '' || !DECIMAL_STRING.test(raw)) {
    throw new MoneyError(`parseDecimal: not a plain decimal string: ${JSON.stringify(input)}`);
  }

  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const intPart = intPartRaw === '' ? '0' : (intPartRaw as string);

  let fracPart = fracPartRaw;
  let rounded = false;

  if (fracPart.length > decimals) {
    if (!options.allowTruncation) {
      throw new MoneyError(
        `parseDecimal: value "${input}" has more than ${decimals} decimal places`,
      );
    }
    // Keep one extra digit of context by rounding the full-precision value down to scale.
    const fullScale = BigInt(intPart + fracPart);
    const scaled = divideRounded(
      fullScale,
      pow10(fracPart.length - decimals),
      options.mode ?? 'half-even',
    );
    rounded = true;
    return negative ? -scaled : scaled;
  }

  if (!rounded) fracPart = fracPart.padEnd(decimals, '0');
  const magnitude = BigInt(intPart + fracPart);
  return negative ? -magnitude : magnitude;
}

/** Render a scaled integer as a plain decimal string. Never uses exponent notation. */
export function formatDecimal(
  value: bigint,
  decimals: number,
  options: { trimTrailingZeros?: boolean; minFractionDigits?: number } = {},
): string {
  if (decimals === 0) return value.toString();

  const negative = value < 0n;
  const digits = absBigInt(value)
    .toString()
    .padStart(decimals + 1, '0');
  const intPart = digits.slice(0, digits.length - decimals);
  let fracPart = digits.slice(digits.length - decimals);

  if (options.trimTrailingZeros) {
    const min = options.minFractionDigits ?? 0;
    fracPart = fracPart.replace(/0+$/, '');
    while (fracPart.length < min) fracPart += '0';
  } else if (options.minFractionDigits !== undefined) {
    fracPart = fracPart.slice(0, Math.max(options.minFractionDigits, fracPart.length));
  }

  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative && /[1-9]/.test(digits) ? `-${body}` : body;
}

/** Compare two BigInts, returning -1 | 0 | 1 (useful as a sort comparator). */
export function compareBigInt(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Sum a list of BigInts. Empty list sums to zero, as it should. */
export function sumBigInt(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** Absolute value. */
export function abs(value: bigint): bigint {
  return absBigInt(value);
}

/**
 * Parse an integer that arrives as a string from Postgres (`NUMERIC(78,0)` / `BIGINT`).
 * Rejects anything that is not a plain integer so a driver change cannot silently
 * introduce floats.
 */
export function parseIntegerString(input: string | number | bigint | null | undefined): bigint {
  if (input === null || input === undefined) throw new MoneyError('parseIntegerString: null value');
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new MoneyError(`parseIntegerString: unsafe numeric value ${input}`);
    }
    return BigInt(input);
  }
  const raw = input.trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new MoneyError(`parseIntegerString: not an integer string: ${JSON.stringify(input)}`);
  }
  return BigInt(raw);
}
