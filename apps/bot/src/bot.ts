import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import {
  FiatAmount,
  formatFiat,
  formatToken,
  relativeTimeKey,
  shortenAddress,
  TokenAmount,
} from '@wallet/shared';
import { escapeHtml, miniAppLink, START_PARAM } from '@wallet/telegram';
import type { AppContext, Services } from '@wallet/core';
import { resolveBotUser, serviceContextFor, type BotUser } from './session.js';

/**
 * The Telegram bot.
 *
 * Two jobs:
 *   1. be the entry point — a menu button and commands that open the Mini App;
 *   2. answer quick read-only questions ("what's my balance?") without opening it.
 *
 * Everything that moves money lives in the Mini App. The bot never sends, never confirms,
 * and never accepts an amount — see `session.ts` for why that boundary is drawn here.
 */

type BotContext = Context;

export function createBot(app: AppContext, services: Services): Bot<BotContext> {
  if (!app.config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to start the bot');
  }

  const bot = new Bot<BotContext>(app.config.telegram.botToken);
  const links = {
    botUsername: app.config.telegram.botUsername,
    ...(app.config.telegram.miniAppShortName
      ? { appShortName: app.config.telegram.miniAppShortName }
      : {}),
  };

  /** The "open the app" button attached to almost every reply. */
  const openApp = (label: string, startParam?: string): InlineKeyboard =>
    new InlineKeyboard().url(label, miniAppLink(links, startParam));

  /**
   * Resolve the user, or explain how to get started.
   * Returns null when the caller should stop.
   */
  async function requireUser(ctx: BotContext): Promise<BotUser | null> {
    const from = ctx.from;
    if (!from) return null;

    const user = await resolveBotUser(app, from.id, from.language_code);
    if (!user) {
      // Not an error: they simply have not opened the Mini App yet, which is where the
      // account is actually created (from verified initData).
      const fallback = app.config.telegram.botUsername
        ? new InlineKeyboard().url('Open app', miniAppLink(links))
        : undefined;
      await ctx.reply(
        'Open the Mini App once to finish setting up your account.',
        fallback ? { reply_markup: fallback } : {},
      );
      return null;
    }
    return user;
  }

  /* ------------------------------------------------------------- commands -- */

  bot.command('start', async (ctx) => {
    const from = ctx.from;
    const user = await resolveBotUser(app, from?.id ?? 0, from?.language_code);
    const t = user?.t;
    const name = escapeHtml(from?.first_name ?? '');

    const text = t
      ? t('bot.welcome', { name })
      : `Welcome${name ? `, ${name}` : ''}.\n\nThis is your private financial dashboard. Tap below to open it.`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: openApp(t ? t('bot.openDashboard') : '📊 Open dashboard'),
    });
  });

  bot.command('help', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(user.t('bot.help'), { reply_markup: openApp(user.t('bot.openDashboard')) });
  });

  bot.command('balance', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;

    const context = serviceContextFor(app, user, randomUUID());
    const summary = await services.portfolio.summary(context);
    const t = user.t;

    const lines = [`<b>${t('bot.balance.title')}</b>`, ''];

    // Cash always shows: it needs no exchange rate, so it is always trustworthy.
    lines.push(
      t('bot.balance.cash', {
        amount: formatFiat(
          FiatAmount.fromMinor(summary.cash.native.minor, summary.cash.native.currency),
          { locale: user.locale },
        ),
      }),
    );

    lines.push(
      t('bot.balance.crypto', {
        amount: summary.crypto.usd
          ? formatFiat(FiatAmount.fromMinor(summary.crypto.usd.minor, 'USD'), {
              locale: user.locale,
            })
          : '—',
      }),
    );

    if (summary.totalUsd && summary.totalIls) {
      lines.push(
        '',
        t('bot.balance.total', {
          usd: formatFiat(FiatAmount.fromMinor(summary.totalUsd.minor, 'USD'), {
            locale: user.locale,
          }),
          ils: formatFiat(FiatAmount.fromMinor(summary.totalIls.minor, 'ILS'), {
            locale: user.locale,
          }),
        }),
      );
    } else {
      // Never fabricate a total from a missing rate or price.
      lines.push('', t('dashboard.partialValuation'));
    }

    if (summary.rate) {
      const age = relativeTimeKey(new Date(summary.rate.updatedAt));
      lines.push(
        '',
        `<i>${escapeHtml(
          t('bot.balance.rate', {
            rate: summary.rate.rate,
            time: t(age.key, age.params),
          }),
        )}</i>`,
      );
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: openApp(t('bot.openDashboard')),
    });
  });

  bot.command('transactions', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;

    const context = serviceContextFor(app, user, randomUUID());
    const recent = await services.transactions.recent(context, 8);
    const t = user.t;

    if (recent.length === 0) {
      await ctx.reply(t('bot.transactions.empty'), {
        reply_markup: openApp(t('bot.openDashboard'), START_PARAM.screen('activity')),
      });
      return;
    }

    const lines = [`<b>${t('bot.transactions.title')}</b>`, ''];
    for (const item of recent) {
      const sign = item.direction === 'in' ? '🟢' : '🔴';
      const amount = item.fiat
        ? formatFiat(FiatAmount.fromMinor(item.fiat.minor, item.fiat.currency), {
            locale: user.locale,
            signDisplay: 'always',
          })
        : item.token
          ? formatToken(
              TokenAmount.fromRaw(item.token.raw, {
                assetKey: item.token.assetId,
                symbol: item.token.symbol,
                decimals: item.token.decimals,
              }),
              { locale: user.locale, signDisplay: 'always' },
            )
          : '—';

      lines.push(
        `${sign} <b>${escapeHtml(amount)}</b> · ${escapeHtml(item.title)}`,
        `<i>${escapeHtml(new Date(item.occurredAt).toISOString().slice(0, 16).replace('T', ' '))} · ${escapeHtml(t(`tx.status.${item.status}`))}</i>`,
        '',
      );
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: openApp(t('common.showAll'), START_PARAM.screen('activity')),
    });
  });

  bot.command('wallets', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;

    const context = serviceContextFor(app, user, randomUUID());
    const wallets = await services.wallets.list(context);
    const t = user.t;

    if (wallets.length === 0) {
      await ctx.reply(t('bot.wallets.empty'), {
        reply_markup: openApp(t('wallets.add'), START_PARAM.screen('wallets')),
      });
      return;
    }

    const lines = [`<b>${t('bot.wallets.title')}</b>`, ''];
    for (const wallet of wallets) {
      lines.push(
        `👛 <b>${escapeHtml(wallet.name)}</b>`,
        `<code>${escapeHtml(shortenAddress(wallet.address, 10, 8))}</code>`,
        `<i>${escapeHtml(wallet.network.toUpperCase())} · ${escapeHtml(
          wallet.isWatchOnly ? t('wallets.watchOnly') : t('wallets.managed'),
        )}</i>`,
        '',
      );
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: openApp(t('bot.openDashboard'), START_PARAM.screen('wallets')),
    });
  });

  bot.command('income', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;

    const context = serviceContextFor(app, user, randomUUID());
    const items = await services.planning.listExpectedIncome(context, {
      statuses: ['pending', 'delayed'],
    });
    const t = user.t;

    if (items.length === 0) {
      await ctx.reply(t('bot.income.empty'), {
        reply_markup: openApp(t('income.add'), START_PARAM.screen('payments')),
      });
      return;
    }

    const lines = [`<b>${t('bot.income.title')}</b>`, ''];
    for (const item of items.slice(0, 8)) {
      const amount = formatFiat(FiatAmount.fromMinor(item.amount.minor, item.amount.currency), {
        locale: user.locale,
      });
      const when = item.isOverdue
        ? t('common.overdueDays', { count: Math.abs(item.daysUntil) })
        : item.daysUntil === 0
          ? t('common.today')
          : t('common.inDays', { count: item.daysUntil });
      lines.push(
        `⏳ <b>${escapeHtml(amount)}</b> · ${escapeHtml(item.name)}`,
        `<i>${escapeHtml(when)}</i>`,
        '',
      );
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: openApp(t('bot.openDashboard'), START_PARAM.screen('payments')),
    });
  });

  bot.command('scheduled', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;

    const context = serviceContextFor(app, user, randomUUID());
    const items = await services.planning.listScheduledPayments(context);
    const t = user.t;

    if (items.length === 0) {
      await ctx.reply(t('bot.scheduled.empty'), {
        reply_markup: openApp(t('schedule.add'), START_PARAM.screen('payments')),
      });
      return;
    }

    const lines = [`<b>${t('bot.scheduled.title')}</b>`, ''];
    for (const item of items.slice(0, 8)) {
      const amount = formatToken(
        TokenAmount.fromRaw(item.amount.raw, {
          assetKey: item.amount.assetId,
          symbol: item.amount.symbol,
          decimals: item.amount.decimals,
        }),
        { locale: user.locale },
      );
      lines.push(
        `📅 <b>${escapeHtml(amount)}</b> → <code>${escapeHtml(shortenAddress(item.toAddress))}</code>`,
        `<i>${escapeHtml(item.scheduledAt.slice(0, 16).replace('T', ' '))} · ${escapeHtml(
          t(`schedule.status.${item.status}`),
        )}</i>`,
        '',
      );
    }

    // Be explicit about the safe default rather than letting the user assume it will run.
    if (!app.config.sending.enabled) lines.push(`<i>${escapeHtml(t('schedule.disabledNote'))}</i>`);

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: openApp(t('bot.openDashboard'), START_PARAM.screen('payments')),
    });
  });

  // Money-moving commands deliberately redirect into the Mini App.
  bot.command('send', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    const message = app.config.sending.enabled
      ? user.t('bot.send.useApp')
      : `${user.t('bot.send.useApp')}\n\n${user.t('send.disabledHint')}`;
    await ctx.reply(message, {
      reply_markup: openApp(user.t('bot.menu.send'), START_PARAM.screen('send')),
    });
  });

  bot.command('receive', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(user.t('bot.receive.useApp'), {
      reply_markup: openApp(user.t('bot.menu.receive'), START_PARAM.screen('receive')),
    });
  });

  bot.command('settings', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(user.t('bot.settings.useApp'), {
      reply_markup: openApp(user.t('bot.menu.settings'), START_PARAM.screen('settings')),
    });
  });

  /* -------------------------------------------------------------- fallback -- */

  bot.on('message:text', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user) return;
    await ctx.reply(user.t('bot.unknownCommand'), {
      reply_markup: openApp(user.t('bot.openDashboard')),
    });
  });

  /* ----------------------------------------------------------- error trap -- */

  bot.catch((error) => {
    // Never let a handler failure leak internals into a chat message.
    app.logger.error('bot handler failed', {
      operation: 'bot.error',
      updateId: error.ctx.update.update_id,
      error: error.error instanceof Error ? error.error.message : String(error.error),
    });
  });

  return bot;
}

/** Register the command list and the persistent menu button. */
export async function configureBotProfile(app: AppContext, bot: Bot<BotContext>): Promise<void> {
  const commands = [
    { command: 'start', description: 'Open the dashboard' },
    { command: 'balance', description: 'Current balances' },
    { command: 'transactions', description: 'Recent activity' },
    { command: 'wallets', description: 'Your wallets' },
    { command: 'income', description: 'Expected income' },
    { command: 'scheduled', description: 'Scheduled payments' },
    { command: 'receive', description: 'Receive crypto' },
    { command: 'settings', description: 'Preferences' },
    { command: 'help', description: 'How to use this bot' },
  ];

  await bot.api.setMyCommands(commands);

  await bot.api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: 'Wallet',
      web_app: { url: app.config.telegram.webAppUrl },
    },
  });
}
