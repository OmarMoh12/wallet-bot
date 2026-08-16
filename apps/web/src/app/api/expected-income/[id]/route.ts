import { AppError, updateExpectedIncomeRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function incomeId(params: Record<string, string>): string {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('EXPECTED_INCOME_NOT_FOUND');
  return parsed.data;
}

export const PATCH = route(
  { bucket: 'write', bodySchema: updateExpectedIncomeRequestSchema },
  async ({ service, params, body }) =>
    getServices().planning.updateExpectedIncome(service, incomeId(params), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.expectedDate !== undefined ? { expectedDate: body.expectedDate } : {}),
      ...(body.remindAt !== undefined ? { remindAt: body.remindAt ?? null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    }),
);

export const DELETE = route({ bucket: 'write' }, async ({ service, params }) => {
  await getServices().planning.removeExpectedIncome(service, incomeId(params));
  return { ok: true };
});
