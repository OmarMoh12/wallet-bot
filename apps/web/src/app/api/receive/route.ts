import { z } from 'zod';
import { uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({ walletId: uuidSchema, assetId: uuidSchema }).strict();

/** Address, network label and a server-rendered QR for the receive screen. */
export const GET = route({ bucket: 'read', querySchema }, async ({ service, query }) =>
  getServices().receive.info(service, { walletId: query.walletId, assetId: query.assetId }),
);
