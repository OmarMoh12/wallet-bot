import { z } from 'zod';
import { NETWORK_ENVS, NETWORKS } from '../domain/enums.js';
import { FIAT_CURRENCIES } from '../money/fiat.js';

/**
 * Shared primitives for every API contract.
 *
 * Two rules apply throughout the schema layer:
 *   1. Objects are `.strict()` — unknown keys are rejected, not stripped. This is the
 *      structural defence against mass assignment.
 *   2. Free-text fields are length-bounded and stripped of control characters, so nothing
 *      unbounded or invisible reaches the database, the Telegram API, or the UI.
 */

export const uuidSchema = z.string().uuid();

/**
 * Control characters (except tab/newline) and bidi-override characters have no legitimate
 * place in user text. The bidi set matters specifically here: this app renders Arabic, and
 * U+202A-U+202E / U+2066-U+2069 can visually reverse an address or amount inside a
 * confirmation screen while the underlying string says something else entirely.
 */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function boundedText(max: number, min = 0) {
  return z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS, '').trim())
    .pipe(z.string().min(min).max(max));
}

export const titleSchema = boundedText(120, 1);
export const descriptionSchema = boundedText(500);
export const notesSchema = boundedText(2000);
export const nameSchema = boundedText(60, 1);

/** ISO-8601 instant. Rejects anything Date cannot parse unambiguously. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), { message: 'Invalid date' });

/** Calendar date without a time component, e.g. "2026-08-25". */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), { message: 'Invalid date' });

/**
 * A monetary amount as a plain decimal string. Never a number — JSON numbers are IEEE-754
 * doubles and `0.1 + 0.2 !== 0.3`. The server parses this with exact fixed-point helpers.
 */
export const decimalAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}(\.\d{1,18})?$/, 'Expected a non-negative decimal amount')
  // "Greater than zero" checked lexically — never by converting to a float.
  .refine((value) => /[1-9]/.test(value), { message: 'Amount must be greater than zero' });

/** Same as above but allows a leading minus (adjustments can be negative). */
export const signedDecimalAmountSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}(\.\d{1,18})?$/, 'Expected a decimal amount');

export const fiatCurrencySchema = z.enum(FIAT_CURRENCIES);
export const networkSchema = z.enum(NETWORKS);
export const networkEnvSchema = z.enum(NETWORK_ENVS);

/**
 * Idempotency key supplied by the client on every mutating request that creates money
 * movement. Opaque to the server; only its uniqueness per user matters.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency key must be URL-safe');

export const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Bounded free-text search term. */
export const searchTermSchema = boundedText(120).optional();

/**
 * A raw blockchain address as typed by a user. Only shape is checked here — the
 * network-specific checksum validation lives in `@wallet/blockchain` and always runs
 * server-side before anything is stored or sent.
 */
export const rawAddressSchema = z
  .string()
  .trim()
  .min(20)
  .max(120)
  .regex(/^[A-Za-z0-9_:-]+$/, 'Address contains unexpected characters');

export const txHashSchema = z
  .string()
  .trim()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Invalid transaction hash');

/** A short user-facing memo/comment attached to a transfer. */
export const memoSchema = boundedText(120).optional();

export const localeSchema = z.enum(['en', 'ar']);
export const themePreferenceSchema = z.enum(['system', 'dark', 'light']);

/** Reusable sort direction. */
export const sortDirectionSchema = z.enum(['asc', 'desc']).default('desc');
