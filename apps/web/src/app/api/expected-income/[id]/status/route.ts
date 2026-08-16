import { AppError, expectedIncomeStatusRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mark expected income received / delayed / cancelled.
 *
 * When marking received, the ledger entry and the status change commit together, so the two
 * can never disagree about whether the money arrived.
 */
export const POST = route(
  { bucket: 'write', bodySchema: expectedIncomeStatusRequestSchema },
  async ({ service, params, body }) => {
    const parsed = uuidSchema.safeParse(params.id);
    if (!parsed.success) throw new AppError('EXPECTED_INCOME_NOT_FOUND');

    return getServices().planning.setExpectedIncomeStatus(service, parsed.data, {
      status: body.status,
      createTransaction: body.createTransaction,
      ...(body.cashAccountId ? { cashAccountId: body.cashAccountId } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
  },
);
