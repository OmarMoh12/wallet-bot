import { createCashAccountRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'read' }, async ({ service }) => ({
  items: await getServices().catalog.listCashAccounts(service),
}));

export const POST = route(
  { bucket: 'write', bodySchema: createCashAccountRequestSchema },
  async ({ service, body }) => getServices().catalog.createCashAccount(service, body),
);
