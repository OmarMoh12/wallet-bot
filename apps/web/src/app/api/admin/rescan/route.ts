import { adminRescanSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(
  { bucket: 'admin', admin: true, bodySchema: adminRescanSchema },
  async ({ service, body }) => {
    await getServices().admin.rescanWallet(service, {
      walletId: body.walletId,
      fromScratch: body.fromScratch,
    });
    return { ok: true };
  },
);
