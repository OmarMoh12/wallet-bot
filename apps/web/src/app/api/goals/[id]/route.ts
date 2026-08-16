import { AppError, updateGoalRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function goalId(params: Record<string, string>): string {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('GOAL_NOT_FOUND');
  return parsed.data;
}

export const PATCH = route(
  { bucket: 'write', bodySchema: updateGoalRequestSchema },
  async ({ service, params, body }) =>
    getServices().planning.updateGoal(service, goalId(params), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.targetAmount !== undefined ? { targetAmount: body.targetAmount } : {}),
      ...(body.currentAmount !== undefined ? { currentAmount: body.currentAmount } : {}),
      ...(body.deadline !== undefined ? { deadline: body.deadline ?? null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    }),
);

export const DELETE = route({ bucket: 'write' }, async ({ service, params }) => {
  await getServices().planning.removeGoal(service, goalId(params));
  return { ok: true };
});
