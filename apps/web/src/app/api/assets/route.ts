import { z } from 'zod';
import { AppError, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';
import { toAssetDto } from '@wallet/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({ walletId: uuidSchema }).strict();

/** Assets available on a wallet's network, for the send and receive pickers. */
export const GET = route({ bucket: 'read', querySchema }, async ({ service, query }) => {
  if (!query.walletId) throw new AppError('VALIDATION_ERROR');
  const rows = await getServices().wallets.assetsForWallet(service, query.walletId);
  return { items: rows.map(toAssetDto) };
});
