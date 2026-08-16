import { createCategoryRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'read' }, async ({ service }) => ({
  items: await getServices().catalog.listCategories(service),
}));

export const POST = route(
  { bucket: 'write', bodySchema: createCategoryRequestSchema },
  async ({ service, body }) =>
    getServices().catalog.createCategory(service, {
      name: body.name,
      kind: body.kind,
      ...(body.icon ? { icon: body.icon } : {}),
      ...(body.color ? { color: body.color } : {}),
    }),
);
