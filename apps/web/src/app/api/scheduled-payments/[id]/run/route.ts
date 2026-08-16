import { AppError, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask for a scheduled payment to run now.
 *
 * Only queues the attempt; the worker still applies every pre-flight check, and the whole
 * path fails closed while sending is disabled.
 */
export const POST = route({ bucket: 'send' }, async ({ service, params }) => {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('SCHEDULED_PAYMENT_NOT_FOUND');
  await getServices().planning.runScheduledPaymentNow(service, parsed.data);
  return { ok: true };
});
