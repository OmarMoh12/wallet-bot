import { updateNotificationPreferencesSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  { bucket: 'write', bodySchema: updateNotificationPreferencesSchema },
  async ({ service, body }) =>
    getServices().catalog.updateNotificationPreferences(service, {
      ...(body.types ? { types: body.types } : {}),
      ...(body.quietHoursStart !== undefined
        ? { quietHoursStart: body.quietHoursStart ?? null }
        : {}),
      ...(body.quietHoursEnd !== undefined ? { quietHoursEnd: body.quietHoursEnd ?? null } : {}),
      ...(body.minCryptoValueUsd ? { minCryptoValueUsd: body.minCryptoValueUsd } : {}),
      ...(body.fxAlertThresholdPercent
        ? { fxAlertThresholdPercent: body.fxAlertThresholdPercent }
        : {}),
    }),
);
