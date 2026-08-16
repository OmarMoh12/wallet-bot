import { createExpectedIncomeRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'read' }, async ({ service }) => ({
  items: await getServices().planning.listExpectedIncome(service),
}));

export const POST = route(
  { bucket: 'write', bodySchema: createExpectedIncomeRequestSchema },
  async ({ service, body }) => getServices().planning.createExpectedIncome(service, body),
);
