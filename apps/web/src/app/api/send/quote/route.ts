import { sendQuoteRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phase 1 of a transfer: validate and price it.
 *
 * Touches no key material and cannot move funds. Rate limited on the `send` bucket, which is
 * per-hour rather than per-minute.
 */
export const POST = route(
  { bucket: 'send', bodySchema: sendQuoteRequestSchema },
  async ({ service, body }) => getServices().send.quote(service, body),
);
