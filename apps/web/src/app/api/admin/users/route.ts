import { z } from 'zod';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();

export const GET = route(
  { bucket: 'admin', admin: true, querySchema },
  async ({ service, query }) => ({
    items: await getServices().admin.listUsers(service, query),
  }),
);
