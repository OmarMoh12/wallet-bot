import { adminToggleSendingSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'admin', admin: true }, async ({ service }) =>
  getServices().admin.settings(service),
);

/**
 * Toggle outgoing transfers.
 *
 * The database flag can only ever tighten the environment setting — enabling it here does
 * nothing while `SENDING_ENABLED=false`. The response reports the effective value so the UI
 * cannot imply otherwise.
 */
export const POST = route(
  { bucket: 'admin', admin: true, bodySchema: adminToggleSendingSchema },
  async ({ service, body }) =>
    getServices().admin.setSendingEnabled(service, {
      enabled: body.enabled,
      reason: body.reason,
    }),
);
