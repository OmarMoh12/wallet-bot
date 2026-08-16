import { createScheduledPaymentRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ bucket: 'read' }, async ({ service }) => ({
  items: await getServices().planning.listScheduledPayments(service),
}));

/**
 * Schedule a transfer.
 *
 * Creating one is an intent, not an authorisation to move funds — execution runs the full
 * send pipeline, which is refused while sending is disabled.
 */
export const POST = route(
  { bucket: 'send', bodySchema: createScheduledPaymentRequestSchema },
  async ({ service, body }) => getServices().planning.createScheduledPayment(service, body),
);
