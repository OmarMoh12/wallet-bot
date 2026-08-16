import { telegramAuthRequestSchema, type SessionDto } from '@wallet/shared';
import { publicRoute } from '@/lib/server/handler';
import { getAppContext, getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchange Telegram `initData` for a session token.
 *
 * This is the only way to obtain authority in this system. The raw initData is verified
 * against the bot token server-side; nothing the client asserts about its own identity is
 * used. Rate limited on IP because there is no user yet.
 */
export const POST = publicRoute(
  { bucket: 'auth', bodySchema: telegramAuthRequestSchema },
  async ({ body, request, requestId }): Promise<SessionDto> => {
    const app = getAppContext();
    const services = getServices();

    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip');

    const result = await services.auth.authenticateWithTelegram({
      initData: body.initData,
      ...(body.locale ? { localeHint: body.locale } : {}),
      ip: ip ?? null,
      userAgent: request.headers.get('user-agent'),
      requestId,
    });

    const actor = {
      userId: result.user.id,
      telegramId: BigInt(result.user.telegram_id),
      isAdmin: result.user.is_admin,
      sessionId: 'pending',
      locale: result.settings.locale as 'en' | 'ar',
    };

    const settings = await services.catalog.getSettings({
      app,
      actor,
      requestId,
      t: (key: string) => key,
      ip: null,
      userAgent: null,
    } as never);

    return {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: {
        id: result.user.id,
        telegramId: result.user.telegram_id,
        firstName: result.user.first_name,
        lastName: result.user.last_name,
        username: result.user.username,
        photoUrl: result.user.photo_url,
        isAdmin: result.user.is_admin,
      },
      settings,
      features: {
        sendingEnabled: app.config.sending.enabled,
        simulatedSending: app.signer.simulated,
        chainEnv: app.config.chain.env,
        safeMode: app.config.safeMode,
      },
    };
  },
);
