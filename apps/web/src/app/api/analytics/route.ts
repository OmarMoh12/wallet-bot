import { analyticsQuerySchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(
  { bucket: 'read', querySchema: analyticsQuerySchema },
  async ({ service, query }) => getServices().analytics.overview(service, query),
);
