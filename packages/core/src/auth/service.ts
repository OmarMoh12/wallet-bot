import {
  AppError,
  DEFAULT_LOCALE,
  addSeconds,
  isLocale,
  resolveLocaleFromTelegram,
  type Locale,
} from '@wallet/shared';
import { opsRepo, sessionsRepo, usersRepo, withSystem, withUser, type Sql } from '@wallet/db';
import type { UserRow, UserSettingsRow } from '@wallet/db';
import { verifyInitData, type VerifiedInitData } from '@wallet/telegram';
import type { ServerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import {
  hashIp,
  hashSessionToken,
  hashPin,
  issueSessionToken,
  looksLikeSessionToken,
  verifyPin,
} from './tokens.js';

/**
 * Authentication.
 *
 * The whole model in one paragraph: the client sends Telegram's signed `initData`; the
 * server verifies the signature with the bot token, refuses anything stale or previously
 * seen, and issues a short-lived opaque session token. The client holds that token in
 * memory only and sends it as a bearer header. No cookie carries authority, so cross-site
 * requests cannot act on the user's behalf and CSRF does not apply to this API.
 *
 * Nothing here ever trusts a user id supplied by the client.
 */

/** PIN lockout policy. */
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_SECONDS = 15 * 60;

/** How long an initData hash is remembered for replay protection. */
const INIT_DATA_REPLAY_TTL_SECONDS = 24 * 60 * 60;

export interface AuthenticatedActor {
  userId: string;
  telegramId: bigint;
  isAdmin: boolean;
  sessionId: string;
  locale: Locale;
}

export interface AuthenticateResult {
  token: string;
  expiresAt: Date;
  user: UserRow;
  settings: UserSettingsRow;
  created: boolean;
  startParam: string | null;
}

export interface AuthenticateOptions {
  initData: string;
  localeHint?: Locale;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export class AuthService {
  constructor(private readonly deps: { sql: Sql; config: ServerConfig; logger: Logger }) {}

  /**
   * Exchange verified `initData` for a session.
   *
   * Order matters: signature first (cheapest way to reject a forgery), then freshness, then
   * replay, then any database write. An attacker with an invalid payload never causes a
   * write.
   */
  async authenticateWithTelegram(options: AuthenticateOptions): Promise<AuthenticateResult> {
    const { config, sql, logger } = this.deps;

    if (!config.telegram.botToken) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        internal: 'authentication attempted without TELEGRAM_BOT_TOKEN configured',
      });
    }

    let verified: VerifiedInitData;
    try {
      verified = verifyInitData(options.initData, {
        botToken: config.telegram.botToken,
        maxAgeSeconds: config.telegram.initDataMaxAgeSeconds,
      });
    } catch (error) {
      logger.warn('initData verification failed', {
        requestId: options.requestId,
        operation: 'auth.telegram',
        reason: AppError.is(error) ? error.code : 'unknown',
      });
      throw error;
    }

    // Replay protection: one initData payload may mint at most one session. The claim is a
    // unique-index insert, so two concurrent requests cannot both win.
    const claimed = await withSystem(sql, (tx) =>
      opsRepo.claimEvent(tx, {
        scope: 'initdata',
        key: verified.hash,
        ttlSeconds: INIT_DATA_REPLAY_TTL_SECONDS,
      }),
    );
    if (!claimed) {
      throw new AppError('INIT_DATA_REPLAYED', {
        internal: `initData hash ${verified.hash.slice(0, 8)}… was already exchanged`,
      });
    }

    const telegramId = BigInt(verified.user.id);
    const isAdminById = config.telegram.adminTelegramIds.includes(telegramId);

    const locale: Locale =
      options.localeHint && isLocale(options.localeHint)
        ? options.localeHint
        : (resolveLocaleFromTelegram(verified.user.language_code) ?? DEFAULT_LOCALE);

    // User creation runs unbound: there is no identity to bind to yet.
    const { user, created } = await withSystem(sql, async (tx) => {
      const result = await usersRepo.upsertTelegramUser(
        tx,
        {
          telegramId,
          username: verified.user.username ?? null,
          firstName: verified.user.first_name,
          lastName: verified.user.last_name ?? null,
          photoUrl: verified.user.photo_url ?? null,
          languageCode: verified.user.language_code ?? null,
        },
        { makeAdmin: isAdminById },
      );
      await usersRepo.ensureUserSettings(tx, { userId: result.user.id, locale });
      return result;
    });

    if (!user.is_active) {
      throw new AppError('FORBIDDEN', { internal: 'account is deactivated' });
    }

    const { token, tokenHash } = issueSessionToken(config.security.sessionSecret);
    const expiresAt = addSeconds(new Date(), config.security.sessionTtlSeconds);

    const settings = await withUser(
      sql,
      { userId: user.id, isAdmin: user.is_admin },
      async (tx) => {
        await sessionsRepo.createSession(tx, {
          userId: user.id,
          tokenHash,
          expiresAt,
          ipHash: hashIp(config.security.sessionSecret, options.ip),
          userAgent: options.userAgent?.slice(0, 512) ?? null,
        });

        await opsRepo.writeAudit(tx, {
          userId: user.id,
          actorType: 'user',
          action: 'auth.login',
          entityType: 'session',
          ipHash: hashIp(config.security.sessionSecret, options.ip),
          userAgent: options.userAgent?.slice(0, 512) ?? null,
          requestId: options.requestId,
          metadata: { created, telegramId: telegramId.toString() },
        });

        const row = await usersRepo.getUserSettings(tx, user.id);
        if (!row)
          throw new AppError('INTERNAL_ERROR', { internal: 'settings row missing after upsert' });
        return row;
      },
    );

    logger.info('user authenticated', {
      requestId: options.requestId,
      operation: 'auth.telegram',
      userId: user.id,
      created,
    });

    return { token, expiresAt, user, settings, created, startParam: verified.startParam };
  }

  /**
   * Resolve a bearer token to an actor.
   *
   * Runs unbound because this query establishes identity. Everything after it is bound and
   * therefore RLS-constrained.
   */
  async resolveSession(token: string): Promise<AuthenticatedActor | null> {
    if (!looksLikeSessionToken(token)) return null;

    const tokenHash = hashSessionToken(this.deps.config.security.sessionSecret, token);
    const resolved = await withSystem(this.deps.sql, (tx) =>
      sessionsRepo.resolveSession(tx, tokenHash),
    );
    if (!resolved) return null;

    const settings = await withUser(
      this.deps.sql,
      { userId: resolved.user.id, isAdmin: resolved.user.is_admin },
      async (tx) => {
        await sessionsRepo.touchSession(tx, resolved.session.id);
        return usersRepo.getUserSettings(tx, resolved.user.id);
      },
    );

    return {
      userId: resolved.user.id,
      telegramId: BigInt(resolved.user.telegram_id),
      isAdmin: resolved.user.is_admin,
      sessionId: resolved.session.id,
      locale: isLocale(settings?.locale) ? settings.locale : DEFAULT_LOCALE,
    };
  }

  async revokeSession(actor: AuthenticatedActor, requestId: string): Promise<void> {
    await withUser(this.deps.sql, { userId: actor.userId, isAdmin: actor.isAdmin }, async (tx) => {
      await sessionsRepo.revokeSession(tx, actor.sessionId);
      await opsRepo.writeAudit(tx, {
        userId: actor.userId,
        actorType: 'user',
        action: 'auth.session_revoked',
        entityType: 'session',
        entityId: actor.sessionId,
        requestId,
      });
    });
  }

  /* ------------------------------------------------------------------ PIN -- */

  async setPin(
    actor: AuthenticatedActor,
    params: { pin: string; currentPin?: string; requestId: string },
  ): Promise<void> {
    const { sql, config } = this.deps;

    await withUser(sql, { userId: actor.userId, isAdmin: actor.isAdmin }, async (tx) => {
      const settings = await usersRepo.getUserSettings(tx, actor.userId);
      if (!settings) throw new AppError('NOT_FOUND');

      // Changing an existing PIN requires the old one.
      if (settings.pin_hash) {
        if (!params.currentPin) throw new AppError('PIN_REQUIRED');
        const ok = await verifyPin(
          params.currentPin,
          { hash: settings.pin_hash, salt: settings.pin_salt ?? '' },
          config.security.pinPepper,
        );
        if (!ok) throw new AppError('PIN_INVALID');
      }

      const credentials = await hashPin(params.pin, config.security.pinPepper);
      await usersRepo.setPinCredentials(tx, actor.userId, credentials);

      // A PIN change invalidates other sessions: if it was changed under duress or after a
      // token leak, the old sessions must not survive it.
      await sessionsRepo.revokeAllSessions(tx, actor.userId, { exceptSessionId: actor.sessionId });

      await opsRepo.writeAudit(tx, {
        userId: actor.userId,
        actorType: 'user',
        action: 'auth.pin_set',
        entityType: 'user_settings',
        entityId: actor.userId,
        requestId: params.requestId,
        metadata: { changed: Boolean(settings.pin_hash) },
      });
    });
  }

  /**
   * Verify a PIN for a sensitive action.
   *
   * Failures increment a counter and lock the account for `PIN_LOCK_SECONDS` once the
   * threshold is hit, which is what makes a six-digit secret defensible.
   */
  async requirePin(
    actor: AuthenticatedActor,
    pin: string | undefined,
    requestId: string,
  ): Promise<void> {
    const { sql, config } = this.deps;

    await withUser(sql, { userId: actor.userId, isAdmin: actor.isAdmin }, async (tx) => {
      const settings = await usersRepo.getUserSettings(tx, actor.userId);
      if (!settings) throw new AppError('NOT_FOUND');
      if (!settings.pin_hash || !settings.pin_salt) throw new AppError('PIN_NOT_SET');

      if (settings.pin_locked_until && settings.pin_locked_until > new Date()) {
        throw new AppError('PIN_LOCKED', {
          details: {
            retryAfterSeconds: Math.ceil((settings.pin_locked_until.getTime() - Date.now()) / 1000),
          },
        });
      }

      if (!pin) throw new AppError('PIN_REQUIRED');

      const ok = await verifyPin(
        pin,
        { hash: settings.pin_hash, salt: settings.pin_salt },
        config.security.pinPepper,
      );

      if (!ok) {
        const failure = await usersRepo.recordPinFailure(tx, actor.userId, {
          maxAttempts: PIN_MAX_ATTEMPTS,
          lockSeconds: PIN_LOCK_SECONDS,
        });
        await opsRepo.writeAudit(tx, {
          userId: actor.userId,
          actorType: 'user',
          action: failure.lockedUntil ? 'auth.pin_locked' : 'auth.pin_failed',
          entityType: 'user_settings',
          entityId: actor.userId,
          requestId,
          metadata: { failedCount: failure.failedCount },
        });
        throw new AppError(failure.lockedUntil ? 'PIN_LOCKED' : 'PIN_INVALID');
      }

      await usersRepo.clearPinFailures(tx, actor.userId);
    });
  }

  /** Does this user have a PIN configured? */
  async hasPin(actor: AuthenticatedActor): Promise<boolean> {
    const settings = await withUser(
      this.deps.sql,
      { userId: actor.userId, isAdmin: actor.isAdmin },
      (tx) => usersRepo.getUserSettings(tx, actor.userId),
    );
    return Boolean(settings?.pin_hash);
  }
}
