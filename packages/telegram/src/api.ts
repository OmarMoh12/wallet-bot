import { z } from 'zod';
import { AppError } from '@wallet/shared';

/**
 * Minimal Telegram Bot API client.
 *
 * The bot process itself uses grammY for updates and command routing; this client exists so
 * that the *worker* can deliver notifications without pulling in a framework, and so both
 * share one implementation of the things that actually matter here: HTML escaping,
 * `retry_after` handling, and never letting a bot token reach a log line.
 */

const API_BASE = 'https://api.telegram.org';

const responseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().max(500).optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

const messageSchema = z.object({
  message_id: z.number(),
  date: z.number().optional(),
});

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
}

export interface SendMessageOptions {
  chatId: string | number;
  text: string;
  /** Buttons, as rows. */
  keyboard?: InlineKeyboardButton[][];
  disableNotification?: boolean;
  disablePreview?: boolean;
  parseMode?: 'HTML' | 'MarkdownV2' | null;
}

export class TelegramApiError extends AppError {
  readonly retryAfterSeconds: number | null;
  readonly telegramCode: number | null;
  /** True when Telegram will never accept this message (blocked bot, deleted chat). */
  readonly permanent: boolean;

  constructor(params: {
    description: string;
    errorCode: number | null;
    retryAfter: number | null;
  }) {
    const permanent =
      params.errorCode === 403 ||
      params.errorCode === 400 ||
      /bot was blocked|chat not found|user is deactivated/i.test(params.description);
    super('SERVICE_UNAVAILABLE', {
      internal: `Telegram API error ${params.errorCode ?? '?'}: ${params.description}`,
      retryable: !permanent,
    });
    this.name = 'TelegramApiError';
    this.retryAfterSeconds = params.retryAfter;
    this.telegramCode = params.errorCode;
    this.permanent = permanent;
  }
}

/**
 * Escape text for Telegram's HTML parse mode.
 *
 * Applied to every dynamic value in a notification — wallet names, transaction titles,
 * category names. A user-chosen wallet name containing `<b>` would otherwise break the
 * message, and Telegram would reject the whole send.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class TelegramClient {
  private readonly base: string;

  constructor(
    private readonly botToken: string,
    private readonly options: { timeoutMs?: number; apiBase?: string } = {},
  ) {
    if (!botToken)
      throw new AppError('INTERNAL_ERROR', { internal: 'TelegramClient needs a token' });
    this.base = `${(options.apiBase ?? API_BASE).replace(/\/+$/, '')}/bot${botToken}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

    try {
      const response = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', {
          internal: `Telegram returned non-JSON (${response.status})`,
          retryable: true,
        });
      }

      const envelope = responseSchema.safeParse(parsed);
      if (!envelope.success) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          internal: 'Telegram response did not match the expected envelope',
          retryable: true,
        });
      }

      if (!envelope.data.ok) {
        throw new TelegramApiError({
          description: envelope.data.description ?? 'unknown error',
          errorCode: envelope.data.error_code ?? null,
          retryAfter: envelope.data.parameters?.retry_after ?? null,
        });
      }

      return envelope.data.result as T;
    } catch (error) {
      if (AppError.is(error)) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('TIMEOUT', { internal: 'Telegram API timed out', retryable: true });
      }
      // Deliberately does not include the URL: it contains the bot token.
      throw new AppError('SERVICE_UNAVAILABLE', {
        internal: `Telegram API request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<{ messageId: number }> {
    const result = await this.call<unknown>('sendMessage', {
      chat_id: options.chatId,
      text: options.text,
      parse_mode: options.parseMode === null ? undefined : (options.parseMode ?? 'HTML'),
      disable_notification: options.disableNotification ?? false,
      link_preview_options: { is_disabled: options.disablePreview ?? true },
      reply_markup: options.keyboard?.length ? { inline_keyboard: options.keyboard } : undefined,
    });

    const message = messageSchema.safeParse(result);
    return { messageId: message.success ? message.data.message_id : 0 };
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    languageCode?: string,
  ): Promise<void> {
    await this.call('setMyCommands', {
      commands,
      ...(languageCode ? { language_code: languageCode } : {}),
    });
  }

  async setChatMenuButton(params: { text: string; webAppUrl: string }): Promise<void> {
    await this.call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: params.text, web_app: { url: params.webAppUrl } },
    });
  }

  async setWebhook(params: {
    url: string;
    secretToken: string;
    allowedUpdates?: string[];
  }): Promise<void> {
    await this.call('setWebhook', {
      url: params.url,
      secret_token: params.secretToken,
      allowed_updates: params.allowedUpdates ?? ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async getMe(): Promise<{ id: number; username?: string }> {
    return this.call<{ id: number; username?: string }>('getMe', {});
  }
}
