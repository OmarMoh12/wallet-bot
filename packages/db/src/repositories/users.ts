import type { Locale, ThemePreference } from '@wallet/shared';
import type { Queryable } from '../client.js';
import type { FiatCode, NotificationPreferencesRow, UserRow, UserSettingsRow } from '../types.js';

export interface TelegramProfile {
  telegramId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  photoUrl: string | null;
  languageCode: string | null;
}

export interface UpsertUserResult {
  user: UserRow;
  created: boolean;
}

/**
 * Create or refresh the user behind a verified Telegram profile.
 *
 * Runs in an unbound (system) transaction because it executes *before* an identity exists.
 * The gate protecting it is initData signature verification, not RLS — see docs/security.md.
 */
export async function upsertTelegramUser(
  sql: Queryable,
  profile: TelegramProfile,
  options: { makeAdmin: boolean },
): Promise<UpsertUserResult> {
  const rows = await sql<Array<UserRow & { was_inserted: boolean }>>`
    INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, language_code, is_admin, last_seen_at)
    VALUES (
      ${profile.telegramId.toString()},
      ${profile.username},
      ${profile.firstName},
      ${profile.lastName},
      ${profile.photoUrl},
      ${profile.languageCode},
      ${options.makeAdmin},
      now()
    )
    ON CONFLICT (telegram_id) DO UPDATE SET
      username      = EXCLUDED.username,
      first_name    = EXCLUDED.first_name,
      last_name     = EXCLUDED.last_name,
      photo_url     = EXCLUDED.photo_url,
      language_code = COALESCE(EXCLUDED.language_code, users.language_code),
      -- Admin status is only ever GRANTED here, never revoked, and only for ids listed in
      -- TELEGRAM_ADMIN_IDS. Removing an admin is a deliberate, audited operation.
      is_admin      = users.is_admin OR ${options.makeAdmin},
      last_seen_at  = now(),
      updated_at    = now()
    RETURNING *, (xmax = 0) AS was_inserted
  `;

  const row = rows[0];
  if (!row) throw new Error('upsertTelegramUser: no row returned');
  const { was_inserted: created, ...user } = row;
  return { user: user as UserRow, created };
}

export async function findUserById(sql: Queryable, userId: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT * FROM users WHERE id = ${userId} AND deleted_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findUserByTelegramId(
  sql: Queryable,
  telegramId: bigint,
): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT * FROM users WHERE telegram_id = ${telegramId.toString()} AND deleted_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function touchLastSeen(sql: Queryable, userId: string): Promise<void> {
  await sql`UPDATE users SET last_seen_at = now() WHERE id = ${userId}`;
}

/* ------------------------------------------------------------------ settings -- */

export interface EnsureSettingsInput {
  userId: string;
  locale: Locale;
  timezone?: string;
}

/** Create the settings + notification-preference rows if they do not exist yet. */
export async function ensureUserSettings(
  sql: Queryable,
  input: EnsureSettingsInput,
): Promise<UserSettingsRow> {
  const rows = await sql<UserSettingsRow[]>`
    INSERT INTO user_settings (user_id, locale, timezone)
    VALUES (${input.userId}, ${input.locale}, ${input.timezone ?? 'UTC'})
    ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
    RETURNING *
  `;

  await sql`
    INSERT INTO notification_preferences (user_id)
    VALUES (${input.userId})
    ON CONFLICT (user_id) DO NOTHING
  `;

  const row = rows[0];
  if (!row) throw new Error('ensureUserSettings: no row returned');
  return row;
}

export async function getUserSettings(
  sql: Queryable,
  userId: string,
): Promise<UserSettingsRow | null> {
  const rows = await sql<UserSettingsRow[]>`
    SELECT * FROM user_settings WHERE user_id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface UpdateSettingsInput {
  locale?: Locale;
  themePreference?: ThemePreference;
  primaryFiat?: FiatCode;
  reportingFiat?: FiatCode;
  fxMode?: 'auto' | 'manual';
  manualUsdIls?: string | null;
  timezone?: string;
  hideBalances?: boolean;
}

/**
 * Update settings.
 *
 * Every column is named explicitly. There is no "spread the request body into the UPDATE"
 * path anywhere in this repository layer — that is the mass-assignment defence, and it is
 * why `pin_hash` cannot be reached from a settings request no matter what the body contains.
 */
export async function updateUserSettings(
  sql: Queryable,
  userId: string,
  input: UpdateSettingsInput,
): Promise<UserSettingsRow | null> {
  const rows = await sql<UserSettingsRow[]>`
    UPDATE user_settings SET
      locale           = COALESCE(${input.locale ?? null}, locale),
      theme_preference = COALESCE(${input.themePreference ?? null}, theme_preference),
      primary_fiat     = COALESCE(${input.primaryFiat ?? null}, primary_fiat),
      reporting_fiat   = COALESCE(${input.reportingFiat ?? null}, reporting_fiat),
      fx_mode          = COALESCE(${input.fxMode ?? null}, fx_mode),
      manual_usd_ils   = CASE
                           WHEN ${input.manualUsdIls === null} THEN NULL
                           ELSE COALESCE(${input.manualUsdIls ?? null}::numeric, manual_usd_ils)
                         END,
      timezone         = COALESCE(${input.timezone ?? null}, timezone),
      hide_balances    = COALESCE(${input.hideBalances ?? null}, hide_balances),
      updated_at       = now()
    WHERE user_id = ${userId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/* ----------------------------------------------------------------------- PIN -- */

export async function setPinCredentials(
  sql: Queryable,
  userId: string,
  credentials: { hash: string; salt: string },
): Promise<void> {
  await sql`
    UPDATE user_settings SET
      pin_hash         = ${credentials.hash},
      pin_salt         = ${credentials.salt},
      pin_set_at       = now(),
      pin_failed_count = 0,
      pin_locked_until = NULL,
      updated_at       = now()
    WHERE user_id = ${userId}
  `;
}

/** Record a failed PIN attempt and lock the account once the threshold is reached. */
export async function recordPinFailure(
  sql: Queryable,
  userId: string,
  options: { maxAttempts: number; lockSeconds: number },
): Promise<{ failedCount: number; lockedUntil: Date | null }> {
  const rows = await sql<Array<{ pin_failed_count: number; pin_locked_until: Date | null }>>`
    UPDATE user_settings SET
      pin_failed_count = pin_failed_count + 1,
      pin_locked_until = CASE
        WHEN pin_failed_count + 1 >= ${options.maxAttempts}
          THEN now() + make_interval(secs => ${options.lockSeconds})
        ELSE pin_locked_until
      END,
      updated_at = now()
    WHERE user_id = ${userId}
    RETURNING pin_failed_count, pin_locked_until
  `;
  const row = rows[0];
  return {
    failedCount: row?.pin_failed_count ?? 0,
    lockedUntil: row?.pin_locked_until ?? null,
  };
}

export async function clearPinFailures(sql: Queryable, userId: string): Promise<void> {
  await sql`
    UPDATE user_settings
    SET pin_failed_count = 0, pin_locked_until = NULL, updated_at = now()
    WHERE user_id = ${userId}
  `;
}

/* ------------------------------------------------- notification preferences -- */

export async function getNotificationPreferences(
  sql: Queryable,
  userId: string,
): Promise<NotificationPreferencesRow | null> {
  const rows = await sql<NotificationPreferencesRow[]>`
    SELECT * FROM notification_preferences WHERE user_id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface UpdateNotificationPreferencesInput {
  enabledTypes?: Record<string, boolean>;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  minCryptoValueUsdMinor?: bigint;
  fxAlertThresholdBps?: number;
}

export async function updateNotificationPreferences(
  sql: Queryable,
  userId: string,
  input: UpdateNotificationPreferencesInput,
): Promise<NotificationPreferencesRow | null> {
  const rows = await sql<NotificationPreferencesRow[]>`
    UPDATE notification_preferences SET
      enabled_types = CASE
        WHEN ${input.enabledTypes ? JSON.stringify(input.enabledTypes) : null}::jsonb IS NULL
          THEN enabled_types
        ELSE enabled_types || ${input.enabledTypes ? JSON.stringify(input.enabledTypes) : '{}'}::jsonb
      END,
      quiet_hours_start = CASE
        WHEN ${input.quietHoursStart === null} THEN NULL
        ELSE COALESCE(${input.quietHoursStart ?? null}::time, quiet_hours_start)
      END,
      quiet_hours_end = CASE
        WHEN ${input.quietHoursEnd === null} THEN NULL
        ELSE COALESCE(${input.quietHoursEnd ?? null}::time, quiet_hours_end)
      END,
      min_crypto_value_usd_minor =
        COALESCE(${input.minCryptoValueUsdMinor?.toString() ?? null}::bigint, min_crypto_value_usd_minor),
      fx_alert_threshold_bps =
        COALESCE(${input.fxAlertThresholdBps ?? null}::integer, fx_alert_threshold_bps),
      updated_at = now()
    WHERE user_id = ${userId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------- admin -- */

export async function listUsers(
  sql: Queryable,
  options: { limit: number; offset: number },
): Promise<UserRow[]> {
  const rows = await sql<UserRow[]>`
    SELECT * FROM users
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${options.limit} OFFSET ${options.offset}
  `;
  return [...rows];
}

export async function setUserActive(
  sql: Queryable,
  userId: string,
  isActive: boolean,
): Promise<void> {
  await sql`UPDATE users SET is_active = ${isActive}, updated_at = now() WHERE id = ${userId}`;
}
