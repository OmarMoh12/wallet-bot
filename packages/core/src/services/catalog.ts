import {
  AppError,
  FiatAmount,
  NOTIFICATION_TYPES,
  bigintToNumber,
  isLocale,
  type CashAccountDto,
  type CategoryDto,
  type CategoryKind,
  type NotificationType,
  type UserSettingsDto,
} from '@wallet/shared';
import { accountsRepo, usersRepo, type FiatCode } from '@wallet/db';
import { asUser, audit, type ServiceContext } from './base.js';
import { toCategoryDto, toFiatDto } from '../mappers.js';

/**
 * Reference data owned by the user: categories, cash accounts, and settings.
 */
export class CatalogService {
  /* ------------------------------------------------------------ categories -- */

  async listCategories(context: ServiceContext): Promise<CategoryDto[]> {
    const rows = await asUser(context, (tx) =>
      accountsRepo.listCategories(tx, context.actor.userId),
    );
    return rows.map((row) => toCategoryDto(row, (key) => context.t(key)));
  }

  async createCategory(
    context: ServiceContext,
    input: { name: string; kind: CategoryKind; icon?: string; color?: string },
  ): Promise<CategoryDto> {
    const row = await asUser(context, async (tx) => {
      const created = await accountsRepo.createCategory(tx, {
        userId: context.actor.userId,
        name: input.name,
        kind: input.kind,
        icon: input.icon ?? null,
        color: input.color ?? null,
      });
      await audit(context, tx, {
        action: 'category.created',
        entityType: 'category',
        entityId: created.id,
      });
      return created;
    });
    return toCategoryDto(row, (key) => context.t(key));
  }

  async updateCategory(
    context: ServiceContext,
    id: string,
    input: { name?: string; kind?: CategoryKind; icon?: string | null; color?: string | null },
  ): Promise<CategoryDto> {
    const row = await asUser(context, async (tx) => {
      const updated = await accountsRepo.updateCategory(tx, context.actor.userId, id, input);
      // A system category is visible but not editable; both cases surface as NOT_FOUND to
      // avoid leaking which is which.
      if (!updated) throw new AppError('CATEGORY_NOT_FOUND');
      await audit(context, tx, {
        action: 'category.updated',
        entityType: 'category',
        entityId: id,
      });
      return updated;
    });
    return toCategoryDto(row, (key) => context.t(key));
  }

  /** Refuses while transactions still reference the category, so history stays labelled. */
  async removeCategory(context: ServiceContext, id: string): Promise<void> {
    await asUser(context, async (tx) => {
      const usage = await accountsRepo.countCategoryUsage(tx, context.actor.userId, id);
      if (usage > 0) {
        throw new AppError('CATEGORY_IN_USE', { details: { transactions: usage } });
      }
      const removed = await accountsRepo.softDeleteCategory(tx, context.actor.userId, id);
      if (!removed) throw new AppError('CATEGORY_NOT_FOUND');
      await audit(context, tx, {
        action: 'category.deleted',
        entityType: 'category',
        entityId: id,
      });
    });
  }

  /* --------------------------------------------------------- cash accounts -- */

  async listCashAccounts(context: ServiceContext): Promise<CashAccountDto[]> {
    const rows = await asUser(context, (tx) =>
      accountsRepo.listCashAccounts(tx, context.actor.userId),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      balance: toFiatDto(FiatAmount.fromMinor(row.balance_minor, row.currency)),
      isDefault: row.is_default,
    }));
  }

  /**
   * Create a cash account, optionally with an opening balance.
   *
   * The opening balance is recorded as an `adjustment` transaction rather than written
   * straight into the balance column: the cached balance is derived from the ledger by
   * trigger, so an unexplained starting figure would be an unauditable hole.
   */
  async createCashAccount(
    context: ServiceContext,
    input: { name: string; currency: FiatCode; openingBalance: string; isDefault: boolean },
  ): Promise<CashAccountDto> {
    const opening = FiatAmount.parse(input.openingBalance.replace(/^\+/, ''), input.currency);

    const row = await asUser(context, async (tx) => {
      const account = await accountsRepo.createCashAccount(tx, {
        userId: context.actor.userId,
        name: input.name,
        currency: input.currency,
        isDefault: input.isDefault,
      });

      if (!opening.isZero()) {
        await tx`
          INSERT INTO transactions (
            user_id, kind, type, direction, status, source, title,
            cash_account_id, fiat_currency, fiat_amount_minor, occurred_at, idempotency_key
          ) VALUES (
            ${context.actor.userId}, 'cash', 'adjustment',
            ${opening.isNegative() ? 'out' : 'in'}, 'confirmed', 'system',
            ${'Opening balance'}, ${account.id}, ${input.currency},
            ${opening.minor.toString()}, now(), ${`opening:${account.id}`}
          )
        `;
      }

      await audit(context, tx, {
        action: 'cash_account.created',
        entityType: 'cash_account',
        entityId: account.id,
        metadata: { currency: input.currency },
      });

      const refreshed = await accountsRepo.findCashAccount(tx, context.actor.userId, account.id);
      return refreshed ?? account;
    });

    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      balance: toFiatDto(FiatAmount.fromMinor(row.balance_minor, row.currency)),
      isDefault: row.is_default,
    };
  }

  /* --------------------------------------------------------------- settings -- */

  async getSettings(context: ServiceContext): Promise<UserSettingsDto> {
    const { settings, preferences } = await asUser(context, async (tx) => ({
      settings: await usersRepo.getUserSettings(tx, context.actor.userId),
      preferences: await usersRepo.getNotificationPreferences(tx, context.actor.userId),
    }));
    if (!settings) throw new AppError('NOT_FOUND');

    // Absent means enabled: a newly added notification type is opt-out, not opt-in, so a
    // user does not silently miss alerts about money arriving.
    const notifications = {} as Record<NotificationType, boolean>;
    for (const type of NOTIFICATION_TYPES) {
      notifications[type] = preferences?.enabled_types?.[type] !== false;
    }

    return {
      locale: isLocale(settings.locale) ? settings.locale : 'en',
      themePreference: settings.theme_preference,
      primaryFiat: settings.primary_fiat,
      reportingFiat: settings.reporting_fiat,
      fxMode: settings.fx_mode,
      manualUsdIls: settings.manual_usd_ils,
      timezone: settings.timezone,
      hideBalances: settings.hide_balances,
      pinSet: Boolean(settings.pin_hash),
      notifications,
      quietHoursStart: preferences?.quiet_hours_start ?? null,
      quietHoursEnd: preferences?.quiet_hours_end ?? null,
    };
  }

  async updateSettings(
    context: ServiceContext,
    input: {
      locale?: 'en' | 'ar';
      themePreference?: 'system' | 'dark' | 'light';
      primaryFiat?: FiatCode;
      reportingFiat?: FiatCode;
      fxMode?: 'auto' | 'manual';
      manualUsdIls?: string;
      timezone?: string;
      hideBalances?: boolean;
    },
  ): Promise<UserSettingsDto> {
    // Switching to a manual rate without supplying one would leave conversions undefined.
    if (input.fxMode === 'manual' && !input.manualUsdIls) {
      const current = await asUser(context, (tx) =>
        usersRepo.getUserSettings(tx, context.actor.userId),
      );
      if (!current?.manual_usd_ils) {
        throw new AppError('VALIDATION_ERROR', { details: { field: 'manualUsdIls' } });
      }
    }

    await asUser(context, async (tx) => {
      const updated = await usersRepo.updateUserSettings(tx, context.actor.userId, input);
      if (!updated) throw new AppError('NOT_FOUND');
      await audit(context, tx, {
        action: 'settings.updated',
        entityType: 'user_settings',
        entityId: context.actor.userId,
        metadata: { fields: Object.keys(input) },
      });
    });

    // A manual rate change must not be served from a cache computed with the old one.
    context.app.currency.clearCache();
    return this.getSettings(context);
  }

  async updateNotificationPreferences(
    context: ServiceContext,
    input: {
      types?: Partial<Record<NotificationType, boolean>>;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
      minCryptoValueUsd?: string;
      fxAlertThresholdPercent?: string;
    },
  ): Promise<UserSettingsDto> {
    await asUser(context, async (tx) => {
      const minMinor = input.minCryptoValueUsd
        ? FiatAmount.parse(input.minCryptoValueUsd, 'USD').minor
        : undefined;
      const thresholdBps = input.fxAlertThresholdPercent
        ? FiatAmount.parse(input.fxAlertThresholdPercent, 'USD').minor
        : undefined;

      const updated = await usersRepo.updateNotificationPreferences(tx, context.actor.userId, {
        ...(input.types ? { enabledTypes: input.types as Record<string, boolean> } : {}),
        ...(input.quietHoursStart !== undefined ? { quietHoursStart: input.quietHoursStart } : {}),
        ...(input.quietHoursEnd !== undefined ? { quietHoursEnd: input.quietHoursEnd } : {}),
        ...(minMinor !== undefined ? { minCryptoValueUsdMinor: minMinor } : {}),
        // "2.5%" arrives as 250 basis points via the two-decimal minor-unit parse.
        ...(thresholdBps !== undefined
          ? { fxAlertThresholdBps: bigintToNumber(thresholdBps, 'fxAlertThresholdBps') }
          : {}),
      });
      if (!updated) throw new AppError('NOT_FOUND');

      await audit(context, tx, {
        action: 'settings.updated',
        entityType: 'notification_preferences',
        entityId: context.actor.userId,
      });
    });

    return this.getSettings(context);
  }
}
