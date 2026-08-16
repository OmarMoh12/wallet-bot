import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Everything the home screen needs, in one round trip. */
export const GET = route({ bucket: 'read' }, async ({ service }) =>
  getServices().dashboard.load(service),
);
