import { parseCount, type ActorType, type JobType, type NotificationType } from '@wallet/shared';
import { asJson, type Queryable } from '../client.js';
import type {
  AppSettingRow,
  AssetPriceRow,
  AssetRow,
  AuditLogRow,
  ExchangeRateRow,
  FiatCode,
  JobRow,
  NotificationRow,
} from '../types.js';

/* ------------------------------------------------------------------- assets -- */

export async function listAssets(
  sql: Queryable,
  options: { env?: string; activeOnly?: boolean } = {},
): Promise<AssetRow[]> {
  const rows = await sql<AssetRow[]>`
    SELECT * FROM assets
    WHERE true
      ${options.env ? sql`AND env = ${options.env}` : sql``}
      ${options.activeOnly === false ? sql`` : sql`AND is_active`}
    ORDER BY network ASC, kind DESC, symbol ASC
  `;
  return [...rows];
}

export async function findAsset(sql: Queryable, assetId: string): Promise<AssetRow | null> {
  const rows = await sql<AssetRow[]>`SELECT * FROM assets WHERE id = ${assetId} LIMIT 1`;
  return rows[0] ?? null;
}

export async function findAssetByContract(
  sql: Queryable,
  params: { network: string; env: string; contractAddress: string | null; symbol?: string },
): Promise<AssetRow | null> {
  const rows = await sql<AssetRow[]>`
    SELECT * FROM assets
    WHERE network = ${params.network}
      AND env = ${params.env}
      AND ${
        params.contractAddress
          ? sql`contract_address = ${params.contractAddress}`
          : sql`contract_address IS NULL`
      }
      ${params.symbol && !params.contractAddress ? sql`AND symbol = ${params.symbol}` : sql``}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/* ------------------------------------------------------------ notifications -- */

export interface EnqueueNotificationInput {
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  dedupeKey: string;
  deliverAfter?: Date;
}

/**
 * Queue a notification.
 *
 * The unique `(user_id, dedupe_key)` index is the anti-spam primitive: re-processing the
 * same chain event, or two workers racing on it, produces exactly one message. `null` means
 * "already queued", which callers treat as success.
 */
export async function enqueueNotification(
  sql: Queryable,
  input: EnqueueNotificationInput,
): Promise<NotificationRow | null> {
  const rows = await sql<NotificationRow[]>`
    INSERT INTO notifications (user_id, type, payload, dedupe_key, deliver_after)
    VALUES (
      ${input.userId}, ${input.type}, ${sql.json(asJson(input.payload))},
      ${input.dedupeKey}, ${input.deliverAfter ?? new Date()}
    )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING *
  `;
  return rows[0] ?? null;
}

export interface PendingNotification extends NotificationRow {
  telegram_id: string;
  locale: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
  enabled_types: Record<string, boolean>;
}

/**
 * Claim queued notifications for delivery, joined with everything the renderer needs
 * (language, quiet hours, per-type preferences) so the bot makes one query per batch.
 */
export async function claimNotifications(
  sql: Queryable,
  options: { limit: number; worker: string },
): Promise<PendingNotification[]> {
  const rows = await sql<PendingNotification[]>`
    WITH claimed AS (
      SELECT id FROM notifications
      WHERE status = 'queued' AND deliver_after <= now()
      ORDER BY deliver_after ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE notifications n
    SET attempts = n.attempts + 1, updated_at = now()
    FROM claimed
    WHERE n.id = claimed.id
    RETURNING n.*,
      (SELECT u.telegram_id FROM users u WHERE u.id = n.user_id) AS telegram_id,
      (SELECT s.locale FROM user_settings s WHERE s.user_id = n.user_id) AS locale,
      (SELECT s.timezone FROM user_settings s WHERE s.user_id = n.user_id) AS timezone,
      (SELECT p.quiet_hours_start FROM notification_preferences p WHERE p.user_id = n.user_id) AS quiet_hours_start,
      (SELECT p.quiet_hours_end FROM notification_preferences p WHERE p.user_id = n.user_id) AS quiet_hours_end,
      (SELECT p.enabled_types FROM notification_preferences p WHERE p.user_id = n.user_id) AS enabled_types
  `;
  return [...rows];
}

export async function markNotificationSent(
  sql: Queryable,
  id: string,
  telegramMessageId: number | null,
): Promise<void> {
  await sql`
    UPDATE notifications
    SET status = 'sent', sent_at = now(), telegram_message_id = ${telegramMessageId}, error = NULL,
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function markNotificationFailed(
  sql: Queryable,
  id: string,
  error: string,
  retryAt: Date | null,
): Promise<void> {
  await sql`
    UPDATE notifications SET
      status        = ${retryAt ? 'queued' : 'failed'},
      deliver_after = COALESCE(${retryAt}, deliver_after),
      error         = ${error.slice(0, 500)},
      updated_at    = now()
    WHERE id = ${id}
  `;
}

export async function suppressNotification(
  sql: Queryable,
  id: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE notifications
    SET status = 'suppressed', error = ${reason.slice(0, 500)}, updated_at = now()
    WHERE id = ${id}
  `;
}

/** Defer a notification without consuming an attempt — used for quiet hours. */
export async function deferNotification(
  sql: Queryable,
  id: string,
  deliverAfter: Date,
): Promise<void> {
  await sql`
    UPDATE notifications
    SET deliver_after = ${deliverAfter}, attempts = GREATEST(attempts - 1, 0), updated_at = now()
    WHERE id = ${id}
  `;
}

/* --------------------------------------------------------------------- jobs -- */

export async function enqueueJob(
  sql: Queryable,
  input: {
    type: JobType | string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    dedupeKey?: string | null;
    queue?: string;
    priority?: number;
    maxAttempts?: number;
  },
): Promise<string> {
  const rows = await sql<Array<{ enqueue_job: string }>>`
    SELECT app.enqueue_job(
      ${input.type},
      ${sql.json(asJson(input.payload ?? {}))},
      ${input.runAt ?? new Date()},
      ${input.dedupeKey ?? null},
      ${input.queue ?? 'default'},
      ${input.priority ?? 100},
      ${input.maxAttempts ?? 5}
    ) AS enqueue_job
  `;
  const id = rows[0]?.enqueue_job;
  if (!id) throw new Error('enqueueJob: no id returned');
  return id;
}

export async function claimJobs(
  sql: Queryable,
  options: { worker: string; limit: number; leaseSeconds: number; queue?: string },
): Promise<JobRow[]> {
  const rows = await sql<JobRow[]>`
    SELECT * FROM app.claim_jobs(
      ${options.worker}, ${options.limit}, ${options.leaseSeconds}, ${options.queue ?? 'default'}
    )
  `;
  return [...rows];
}

export async function completeJob(sql: Queryable, id: string): Promise<void> {
  await sql`
    UPDATE jobs SET status = 'succeeded', finished_at = now(), locked_by = NULL,
                    locked_until = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Fail a job. Below `max_attempts` it goes back to `queued` with a backoff; at the limit it
 * becomes `dead` so it stops consuming worker capacity and shows up in the admin panel.
 */
export async function failJob(
  sql: Queryable,
  id: string,
  error: string,
  retryDelayMs: number,
): Promise<void> {
  await sql`
    UPDATE jobs SET
      status       = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status_t
                          ELSE 'queued'::job_status_t END,
      run_at       = now() + make_interval(secs => ${retryDelayMs / 1000}),
      locked_by    = NULL,
      locked_until = NULL,
      last_error   = ${error.slice(0, 2000)},
      finished_at  = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
      updated_at   = now()
    WHERE id = ${id}
  `;
}

export async function reclaimStuckJobs(sql: Queryable, graceSeconds = 0): Promise<number> {
  const rows = await sql<Array<{ reclaim_stuck_jobs: number }>>`
    SELECT app.reclaim_stuck_jobs(${graceSeconds}) AS reclaim_stuck_jobs
  `;
  return rows[0]?.reclaim_stuck_jobs ?? 0;
}

export async function jobQueueStats(
  sql: Queryable,
): Promise<Array<{ status: string; count: string }>> {
  const rows = await sql<Array<{ status: string; count: string }>>`
    SELECT status::text AS status, COUNT(*)::text AS count FROM jobs GROUP BY status
  `;
  return [...rows];
}

export async function listDeadJobs(sql: Queryable, limit: number): Promise<JobRow[]> {
  const rows = await sql<JobRow[]>`
    SELECT * FROM jobs WHERE status = 'dead' ORDER BY finished_at DESC LIMIT ${limit}
  `;
  return [...rows];
}

/* ------------------------------------------------------------------- events -- */

/** Returns true if THIS caller claimed the key (i.e. the event is new). */
export async function claimEvent(
  sql: Queryable,
  params: { scope: string; key: string; ttlSeconds?: number; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const rows = await sql<Array<{ claim_event: boolean }>>`
    SELECT app.claim_event(
      ${params.scope}, ${params.key}, ${params.ttlSeconds ?? null}, ${sql.json(asJson(params.metadata ?? {}))}
    ) AS claim_event
  `;
  return rows[0]?.claim_event ?? false;
}

/* -------------------------------------------------------------- rate limits -- */

export async function bumpRateLimit(
  sql: Queryable,
  params: { bucket: string; subject: string; windowMs: number },
): Promise<number> {
  const rows = await sql<Array<{ bump_rate_limit: number }>>`
    SELECT app.bump_rate_limit(${params.bucket}, ${params.subject}, ${params.windowMs})
      AS bump_rate_limit
  `;
  return rows[0]?.bump_rate_limit ?? 0;
}

/* -------------------------------------------------------------- audit trail -- */

export interface AuditEntry {
  userId: string | null;
  actorType: ActorType;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append to the audit trail.
 *
 * `metadata` must already have been passed through `redact()` by the caller — this layer
 * does not inspect it, and the app role has no UPDATE/DELETE grant on this table, so an
 * entry cannot be rewritten after the fact.
 */
export async function writeAudit(sql: Queryable, entry: AuditEntry): Promise<void> {
  await sql`
    INSERT INTO audit_logs
      (user_id, actor_type, action, entity_type, entity_id, ip_hash, user_agent, request_id, metadata)
    VALUES (
      ${entry.userId}, ${entry.actorType}, ${entry.action}, ${entry.entityType ?? null},
      ${entry.entityId ?? null}, ${entry.ipHash ?? null}, ${entry.userAgent ?? null},
      ${entry.requestId ?? null}, ${sql.json(asJson(entry.metadata ?? {}))}
    )
  `;
}

export async function listAuditLogs(
  sql: Queryable,
  options: { userId?: string; limit: number; offset: number },
): Promise<AuditLogRow[]> {
  const rows = await sql<AuditLogRow[]>`
    SELECT * FROM audit_logs
    WHERE true ${options.userId ? sql`AND user_id = ${options.userId}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${options.limit} OFFSET ${options.offset}
  `;
  return [...rows];
}

/* -------------------------------------------------------------- market data -- */

export async function insertExchangeRate(
  sql: Queryable,
  input: { base: FiatCode; quote: FiatCode; rate: string; source: string; isManual: boolean },
): Promise<ExchangeRateRow> {
  const rows = await sql<ExchangeRateRow[]>`
    INSERT INTO exchange_rates (base, quote, rate, source, is_manual)
    VALUES (${input.base}, ${input.quote}, ${input.rate}, ${input.source}, ${input.isManual})
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('insertExchangeRate: no row returned');
  return row;
}

export async function latestExchangeRate(
  sql: Queryable,
  base: FiatCode,
  quote: FiatCode,
): Promise<ExchangeRateRow | null> {
  const rows = await sql<ExchangeRateRow[]>`
    SELECT * FROM exchange_rates
    WHERE base = ${base} AND quote = ${quote}
    ORDER BY fetched_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function exchangeRateHistory(
  sql: Queryable,
  params: { base: FiatCode; quote: FiatCode; since: Date; limit: number },
): Promise<ExchangeRateRow[]> {
  const rows = await sql<ExchangeRateRow[]>`
    SELECT * FROM exchange_rates
    WHERE base = ${params.base} AND quote = ${params.quote} AND fetched_at >= ${params.since}
    ORDER BY fetched_at DESC
    LIMIT ${params.limit}
  `;
  return [...rows];
}

export async function insertAssetPrice(
  sql: Queryable,
  input: { assetId: string; quote: FiatCode; price: string; source: string },
): Promise<void> {
  await sql`
    INSERT INTO asset_prices (asset_id, quote, price, source)
    VALUES (${input.assetId}, ${input.quote}, ${input.price}, ${input.source})
  `;
}

export interface LatestPriceRow extends AssetPriceRow {
  symbol: string;
  decimals: number;
}

/** Latest USD price per asset, one row each, via DISTINCT ON. */
export async function latestAssetPrices(
  sql: Queryable,
  assetIds: string[],
): Promise<LatestPriceRow[]> {
  if (assetIds.length === 0) return [];
  const rows = await sql<LatestPriceRow[]>`
    SELECT DISTINCT ON (p.asset_id) p.*, a.symbol, a.decimals
    FROM asset_prices p
    JOIN assets a ON a.id = p.asset_id
    WHERE p.asset_id IN ${sql(assetIds)} AND p.quote = 'USD'
    ORDER BY p.asset_id, p.fetched_at DESC
  `;
  return [...rows];
}

/* ------------------------------------------------------------- app settings -- */

export async function getAppSetting<T>(sql: Queryable, key: string, fallback: T): Promise<T> {
  const rows = await sql<AppSettingRow[]>`SELECT * FROM app_settings WHERE key = ${key} LIMIT 1`;
  const row = rows[0];
  return row ? (row.value as T) : fallback;
}

export async function getAllAppSettings(sql: Queryable): Promise<Record<string, unknown>> {
  const rows = await sql<AppSettingRow[]>`SELECT * FROM app_settings`;
  const output: Record<string, unknown> = {};
  for (const row of rows) output[row.key] = row.value;
  return output;
}

export async function setAppSetting(
  sql: Queryable,
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${sql.json(asJson(value as never))}, ${updatedBy}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
}

/* ------------------------------------------------------------------ cleanup -- */

export async function cleanupExpired(
  sql: Queryable,
  jobRetentionDays = 14,
): Promise<{ events: number; jobs: number; sessions: number; limits: number }> {
  const rows = await sql<
    Array<{
      deleted_events: string;
      deleted_jobs: string;
      deleted_sessions: string;
      deleted_limits: string;
    }>
  >`SELECT * FROM app.cleanup_expired(${jobRetentionDays})`;
  const row = rows[0];
  return {
    events: parseCount(row?.deleted_events),
    jobs: parseCount(row?.deleted_jobs),
    sessions: parseCount(row?.deleted_sessions),
    limits: parseCount(row?.deleted_limits),
  };
}
