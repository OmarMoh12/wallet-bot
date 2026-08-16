import { AppError, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = route({ bucket: 'write' }, async ({ service, params }) => {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('SCHEDULED_PAYMENT_NOT_FOUND');
  return getServices().planning.cancelScheduledPayment(service, parsed.data);
});
