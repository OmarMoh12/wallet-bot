/**
 * The application's complete error vocabulary.
 *
 * Every failure that can reach a client is one of these codes. Clients switch on the code;
 * the human-readable text comes from the i18n catalogue, so errors are localized and no
 * internal detail (stack traces, SQL, provider payloads) ever crosses the boundary.
 */
export const ERROR_CODES = [
  // --- auth / session -------------------------------------------------------
  'UNAUTHORIZED',
  'FORBIDDEN',
  'SESSION_EXPIRED',
  'INVALID_INIT_DATA',
  'INIT_DATA_EXPIRED',
  'INIT_DATA_REPLAYED',
  'PIN_REQUIRED',
  'PIN_INVALID',
  'PIN_LOCKED',
  'PIN_NOT_SET',
  'ADMIN_REQUIRED',

  // --- request validation ---------------------------------------------------
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'INVALID_STATE_TRANSITION',

  // --- domain: wallets & chain ---------------------------------------------
  'WALLET_NOT_FOUND',
  'WALLET_INACTIVE',
  'WALLET_ALREADY_EXISTS',
  'INVALID_ADDRESS',
  'ADDRESS_NETWORK_MISMATCH',
  'ASSET_NOT_FOUND',
  'ASSET_NOT_SUPPORTED',
  'NETWORK_UNAVAILABLE',
  'PROVIDER_ERROR',
  'CHAIN_ID_MISMATCH',
  'TRANSACTION_NOT_FOUND',
  'DUPLICATE_TRANSACTION',

  // --- domain: money --------------------------------------------------------
  'INSUFFICIENT_BALANCE',
  'AMOUNT_TOO_SMALL',
  'AMOUNT_TOO_LARGE',
  'CURRENCY_MISMATCH',
  'EXCHANGE_RATE_UNAVAILABLE',
  'EXCHANGE_RATE_STALE',
  'PRICE_UNAVAILABLE',
  'CASH_ACCOUNT_NOT_FOUND',
  // EVM chains charge gas in the native coin, separately from the asset being sent, so
  // "enough USDT but no BNB" is a distinct failure with a completely different remedy.
  'INSUFFICIENT_GAS',
  'GAS_ESTIMATION_FAILED',

  // --- domain: sending ------------------------------------------------------
  'SENDING_DISABLED',
  'SEND_LIMIT_EXCEEDED',
  'SEND_DAILY_LIMIT_EXCEEDED',
  'SEND_QUOTE_EXPIRED',
  'SEND_ALREADY_CONFIRMED',
  'SIGNER_UNAVAILABLE',
  'SIGNER_REJECTED',
  'SELF_TRANSFER_NOT_ALLOWED',
  'WATCH_ONLY_WALLET',
  'KEY_GENERATION_FAILED',

  // --- domain: scheduling ---------------------------------------------------
  'SCHEDULED_PAYMENT_NOT_FOUND',
  'SCHEDULE_IN_PAST',
  'SCHEDULE_NOT_CANCELLABLE',
  'EXPECTED_INCOME_NOT_FOUND',
  'GOAL_NOT_FOUND',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_IN_USE',

  // --- infrastructure -------------------------------------------------------
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'FEATURE_DISABLED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Readonly<Partial<Record<ErrorCode, number>>> = {
  UNAUTHORIZED: 401,
  SESSION_EXPIRED: 401,
  INVALID_INIT_DATA: 401,
  INIT_DATA_EXPIRED: 401,
  INIT_DATA_REPLAYED: 401,
  PIN_REQUIRED: 401,
  PIN_INVALID: 401,
  PIN_LOCKED: 423,
  PIN_NOT_SET: 409,
  FORBIDDEN: 403,
  ADMIN_REQUIRED: 403,
  WATCH_ONLY_WALLET: 403,
  SENDING_DISABLED: 403,
  FEATURE_DISABLED: 403,
  VALIDATION_ERROR: 400,
  INVALID_ADDRESS: 400,
  ADDRESS_NETWORK_MISMATCH: 400,
  AMOUNT_TOO_SMALL: 400,
  AMOUNT_TOO_LARGE: 400,
  CURRENCY_MISMATCH: 400,
  SCHEDULE_IN_PAST: 400,
  SELF_TRANSFER_NOT_ALLOWED: 400,
  NOT_FOUND: 404,
  WALLET_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  CASH_ACCOUNT_NOT_FOUND: 404,
  SCHEDULED_PAYMENT_NOT_FOUND: 404,
  EXPECTED_INCOME_NOT_FOUND: 404,
  GOAL_NOT_FOUND: 404,
  CATEGORY_NOT_FOUND: 404,
  CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  DUPLICATE_TRANSACTION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_STATE_TRANSITION: 409,
  SEND_ALREADY_CONFIRMED: 409,
  SCHEDULE_NOT_CANCELLABLE: 409,
  CATEGORY_IN_USE: 409,
  INSUFFICIENT_BALANCE: 422,
  INSUFFICIENT_GAS: 422,
  GAS_ESTIMATION_FAILED: 502,
  CHAIN_ID_MISMATCH: 400,
  KEY_GENERATION_FAILED: 500,
  SEND_LIMIT_EXCEEDED: 422,
  SEND_DAILY_LIMIT_EXCEEDED: 422,
  SEND_QUOTE_EXPIRED: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  NETWORK_UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
  SIGNER_UNAVAILABLE: 503,
  SIGNER_REJECTED: 502,
  SERVICE_UNAVAILABLE: 503,
  EXCHANGE_RATE_UNAVAILABLE: 503,
  EXCHANGE_RATE_STALE: 503,
  PRICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function httpStatusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Extra, non-sensitive context safe to serialise to the client. */
export type ErrorDetails = Record<string, string | number | boolean | null | string[]>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;
  /** Message intended for operators only. Never serialised to a client. */
  readonly internal?: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    options: {
      message?: string;
      details?: ErrorDetails;
      internal?: string;
      cause?: unknown;
      retryable?: boolean;
      status?: number;
    } = {},
  ) {
    super(options.message ?? code, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? httpStatusForCode(code);
    if (options.details) this.details = options.details;
    if (options.internal) this.internal = options.internal;
    this.retryable = options.retryable ?? this.status >= 500;
  }

  static is(error: unknown): error is AppError {
    return error instanceof AppError;
  }

  /** The client-facing shape. Deliberately narrow. */
  toWire(requestId?: string): {
    error: { code: ErrorCode; details?: ErrorDetails; requestId?: string };
  } {
    return {
      error: {
        code: this.code,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

/** Convenience constructors for the codes used most often. */
export const errors = {
  unauthorized: (internal?: string) => new AppError('UNAUTHORIZED', { internal }),
  forbidden: (internal?: string) => new AppError('FORBIDDEN', { internal }),
  notFound: (code: ErrorCode = 'NOT_FOUND', details?: ErrorDetails) =>
    new AppError(code, { details }),
  validation: (details?: ErrorDetails) => new AppError('VALIDATION_ERROR', { details }),
  conflict: (code: ErrorCode = 'CONFLICT', details?: ErrorDetails) =>
    new AppError(code, { details }),
  internal: (internal?: string, cause?: unknown) =>
    new AppError('INTERNAL_ERROR', { internal, cause }),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError('RATE_LIMITED', { details: { retryAfterSeconds } }),
} as const;

/** Normalise any thrown value into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError {
  if (AppError.is(error)) return error;
  if (error instanceof Error) {
    return new AppError('INTERNAL_ERROR', { internal: error.message, cause: error });
  }
  return new AppError('INTERNAL_ERROR', { internal: `Non-error thrown: ${String(error)}` });
}
