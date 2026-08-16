import { createWalletRequestSchema, walletListQuerySchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  { bucket: 'read', querySchema: walletListQuerySchema },
  async ({ service, query }) =>
    getServices().wallets.list(service, { includeInactive: query.includeInactive }),
);

/** Add a watch-only wallet. The schema pins `type` so a signing wallet cannot be created. */
export const POST = route(
  { bucket: 'write', bodySchema: createWalletRequestSchema },
  async ({ service, body }) => getServices().wallets.create(service, body),
);
