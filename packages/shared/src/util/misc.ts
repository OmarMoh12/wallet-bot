import { AppError } from '../errors.js';

/** Narrow `unknown` to a record without reaching for `any`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exhaustiveness helper. Calling this in a `default:` branch turns a missing switch case
 * into a compile error rather than a silent fallthrough.
 */
export function assertNever(value: never, context: string): never {
  throw new AppError('INTERNAL_ERROR', {
    internal: `Unhandled case in ${context}: ${JSON.stringify(value)}`,
  });
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new AppError('INTERNAL_ERROR', { internal: message });
  }
  return value;
}

/**
 * The single audited BigInt -> number conversion in the codebase.
 *
 * Every other module goes through this, so `Number(...)` never appears near money. Values
 * outside the safe-integer range throw rather than silently losing precision — which is the
 * exact failure this whole convention exists to prevent.
 */
export function bigintToNumber(value: bigint, label: string): number {
  const MAX = BigInt(globalThis.Number.MAX_SAFE_INTEGER);
  if (value > MAX || value < -MAX) {
    throw new AppError('INTERNAL_ERROR', {
      internal: `${label}: BigInt ${value} exceeds the safe integer range`,
    });
  }
  return globalThis.Number(value);
}

/**
 * Parse a COUNT / cardinality value returned by PostgreSQL.
 *
 * Separate from the money path on purpose: a row count is not an amount, and giving it its
 * own named helper keeps `Number(...)` from appearing anywhere that handles money — which
 * is what makes the lint rule banning it meaningful rather than noisy.
 */
export function parseCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return globalThis.Number.isFinite(value) ? value : 0;
  const parsed = globalThis.Number.parseInt(value, 10);
  return globalThis.Number.isFinite(parsed) ? parsed : 0;
}

/** Clamp an integer into a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Basis points (0–10000) from a ratio expressed as two BigInts. Safe when total is zero. */
export function shareBps(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  const bps = (part * 10000n) / total;
  return clamp(bigintToNumber(bps, 'shareBps'), 0, 10000);
}

/** Signed change in basis points; null when the baseline is zero (no meaningful ratio). */
export function changeBps(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const delta = ((current - previous) * 10000n) / (previous < 0n ? -previous : previous);
  return bigintToNumber(delta, 'changeBps');
}

/** Group items by a derived key, preserving insertion order. */
export function groupBy<T, K extends string>(
  items: readonly T[],
  keyOf: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** Remove undefined values so they are not serialised as explicit nulls. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) output[key] = entry;
  }
  return output as Partial<T>;
}

/** Chunk an array for batched I/O. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size must be positive');
  const output: T[][] = [];
  for (let i = 0; i < items.length; i += size) output.push(items.slice(i, i + size));
  return output;
}

/** Await a delay. Used for backoff; never for polling in request handlers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wrap a promise with a timeout that rejects as an AppError.
 * Every outbound network call in this system is wrapped in one of these.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AppError('TIMEOUT', { internal: `${label} timed out after ${ms}ms` })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Deterministic ordering helper for stable API output. */
export function byField<T, K extends keyof T>(field: K, direction: 'asc' | 'desc' = 'asc') {
  return (a: T, b: T): number => {
    const left = a[field];
    const right = b[field];
    if (left === right) return 0;
    const result = left < right ? -1 : 1;
    return direction === 'asc' ? result : -result;
  };
}
