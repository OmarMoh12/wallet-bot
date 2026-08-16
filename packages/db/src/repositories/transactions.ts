import {
  parseCount,
  type Network,
  type NetworkEnv,
  type TxDirection,
  type TxKind,
  type TxSource,
  type TxStatus,
  type TxType,
} from '@wallet/shared';
import type { Queryable } from '../client.js';
import type { FiatCode, TransactionRow, TransactionWithRelationsRow } from '../types.js';

/* ---------------------------------------------------------------- insertion -- */

export interface CreateCashTransactionInput {
  userId: string;
  type: Extract<TxType, 'income' | 'expense' | 'adjustment'>;
  direction: TxDirection;
  status: TxStatus;
  source: TxSource;
  title: string;
  description: string | null;
  notes: string | null;
  categoryId: string | null;
  occurredAt: Date;
  cashAccountId: string;
  currency: FiatCode;
  /** Signed minor units. Sign must agree with `direction` — the DB enforces it too. */
  amountMinor: bigint;
  valueUsdMinor: bigint | null;
  valueIlsMinor: bigint | null;
  usdIlsRate: string | null;
  externalRef: string | null;
  idempotencyKey: string | null;
}

export async function createCashTransaction(
  sql: Queryable,
  input: CreateCashTransactionInput,
): Promise<TransactionRow> {
  const rows = await sql<TransactionRow[]>`
    INSERT INTO transactions (
      user_id, kind, type, direction, status, source,
      title, description, notes, category_id, occurred_at,
      cash_account_id, fiat_currency, fiat_amount_minor,
      value_usd_minor, value_ils_minor, usd_ils_rate, valued_at,
      external_ref, idempotency_key
    ) VALUES (
      ${input.userId}, 'cash', ${input.type}, ${input.direction}, ${input.status}, ${input.source},
      ${input.title}, ${input.description}, ${input.notes}, ${input.categoryId}, ${input.occurredAt},
      ${input.cashAccountId}, ${input.currency}, ${input.amountMinor.toString()},
      ${input.valueUsdMinor?.toString() ?? null},
      ${input.valueIlsMinor?.toString() ?? null},
      ${input.usdIlsRate},
      ${input.valueUsdMinor === null ? null : new Date()},
      ${input.externalRef}, ${input.idempotencyKey}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createCashTransaction: no row returned');
  return row;
}

export interface CreateChainTransactionInput {
  userId: string;
  type: TxType;
  direction: TxDirection;
  status: TxStatus;
  source: TxSource;
  title: string;
  description: string | null;
  categoryId: string | null;
  occurredAt: Date;
  walletId: string | null;
  assetId: string;
  /** Signed base units. */
  rawAmount: bigint;
  network: Network;
  env: NetworkEnv;
  txHash: string;
  logIndex: number;
  counterpartyAddress: string | null;
  memo: string | null;
  feeAssetId: string | null;
  feeRawAmount: bigint | null;
  confirmations: number | null;
  requiredConfirmations: number | null;
  blockNumber: bigint | null;
  blockTime: Date | null;
  valueUsdMinor: bigint | null;
  valueIlsMinor: bigint | null;
  usdIlsRate: string | null;
  unitPriceUsd: string | null;
  sendRequestId?: string | null;
  scheduledPaymentId?: string | null;
}

/**
 * Insert a chain-sourced transaction, or do nothing if it already exists.
 *
 * `ON CONFLICT DO NOTHING` against the `(network, env, tx_hash, log_index)` unique index is
 * the second of two idempotency gates (the first is `processed_events`). Returning `null`
 * tells the caller "already ingested" without an extra round trip, and without a
 * check-then-insert race between concurrent workers.
 */
export async function insertChainTransactionIfNew(
  sql: Queryable,
  input: CreateChainTransactionInput,
): Promise<TransactionRow | null> {
  const rows = await sql<TransactionRow[]>`
    INSERT INTO transactions (
      user_id, kind, type, direction, status, source,
      title, description, category_id, occurred_at,
      wallet_id, asset_id, raw_amount, network, env, tx_hash, log_index,
      counterparty_address, memo, fee_asset_id, fee_raw_amount,
      confirmations, required_confirmations, block_number, block_time,
      value_usd_minor, value_ils_minor, usd_ils_rate, unit_price_usd, valued_at,
      send_request_id, scheduled_payment_id
    ) VALUES (
      ${input.userId}, 'crypto', ${input.type}, ${input.direction}, ${input.status}, ${input.source},
      ${input.title}, ${input.description}, ${input.categoryId}, ${input.occurredAt},
      ${input.walletId}, ${input.assetId}, ${input.rawAmount.toString()},
      ${input.network}, ${input.env}, ${input.txHash}, ${input.logIndex},
      ${input.counterpartyAddress}, ${input.memo}, ${input.feeAssetId},
      ${input.feeRawAmount?.toString() ?? null},
      ${input.confirmations}, ${input.requiredConfirmations},
      ${input.blockNumber?.toString() ?? null}, ${input.blockTime},
      ${input.valueUsdMinor?.toString() ?? null},
      ${input.valueIlsMinor?.toString() ?? null},
      ${input.usdIlsRate}, ${input.unitPriceUsd},
      ${input.valueUsdMinor === null ? null : new Date()},
      ${input.sendRequestId ?? null}, ${input.scheduledPaymentId ?? null}
    )
    ON CONFLICT (network, env, tx_hash, log_index) WHERE tx_hash IS NOT NULL DO NOTHING
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Look up a previously created row by its client idempotency key. */
export async function findByIdempotencyKey(
  sql: Queryable,
  userId: string,
  idempotencyKey: string,
): Promise<TransactionRow | null> {
  const rows = await sql<TransactionRow[]>`
    SELECT * FROM transactions
    WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------- reads -- */

const RELATION_SELECT = (sql: Queryable) => sql`
  t.*,
  a.symbol            AS asset_symbol,
  a.name              AS asset_name,
  a.decimals          AS asset_decimals,
  a.contract_address  AS asset_contract,
  a.icon_key          AS asset_icon,
  a.kind              AS asset_kind,
  fa.symbol           AS fee_asset_symbol,
  fa.decimals         AS fee_asset_decimals,
  w.name              AS wallet_name,
  c.key               AS category_key,
  c.name              AS category_name,
  c.kind              AS category_kind,
  c.icon              AS category_icon,
  c.color             AS category_color,
  c.is_system         AS category_is_system
`;

const RELATION_JOINS = (sql: Queryable) => sql`
  LEFT JOIN assets a      ON a.id = t.asset_id
  LEFT JOIN assets fa     ON fa.id = t.fee_asset_id
  LEFT JOIN wallets w     ON w.id = t.wallet_id
  LEFT JOIN categories c  ON c.id = t.category_id
`;

export interface TransactionFilters {
  kind?: TxKind;
  type?: TxType;
  status?: TxStatus;
  direction?: 'in' | 'out';
  network?: Network;
  walletId?: string;
  cashAccountId?: string;
  categoryId?: string;
  currency?: FiatCode;
  symbol?: string;
  from?: string;
  to?: string;
  search?: string;
}

export interface KeysetCursor {
  occurredAt: Date;
  id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** Returns null for anything malformed rather than throwing — a bad cursor is not an outage. */
export function decodeCursor(value: string | undefined): KeysetCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return null;
    const occurredAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(occurredAt.getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

/**
 * Paged transaction history.
 *
 * Keyset pagination on `(occurred_at DESC, id DESC)` rather than OFFSET: stable under
 * concurrent inserts, and constant time at any depth. Search uses the GIN full-text index;
 * the term is a bind parameter, never concatenated into the query.
 */
export async function listTransactions(
  sql: Queryable,
  userId: string,
  filters: TransactionFilters,
  page: { limit: number; cursor?: string },
): Promise<{ items: TransactionWithRelationsRow[]; nextCursor: string | null }> {
  const cursor = decodeCursor(page.cursor);
  const limit = Math.min(Math.max(page.limit, 1), 100);

  const rows = await sql<TransactionWithRelationsRow[]>`
    SELECT ${RELATION_SELECT(sql)}
    FROM transactions t
    ${RELATION_JOINS(sql)}
    WHERE t.user_id = ${userId}
      AND t.deleted_at IS NULL
      ${filters.kind ? sql`AND t.kind = ${filters.kind}` : sql``}
      ${filters.type ? sql`AND t.type = ${filters.type}` : sql``}
      ${filters.status ? sql`AND t.status = ${filters.status}` : sql``}
      ${filters.direction ? sql`AND t.direction = ${filters.direction}` : sql``}
      ${filters.network ? sql`AND t.network = ${filters.network}` : sql``}
      ${filters.walletId ? sql`AND t.wallet_id = ${filters.walletId}` : sql``}
      ${filters.cashAccountId ? sql`AND t.cash_account_id = ${filters.cashAccountId}` : sql``}
      ${filters.categoryId ? sql`AND t.category_id = ${filters.categoryId}` : sql``}
      ${filters.currency ? sql`AND t.fiat_currency = ${filters.currency}` : sql``}
      ${filters.symbol ? sql`AND a.symbol = ${filters.symbol.toUpperCase()}` : sql``}
      ${filters.from ? sql`AND t.occurred_at >= ${`${filters.from}T00:00:00Z`}::timestamptz` : sql``}
      ${filters.to ? sql`AND t.occurred_at < (${`${filters.to}T00:00:00Z`}::timestamptz + interval '1 day')` : sql``}
      ${
        filters.search
          ? sql`AND (
              to_tsvector('simple',
                coalesce(t.title, '') || ' ' ||
                coalesce(t.description, '') || ' ' ||
                coalesce(t.tx_hash, '') || ' ' ||
                coalesce(t.counterparty_address, '')
              ) @@ plainto_tsquery('simple', ${filters.search})
              OR t.tx_hash = ${filters.search}
              OR t.counterparty_address = ${filters.search}
            )`
          : sql``
      }
      ${
        cursor
          ? sql`AND (t.occurred_at, t.id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
          : sql``
      }
    ORDER BY t.occurred_at DESC, t.id DESC
    LIMIT ${limit + 1}
  `;

  const items = [...rows];
  let nextCursor: string | null = null;
  if (items.length > limit) {
    items.length = limit;
    const last = items[items.length - 1];
    if (last) nextCursor = encodeCursor({ occurredAt: last.occurred_at, id: last.id });
  }
  return { items, nextCursor };
}

export async function findTransaction(
  sql: Queryable,
  userId: string,
  transactionId: string,
): Promise<TransactionWithRelationsRow | null> {
  const rows = await sql<TransactionWithRelationsRow[]>`
    SELECT ${RELATION_SELECT(sql)}
    FROM transactions t
    ${RELATION_JOINS(sql)}
    WHERE t.id = ${transactionId} AND t.user_id = ${userId} AND t.deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateTransaction(
  sql: Queryable,
  userId: string,
  transactionId: string,
  input: {
    title?: string;
    description?: string | null;
    notes?: string | null;
    categoryId?: string | null;
    occurredAt?: Date;
  },
): Promise<TransactionRow | null> {
  const rows = await sql<TransactionRow[]>`
    UPDATE transactions SET
      title       = COALESCE(${input.title ?? null}, title),
      description = CASE WHEN ${input.description === null} THEN NULL
                         ELSE COALESCE(${input.description ?? null}, description) END,
      notes       = CASE WHEN ${input.notes === null} THEN NULL
                         ELSE COALESCE(${input.notes ?? null}, notes) END,
      category_id = CASE WHEN ${input.categoryId === null} THEN NULL
                         ELSE COALESCE(${input.categoryId ?? null}::uuid, category_id) END,
      occurred_at = COALESCE(${input.occurredAt ?? null}, occurred_at),
      updated_at  = now()
    WHERE id = ${transactionId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Soft delete. The cash-balance trigger reverses the row's contribution automatically. */
export async function softDeleteTransaction(
  sql: Queryable,
  userId: string,
  transactionId: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE transactions SET deleted_at = now(), updated_at = now()
    WHERE id = ${transactionId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/* ------------------------------------------------------- confirmation walker -- */

export async function listInFlightChainTransactions(
  sql: Queryable,
  options: { limit: number; olderThanSeconds: number },
): Promise<TransactionRow[]> {
  const rows = await sql<TransactionRow[]>`
    SELECT * FROM transactions
    WHERE status IN ('detected', 'confirming')
      AND kind = 'crypto'
      AND deleted_at IS NULL
      AND updated_at < now() - make_interval(secs => ${options.olderThanSeconds})
    ORDER BY updated_at ASC
    LIMIT ${options.limit}
  `;
  return [...rows];
}

export async function updateChainTransactionStatus(
  sql: Queryable,
  transactionId: string,
  update: { status: TxStatus; confirmations: number | null; blockNumber?: bigint | null },
): Promise<TransactionRow | null> {
  const rows = await sql<TransactionRow[]>`
    UPDATE transactions SET
      status        = ${update.status},
      confirmations = COALESCE(${update.confirmations}, confirmations),
      block_number  = COALESCE(${update.blockNumber?.toString() ?? null}::bigint, block_number),
      updated_at    = now()
    WHERE id = ${transactionId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------- analytics -- */

export interface PeriodTotalsRow {
  currency: FiatCode;
  income_minor: string;
  expense_minor: string;
}

/**
 * Income/expense totals over a window.
 *
 * Uses the stored `value_*_minor` snapshots so a historical report does not change when
 * today's exchange rate does. Rows with no valuation are excluded rather than assumed zero;
 * the caller surfaces that as a `partial` flag instead of quietly under-reporting.
 */
export async function periodTotals(
  sql: Queryable,
  userId: string,
  params: { from: Date; to: Date; currency: FiatCode },
): Promise<{ incomeMinor: bigint; expenseMinor: bigint; missingValuations: number }> {
  const column = params.currency === 'USD' ? sql`value_usd_minor` : sql`value_ils_minor`;
  const rows = await sql<Array<{ income_minor: string; expense_minor: string; missing: string }>>`
    SELECT
      COALESCE(SUM(${column}) FILTER (WHERE direction = 'in'), 0)  AS income_minor,
      COALESCE(SUM(-${column}) FILTER (WHERE direction = 'out'), 0) AS expense_minor,
      COUNT(*) FILTER (WHERE ${column} IS NULL)                     AS missing
    FROM transactions
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND status = 'confirmed'
      AND occurred_at >= ${params.from}
      AND occurred_at < ${params.to}
  `;
  const row = rows[0];
  return {
    incomeMinor: BigInt(row?.income_minor ?? '0'),
    expenseMinor: BigInt(row?.expense_minor ?? '0'),
    missingValuations: parseCount(row?.missing),
  };
}

export interface SeriesBucketRow {
  bucket: Date;
  income_minor: string;
  expense_minor: string;
}

export async function periodSeries(
  sql: Queryable,
  userId: string,
  params: { from: Date; to: Date; currency: FiatCode; bucket: 'day' | 'week' | 'month' },
): Promise<SeriesBucketRow[]> {
  const column = params.currency === 'USD' ? sql`value_usd_minor` : sql`value_ils_minor`;
  // `bucket` is a closed enum from a Zod-validated source, mapped to a literal here so no
  // caller-supplied text can reach date_trunc.
  const truncUnit = params.bucket === 'week' ? 'week' : params.bucket === 'month' ? 'month' : 'day';
  const rows = await sql<SeriesBucketRow[]>`
    SELECT
      date_trunc(${truncUnit}, occurred_at) AS bucket,
      COALESCE(SUM(${column}) FILTER (WHERE direction = 'in'), 0)   AS income_minor,
      COALESCE(SUM(-${column}) FILTER (WHERE direction = 'out'), 0) AS expense_minor
    FROM transactions
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND status = 'confirmed'
      AND occurred_at >= ${params.from}
      AND occurred_at < ${params.to}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  return [...rows];
}

export interface CategoryTotalRow {
  category_id: string | null;
  category_key: string | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
  amount_minor: string;
}

export async function categoryTotals(
  sql: Queryable,
  userId: string,
  params: { from: Date; to: Date; currency: FiatCode; direction: 'in' | 'out' },
): Promise<CategoryTotalRow[]> {
  const column = params.currency === 'USD' ? sql`t.value_usd_minor` : sql`t.value_ils_minor`;
  const rows = await sql<CategoryTotalRow[]>`
    SELECT
      t.category_id,
      c.key   AS category_key,
      c.name  AS category_name,
      c.icon  AS category_icon,
      c.color AS category_color,
      COALESCE(SUM(abs(${column})), 0) AS amount_minor
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ${userId}
      AND t.deleted_at IS NULL
      AND t.status = 'confirmed'
      AND t.direction = ${params.direction}
      AND t.occurred_at >= ${params.from}
      AND t.occurred_at < ${params.to}
    GROUP BY t.category_id, c.key, c.name, c.icon, c.color
    ORDER BY 6 DESC
    LIMIT 12
  `;
  return [...rows];
}
