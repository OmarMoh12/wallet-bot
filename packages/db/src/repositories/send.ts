import type { SendRequestStatus } from '@wallet/shared';
import type { Queryable } from '../client.js';
import type { AssetRow, SendRequestRow, WalletRow } from '../types.js';

/**
 * Send requests: the two-phase record behind every outgoing transfer.
 *
 * The unique index on `(user_id, idempotency_key)` is what makes a retried request return
 * the original result instead of sending a second time. `quote_fingerprint` binds the
 * confirmation to exactly the numbers the user was shown.
 */

export interface CreateSendRequestInput {
  userId: string;
  walletId: string;
  assetId: string;
  toAddress: string;
  toAddressCanonical: string;
  rawAmount: bigint;
  memo: string | null;
  quoteFingerprint: string;
  feeAssetId: string | null;
  feeRawAmount: bigint | null;
  valueUsdMinor: bigint | null;
  expiresAt: Date;
  simulated: boolean;
  idempotencyKey: string;
  scheduledPaymentId?: string | null;
}

export interface CreateSendRequestResult {
  request: SendRequestRow;
  /** False when an existing request with the same idempotency key was returned. */
  created: boolean;
}

export async function createSendRequest(
  sql: Queryable,
  input: CreateSendRequestInput,
): Promise<CreateSendRequestResult> {
  const inserted = await sql<SendRequestRow[]>`
    INSERT INTO send_requests (
      user_id, wallet_id, asset_id, to_address, to_address_canonical, raw_amount, memo,
      quote_fingerprint, fee_asset_id, fee_raw_amount, value_usd_minor,
      expires_at, simulated, idempotency_key, scheduled_payment_id
    ) VALUES (
      ${input.userId}, ${input.walletId}, ${input.assetId}, ${input.toAddress},
      ${input.toAddressCanonical}, ${input.rawAmount.toString()}, ${input.memo},
      ${input.quoteFingerprint}, ${input.feeAssetId},
      ${input.feeRawAmount?.toString() ?? null}, ${input.valueUsdMinor?.toString() ?? null},
      ${input.expiresAt}, ${input.simulated}, ${input.idempotencyKey},
      ${input.scheduledPaymentId ?? null}
    )
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING *
  `;

  const row = inserted[0];
  if (row) return { request: row, created: true };

  const existing = await sql<SendRequestRow[]>`
    SELECT * FROM send_requests
    WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  const found = existing[0];
  if (!found) throw new Error('createSendRequest: conflict without an existing row');
  return { request: found, created: false };
}

export interface SendRequestWithRelations extends SendRequestRow {
  wallet: WalletRow;
  asset: AssetRow;
  fee_asset: AssetRow | null;
}

export async function findSendRequest(
  sql: Queryable,
  userId: string,
  id: string,
): Promise<SendRequestWithRelations | null> {
  const rows = await sql<SendRequestWithRelations[]>`
    SELECT s.*, to_jsonb(w.*) AS wallet, to_jsonb(a.*) AS asset,
           CASE WHEN fa.id IS NULL THEN NULL ELSE to_jsonb(fa.*) END AS fee_asset
    FROM send_requests s
    JOIN wallets w ON w.id = s.wallet_id
    JOIN assets a ON a.id = s.asset_id
    LEFT JOIN assets fa ON fa.id = s.fee_asset_id
    WHERE s.id = ${id} AND s.user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Move `quoted` -> `confirmed`, but only if the fingerprint still matches and the quote has
 * not expired.
 *
 * Expressed as a single conditional UPDATE rather than read-then-write: two concurrent
 * confirmations of the same quote cannot both succeed, because only one can observe
 * `status = 'quoted'`. That is the double-spend guard for the manual send path.
 */
export async function confirmSendRequest(
  sql: Queryable,
  params: { userId: string; id: string; fingerprint: string },
): Promise<SendRequestRow | null> {
  const rows = await sql<SendRequestRow[]>`
    UPDATE send_requests SET
      status = 'confirmed',
      confirmed_at = now(),
      updated_at = now()
    WHERE id = ${params.id}
      AND user_id = ${params.userId}
      AND status = 'quoted'
      AND quote_fingerprint = ${params.fingerprint}
      AND expires_at > now()
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function setSendRequestStatus(
  sql: Queryable,
  id: string,
  status: SendRequestStatus,
  extra: {
    txHash?: string | null;
    transactionId?: string | null;
    errorCode?: string | null;
  } = {},
): Promise<SendRequestRow | null> {
  const rows = await sql<SendRequestRow[]>`
    UPDATE send_requests SET
      status         = ${status},
      tx_hash        = COALESCE(${extra.txHash ?? null}, tx_hash),
      transaction_id = COALESCE(${extra.transactionId ?? null}::uuid, transaction_id),
      error_code     = ${extra.errorCode ?? null},
      broadcast_at   = CASE WHEN ${status} = 'broadcast' THEN now() ELSE broadcast_at END,
      completed_at   = CASE WHEN ${status} = 'completed' THEN now() ELSE completed_at END,
      updated_at     = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Total USD value the user has committed to sending in the trailing window.
 * Counts anything past the point of no return (`confirmed` onwards) so a burst of
 * confirmations cannot slip under the daily cap.
 */
export async function spentUsdMinorInWindow(
  sql: Queryable,
  userId: string,
  windowSeconds: number,
): Promise<bigint> {
  const rows = await sql<Array<{ total: string }>>`
    SELECT COALESCE(SUM(value_usd_minor), 0) AS total
    FROM send_requests
    WHERE user_id = ${userId}
      AND status IN ('confirmed', 'signing', 'broadcast', 'completed')
      AND confirmed_at IS NOT NULL
      AND confirmed_at > now() - make_interval(secs => ${windowSeconds})
  `;
  return BigInt(rows[0]?.total ?? '0');
}

/** Expire stale quotes. Runs in the cleanup job. */
export async function expireStaleQuotes(sql: Queryable, limit: number): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE send_requests SET status = 'expired', updated_at = now()
    WHERE id IN (
      SELECT id FROM send_requests
      WHERE status = 'quoted' AND expires_at < now()
      ORDER BY expires_at ASC
      LIMIT ${limit}
    )
    RETURNING id
  `;
  return rows.length;
}

/** Has the user sent to this address before? Drives the "new recipient" warning. */
export async function hasSentToAddressBefore(
  sql: Queryable,
  userId: string,
  addressCanonical: string,
): Promise<boolean> {
  const rows = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM send_requests
      WHERE user_id = ${userId}
        AND to_address_canonical = ${addressCanonical}
        AND status IN ('broadcast', 'completed')
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}
