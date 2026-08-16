import {
  AppError,
  FiatAmount,
  TokenAmount,
  assetKey,
  jobKey,
  type CreateExpectedIncomeRequest,
  type CreateScheduledPaymentRequest,
  type ExpectedIncomeDto,
  type ExpectedIncomeStatus,
  type GoalDto,
  type ScheduledPaymentDto,
} from '@wallet/shared';
import { validateAddress } from '@wallet/blockchain';
import {
  accountsRepo,
  isUniqueViolation,
  opsRepo,
  planningRepo,
  transactionsRepo,
  walletsRepo,
  type ExpectedIncomeRow,
  type FiatCode,
} from '@wallet/db';
import { asUser, audit, fxPreference, type ServiceContext } from './base.js';
import {
  toCategoryDto,
  toExpectedIncomeDto,
  toGoalDto,
  toScheduledPaymentDto,
} from '../mappers.js';

/**
 * Forward-looking money: expected income, scheduled payments, and goals.
 *
 * A scheduled payment created here is an **intent**, never an authorisation to move funds.
 * Execution runs through the same guarded send pipeline as a manual transfer and is refused
 * outright while sending is disabled — which is the default.
 */
export class PlanningService {
  /* --------------------------------------------------------- expected income -- */

  async listExpectedIncome(
    context: ServiceContext,
    options: { statuses?: ExpectedIncomeStatus[] } = {},
  ): Promise<ExpectedIncomeDto[]> {
    const rows = await asUser(context, (tx) =>
      planningRepo.listExpectedIncome(tx, context.actor.userId, options),
    );
    return this.decorateExpectedIncome(context, rows);
  }

  private async decorateExpectedIncome(
    context: ServiceContext,
    rows: ExpectedIncomeRow[],
  ): Promise<ExpectedIncomeDto[]> {
    const preference = await fxPreference(context);
    const categories = await asUser(context, (tx) =>
      accountsRepo.listCategories(tx, context.actor.userId),
    );
    const byId = new Map(categories.map((category) => [category.id, category]));

    const output: ExpectedIncomeDto[] = [];
    for (const row of rows) {
      const amount = FiatAmount.fromMinor(row.amount_minor, row.currency);
      const usd = await context.app.currency.convert(amount, 'USD', preference);
      const category = row.category_id ? byId.get(row.category_id) : undefined;
      output.push(
        toExpectedIncomeDto(row, {
          usdMinor: usd?.amount.minor ?? null,
          category: category ? toCategoryDto(category, (key) => context.t(key)) : null,
        }),
      );
    }
    return output;
  }

  async createExpectedIncome(
    context: ServiceContext,
    request: CreateExpectedIncomeRequest,
  ): Promise<ExpectedIncomeDto> {
    const amount = FiatAmount.parse(request.amount, request.currency);
    if (!amount.isPositive()) throw new AppError('AMOUNT_TOO_SMALL');

    const row = await asUser(context, async (tx) => {
      const created = await planningRepo.createExpectedIncome(tx, {
        userId: context.actor.userId,
        name: request.name,
        reason: request.reason ?? null,
        amountMinor: amount.minor,
        currency: request.currency as FiatCode,
        expectedDate: request.expectedDate,
        remindAt: request.remindAt ?? null,
        categoryId: request.categoryId ?? null,
        notes: request.notes ?? null,
      });
      await audit(context, tx, {
        action: 'expected_income.created',
        entityType: 'expected_income',
        entityId: created.id,
      });
      return created;
    });

    const [dto] = await this.decorateExpectedIncome(context, [row]);
    if (!dto) throw new AppError('INTERNAL_ERROR');
    return dto;
  }

  async updateExpectedIncome(
    context: ServiceContext,
    id: string,
    input: {
      name?: string;
      reason?: string | null;
      amount?: string;
      currency?: FiatCode;
      expectedDate?: string;
      remindAt?: Date | null;
      notes?: string | null;
    },
  ): Promise<ExpectedIncomeDto> {
    const row = await asUser(context, async (tx) => {
      const existing = await planningRepo.findExpectedIncome(tx, context.actor.userId, id);
      if (!existing) throw new AppError('EXPECTED_INCOME_NOT_FOUND');

      const currency = input.currency ?? existing.currency;
      const amountMinor =
        input.amount === undefined ? undefined : FiatAmount.parse(input.amount, currency).minor;

      const updated = await planningRepo.updateExpectedIncome(tx, context.actor.userId, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.expectedDate !== undefined ? { expectedDate: input.expectedDate } : {}),
        ...(input.remindAt !== undefined ? { remindAt: input.remindAt } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      if (!updated) throw new AppError('EXPECTED_INCOME_NOT_FOUND');

      await audit(context, tx, {
        action: 'expected_income.updated',
        entityType: 'expected_income',
        entityId: id,
      });
      return updated;
    });

    const [dto] = await this.decorateExpectedIncome(context, [row]);
    if (!dto) throw new AppError('INTERNAL_ERROR');
    return dto;
  }

  /**
   * Change status, optionally recording the money in the ledger.
   *
   * When marking `received` with `createTransaction`, the income row and the ledger entry
   * are written in ONE transaction and linked, so the two can never disagree about whether
   * the money arrived.
   */
  async setExpectedIncomeStatus(
    context: ServiceContext,
    id: string,
    params: {
      status: ExpectedIncomeStatus;
      createTransaction: boolean;
      cashAccountId?: string;
      idempotencyKey?: string;
    },
  ): Promise<ExpectedIncomeDto> {
    const preference = await fxPreference(context);

    const row = await asUser(context, async (tx) => {
      const existing = await planningRepo.findExpectedIncome(tx, context.actor.userId, id);
      if (!existing) throw new AppError('EXPECTED_INCOME_NOT_FOUND');

      let transactionId: string | null = null;

      if (params.status === 'received' && params.createTransaction) {
        const amount = FiatAmount.fromMinor(existing.amount_minor, existing.currency);
        const usd = await context.app.currency.convert(amount, 'USD', preference);
        const ils = await context.app.currency.convert(amount, 'ILS', preference);

        const account = params.cashAccountId
          ? await accountsRepo.findCashAccount(tx, context.actor.userId, params.cashAccountId)
          : await accountsRepo.ensureCashAccount(tx, {
              userId: context.actor.userId,
              currency: existing.currency,
              name: existing.currency === 'ILS' ? 'Cash (₪)' : 'Cash ($)',
            });
        if (!account) throw new AppError('CASH_ACCOUNT_NOT_FOUND');

        const created = await transactionsRepo.createCashTransaction(tx, {
          userId: context.actor.userId,
          type: 'income',
          direction: 'in',
          status: 'confirmed',
          source: 'system',
          title: existing.name,
          description: existing.reason,
          notes: null,
          categoryId: existing.category_id,
          occurredAt: new Date(),
          cashAccountId: account.id,
          currency: existing.currency,
          amountMinor: amount.minor,
          valueUsdMinor: usd?.amount.minor ?? null,
          valueIlsMinor: ils?.amount.minor ?? null,
          usdIlsRate: usd?.rate.rate.toDecimalString(10) ?? null,
          externalRef: null,
          // Namespaced by the income row so marking "received" twice cannot double-count.
          idempotencyKey: params.idempotencyKey ?? `expected-income:${existing.id}`,
        });
        transactionId = created.id;
      }

      const updated = await planningRepo.setExpectedIncomeStatus(
        tx,
        context.actor.userId,
        id,
        params.status,
        transactionId,
      );
      if (!updated) throw new AppError('EXPECTED_INCOME_NOT_FOUND');

      await audit(context, tx, {
        action: 'expected_income.updated',
        entityType: 'expected_income',
        entityId: id,
        metadata: { status: params.status, transactionId },
      });
      return updated;
    });

    const [dto] = await this.decorateExpectedIncome(context, [row]);
    if (!dto) throw new AppError('INTERNAL_ERROR');
    return dto;
  }

  async removeExpectedIncome(context: ServiceContext, id: string): Promise<void> {
    await asUser(context, async (tx) => {
      const removed = await planningRepo.softDeleteExpectedIncome(tx, context.actor.userId, id);
      if (!removed) throw new AppError('EXPECTED_INCOME_NOT_FOUND');
      await audit(context, tx, {
        action: 'expected_income.updated',
        entityType: 'expected_income',
        entityId: id,
        metadata: { deleted: true },
      });
    });
  }

  /* ------------------------------------------------------ scheduled payments -- */

  async listScheduledPayments(context: ServiceContext): Promise<ScheduledPaymentDto[]> {
    const rows = await asUser(context, (tx) =>
      planningRepo.listScheduledPayments(tx, context.actor.userId),
    );
    const preference = await fxPreference(context);
    const executable = context.app.config.sending.enabled;

    const output: ScheduledPaymentDto[] = [];
    for (const row of rows) {
      const usdMinor = await this.valueScheduled(context, row.raw_amount, row.asset, preference);
      output.push(
        toScheduledPaymentDto(row, {
          wallet: row.wallet,
          asset: row.asset,
          usdMinor,
          executable,
        }),
      );
    }
    return output;
  }

  private async valueScheduled(
    context: ServiceContext,
    rawAmount: string,
    asset: {
      id: string;
      symbol: string;
      decimals: number;
      price_id: string | null;
      network: string;
      env: string;
      contract_address: string | null;
    },
    preference: { mode: 'auto' | 'manual'; manualUsdIls: string | null },
  ): Promise<bigint | null> {
    const prices = await context.app.currency.getPrices([
      { id: asset.id, symbol: asset.symbol, priceId: asset.price_id },
    ]);
    const amount = TokenAmount.fromRaw(rawAmount, {
      assetKey: asset.id,
      symbol: asset.symbol,
      decimals: asset.decimals,
    });
    const valued = await context.app.currency.valueToken(amount, prices.get(asset.id), preference);
    return valued.usd?.minor ?? null;
  }

  /**
   * Create a scheduled payment.
   *
   * Everything that can be validated now is validated now — address, network match, amount,
   * future timestamp — so the user finds out about a mistake while they are looking at the
   * screen, not silently at 3 a.m. when the job runs. The pre-flight checks run again at
   * execution time, because balances and network conditions change.
   */
  async createScheduledPayment(
    context: ServiceContext,
    request: CreateScheduledPaymentRequest,
  ): Promise<ScheduledPaymentDto> {
    if (request.scheduledAt.getTime() <= Date.now()) {
      throw new AppError('SCHEDULE_IN_PAST');
    }

    const prepared = await asUser(context, async (tx) => {
      const wallet = await walletsRepo.findWallet(tx, context.actor.userId, request.walletId);
      if (!wallet) throw new AppError('WALLET_NOT_FOUND');
      if (!wallet.is_active) throw new AppError('WALLET_INACTIVE');

      const asset = await opsRepo.findAsset(tx, request.assetId);
      if (!asset) throw new AppError('ASSET_NOT_FOUND');
      if (asset.network !== wallet.network || asset.env !== wallet.env) {
        throw new AppError('ASSET_NOT_SUPPORTED', {
          details: { reason: 'asset does not belong to the wallet network' },
        });
      }
      return { wallet, asset };
    });

    const validation = validateAddress(prepared.wallet.network, request.toAddress);
    if (!validation.valid) {
      throw new AppError('INVALID_ADDRESS', {
        details: { network: prepared.wallet.network, reason: validation.reason },
      });
    }
    if (validation.canonical === prepared.wallet.address_canonical) {
      throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    }

    const amount = TokenAmount.parse(request.amount, {
      assetKey: assetKey({
        network: prepared.asset.network,
        env: prepared.asset.env,
        contractAddress: prepared.asset.contract_address,
        symbol: prepared.asset.symbol,
      }),
      symbol: prepared.asset.symbol,
      decimals: prepared.asset.decimals,
    });
    if (!amount.isPositive()) throw new AppError('AMOUNT_TOO_SMALL');

    try {
      const row = await asUser(context, async (tx) => {
        const created = await planningRepo.createScheduledPayment(tx, {
          userId: context.actor.userId,
          walletId: prepared.wallet.id,
          assetId: prepared.asset.id,
          title: request.title ?? null,
          toAddress: validation.display,
          toAddressCanonical: validation.canonical,
          rawAmount: amount.raw,
          memo: request.memo ?? null,
          scheduledAt: request.scheduledAt,
          notes: request.notes ?? null,
          idempotencyKey: request.idempotencyKey,
        });

        await audit(context, tx, {
          action: 'schedule.created',
          entityType: 'scheduled_payment',
          entityId: created.id,
          metadata: {
            network: prepared.wallet.network,
            symbol: prepared.asset.symbol,
            scheduledAt: request.scheduledAt.toISOString(),
          },
        });
        return created;
      });

      const preference = await fxPreference(context);
      const usdMinor = await this.valueScheduled(
        context,
        row.raw_amount,
        prepared.asset,
        preference,
      );

      return toScheduledPaymentDto(row, {
        wallet: prepared.wallet,
        asset: prepared.asset,
        usdMinor,
        executable: context.app.config.sending.enabled,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await asUser(context, (tx) =>
          planningRepo.listScheduledPayments(tx, context.actor.userId),
        );
        const match = existing.find((row) => row.idempotency_key === request.idempotencyKey);
        if (match) {
          const preference = await fxPreference(context);
          return toScheduledPaymentDto(match, {
            wallet: match.wallet,
            asset: match.asset,
            usdMinor: await this.valueScheduled(context, match.raw_amount, match.asset, preference),
            executable: context.app.config.sending.enabled,
          });
        }
        throw new AppError('IDEMPOTENCY_KEY_REUSED');
      }
      throw error;
    }
  }

  async cancelScheduledPayment(context: ServiceContext, id: string): Promise<ScheduledPaymentDto> {
    const row = await asUser(context, async (tx) => {
      const cancelled = await planningRepo.cancelScheduledPayment(tx, context.actor.userId, id);
      if (!cancelled) {
        // Either it does not exist, or it is already executing/completed.
        const existing = await planningRepo.findScheduledPayment(tx, context.actor.userId, id);
        throw new AppError(existing ? 'SCHEDULE_NOT_CANCELLABLE' : 'SCHEDULED_PAYMENT_NOT_FOUND');
      }
      await audit(context, tx, {
        action: 'schedule.cancelled',
        entityType: 'scheduled_payment',
        entityId: id,
      });
      return cancelled;
    });

    const full = await asUser(context, (tx) =>
      planningRepo.findScheduledPayment(tx, context.actor.userId, row.id),
    );
    if (!full) throw new AppError('SCHEDULED_PAYMENT_NOT_FOUND');

    const preference = await fxPreference(context);
    return toScheduledPaymentDto(full, {
      wallet: full.wallet,
      asset: full.asset,
      usdMinor: await this.valueScheduled(context, full.raw_amount, full.asset, preference),
      executable: false,
    });
  }

  /** Queue an immediate execution attempt for a payment that is already due-able. */
  async runScheduledPaymentNow(context: ServiceContext, id: string): Promise<void> {
    if (!context.app.config.sending.enabled) throw new AppError('SENDING_DISABLED');

    const row = await asUser(context, (tx) =>
      planningRepo.findScheduledPayment(tx, context.actor.userId, id),
    );
    if (!row) throw new AppError('SCHEDULED_PAYMENT_NOT_FOUND');
    if (row.status !== 'scheduled' && row.status !== 'failed') {
      throw new AppError('INVALID_STATE_TRANSITION', {
        details: { entity: 'scheduled_payment', from: row.status, to: 'processing' },
      });
    }

    await asUser(context, async (tx) => {
      await tx`
        UPDATE scheduled_payments
        SET scheduled_at = now(), status = 'scheduled', next_attempt_at = NULL, updated_at = now()
        WHERE id = ${id} AND user_id = ${context.actor.userId}
      `;
      await audit(context, tx, {
        action: 'schedule.updated',
        entityType: 'scheduled_payment',
        entityId: id,
        metadata: { runNow: true },
      });
    });

    await context.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', '', true)`;
      await opsRepo.enqueueJob(tx, {
        type: 'schedule.tick',
        payload: { scheduledPaymentId: id },
        dedupeKey: jobKey('schedule.tick', 'manual', id),
        priority: 5,
      });
    });
  }

  /* ---------------------------------------------------------------- goals -- */

  async listGoals(context: ServiceContext): Promise<GoalDto[]> {
    const rows = await asUser(context, (tx) => planningRepo.listGoals(tx, context.actor.userId));
    return rows.map(toGoalDto);
  }

  async createGoal(
    context: ServiceContext,
    input: {
      name: string;
      targetAmount: string;
      currency: FiatCode;
      currentAmount?: string;
      deadline?: string;
      icon?: string;
      color?: string;
      notes?: string;
    },
  ): Promise<GoalDto> {
    const target = FiatAmount.parse(input.targetAmount, input.currency);
    if (!target.isPositive()) throw new AppError('AMOUNT_TOO_SMALL');
    const current = input.currentAmount
      ? FiatAmount.parse(input.currentAmount, input.currency)
      : FiatAmount.zero(input.currency);

    const row = await asUser(context, async (tx) => {
      const created = await planningRepo.createGoal(tx, {
        userId: context.actor.userId,
        name: input.name,
        targetMinor: target.minor,
        currentMinor: current.minor,
        currency: input.currency,
        deadline: input.deadline ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        notes: input.notes ?? null,
      });
      await audit(context, tx, {
        action: 'goal.created',
        entityType: 'financial_goal',
        entityId: created.id,
      });
      return created;
    });
    return toGoalDto(row);
  }

  async updateGoal(
    context: ServiceContext,
    id: string,
    input: {
      name?: string;
      targetAmount?: string;
      currentAmount?: string;
      deadline?: string | null;
      status?: 'active' | 'achieved' | 'archived';
      notes?: string | null;
    },
  ): Promise<GoalDto> {
    const row = await asUser(context, async (tx) => {
      const existing = await planningRepo.findGoal(tx, context.actor.userId, id);
      if (!existing) throw new AppError('GOAL_NOT_FOUND');

      const updated = await planningRepo.updateGoal(tx, context.actor.userId, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.targetAmount !== undefined
          ? { targetMinor: FiatAmount.parse(input.targetAmount, existing.currency).minor }
          : {}),
        ...(input.currentAmount !== undefined
          ? { currentMinor: FiatAmount.parse(input.currentAmount, existing.currency).minor }
          : {}),
        ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      if (!updated) throw new AppError('GOAL_NOT_FOUND');
      await audit(context, tx, {
        action: 'goal.updated',
        entityType: 'financial_goal',
        entityId: id,
      });
      return updated;
    });
    return toGoalDto(row);
  }

  /** Atomic contribution — safe against concurrent taps. */
  async contributeToGoal(
    context: ServiceContext,
    id: string,
    amountText: string,
  ): Promise<GoalDto> {
    const row = await asUser(context, async (tx) => {
      const existing = await planningRepo.findGoal(tx, context.actor.userId, id);
      if (!existing) throw new AppError('GOAL_NOT_FOUND');

      const delta = FiatAmount.parse(amountText, existing.currency);
      const updated = await planningRepo.contributeToGoal(
        tx,
        context.actor.userId,
        id,
        delta.minor,
      );
      if (!updated) throw new AppError('GOAL_NOT_FOUND');

      await audit(context, tx, {
        action: 'goal.updated',
        entityType: 'financial_goal',
        entityId: id,
        metadata: { contributedMinor: delta.minor.toString() },
      });
      return updated;
    });
    return toGoalDto(row);
  }

  async removeGoal(context: ServiceContext, id: string): Promise<void> {
    await asUser(context, async (tx) => {
      const removed = await planningRepo.softDeleteGoal(tx, context.actor.userId, id);
      if (!removed) throw new AppError('GOAL_NOT_FOUND');
      await audit(context, tx, {
        action: 'goal.updated',
        entityType: 'financial_goal',
        entityId: id,
        metadata: { deleted: true },
      });
    });
  }
}
