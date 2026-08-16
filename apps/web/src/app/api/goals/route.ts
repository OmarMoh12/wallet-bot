import { createGoalRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'read' }, async ({ service }) => ({
  items: await getServices().planning.listGoals(service),
}));

export const POST = route(
  { bucket: 'write', bodySchema: createGoalRequestSchema },
  async ({ service, body }) =>
    getServices().planning.createGoal(service, {
      name: body.name,
      targetAmount: body.targetAmount,
      currency: body.currency,
      ...(body.currentAmount ? { currentAmount: body.currentAmount } : {}),
      ...(body.deadline ? { deadline: body.deadline } : {}),
      ...(body.icon ? { icon: body.icon } : {}),
      ...(body.color ? { color: body.color } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
    }),
);
