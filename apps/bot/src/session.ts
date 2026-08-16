import {
  DEFAULT_LOCALE,
  createTranslator,
  isLocale,
  resolveLocaleFromTelegram,
  type Locale,
  type Translator,
} from '@wallet/shared';
import { usersRepo, withSystem } from '@wallet/db';
import type { AppContext, AuthenticatedActor, ServiceContext } from '@wallet/core';

/**
 * Mapping a Telegram update to an application identity.
 *
 * Why this is safe without initData: bot updates arrive over a channel that is already
 * authenticated — long polling is an authenticated call *we* make with the bot token, and
 * webhook deliveries are verified with `X-Telegram-Bot-Api-Secret-Token` before routing.
 * The `from.id` on an update therefore comes from Telegram, not from a client.
 *
 * It is still a strictly weaker channel than the Mini App, which is why the bot exposes
 * **read-only** commands. Anything that moves money is confirmed inside the Mini App, where
 * initData is verified per request and a PIN is required.
 */

export interface BotUser {
  actor: AuthenticatedActor;
  locale: Locale;
  t: Translator;
  firstName: string;
}

/**
 * Resolve an existing user. Returns null when the person has never opened the Mini App —
 * the bot then tells them to open it once, rather than creating an account from a channel
 * that cannot prove as much.
 */
export async function resolveBotUser(
  app: AppContext,
  telegramId: number | bigint,
  languageCode?: string,
): Promise<BotUser | null> {
  const id = typeof telegramId === 'bigint' ? telegramId : BigInt(telegramId);

  const user = await withSystem(app.sql, (tx) => usersRepo.findUserByTelegramId(tx, id));
  if (!user || !user.is_active) return null;

  const settings = await withSystem(app.sql, (tx) => usersRepo.getUserSettings(tx, user.id));
  const locale: Locale = isLocale(settings?.locale)
    ? settings.locale
    : (resolveLocaleFromTelegram(languageCode) ?? DEFAULT_LOCALE);

  return {
    actor: {
      userId: user.id,
      telegramId: id,
      isAdmin: user.is_admin,
      sessionId: 'bot',
      locale,
    },
    locale,
    t: createTranslator(locale),
    firstName: user.first_name,
  };
}

export function serviceContextFor(
  app: AppContext,
  user: BotUser,
  requestId: string,
): ServiceContext {
  return {
    app,
    actor: user.actor,
    requestId,
    t: user.t,
    ip: null,
    userAgent: 'telegram-bot',
  };
}
