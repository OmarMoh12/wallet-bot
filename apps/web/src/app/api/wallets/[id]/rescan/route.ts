import { AppError, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Queue an immediate rescan. Deduped, so repeated taps cost nothing. */
export const POST = route({ bucket: 'write' }, async ({ service, params }) => {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('WALLET_NOT_FOUND');
  await getServices().wallets.requestRescan(service, parsed.data);
  return { ok: true };
});
