import { z } from 'zod';
import {
  CATEGORY_KINDS,
  EXPECTED_INCOME_STATUSES,
  FX_MODES,
  NOTIFICATION_TYPES,
  TX_KINDS,
  TX_STATUSES,
  TX_TYPES,
} from '../domain/enums.js';
import {
  decimalAmountSchema,
  descriptionSchema,
  fiatCurrencySchema,
  idempotencyKeySchema,
  isoDateSchema,
  isoDateTimeSchema,
  localeSchema,
  memoSchema,
  nameSchema,
  networkEnvSchema,
  networkSchema,
  notesSchema,
  paginationSchema,
  rawAddressSchema,
  searchTermSchema,
  signedDecimalAmountSchema,
  themePreferenceSchema,
  titleSchema,
  uuidSchema,
} from './common.js';

/* ------------------------------------------------------------------ auth -- */

export const telegramAuthRequestSchema = z
  .object({
    /** Raw `window.Telegram.WebApp.initData` string. Verified server-side. */
    initData: z.string().min(1).max(4096),
    /** Optional locale hint; the server still decides. */
    locale: localeSchema.optional(),
  })
  .strict();
export type TelegramAuthRequest = z.infer<typeof telegramAuthRequestSchema>;

export const setPinRequestSchema = z
  .object({
    pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits'),
    currentPin: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();

export const verifyPinRequestSchema = z.object({ pin: z.string().regex(/^\d{6}$/) }).strict();

/* --------------------------------------------------------------- wallets -- */

export const createWalletRequestSchema = z
  .object({
    name: nameSchema,
    network: networkSchema,
    env: networkEnvSchema.optional(),
    address: rawAddressSchema,
    /**
     * Only `watch_only` is accepted through the public API. A managed (signing) wallet is
     * provisioned out-of-band on the signer service — the web tier cannot create one.
     */
    type: z.literal('watch_only').default('watch_only'),
  })
  .strict();
export type CreateWalletRequest = z.infer<typeof createWalletRequestSchema>;

/**
 * Create a wallet whose key the signer holds.
 *
 * Restricted to EVM networks: TRON and TON keys are provisioned out of band on the signer
 * host. The response contains only the address — there is no field for a private key, and
 * that is enforced by the response type, not by convention.
 */
export const generateWalletRequestSchema = z
  .object({
    name: nameSchema,
    network: z.enum(['bsc']),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type GenerateWalletRequest = z.infer<typeof generateWalletRequestSchema>;

export const updateWalletRequestSchema = z
  .object({
    name: nameSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const walletListQuerySchema = z
  .object({
    network: networkSchema.optional(),
    includeInactive: z.coerce.boolean().default(false),
  })
  .strict();

/* ---------------------------------------------------------- transactions -- */

const cashTransactionBaseSchema = z
  .object({
    type: z.enum(['income', 'expense', 'adjustment']),
    amount: signedDecimalAmountSchema,
    currency: fiatCurrencySchema,
    cashAccountId: uuidSchema.optional(),
    categoryId: uuidSchema.nullish(),
    title: titleSchema,
    description: descriptionSchema.optional(),
    notes: notesSchema.optional(),
    occurredAt: isoDateTimeSchema.optional(),
    externalRef: z.string().trim().max(120).optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const createCashTransactionRequestSchema = cashTransactionBaseSchema.superRefine(
  (value, ctx) => {
    if (value.type !== 'adjustment' && value.amount.startsWith('-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'Only adjustments may be negative; use type=expense instead',
      });
    }
    if (!/[1-9]/.test(value.amount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'Amount must not be zero',
      });
    }
  },
);
export type CreateCashTransactionRequest = z.infer<typeof createCashTransactionRequestSchema>;

export const updateTransactionRequestSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    notes: notesSchema.optional(),
    categoryId: uuidSchema.nullish(),
    occurredAt: isoDateTimeSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const transactionFilterSchema = paginationSchema
  .extend({
    kind: z.enum(TX_KINDS).optional(),
    type: z.enum(TX_TYPES).optional(),
    status: z.enum(TX_STATUSES).optional(),
    direction: z.enum(['in', 'out']).optional(),
    network: networkSchema.optional(),
    walletId: uuidSchema.optional(),
    cashAccountId: uuidSchema.optional(),
    categoryId: uuidSchema.optional(),
    currency: fiatCurrencySchema.optional(),
    /** Asset symbol filter, e.g. "USDT" | "TON" | "TRX". */
    symbol: z
      .string()
      .trim()
      .max(16)
      .regex(/^[A-Za-z0-9]+$/)
      .optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    search: searchTermSchema,
  })
  .strict();
export type TransactionFilter = z.infer<typeof transactionFilterSchema>;

/* ------------------------------------------------------------------ send -- */

export const sendQuoteRequestSchema = z
  .object({
    walletId: uuidSchema,
    assetId: uuidSchema,
    toAddress: rawAddressSchema,
    amount: decimalAmountSchema,
    memo: memoSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type SendQuoteRequest = z.infer<typeof sendQuoteRequestSchema>;

export const sendConfirmRequestSchema = z
  .object({
    sendRequestId: uuidSchema,
    /** Must match the quote the user actually saw — guards against a swapped confirmation. */
    quoteFingerprint: z.string().min(16).max(128),
    pin: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export type SendConfirmRequest = z.infer<typeof sendConfirmRequestSchema>;

/* ---------------------------------------------------- scheduled payments -- */

export const createScheduledPaymentRequestSchema = z
  .object({
    walletId: uuidSchema,
    assetId: uuidSchema,
    toAddress: rawAddressSchema,
    amount: decimalAmountSchema,
    memo: memoSchema,
    scheduledAt: isoDateTimeSchema,
    title: titleSchema.optional(),
    notes: notesSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type CreateScheduledPaymentRequest = z.infer<typeof createScheduledPaymentRequestSchema>;

export const updateScheduledPaymentRequestSchema = z
  .object({
    amount: decimalAmountSchema.optional(),
    toAddress: rawAddressSchema.optional(),
    memo: memoSchema,
    scheduledAt: isoDateTimeSchema.optional(),
    title: titleSchema.optional(),
    notes: notesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/* ------------------------------------------------------- expected income -- */

export const createExpectedIncomeRequestSchema = z
  .object({
    name: nameSchema,
    reason: descriptionSchema.optional(),
    amount: decimalAmountSchema,
    currency: fiatCurrencySchema,
    expectedDate: isoDateSchema,
    remindAt: isoDateTimeSchema.optional(),
    categoryId: uuidSchema.nullish(),
    notes: notesSchema.optional(),
  })
  .strict();
export type CreateExpectedIncomeRequest = z.infer<typeof createExpectedIncomeRequestSchema>;

export const updateExpectedIncomeRequestSchema = z
  .object({
    name: nameSchema.optional(),
    reason: descriptionSchema.optional(),
    amount: decimalAmountSchema.optional(),
    currency: fiatCurrencySchema.optional(),
    expectedDate: isoDateSchema.optional(),
    remindAt: isoDateTimeSchema.nullish(),
    notes: notesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const expectedIncomeStatusRequestSchema = z
  .object({
    status: z.enum(EXPECTED_INCOME_STATUSES),
    /** When marking `received`, optionally create the matching ledger entry. */
    createTransaction: z.boolean().default(true),
    cashAccountId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

/* ------------------------------------------------------------ categories -- */

export const createCategoryRequestSchema = z
  .object({
    name: nameSchema,
    kind: z.enum(CATEGORY_KINDS).default('both'),
    icon: z
      .string()
      .trim()
      .max(32)
      .regex(/^[a-z0-9-]+$/, 'Icon must be a known icon key')
      .optional(),
    color: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value')
      .optional(),
  })
  .strict();

export const updateCategoryRequestSchema = createCategoryRequestSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/* ----------------------------------------------------------------- goals -- */

export const createGoalRequestSchema = z
  .object({
    name: nameSchema,
    targetAmount: decimalAmountSchema,
    currency: fiatCurrencySchema,
    currentAmount: decimalAmountSchema.optional(),
    deadline: isoDateSchema.optional(),
    icon: z
      .string()
      .trim()
      .max(32)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    color: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    notes: notesSchema.optional(),
  })
  .strict();

export const updateGoalRequestSchema = z
  .object({
    name: nameSchema.optional(),
    targetAmount: decimalAmountSchema.optional(),
    currentAmount: decimalAmountSchema.optional(),
    deadline: isoDateSchema.nullish(),
    status: z.enum(['active', 'achieved', 'archived']).optional(),
    notes: notesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const contributeGoalRequestSchema = z
  .object({
    amount: decimalAmountSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

/* -------------------------------------------------------------- settings -- */

export const updateSettingsRequestSchema = z
  .object({
    locale: localeSchema.optional(),
    themePreference: themePreferenceSchema.optional(),
    primaryFiat: fiatCurrencySchema.optional(),
    reportingFiat: fiatCurrencySchema.optional(),
    fxMode: z.enum(FX_MODES).optional(),
    /** Only meaningful when fxMode === 'manual'. */
    manualUsdIls: z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,8})?$/)
      .optional(),
    timezone: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/, 'Invalid IANA timezone')
      .optional(),
    hideBalances: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

export const updateNotificationPreferencesSchema = z
  .object({
    types: z.record(z.enum(NOTIFICATION_TYPES), z.boolean()).optional(),
    quietHoursStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullish(),
    quietHoursEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullish(),
    minCryptoValueUsd: z
      .string()
      .trim()
      .regex(/^\d{1,9}(\.\d{1,2})?$/)
      .optional(),
    fxAlertThresholdPercent: z
      .string()
      .trim()
      .regex(/^\d{1,2}(\.\d{1,2})?$/)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/* ------------------------------------------------------------ cash accts -- */

export const createCashAccountRequestSchema = z
  .object({
    name: nameSchema,
    currency: fiatCurrencySchema,
    openingBalance: signedDecimalAmountSchema.default('0'),
    isDefault: z.boolean().default(false),
  })
  .strict();

/* ------------------------------------------------------------- analytics -- */

export const analyticsQuerySchema = z
  .object({
    period: z.enum(['week', 'month', 'quarter', 'year']).default('month'),
    currency: fiatCurrencySchema.optional(),
  })
  .strict();
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/* ----------------------------------------------------------------- admin -- */

export const adminToggleSendingSchema = z
  .object({
    enabled: z.boolean(),
    reason: descriptionSchema,
  })
  .strict();

export const adminRescanSchema = z
  .object({
    walletId: uuidSchema,
    /** Rewind the scan cursor and re-read history. Idempotent by design. */
    fromScratch: z.boolean().default(false),
  })
  .strict();

export const adminSetFxRateSchema = z
  .object({
    base: fiatCurrencySchema,
    quote: fiatCurrencySchema,
    rate: z
      .string()
      .trim()
      .regex(/^\d{1,6}(\.\d{1,10})?$/),
    reason: descriptionSchema,
  })
  .strict()
  .refine((value) => value.base !== value.quote, { message: 'base and quote must differ' });
