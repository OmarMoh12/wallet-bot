import { updateSettingsRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'read' }, async ({ service }) =>
  getServices().catalog.getSettings(service),
);

export const PATCH = route(
  { bucket: 'write', bodySchema: updateSettingsRequestSchema },
  async ({ service, body }) => getServices().catalog.updateSettings(service, body),
);
