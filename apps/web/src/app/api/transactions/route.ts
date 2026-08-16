import { createCashTransactionRequestSchema, transactionFilterSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  { bucket: 'read', querySchema: transactionFilterSchema },
  async ({ service, query }) => getServices().transactions.list(service, query),
);

/** Record a manual cash transaction. Idempotent on the client-supplied key. */
export const POST = route(
  { bucket: 'write', bodySchema: createCashTransactionRequestSchema },
  async ({ service, body }) => getServices().transactions.createCash(service, body),
);
