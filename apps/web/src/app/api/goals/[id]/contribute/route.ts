import { AppError, contributeGoalRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Atomic increment, so two taps cannot double-count a contribution. */
export const POST = route(
  { bucket: 'write', bodySchema: contributeGoalRequestSchema },
  async ({ service, params, body }) => {
    const parsed = uuidSchema.safeParse(params.id);
    if (!parsed.success) throw new AppError('GOAL_NOT_FOUND');
    return getServices().planning.contributeToGoal(service, parsed.data, body.amount);
  },
);
