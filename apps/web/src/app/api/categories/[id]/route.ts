import { AppError, updateCategoryRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function categoryId(params: Record<string, string>): string {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('CATEGORY_NOT_FOUND');
  return parsed.data;
}

export const PATCH = route(
  { bucket: 'write', bodySchema: updateCategoryRequestSchema },
  async ({ service, params, body }) =>
    getServices().catalog.updateCategory(service, categoryId(params), body),
);

export const DELETE = route({ bucket: 'write' }, async ({ service, params }) => {
  await getServices().catalog.removeCategory(service, categoryId(params));
  return { ok: true };
});
