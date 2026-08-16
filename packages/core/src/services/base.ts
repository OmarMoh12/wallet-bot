import {
  AppError,
  DEFAULT_LOCALE,
  createTranslator,
  type Locale,
  type Translator,
} from '@wallet/shared';
import { opsRepo, withSystem, withUser, type TransactionSql } from '@wallet/db';
import type { AppContext } from '../context.js';
import type { AuthenticatedActor } from '../auth/service.js';

/**
 * Per-request service context.
 *
 * Bundles the app-wide singletons with the authenticated actor, the request id used for log
 * correlation, and a translator bound to the user's language. Services take this rather
 * than reaching for globals, so every call site makes the acting identity explicit.
 */
export interface ServiceContext {
  app: AppContext;
  actor: AuthenticatedActor;
  requestId: string;
  t: Translator;
  ip: string | null;
  userAgent: string | null;
}

export function createServiceContext(params: {
  app: AppContext;
  actor: AuthenticatedActor;
  requestId: string;
  locale?: Locale;
  ip?: string | null;
  userAgent?: string | null;
}): ServiceContext {
  return {
    app: params.app,
    actor: params.actor,
    requestId: params.requestId,
    t: createTranslator(params.locale ?? params.actor.locale ?? DEFAULT_LOCALE),
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  };
}

/** Run a transaction bound to the acting user, so RLS applies. */
export function asUser<T>(
  context: ServiceContext,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withUser(
    context.app.sql,
    { userId: context.actor.userId, isAdmin: context.actor.isAdmin },
    fn,
  );
}

/** Run a transaction as the system (workers, infrastructure tables). */
export function asSystem<T>(app: AppContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withSystem(app.sql, fn);
}

export function requireAdmin(context: ServiceContext): void {
  if (!context.actor.isAdmin) {
    throw new AppError('ADMIN_REQUIRED', {
      internal: `user ${context.actor.userId} attempted an admin operation`,
    });
  }
}

/**
 * Write an audit entry inside an existing transaction.
 *
 * Being on the same transaction as the change it describes is the point: an operation and
 * its audit record either both land or neither does.
 */
export async function audit(
  context: ServiceContext,
  tx: TransactionSql,
  entry: {
    action: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await opsRepo.writeAudit(tx, {
    userId: context.actor.userId,
    actorType: context.actor.isAdmin ? 'admin' : 'user',
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    userAgent: context.userAgent,
    requestId: context.requestId,
    metadata: entry.metadata ?? {},
  });
}

/** Resolve the user's FX preference so conversions honour a manual rate. */
export async function fxPreference(
  context: ServiceContext,
): Promise<{ mode: 'auto' | 'manual'; manualUsdIls: string | null }> {
  const settings = await asUser(context, async (tx) => {
    const rows = await tx<Array<{ fx_mode: 'auto' | 'manual'; manual_usd_ils: string | null }>>`
      SELECT fx_mode, manual_usd_ils FROM user_settings WHERE user_id = ${context.actor.userId}
    `;
    return rows[0] ?? null;
  });
  return {
    mode: settings?.fx_mode ?? 'auto',
    manualUsdIls: settings?.manual_usd_ils ?? null,
  };
}
