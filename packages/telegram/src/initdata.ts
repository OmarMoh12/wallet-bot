import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@wallet/shared';

/**
 * Telegram Mini App `initData` verification.
 *
 * This is the only thing standing between "a Telegram user" and "anyone with curl", so it
 * is written to be readable and auditable rather than clever.
 *
 * Telegram's algorithm:
 *   1. Parse `initData` as a query string.
 *   2. Remove the `hash` field; sort the rest by key.
 *   3. Build `key=value` lines joined by `\n` — the *data-check-string*.
 *   4. `secret = HMAC_SHA256(key = "WebAppData", message = bot_token)`
 *   5. `expected = HMAC_SHA256(key = secret, message = data_check_string)`
 *   6. Compare with the received `hash` in constant time.
 *
 * On top of that we enforce:
 *   * `auth_date` freshness (bounded replay window),
 *   * rejection of a future-dated `auth_date` beyond small clock skew,
 *   * size limits before any parsing, and
 *   * a strict Zod schema on the embedded `user` JSON.
 *
 * Replay protection across requests (one initData → one session) is enforced separately by
 * recording the hash in `processed_events`; see `packages/core/src/auth`.
 */

/** Maximum accepted initData length. Telegram's real payloads are well under 2 KB. */
const MAX_INIT_DATA_LENGTH = 4096;
/** Tolerance for a client clock running ahead of ours. */
const FUTURE_SKEW_SECONDS = 60;

export const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().max(128).default(''),
  last_name: z.string().max(128).optional(),
  username: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_]*$/)
    .optional(),
  language_code: z.string().max(16).optional(),
  is_premium: z.boolean().optional(),
  allows_write_to_pm: z.boolean().optional(),
  photo_url: z.string().url().max(512).optional(),
});

export type TelegramUser = z.infer<typeof telegramUserSchema>;

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: Date;
  /** The `hash` field, used as the replay-protection key. */
  hash: string;
  queryId: string | null;
  /** `startapp` payload, used for deep links into a specific screen. */
  startParam: string | null;
  chatType: string | null;
  chatInstance: string | null;
}

export interface VerifyOptions {
  botToken: string;
  maxAgeSeconds: number;
  now?: Date;
}

function constantTimeEquals(a: string, b: string): boolean {
  // Compare digests of both inputs so the comparison is length-independent, and use
  // timingSafeEqual so a byte-wise early exit cannot leak the expected hash.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function buildDataCheckString(params: URLSearchParams, exclude: string[]): string {
  const entries: string[] = [];
  for (const [key, value] of params.entries()) {
    if (exclude.includes(key)) continue;
    entries.push(`${key}=${value}`);
  }
  entries.sort();
  return entries.join('\n');
}

function computeHash(botToken: string, dataCheckString: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

/**
 * Verify `initData` and return the authenticated user.
 *
 * Throws `AppError` with a precise code on every failure path — the caller maps that onto a
 * generic client message so an attacker learns nothing about *why* verification failed.
 */
export function verifyInitData(initData: string, options: VerifyOptions): VerifiedInitData {
  if (!options.botToken) {
    throw new AppError('INTERNAL_ERROR', { internal: 'verifyInitData called without a bot token' });
  }
  if (typeof initData !== 'string' || initData.length === 0) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'empty initData' });
  }
  if (initData.length > MAX_INIT_DATA_LENGTH) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'initData exceeds size limit' });
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    throw new AppError('INVALID_INIT_DATA', { internal: 'initData is not a valid query string' });
  }

  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'missing or malformed hash' });
  }

  // Telegram now also sends a `signature` field for third-party (Ed25519) validation. Its
  // participation in the bot-token check-string has varied across client versions, so we
  // accept a match under either construction. Both are constant-time comparisons against a
  // locally computed value; neither weakens the check.
  const candidates = [
    buildDataCheckString(params, ['hash']),
    buildDataCheckString(params, ['hash', 'signature']),
  ];

  const matched = candidates.some((dataCheckString) =>
    constantTimeEquals(computeHash(options.botToken, dataCheckString), receivedHash.toLowerCase()),
  );

  if (!matched) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'hash mismatch' });
  }

  // --- freshness -------------------------------------------------------------
  const authDateRaw = params.get('auth_date');
  if (!authDateRaw || !/^\d{1,12}$/.test(authDateRaw)) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'missing or malformed auth_date' });
  }
  const authDate = new Date(Number.parseInt(authDateRaw, 10) * 1000);
  const now = options.now ?? new Date();
  const ageSeconds = (now.getTime() - authDate.getTime()) / 1000;

  if (ageSeconds > options.maxAgeSeconds) {
    throw new AppError('INIT_DATA_EXPIRED', {
      internal: `initData is ${Math.round(ageSeconds)}s old (max ${options.maxAgeSeconds}s)`,
    });
  }
  if (ageSeconds < -FUTURE_SKEW_SECONDS) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'auth_date is in the future' });
  }

  // --- user ------------------------------------------------------------------
  const userRaw = params.get('user');
  if (!userRaw) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'initData has no user field' });
  }

  let userJson: unknown;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    throw new AppError('INVALID_INIT_DATA', { internal: 'user field is not valid JSON' });
  }

  const parsed = telegramUserSchema.safeParse(userJson);
  if (!parsed.success) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'user field failed schema validation' });
  }
  if (parsed.data.is_bot) {
    throw new AppError('INVALID_INIT_DATA', { internal: 'bot accounts cannot authenticate' });
  }

  return {
    user: parsed.data,
    authDate,
    hash: receivedHash.toLowerCase(),
    queryId: params.get('query_id'),
    startParam: sanitizeStartParam(params.get('start_param')),
    chatType: params.get('chat_type'),
    chatInstance: params.get('chat_instance'),
  };
}

/**
 * `start_param` is attacker-controllable (anyone can craft a `?startapp=` link and send it
 * to the user), so it is constrained to a conservative character set before being used for
 * routing. It is never interpolated into SQL or HTML.
 */
export function sanitizeStartParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header on a webhook request.
 * Constant-time, and refuses to pass when no secret is configured.
 */
export function verifyWebhookSecret(received: string | null, expected: string): boolean {
  if (!expected || !received) return false;
  return constantTimeEquals(received, expected);
}

/** Non-reversible identifier for a bot token, safe to log. */
export function botTokenFingerprint(botToken: string): string {
  return createHash('sha256').update(botToken).digest('hex').slice(0, 12);
}
