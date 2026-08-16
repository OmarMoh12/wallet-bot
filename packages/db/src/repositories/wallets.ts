import type { Network, NetworkEnv, WalletType } from '@wallet/shared';
import { asJson, type Queryable } from '../client.js';
import type { AssetRow, BlockchainScanRow, WalletBalanceRow, WalletRow } from '../types.js';

export interface CreateWalletInput {
  userId: string;
  name: string;
  network: Network;
  env: NetworkEnv;
  address: string;
  addressCanonical: string;
  type: WalletType;
}

export async function createWallet(sql: Queryable, input: CreateWalletInput): Promise<WalletRow> {
  const rows = await sql<WalletRow[]>`
    INSERT INTO wallets (user_id, name, network, env, address, address_canonical, type)
    VALUES (
      ${input.userId}, ${input.name}, ${input.network}, ${input.env},
      ${input.address}, ${input.addressCanonical}, ${input.type}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createWallet: no row returned');
  return row;
}

export async function listWallets(
  sql: Queryable,
  userId: string,
  options: { includeInactive?: boolean; network?: Network } = {},
): Promise<WalletRow[]> {
  const rows = await sql<WalletRow[]>`
    SELECT * FROM wallets
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      ${options.includeInactive ? sql`` : sql`AND is_active`}
      ${options.network ? sql`AND network = ${options.network}` : sql``}
    ORDER BY created_at ASC
  `;
  return [...rows];
}

export async function findWallet(
  sql: Queryable,
  userId: string,
  walletId: string,
): Promise<WalletRow | null> {
  const rows = await sql<WalletRow[]>`
    SELECT * FROM wallets
    WHERE id = ${walletId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findWalletById(sql: Queryable, walletId: string): Promise<WalletRow | null> {
  const rows = await sql<WalletRow[]>`
    SELECT * FROM wallets WHERE id = ${walletId} AND deleted_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateWallet(
  sql: Queryable,
  userId: string,
  walletId: string,
  input: { name?: string; isActive?: boolean },
): Promise<WalletRow | null> {
  const rows = await sql<WalletRow[]>`
    UPDATE wallets SET
      name       = COALESCE(${input.name ?? null}, name),
      is_active  = COALESCE(${input.isActive ?? null}, is_active),
      updated_at = now()
    WHERE id = ${walletId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Soft delete. History rows keep pointing at the wallet id (the FK is ON DELETE SET NULL),
 * so removing a wallet never destroys the user's transaction record.
 */
export async function softDeleteWallet(
  sql: Queryable,
  userId: string,
  walletId: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE wallets SET deleted_at = now(), is_active = false, updated_at = now()
    WHERE id = ${walletId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/* ------------------------------------------------------------------ scanning -- */

/** Wallets due a scan, oldest first. Runs unbound in the worker. */
export async function listWalletsDueForScan(
  sql: Queryable,
  options: { intervalSeconds: number; limit: number; env?: NetworkEnv },
): Promise<WalletRow[]> {
  const rows = await sql<WalletRow[]>`
    SELECT w.* FROM wallets w
    JOIN users u ON u.id = w.user_id
    WHERE w.is_active
      AND w.deleted_at IS NULL
      AND u.is_active
      AND u.deleted_at IS NULL
      ${options.env ? sql`AND w.env = ${options.env}` : sql``}
      AND (
        w.last_scanned_at IS NULL
        OR w.last_scanned_at < now() - make_interval(secs => ${options.intervalSeconds})
      )
    ORDER BY w.last_scanned_at ASC NULLS FIRST
    LIMIT ${options.limit}
  `;
  return [...rows];
}

export async function markScanSuccess(
  sql: Queryable,
  walletId: string,
  cursor: Record<string, unknown> | null,
): Promise<void> {
  await sql`
    UPDATE wallets SET
      last_scanned_at      = now(),
      scan_cursor          = ${cursor ? sql.json(asJson(cursor)) : null},
      last_scan_error      = NULL,
      consecutive_failures = 0,
      updated_at           = now()
    WHERE id = ${walletId}
  `;
}

export async function markScanFailure(
  sql: Queryable,
  walletId: string,
  error: string,
): Promise<void> {
  await sql`
    UPDATE wallets SET
      last_scanned_at      = now(),
      last_scan_error      = ${error.slice(0, 500)},
      consecutive_failures = LEAST(consecutive_failures + 1, 1000),
      updated_at           = now()
    WHERE id = ${walletId}
  `;
}

export async function resetScanCursor(sql: Queryable, walletId: string): Promise<void> {
  await sql`
    UPDATE wallets SET scan_cursor = NULL, last_scanned_at = NULL, updated_at = now()
    WHERE id = ${walletId}
  `;
}

export async function startScan(
  sql: Queryable,
  input: { walletId: string; provider: string; cursorBefore: Record<string, unknown> | null },
): Promise<BlockchainScanRow> {
  const rows = await sql<BlockchainScanRow[]>`
    INSERT INTO blockchain_scans (wallet_id, provider, cursor_before)
    VALUES (${input.walletId}, ${input.provider}, ${input.cursorBefore ? sql.json(asJson(input.cursorBefore)) : null})
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('startScan: no row returned');
  return row;
}

export async function finishScan(
  sql: Queryable,
  scanId: string,
  result: {
    status: 'ok' | 'failed';
    transfersSeen: number;
    transfersNew: number;
    cursorAfter: Record<string, unknown> | null;
    error?: string;
  },
): Promise<void> {
  await sql`
    UPDATE blockchain_scans SET
      status         = ${result.status},
      finished_at    = now(),
      transfers_seen = ${result.transfersSeen},
      transfers_new  = ${result.transfersNew},
      cursor_after   = ${result.cursorAfter ? sql.json(asJson(result.cursorAfter)) : null},
      error          = ${result.error ? result.error.slice(0, 1000) : null}
    WHERE id = ${scanId}
  `;
}

/* ------------------------------------------------------------------ balances -- */

export interface WalletBalanceWithAsset extends WalletBalanceRow {
  asset: AssetRow;
}

export async function listWalletBalances(
  sql: Queryable,
  walletId: string,
): Promise<WalletBalanceWithAsset[]> {
  const rows = await sql<WalletBalanceWithAsset[]>`
    SELECT b.*, to_jsonb(a.*) AS asset
    FROM wallet_balances b
    JOIN assets a ON a.id = b.asset_id
    WHERE b.wallet_id = ${walletId}
    ORDER BY a.kind DESC, a.symbol ASC
  `;
  return [...rows];
}

/** Every non-zero balance the user holds, across all their wallets. */
export async function listPortfolioBalances(
  sql: Queryable,
  userId: string,
): Promise<Array<WalletBalanceWithAsset & { wallet_name: string; wallet_network: Network }>> {
  const rows = await sql<
    Array<WalletBalanceWithAsset & { wallet_name: string; wallet_network: Network }>
  >`
    SELECT b.*, to_jsonb(a.*) AS asset, w.name AS wallet_name, w.network AS wallet_network
    FROM wallet_balances b
    JOIN wallets w ON w.id = b.wallet_id
    JOIN assets a ON a.id = b.asset_id
    WHERE w.user_id = ${userId}
      AND w.deleted_at IS NULL
      AND w.is_active
      AND b.raw_amount > 0
    ORDER BY a.symbol ASC
  `;
  return [...rows];
}

export async function upsertWalletBalance(
  sql: Queryable,
  input: { walletId: string; assetId: string; rawAmount: bigint; source: string },
): Promise<void> {
  await sql`
    INSERT INTO wallet_balances (wallet_id, asset_id, raw_amount, source, updated_at)
    VALUES (${input.walletId}, ${input.assetId}, ${input.rawAmount.toString()}, ${input.source}, now())
    ON CONFLICT (wallet_id, asset_id) DO UPDATE SET
      raw_amount = EXCLUDED.raw_amount,
      source     = EXCLUDED.source,
      updated_at = now()
  `;
}

/**
 * Apply a signed delta to a cached balance.
 *
 * Used by the chain ingest path so a newly-detected transfer is reflected immediately
 * without waiting for the next full reconcile. Clamped at zero: a negative cached balance
 * would be nonsense, and a clamp is safer than letting a provider gap produce one.
 */
export async function adjustWalletBalance(
  sql: Queryable,
  input: { walletId: string; assetId: string; delta: bigint; source: string },
): Promise<void> {
  await sql`
    INSERT INTO wallet_balances (wallet_id, asset_id, raw_amount, source, updated_at)
    VALUES (${input.walletId}, ${input.assetId}, GREATEST(${input.delta.toString()}::numeric, 0), ${input.source}, now())
    ON CONFLICT (wallet_id, asset_id) DO UPDATE SET
      raw_amount = GREATEST(wallet_balances.raw_amount + ${input.delta.toString()}::numeric, 0),
      source     = EXCLUDED.source,
      updated_at = now()
  `;
}

/** Resolve the wallet that owns an address, for routing an inbound chain event. */
export async function findWalletByAddress(
  sql: Queryable,
  params: { network: Network; env: NetworkEnv; addressCanonical: string },
): Promise<WalletRow | null> {
  const rows = await sql<WalletRow[]>`
    SELECT * FROM wallets
    WHERE network = ${params.network}
      AND env = ${params.env}
      AND address_canonical = ${params.addressCanonical}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}
