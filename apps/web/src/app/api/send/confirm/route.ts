import { sendConfirmRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phase 2: confirm and execute.
 *
 * Requires the quote fingerprint the user actually saw, plus a PIN. The `quoted -> confirmed`
 * transition is a single conditional UPDATE, so only one caller can ever claim a quote.
 */
export const POST = route(
  { bucket: 'send', bodySchema: sendConfirmRequestSchema },
  async ({ service, body }) => getServices().send.confirm(service, body),
);
