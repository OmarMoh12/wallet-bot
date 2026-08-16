import { createTranslator, type Locale, type NotificationType } from '@wallet/shared';
import { escapeHtml, type InlineKeyboardButton } from './api.js';
import { START_PARAM, miniAppLink, type DeepLinkConfig } from './links.js';

/**
 * Notification rendering.
 *
 * Payloads carry *parameters*, never pre-rendered text, so a message is rendered in the
 * user's current language at delivery time — change the language in Settings and the next
 * notification arrives translated, with no migration of queued rows.
 *
 * Every interpolated value is HTML-escaped: wallet names, transaction titles and category
 * names are user-controlled, and an unescaped `<` would make Telegram reject the send.
 */

export interface RenderedNotification {
  text: string;
  keyboard: InlineKeyboardButton[][];
}

export interface RenderContext {
  locale: Locale;
  links: DeepLinkConfig;
}

type Payload = Record<string, unknown>;

function str(payload: Payload, key: string, fallback = ''): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

function escapedParams(payload: Payload, keys: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of keys) output[key] = escapeHtml(str(payload, key));
  return output;
}

/**
 * Render a notification row into Telegram-ready text and buttons.
 *
 * Unknown notification types fall back to a generic "open the app" message rather than
 * throwing — a queued row from an older deploy should still be delivered, not stuck.
 */
export function renderNotification(
  type: NotificationType | string,
  payload: Payload,
  context: RenderContext,
): RenderedNotification {
  const t = createTranslator(context.locale);
  const openApp: InlineKeyboardButton = {
    text: t('notify.openApp'),
    url: miniAppLink(context.links),
  };

  const transactionId = str(payload, 'transactionId');
  const explorerUrl = str(payload, 'explorerUrl');

  const transactionButtons = (): InlineKeyboardButton[][] => {
    const row: InlineKeyboardButton[] = [];
    if (transactionId) {
      row.push({
        text: t('notify.openTransaction'),
        url: miniAppLink(context.links, START_PARAM.transaction(transactionId)),
      });
    }
    // Only https explorer links are ever attached; the URL comes from our own registry.
    if (explorerUrl.startsWith('https://')) {
      row.push({ text: t('notify.openExplorer'), url: explorerUrl });
    }
    return row.length > 0 ? [row] : [[openApp]];
  };

  switch (type) {
    case 'crypto_received': {
      const params = escapedParams(payload, ['amount', 'wallet', 'value', 'network']);
      return {
        text: `<b>${t('notify.cryptoReceived.title', params)}</b>\n\n${t('notify.cryptoReceived.body', params)}`,
        keyboard: transactionButtons(),
      };
    }
    case 'crypto_sent': {
      const params = escapedParams(payload, ['amount', 'address', 'wallet', 'network']);
      return {
        text: `<b>${t('notify.cryptoSent.title', params)}</b>\n\n${t('notify.cryptoSent.body', params)}`,
        keyboard: transactionButtons(),
      };
    }
    case 'crypto_confirmed': {
      const params = escapedParams(payload, ['amount', 'network']);
      return {
        text: `<b>${t('notify.cryptoConfirmed.title', params)}</b>\n\n${t('notify.cryptoConfirmed.body', params)}`,
        keyboard: transactionButtons(),
      };
    }
    case 'crypto_failed': {
      const params = escapedParams(payload, ['amount', 'network']);
      return {
        text: `<b>${t('notify.cryptoFailed.title', params)}</b>\n\n${t('notify.cryptoFailed.body', params)}`,
        keyboard: transactionButtons(),
      };
    }
    case 'expected_income_due': {
      const params = escapedParams(payload, ['name', 'amount']);
      const id = str(payload, 'expectedIncomeId');
      return {
        text: `<b>${t('notify.expectedIncomeDue.title', params)}</b>\n\n${t('notify.expectedIncomeDue.body', params)}`,
        keyboard: [
          [
            {
              text: t('notify.openApp'),
              url: miniAppLink(context.links, id ? START_PARAM.expectedIncome(id) : undefined),
            },
          ],
        ],
      };
    }
    case 'expected_income_overdue': {
      const params = escapedParams(payload, ['name', 'amount', 'date']);
      const id = str(payload, 'expectedIncomeId');
      return {
        text: `<b>${t('notify.expectedIncomeOverdue.title', params)}</b>\n\n${t('notify.expectedIncomeOverdue.body', params)}`,
        keyboard: [
          [
            {
              text: t('notify.review'),
              url: miniAppLink(context.links, id ? START_PARAM.expectedIncome(id) : undefined),
            },
          ],
        ],
      };
    }
    case 'scheduled_payment_upcoming': {
      const params = escapedParams(payload, ['amount', 'address', 'network', 'time']);
      const id = str(payload, 'scheduledPaymentId');
      return {
        text: `<b>${t('notify.scheduledUpcoming.title', params)}</b>\n\n${t('notify.scheduledUpcoming.body', params)}`,
        keyboard: [
          [
            {
              text: t('notify.review'),
              url: miniAppLink(context.links, id ? START_PARAM.scheduled(id) : undefined),
            },
          ],
        ],
      };
    }
    case 'scheduled_payment_executed': {
      const params = escapedParams(payload, ['amount', 'address']);
      return {
        text: `<b>${t('notify.scheduledExecuted.title', params)}</b>\n\n${t('notify.scheduledExecuted.body', params)}`,
        keyboard: transactionButtons(),
      };
    }
    case 'scheduled_payment_failed': {
      // `reason` is an error CODE, translated here — never a raw internal message.
      const reasonCode = str(payload, 'reasonCode', 'INTERNAL_ERROR');
      const params = {
        ...escapedParams(payload, ['amount', 'address']),
        reason: escapeHtml(t(`error.${reasonCode}`)),
      };
      const id = str(payload, 'scheduledPaymentId');
      return {
        text: `<b>${t('notify.scheduledFailed.title', params)}</b>\n\n${t('notify.scheduledFailed.body', params)}`,
        keyboard: [
          [
            {
              text: t('notify.review'),
              url: miniAppLink(context.links, id ? START_PARAM.scheduled(id) : undefined),
            },
          ],
        ],
      };
    }
    case 'fx_rate_alert': {
      const params = escapedParams(payload, ['percent', 'rate']);
      return {
        text: `<b>${t('notify.fxAlert.title', params)}</b>\n\n${t('notify.fxAlert.body', params)}`,
        keyboard: [[openApp]],
      };
    }
    case 'balance_alert': {
      const params = escapedParams(payload, ['wallet', 'amount']);
      const walletId = str(payload, 'walletId');
      return {
        text: `<b>${t('notify.balanceAlert.title', params)}</b>\n\n${t('notify.balanceAlert.body', params)}`,
        keyboard: [
          [
            {
              text: t('notify.openApp'),
              url: miniAppLink(context.links, walletId ? START_PARAM.wallet(walletId) : undefined),
            },
          ],
        ],
      };
    }
    case 'goal_reached': {
      const params = escapedParams(payload, ['name', 'amount']);
      return {
        text: `<b>${t('notify.goalReached.title', params)}</b>\n\n${t('notify.goalReached.body', params)}`,
        keyboard: [[openApp]],
      };
    }
    case 'security_alert': {
      // Security alerts also use a code, so the text is localized and never leaks internals.
      const detailCode = str(payload, 'detailCode', 'generic');
      const params = { detail: escapeHtml(t(`error.${detailCode}`)) };
      return {
        text: `<b>${t('notify.securityAlert.title', params)}</b>\n\n${t('notify.securityAlert.body', params)}`,
        keyboard: [[openApp]],
      };
    }
    default:
      return { text: t('app.name'), keyboard: [[openApp]] };
  }
}
