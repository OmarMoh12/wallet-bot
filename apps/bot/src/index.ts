import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { webhookCallback } from 'grammy';
import { closeAppContext, createAppContext, createServices, healthReport } from '@wallet/core';
import { verifyWebhookSecret } from '@wallet/telegram';
import { configureBotProfile, createBot } from './bot.js';

/**
 * Telegram bot process.
 *
 * Runs on Railway. Two responsibilities:
 *   1. serve Telegram updates (long polling in development, webhook in production);
 *   2. drain the notification queue, so messages reach the user whether or not the Mini App
 *      is open.
 *
 * The webhook path verifies `X-Telegram-Bot-Api-Secret-Token` in constant time *before*
 * grammY parses the body, so an unauthenticated request never reaches the update router.
 */

const context = createAppContext({ service: 'bot' });
const services = createServices(context);

if (!context.config.telegram.botToken) {
  context.logger.fatal('TELEGRAM_BOT_TOKEN is not set; the bot cannot start', {
    operation: 'bot.boot',
  });
  process.exit(1);
}

const bot = createBot(context, services);
const port = context.config.worker.healthPort;

/* --------------------------------------------------- notification pump -- */

let notificationTimer: NodeJS.Timeout | undefined;

/**
 * Drain queued notifications.
 *
 * The worker also runs `notify.dispatch`; both are safe because `claimNotifications` uses
 * `FOR UPDATE SKIP LOCKED`. Having the bot do it too means notifications keep flowing even
 * if the worker is down.
 */
async function pumpNotifications(): Promise<void> {
  try {
    const result = await services.notifications.dispatch(context, { limit: 20, worker: 'bot' });
    if (result.sent > 0 || result.failed > 0) {
      context.logger.debug('notifications dispatched', {
        operation: 'bot.notify',
        ...result,
      });
    }
  } catch (error) {
    context.logger.warn('notification pump failed', {
      operation: 'bot.notify',
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/* ---------------------------------------------------------------- server -- */

const handleWebhook = webhookCallback(bot, 'http');

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';

  const send = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(payload);
  };

  if (url === '/health' || url === '/healthz' || url === '/') {
    healthReport(context, 'bot')
      .then((report) => send(report.status === 'down' ? 503 : 200, report))
      .catch(() => send(503, { status: 'down', service: 'bot' }));
    return;
  }

  if (url.startsWith('/telegram/webhook')) {
    if (context.config.telegram.mode !== 'webhook') {
      send(404, { error: { code: 'NOT_FOUND' } });
      return;
    }

    const header = req.headers['x-telegram-bot-api-secret-token'];
    const received = Array.isArray(header) ? (header[0] ?? null) : (header ?? null);

    // Constant-time check before anything parses the body.
    if (!verifyWebhookSecret(received, context.config.telegram.webhookSecret)) {
      context.logger.warn('rejected webhook with an invalid secret token', {
        operation: 'bot.webhook',
      });
      send(401, { error: { code: 'UNAUTHORIZED' } });
      return;
    }

    void handleWebhook(req, res).catch((error: unknown) => {
      context.logger.error('webhook handling failed', {
        operation: 'bot.webhook',
        error: error instanceof Error ? error.message : 'unknown',
      });
      if (!res.headersSent) send(500, { error: { code: 'INTERNAL_ERROR' } });
    });
    return;
  }

  send(404, { error: { code: 'NOT_FOUND' } });
});

/* -------------------------------------------------------------- start-up -- */

async function main(): Promise<void> {
  await configureBotProfile(context, bot).catch((error: unknown) => {
    // Not fatal: the bot still works, it just has no command list yet.
    context.logger.warn('could not configure bot profile', {
      operation: 'bot.boot',
      error: error instanceof Error ? error.message : 'unknown',
    });
  });

  // A failed bind is a startup failure, and it must say so by name: an unexplained boot
  // crash loop on this service has cost enough time already.
  server.on('error', (error: NodeJS.ErrnoException) => {
    context.logger.fatal('bot http server could not bind', {
      operation: 'bot.boot',
      port,
      code: error.code ?? 'unknown',
      error: error.message,
    });
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    context.logger.info('bot http server listening', { operation: 'bot.boot', port });
  });

  notificationTimer = setInterval(() => void pumpNotifications(), 5000);

  if (context.config.telegram.mode === 'webhook') {
    if (!context.config.telegram.webhookUrl) {
      throw new Error('TELEGRAM_WEBHOOK_URL is required when TELEGRAM_MODE=webhook');
    }
    await bot.api.setWebhook(context.config.telegram.webhookUrl, {
      secret_token: context.config.telegram.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
    });
    context.logger.info('bot running in webhook mode', {
      operation: 'bot.boot',
      url: context.config.telegram.webhookUrl,
    });
  } else {
    // Long polling: remove any webhook first, or Telegram refuses getUpdates.
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    context.logger.info('bot running in polling mode', { operation: 'bot.boot' });
    void bot.start({
      onStart: () => context.logger.info('polling started', { operation: 'bot.boot' }),
    });
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  context.logger.info('bot shutting down', { operation: 'bot.shutdown', signal });
  if (notificationTimer) clearInterval(notificationTimer);
  server.close();
  await bot.stop().catch(() => {});
  await closeAppContext(context).catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  context.logger.error('unhandled rejection in bot', {
    operation: 'bot.error',
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch((error: unknown) => {
  context.logger.fatal('bot failed to start', {
    operation: 'bot.boot',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
