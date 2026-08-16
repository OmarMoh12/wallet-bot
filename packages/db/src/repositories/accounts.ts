import { parseCount, type CategoryKind } from '@wallet/shared';
import type { Queryable } from '../client.js';
import type { CashAccountRow, CategoryRow, FiatCode } from '../types.js';

/* ------------------------------------------------------------- cash accounts -- */

export async function listCashAccounts(sql: Queryable, userId: string): Promise<CashAccountRow[]> {
  const rows = await sql<CashAccountRow[]>`
    SELECT * FROM cash_accounts
    WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY is_default DESC, created_at ASC
  `;
  return [...rows];
}

export async function findCashAccount(
  sql: Queryable,
  userId: string,
  accountId: string,
): Promise<CashAccountRow | null> {
  const rows = await sql<CashAccountRow[]>`
    SELECT * FROM cash_accounts
    WHERE id = ${accountId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findDefaultCashAccount(
  sql: Queryable,
  userId: string,
  currency: FiatCode,
): Promise<CashAccountRow | null> {
  const rows = await sql<CashAccountRow[]>`
    SELECT * FROM cash_accounts
    WHERE user_id = ${userId} AND currency = ${currency} AND deleted_at IS NULL
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createCashAccount(
  sql: Queryable,
  input: { userId: string; name: string; currency: FiatCode; isDefault: boolean },
): Promise<CashAccountRow> {
  // Only one default per user; clear the previous one first.
  if (input.isDefault) {
    await sql`
      UPDATE cash_accounts SET is_default = false, updated_at = now()
      WHERE user_id = ${input.userId} AND is_default AND deleted_at IS NULL
    `;
  }
  const rows = await sql<CashAccountRow[]>`
    INSERT INTO cash_accounts (user_id, name, currency, is_default)
    VALUES (${input.userId}, ${input.name}, ${input.currency}, ${input.isDefault})
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createCashAccount: no row returned');
  return row;
}

/**
 * Ensure the user has a cash account in `currency`, creating one on first use.
 * Called from the manual-transaction path so the UI never has to ask about accounts.
 */
export async function ensureCashAccount(
  sql: Queryable,
  input: { userId: string; currency: FiatCode; name: string },
): Promise<CashAccountRow> {
  const existing = await findDefaultCashAccount(sql, input.userId, input.currency);
  if (existing) return existing;
  const anyAccount = await listCashAccounts(sql, input.userId);
  return createCashAccount(sql, {
    userId: input.userId,
    name: input.name,
    currency: input.currency,
    isDefault: anyAccount.length === 0,
  });
}

/**
 * Recompute a cached balance from the ledger and return it.
 * The invariant `cache == sum(confirmed, non-deleted rows)` is asserted by tests.
 */
export async function recomputeCashBalance(sql: Queryable, accountId: string): Promise<bigint> {
  const rows = await sql<Array<{ recompute_cash_balance: string }>>`
    SELECT app.recompute_cash_balance(${accountId}) AS recompute_cash_balance
  `;
  return BigInt(rows[0]?.recompute_cash_balance ?? '0');
}

/** Total cash per currency, for the dashboard. */
export async function cashTotals(
  sql: Queryable,
  userId: string,
): Promise<Array<{ currency: FiatCode; total_minor: string }>> {
  const rows = await sql<Array<{ currency: FiatCode; total_minor: string }>>`
    SELECT currency, COALESCE(SUM(balance_minor), 0) AS total_minor
    FROM cash_accounts
    WHERE user_id = ${userId} AND deleted_at IS NULL
    GROUP BY currency
  `;
  return [...rows];
}

/* ---------------------------------------------------------------- categories -- */

export async function listCategories(sql: Queryable, userId: string): Promise<CategoryRow[]> {
  const rows = await sql<CategoryRow[]>`
    SELECT * FROM categories
    WHERE (is_system OR user_id = ${userId}) AND deleted_at IS NULL
    ORDER BY is_system DESC, sort_order ASC, name ASC NULLS LAST
  `;
  return [...rows];
}

export async function findCategory(
  sql: Queryable,
  userId: string,
  categoryId: string,
): Promise<CategoryRow | null> {
  const rows = await sql<CategoryRow[]>`
    SELECT * FROM categories
    WHERE id = ${categoryId} AND (is_system OR user_id = ${userId}) AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findCategoryByKey(sql: Queryable, key: string): Promise<CategoryRow | null> {
  const rows = await sql<CategoryRow[]>`
    SELECT * FROM categories WHERE key = ${key} AND is_system AND deleted_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createCategory(
  sql: Queryable,
  input: {
    userId: string;
    name: string;
    kind: CategoryKind;
    icon: string | null;
    color: string | null;
  },
): Promise<CategoryRow> {
  const rows = await sql<CategoryRow[]>`
    INSERT INTO categories (user_id, name, kind, icon, color, is_system)
    VALUES (${input.userId}, ${input.name}, ${input.kind}, ${input.icon}, ${input.color}, false)
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createCategory: no row returned');
  return row;
}

export async function updateCategory(
  sql: Queryable,
  userId: string,
  categoryId: string,
  input: { name?: string; kind?: CategoryKind; icon?: string | null; color?: string | null },
): Promise<CategoryRow | null> {
  const rows = await sql<CategoryRow[]>`
    UPDATE categories SET
      name  = COALESCE(${input.name ?? null}, name),
      kind  = COALESCE(${input.kind ?? null}, kind),
      icon  = CASE WHEN ${input.icon === null} THEN NULL ELSE COALESCE(${input.icon ?? null}, icon) END,
      color = CASE WHEN ${input.color === null} THEN NULL ELSE COALESCE(${input.color ?? null}, color) END,
      updated_at = now()
    WHERE id = ${categoryId} AND user_id = ${userId} AND NOT is_system AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function countCategoryUsage(
  sql: Queryable,
  userId: string,
  categoryId: string,
): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT COUNT(*) AS count FROM transactions
    WHERE user_id = ${userId} AND category_id = ${categoryId} AND deleted_at IS NULL
  `;
  return parseCount(rows[0]?.count);
}

export async function softDeleteCategory(
  sql: Queryable,
  userId: string,
  categoryId: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE categories SET deleted_at = now(), updated_at = now()
    WHERE id = ${categoryId} AND user_id = ${userId} AND NOT is_system AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}
