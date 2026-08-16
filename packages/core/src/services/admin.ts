import { AppError, jobKey, parseCount, type HealthDto } from '@wallet/shared';
import { opsRepo, usersRepo, walletsRepo } from '@wallet/db';
import { asSystem, asUser, audit, requireAdmin, type ServiceContext } from './base.js';
import { healthReport } from './health.js';

/**
 * Owner/admin operations.
 *
 * Every method starts with `requireAdmin` and ends with an audit entry. Admin RLS policies
 * grant SELECT across users but not UPDATE — mutating another user's financial rows has no
 * code path here at all, which is deliberate: an admin can inspect and can operate the
 * platform, but cannot quietly rewrite someone's ledger.
 */
export class AdminService {
  async systemHealth(context: ServiceContext): Promise<HealthDto> {
    requireAdmin(context);
    return healthReport(context.app, 'admin');
  }

  async listUsers(context: ServiceContext, options: { limit: number; offset: number }) {
    requireAdmin(context);
    const rows = await asUser(context, (tx) => usersRepo.listUsers(tx, options));
    return rows.map((row) => ({
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username,
      firstName: row.first_name,
      isAdmin: row.is_admin,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    }));
  }

  async setUserActive(context: ServiceContext, userId: string, isActive: boolean): Promise<void> {
    requireAdmin(context);
    if (userId === context.actor.userId && !isActive) {
      // Locking yourself out of the only admin account is not recoverable in-app.
      throw new AppError('FORBIDDEN', { internal: 'an admin cannot deactivate themselves' });
    }
    await asUser(context, async (tx) => {
      await usersRepo.setUserActive(tx, userId, isActive);
      await audit(context, tx, {
        action: 'admin.user_updated',
        entityType: 'user',
        entityId: userId,
        metadata: { isActive },
      });
    });
  }

  async listAuditLogs(context: ServiceContext, options: { limit: number; offset: number }) {
    requireAdmin(context);
    const rows = await asUser(context, (tx) => opsRepo.listAuditLogs(tx, options));
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      actorType: row.actor_type,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      requestId: row.request_id,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async queueStats(context: ServiceContext) {
    requireAdmin(context);
    const [stats, dead] = await Promise.all([
      asSystem(context.app, (tx) => opsRepo.jobQueueStats(tx)),
      asSystem(context.app, (tx) => opsRepo.listDeadJobs(tx, 20)),
    ]);
    return {
      byStatus: Object.fromEntries(stats.map((row) => [row.status, parseCount(row.count)])),
      dead: dead.map((row) => ({
        id: row.id,
        type: row.type,
        attempts: row.attempts,
        lastError: row.last_error?.slice(0, 300) ?? null,
        finishedAt: row.finished_at?.toISOString() ?? null,
      })),
    };
  }

  async settings(context: ServiceContext) {
    requireAdmin(context);
    const values = await asSystem(context.app, (tx) => opsRepo.getAllAppSettings(tx));
    return {
      database: values,
      // What the environment permits. The database can only ever narrow this.
      environment: {
        sendingEnabled: context.app.config.sending.enabled,
        signerMode: context.app.config.sending.signerMode,
        chainEnv: context.app.config.chain.env,
        blockchainMock: context.app.providers.isMock,
        safeMode: context.app.config.safeMode,
      },
    };
  }

  /**
   * Toggle outgoing transfers.
   *
   * Can only ever turn sending OFF relative to the environment: enabling it here has no
   * effect while `SENDING_ENABLED=false`, because the send service ANDs the two. That
   * asymmetry means a compromised admin session cannot switch on outbound transfers.
   */
  async setSendingEnabled(
    context: ServiceContext,
    params: { enabled: boolean; reason: string },
  ): Promise<{ effective: boolean }> {
    requireAdmin(context);

    await asSystem(context.app, (tx) =>
      opsRepo.setAppSetting(tx, 'sending_enabled', params.enabled, context.actor.userId),
    );
    await asUser(context, (tx) =>
      audit(context, tx, {
        action: 'admin.sending_toggled',
        entityType: 'app_settings',
        metadata: { requested: params.enabled, reason: params.reason },
      }),
    );

    return { effective: params.enabled && context.app.config.sending.enabled };
  }

  async setAppSetting(context: ServiceContext, key: string, value: unknown): Promise<void> {
    requireAdmin(context);
    const allowed = new Set([
      'scheduled_payments_enabled',
      'chain_scanning_enabled',
      'notifications_enabled',
      'fx_auto_refresh_enabled',
      'maintenance_mode',
    ]);
    // An allow-list, not a free-form key/value store: an arbitrary key could shadow a
    // setting some future code path reads.
    if (!allowed.has(key)) {
      throw new AppError('VALIDATION_ERROR', { details: { key } });
    }

    await asSystem(context.app, (tx) =>
      opsRepo.setAppSetting(tx, key, value, context.actor.userId),
    );
    await asUser(context, (tx) =>
      audit(context, tx, {
        action: 'admin.setting_changed',
        entityType: 'app_settings',
        metadata: { key, value: JSON.stringify(value).slice(0, 200) },
      }),
    );
  }

  /** Re-scan a wallet, optionally from the beginning of its history. */
  async rescanWallet(
    context: ServiceContext,
    params: { walletId: string; fromScratch: boolean },
  ): Promise<void> {
    requireAdmin(context);

    const wallet = await asSystem(context.app, (tx) =>
      walletsRepo.findWalletById(tx, params.walletId),
    );
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    await asSystem(context.app, async (tx) => {
      if (params.fromScratch) {
        // Safe by construction: re-reading history is idempotent, so a full replay creates
        // no duplicates.
        await walletsRepo.resetScanCursor(tx, params.walletId);
      }
      await opsRepo.enqueueJob(tx, {
        type: 'chain.scan',
        payload: { walletId: params.walletId, reason: 'admin-rescan' },
        dedupeKey: jobKey('chain.scan', params.walletId),
        priority: 5,
      });
    });

    await asUser(context, (tx) =>
      audit(context, tx, {
        action: 'admin.rescan',
        entityType: 'wallet',
        entityId: params.walletId,
        metadata: { fromScratch: params.fromScratch },
      }),
    );
  }

  /** Set a manual FX rate that overrides the automatic feed system-wide. */
  async setManualRate(
    context: ServiceContext,
    params: { base: 'USD' | 'ILS'; quote: 'USD' | 'ILS'; rate: string; reason: string },
  ): Promise<void> {
    requireAdmin(context);

    await asSystem(context.app, (tx) =>
      opsRepo.insertExchangeRate(tx, {
        base: params.base,
        quote: params.quote,
        rate: params.rate,
        source: 'manual-admin',
        isManual: true,
      }),
    );
    context.app.currency.clearCache();

    await asUser(context, (tx) =>
      audit(context, tx, {
        action: 'admin.setting_changed',
        entityType: 'exchange_rates',
        metadata: {
          pair: `${params.base}/${params.quote}`,
          rate: params.rate,
          reason: params.reason,
        },
      }),
    );
  }

  /** Provider connectivity, for the admin health panel. */
  async providerHealth(context: ServiceContext) {
    requireAdmin(context);
    const results = await Promise.all(
      context.app.providers.all().map((provider) => provider.health()),
    );
    const signer = await context.app.signer.health();
    return {
      chain: results,
      signer: { mode: context.app.signer.mode, ...signer },
    };
  }
}
