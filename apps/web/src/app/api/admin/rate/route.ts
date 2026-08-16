import { adminSetFxRateSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pin a manual exchange rate system-wide. Audited, and clearly labelled in the UI. */
export const POST = route(
  { bucket: 'admin', admin: true, bodySchema: adminSetFxRateSchema },
  async ({ service, body }) => {
    await getServices().admin.setManualRate(service, body);
    return { ok: true };
  },
);
