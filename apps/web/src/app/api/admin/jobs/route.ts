import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'admin', admin: true }, async ({ service }) =>
  getServices().admin.queueStats(service),
);
