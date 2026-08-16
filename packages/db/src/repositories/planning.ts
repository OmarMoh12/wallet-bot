import type { ExpectedIncomeStatus, ScheduledPaymentStatus } from '@wallet/shared';
import type { Queryable } from '../client.js';
import type {
  AssetRow,
  ExpectedIncomeRow,
  FinancialGoalRow,
  FiatCode,
  ScheduledPaymentRow,
  WalletRow,
} from '../types.js';

/* -------------------------------------------------------------- expected income -- */

export interface CreateExpectedIncomeInput {
  userId: string;
  name: string;
  reason: string | null;
  amountMinor: bigint;
  currency: FiatCode;
  expectedDate: string;
  remindAt: Date | null;
  categoryId: string | null;
  notes: string | null;
}

export async function createExpectedIncome(
  sql: Queryable,
  input: CreateExpectedIncomeInput,
): Promise<ExpectedIncomeRow> {
  const rows = await sql<ExpectedIncomeRow[]>`
    INSERT INTO expected_income
      (user_id, name, reason, amount_minor, currency, expected_date, remind_at, category_id, notes)
    VALUES (
      ${input.userId}, ${input.name}, ${input.reason}, ${input.amountMinor.toString()},
      ${input.currency}, ${input.expectedDate}, ${input.remindAt}, ${input.categoryId}, ${input.notes}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createExpectedIncome: no row returned');
  return row;
}

export async function listExpectedIncome(
  sql: Queryable,
  userId: string,
  options: { statuses?: ExpectedIncomeStatus[]; limit?: number } = {},
): Promise<ExpectedIncomeRow[]> {
  const statuses = options.statuses;
  const rows = await sql<ExpectedIncomeRow[]>`
    SELECT * FROM expected_income
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      ${statuses && statuses.length > 0 ? sql`AND status IN ${sql(statuses)}` : sql``}
    ORDER BY expected_date ASC, created_at ASC
    LIMIT ${options.limit ?? 100}
  `;
  return [...rows];
}

export async function findExpectedIncome(
  sql: Queryable,
  userId: string,
  id: string,
): Promise<ExpectedIncomeRow | null> {
  const rows = await sql<ExpectedIncomeRow[]>`
    SELECT * FROM expected_income
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateExpectedIncome(
  sql: Queryable,
  userId: string,
  id: string,
  input: {
    name?: string;
    reason?: string | null;
    amountMinor?: bigint;
    currency?: FiatCode;
    expectedDate?: string;
    remindAt?: Date | null;
    notes?: string | null;
  },
): Promise<ExpectedIncomeRow | null> {
  const rows = await sql<ExpectedIncomeRow[]>`
    UPDATE expected_income SET
      name          = COALESCE(${input.name ?? null}, name),
      reason        = CASE WHEN ${input.reason === null} THEN NULL
                           ELSE COALESCE(${input.reason ?? null}, reason) END,
      amount_minor  = COALESCE(${input.amountMinor?.toString() ?? null}::bigint, amount_minor),
      currency      = COALESCE(${input.currency ?? null}, currency),
      expected_date = COALESCE(${input.expectedDate ?? null}::date, expected_date),
      remind_at     = CASE WHEN ${input.remindAt === null} THEN NULL
                           ELSE COALESCE(${input.remindAt ?? null}, remind_at) END,
      notes         = CASE WHEN ${input.notes === null} THEN NULL
                           ELSE COALESCE(${input.notes ?? null}, notes) END,
      updated_at    = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Transition status. The database trigger rejects an illegal transition, so a concurrent
 * request cannot walk the row backwards through the state machine.
 */
export async function setExpectedIncomeStatus(
  sql: Queryable,
  userId: string,
  id: string,
  status: ExpectedIncomeStatus,
  receivedTransactionId?: string | null,
): Promise<ExpectedIncomeRow | null> {
  const rows = await sql<ExpectedIncomeRow[]>`
    UPDATE expected_income SET
      status = ${status},
      received_transaction_id = COALESCE(${receivedTransactionId ?? null}::uuid, received_transaction_id),
      updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function softDeleteExpectedIncome(
  sql: Queryable,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE expected_income SET deleted_at = now(), updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** Rows whose reminder is due. Runs unbound in the worker. */
export async function listExpectedIncomeReminders(
  sql: Queryable,
  limit: number,
): Promise<ExpectedIncomeRow[]> {
  const rows = await sql<ExpectedIncomeRow[]>`
    SELECT * FROM expected_income
    WHERE deleted_at IS NULL
      AND status IN ('pending', 'delayed')
      AND (
        (remind_at IS NOT NULL AND remind_at <= now() AND reminded_at IS NULL)
        OR (remind_at IS NULL AND expected_date <= current_date AND reminded_at IS NULL)
      )
    ORDER BY expected_date ASC
    LIMIT ${limit}
  `;
  return [...rows];
}

export async function listOverdueExpectedIncome(
  sql: Queryable,
  limit: number,
): Promise<ExpectedIncomeRow[]> {
  const rows = await sql<ExpectedIncomeRow[]>`
    SELECT * FROM expected_income
    WHERE deleted_at IS NULL
      AND status IN ('pending', 'delayed')
      AND expected_date < current_date
      AND (overdue_notified_at IS NULL OR overdue_notified_at < now() - interval '3 days')
    ORDER BY expected_date ASC
    LIMIT ${limit}
  `;
  return [...rows];
}

export async function markExpectedIncomeReminded(
  sql: Queryable,
  id: string,
  field: 'reminded_at' | 'overdue_notified_at',
): Promise<void> {
  if (field === 'reminded_at') {
    await sql`UPDATE expected_income SET reminded_at = now() WHERE id = ${id}`;
  } else {
    await sql`UPDATE expected_income SET overdue_notified_at = now() WHERE id = ${id}`;
  }
}

/* ------------------------------------------------------------ scheduled payments -- */

export interface CreateScheduledPaymentInput {
  userId: string;
  walletId: string;
  assetId: string;
  title: string | null;
  toAddress: string;
  toAddressCanonical: string;
  rawAmount: bigint;
  memo: string | null;
  scheduledAt: Date;
  notes: string | null;
  idempotencyKey: string;
}

export async function createScheduledPayment(
  sql: Queryable,
  input: CreateScheduledPaymentInput,
): Promise<ScheduledPaymentRow> {
  const rows = await sql<ScheduledPaymentRow[]>`
    INSERT INTO scheduled_payments (
      user_id, wallet_id, asset_id, title, to_address, to_address_canonical,
      raw_amount, memo, scheduled_at, notes, idempotency_key
    ) VALUES (
      ${input.userId}, ${input.walletId}, ${input.assetId}, ${input.title},
      ${input.toAddress}, ${input.toAddressCanonical}, ${input.rawAmount.toString()},
      ${input.memo}, ${input.scheduledAt}, ${input.notes}, ${input.idempotencyKey}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createScheduledPayment: no row returned');
  return row;
}

export interface ScheduledPaymentWithRelations extends ScheduledPaymentRow {
  wallet: WalletRow;
  asset: AssetRow;
}

export async function listScheduledPayments(
  sql: Queryable,
  userId: string,
  options: { statuses?: ScheduledPaymentStatus[]; limit?: number } = {},
): Promise<ScheduledPaymentWithRelations[]> {
  const statuses = options.statuses;
  const rows = await sql<ScheduledPaymentWithRelations[]>`
    SELECT s.*, to_jsonb(w.*) AS wallet, to_jsonb(a.*) AS asset
    FROM scheduled_payments s
    JOIN wallets w ON w.id = s.wallet_id
    JOIN assets a ON a.id = s.asset_id
    WHERE s.user_id = ${userId}
      AND s.deleted_at IS NULL
      ${statuses && statuses.length > 0 ? sql`AND s.status IN ${sql(statuses)}` : sql``}
    ORDER BY s.scheduled_at ASC
    LIMIT ${options.limit ?? 100}
  `;
  return [...rows];
}

export async function findScheduledPayment(
  sql: Queryable,
  userId: string,
  id: string,
): Promise<ScheduledPaymentWithRelations | null> {
  const rows = await sql<ScheduledPaymentWithRelations[]>`
    SELECT s.*, to_jsonb(w.*) AS wallet, to_jsonb(a.*) AS asset
    FROM scheduled_payments s
    JOIN wallets w ON w.id = s.wallet_id
    JOIN assets a ON a.id = s.asset_id
    WHERE s.id = ${id} AND s.user_id = ${userId} AND s.deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateScheduledPayment(
  sql: Queryable,
  userId: string,
  id: string,
  input: {
    title?: string | null;
    toAddress?: string;
    toAddressCanonical?: string;
    rawAmount?: bigint;
    memo?: string | null;
    scheduledAt?: Date;
    notes?: string | null;
  },
): Promise<ScheduledPaymentRow | null> {
  // Only a payment that has not started executing may be edited.
  const rows = await sql<ScheduledPaymentRow[]>`
    UPDATE scheduled_payments SET
      title                = CASE WHEN ${input.title === null} THEN NULL
                                  ELSE COALESCE(${input.title ?? null}, title) END,
      to_address           = COALESCE(${input.toAddress ?? null}, to_address),
      to_address_canonical = COALESCE(${input.toAddressCanonical ?? null}, to_address_canonical),
      raw_amount           = COALESCE(${input.rawAmount?.toString() ?? null}::numeric, raw_amount),
      memo                 = CASE WHEN ${input.memo === null} THEN NULL
                                  ELSE COALESCE(${input.memo ?? null}, memo) END,
      scheduled_at         = COALESCE(${input.scheduledAt ?? null}, scheduled_at),
      notes                = CASE WHEN ${input.notes === null} THEN NULL
                                  ELSE COALESCE(${input.notes ?? null}, notes) END,
      updated_at           = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
      AND status IN ('scheduled', 'failed')
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function setScheduledPaymentStatus(
  sql: Queryable,
  id: string,
  status: ScheduledPaymentStatus,
  extra: {
    errorCode?: string | null;
    executedTransactionId?: string | null;
    sendRequestId?: string | null;
    nextAttemptAt?: Date | null;
    releaseLock?: boolean;
  } = {},
): Promise<ScheduledPaymentRow | null> {
  const rows = await sql<ScheduledPaymentRow[]>`
    UPDATE scheduled_payments SET
      status                  = ${status},
      last_error_code         = ${extra.errorCode ?? null},
      last_error_at           = ${extra.errorCode ? new Date() : null},
      executed_transaction_id = COALESCE(${extra.executedTransactionId ?? null}::uuid, executed_transaction_id),
      send_request_id         = COALESCE(${extra.sendRequestId ?? null}::uuid, send_request_id),
      next_attempt_at         = ${extra.nextAttemptAt ?? null},
      locked_by               = CASE WHEN ${extra.releaseLock ?? false} THEN NULL ELSE locked_by END,
      locked_until            = CASE WHEN ${extra.releaseLock ?? false} THEN NULL ELSE locked_until END,
      updated_at              = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Claim due scheduled payments for execution.
 *
 * `FOR UPDATE SKIP LOCKED` plus a lease is what makes multi-worker execution safe: two
 * workers cannot both take the same row, and a worker that dies releases its claim when the
 * lease expires. The status move to `processing` happens in the same statement, so there is
 * no window where a row is claimed but still looks schedulable.
 */
export async function claimDueScheduledPayments(
  sql: Queryable,
  options: { worker: string; limit: number; leaseSeconds: number },
): Promise<ScheduledPaymentRow[]> {
  const rows = await sql<ScheduledPaymentRow[]>`
    WITH due AS (
      SELECT id FROM scheduled_payments
      WHERE status = 'scheduled'
        AND deleted_at IS NULL
        AND scheduled_at <= now()
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY scheduled_at ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE scheduled_payments s
    SET status = 'processing',
        attempts = s.attempts + 1,
        locked_by = ${options.worker},
        locked_until = now() + make_interval(secs => ${options.leaseSeconds}),
        updated_at = now()
    FROM due
    WHERE s.id = due.id
    RETURNING s.*
  `;
  return [...rows];
}

/** Payments starting soon, for the "upcoming" reminder. */
export async function listUpcomingScheduledPayments(
  sql: Queryable,
  options: { withinSeconds: number; limit: number },
): Promise<ScheduledPaymentRow[]> {
  const rows = await sql<ScheduledPaymentRow[]>`
    SELECT * FROM scheduled_payments
    WHERE status = 'scheduled'
      AND deleted_at IS NULL
      AND upcoming_notified_at IS NULL
      AND scheduled_at BETWEEN now() AND now() + make_interval(secs => ${options.withinSeconds})
    ORDER BY scheduled_at ASC
    LIMIT ${options.limit}
  `;
  return [...rows];
}

export async function markScheduledUpcomingNotified(sql: Queryable, id: string): Promise<void> {
  await sql`UPDATE scheduled_payments SET upcoming_notified_at = now() WHERE id = ${id}`;
}

export async function cancelScheduledPayment(
  sql: Queryable,
  userId: string,
  id: string,
): Promise<ScheduledPaymentRow | null> {
  const rows = await sql<ScheduledPaymentRow[]>`
    UPDATE scheduled_payments SET status = 'cancelled', updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
      AND status IN ('scheduled', 'failed')
    RETURNING *
  `;
  return rows[0] ?? null;
}

/* --------------------------------------------------------------------- goals -- */

export async function listGoals(sql: Queryable, userId: string): Promise<FinancialGoalRow[]> {
  const rows = await sql<FinancialGoalRow[]>`
    SELECT * FROM financial_goals
    WHERE user_id = ${userId} AND deleted_at IS NULL AND status <> 'archived'
    ORDER BY status ASC, created_at ASC
  `;
  return [...rows];
}

export async function findGoal(
  sql: Queryable,
  userId: string,
  id: string,
): Promise<FinancialGoalRow | null> {
  const rows = await sql<FinancialGoalRow[]>`
    SELECT * FROM financial_goals
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createGoal(
  sql: Queryable,
  input: {
    userId: string;
    name: string;
    targetMinor: bigint;
    currentMinor: bigint;
    currency: FiatCode;
    deadline: string | null;
    icon: string | null;
    color: string | null;
    notes: string | null;
  },
): Promise<FinancialGoalRow> {
  const rows = await sql<FinancialGoalRow[]>`
    INSERT INTO financial_goals
      (user_id, name, target_minor, current_minor, currency, deadline, icon, color, notes)
    VALUES (
      ${input.userId}, ${input.name}, ${input.targetMinor.toString()},
      ${input.currentMinor.toString()}, ${input.currency}, ${input.deadline},
      ${input.icon}, ${input.color}, ${input.notes}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createGoal: no row returned');
  return row;
}

export async function updateGoal(
  sql: Queryable,
  userId: string,
  id: string,
  input: {
    name?: string;
    targetMinor?: bigint;
    currentMinor?: bigint;
    deadline?: string | null;
    status?: 'active' | 'achieved' | 'archived';
    notes?: string | null;
  },
): Promise<FinancialGoalRow | null> {
  const rows = await sql<FinancialGoalRow[]>`
    UPDATE financial_goals SET
      name          = COALESCE(${input.name ?? null}, name),
      target_minor  = COALESCE(${input.targetMinor?.toString() ?? null}::bigint, target_minor),
      current_minor = COALESCE(${input.currentMinor?.toString() ?? null}::bigint, current_minor),
      deadline      = CASE WHEN ${input.deadline === null} THEN NULL
                           ELSE COALESCE(${input.deadline ?? null}::date, deadline) END,
      status        = COALESCE(${input.status ?? null}, status),
      notes         = CASE WHEN ${input.notes === null} THEN NULL
                           ELSE COALESCE(${input.notes ?? null}, notes) END,
      updated_at    = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Atomic increment — safe under concurrent contributions. */
export async function contributeToGoal(
  sql: Queryable,
  userId: string,
  id: string,
  deltaMinor: bigint,
): Promise<FinancialGoalRow | null> {
  const rows = await sql<FinancialGoalRow[]>`
    UPDATE financial_goals
    SET current_minor = GREATEST(current_minor + ${deltaMinor.toString()}::bigint, 0),
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function softDeleteGoal(sql: Queryable, userId: string, id: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE financial_goals SET deleted_at = now(), updated_at = now()
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}
