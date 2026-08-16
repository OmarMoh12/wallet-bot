import {
  AppError,
  FiatAmount,
  type CreateCashTransactionRequest,
  type Page,
  type TransactionDto,
  type TransactionFilter,
} from '@wallet/shared';
import { accountsRepo, isUniqueViolation, transactionsRepo, type FiatCode } from '@wallet/db';
import { asUser, audit, fxPreference, type ServiceContext } from './base.js';
import { toTransactionDto } from '../mappers.js';

/**
 * Manual (cash) transactions and the unified history feed.
 *
 * The sign convention is enforced in three places — the request schema, this service, and a
 * CHECK constraint — because a sign error is silent and compounding. Money in is positive,
 * money out is negative, and `direction` must agree.
 */
export class TransactionService {
  /**
   * Record a manual cash transaction.
   *
   * Idempotent on `(user_id, idempotency_key)`. A retried request — a flaky connection, a
   * double tap — returns the original row instead of recording the money twice.
   */
  async createCash(
    context: ServiceContext,
    request: CreateCashTransactionRequest,
  ): Promise<TransactionDto> {
    const currency = request.currency as FiatCode;

    // Parse the amount exactly. `FiatAmount.parse` rejects more precision than the currency
    // supports rather than rounding it away.
    let amount: FiatAmount;
    try {
      amount = FiatAmount.parse(request.amount, currency);
    } catch {
      throw new AppError('VALIDATION_ERROR', { details: { field: 'amount' } });
    }
    if (amount.isZero()) throw new AppError('AMOUNT_TOO_SMALL');

    // Normalise sign from the declared type. An "expense" is stored negative regardless of
    // how the client sent it.
    let signed: FiatAmount;
    let direction: 'in' | 'out';
    if (request.type === 'income') {
      signed = amount.abs();
      direction = 'in';
    } else if (request.type === 'expense') {
      signed = amount.abs().negate();
      direction = 'out';
    } else {
      signed = amount;
      direction = amount.isNegative() ? 'out' : 'in';
    }

    const preference = await fxPreference(context);
    const usd = await context.app.currency.convert(signed, 'USD', preference);
    const ils = await context.app.currency.convert(signed, 'ILS', preference);

    const occurredAt = request.occurredAt ?? new Date();

    try {
      const row = await asUser(context, async (tx) => {
        const account = request.cashAccountId
          ? await accountsRepo.findCashAccount(tx, context.actor.userId, request.cashAccountId)
          : await accountsRepo.ensureCashAccount(tx, {
              userId: context.actor.userId,
              currency,
              name: currency === 'ILS' ? 'Cash (₪)' : 'Cash ($)',
            });

        if (!account) throw new AppError('CASH_ACCOUNT_NOT_FOUND');
        if (account.currency !== currency) throw new AppError('CURRENCY_MISMATCH');

        const created = await transactionsRepo.createCashTransaction(tx, {
          userId: context.actor.userId,
          type: request.type,
          direction,
          // Manual entries are immediately final: the user is asserting the money moved.
          status: 'confirmed',
          source: 'manual',
          title: request.title,
          description: request.description ?? null,
          notes: request.notes ?? null,
          categoryId: request.categoryId ?? null,
          occurredAt,
          cashAccountId: account.id,
          currency,
          amountMinor: signed.minor,
          valueUsdMinor: usd?.amount.minor ?? null,
          valueIlsMinor: ils?.amount.minor ?? null,
          usdIlsRate: usd?.rate.rate.toDecimalString(10) ?? null,
          externalRef: request.externalRef ?? null,
          idempotencyKey: request.idempotencyKey,
        });

        await audit(context, tx, {
          action: 'transaction.created',
          entityType: 'transaction',
          entityId: created.id,
          metadata: { kind: 'cash', type: request.type, currency },
        });

        return created;
      });

      return this.get(context, row.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Idempotent replay: return what was created the first time.
        const existing = await asUser(context, (tx) =>
          transactionsRepo.findByIdempotencyKey(tx, context.actor.userId, request.idempotencyKey),
        );
        if (existing) return this.get(context, existing.id);
        throw new AppError('IDEMPOTENCY_KEY_REUSED');
      }
      throw error;
    }
  }

  async list(context: ServiceContext, filter: TransactionFilter): Promise<Page<TransactionDto>> {
    const { limit, cursor, ...filters } = filter;
    const result = await asUser(context, (tx) =>
      transactionsRepo.listTransactions(tx, context.actor.userId, filters, {
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    );

    return {
      items: result.items.map((row) => toTransactionDto(row, (key) => context.t(key))),
      nextCursor: result.nextCursor,
    };
  }

  async get(context: ServiceContext, transactionId: string): Promise<TransactionDto> {
    const row = await asUser(context, (tx) =>
      transactionsRepo.findTransaction(tx, context.actor.userId, transactionId),
    );
    if (!row) throw new AppError('TRANSACTION_NOT_FOUND');
    return toTransactionDto(row, (key) => context.t(key));
  }

  /**
   * Edit descriptive fields only.
   *
   * Amount, currency, wallet and hash are deliberately immutable. Correcting an amount
   * means deleting and re-recording, which leaves both actions in the audit trail — editing
   * a historical amount in place would make the ledger unauditable.
   */
  async update(
    context: ServiceContext,
    transactionId: string,
    input: {
      title?: string;
      description?: string | null;
      notes?: string | null;
      categoryId?: string | null;
      occurredAt?: Date;
    },
  ): Promise<TransactionDto> {
    await asUser(context, async (tx) => {
      const updated = await transactionsRepo.updateTransaction(
        tx,
        context.actor.userId,
        transactionId,
        input,
      );
      if (!updated) throw new AppError('TRANSACTION_NOT_FOUND');
      await audit(context, tx, {
        action: 'transaction.updated',
        entityType: 'transaction',
        entityId: transactionId,
        metadata: { fields: Object.keys(input) },
      });
      return updated;
    });
    return this.get(context, transactionId);
  }

  /**
   * Soft delete.
   *
   * Chain-detected transactions cannot be deleted: they are a record of something that
   * demonstrably happened, and hiding them would desynchronise the ledger from the chain.
   */
  async remove(context: ServiceContext, transactionId: string): Promise<void> {
    await asUser(context, async (tx) => {
      const existing = await transactionsRepo.findTransaction(
        tx,
        context.actor.userId,
        transactionId,
      );
      if (!existing) throw new AppError('TRANSACTION_NOT_FOUND');
      if (existing.source === 'chain') {
        throw new AppError('FORBIDDEN', {
          internal: 'chain-detected transactions cannot be deleted',
          details: { reason: 'chain_transaction' },
        });
      }

      await transactionsRepo.softDeleteTransaction(tx, context.actor.userId, transactionId);
      await audit(context, tx, {
        action: 'transaction.deleted',
        entityType: 'transaction',
        entityId: transactionId,
      });
    });
  }

  /** Most recent activity, for the dashboard. */
  async recent(context: ServiceContext, limit = 5): Promise<TransactionDto[]> {
    const result = await asUser(context, (tx) =>
      transactionsRepo.listTransactions(tx, context.actor.userId, {}, { limit }),
    );
    return result.items.map((row) => toTransactionDto(row, (key) => context.t(key)));
  }
}
