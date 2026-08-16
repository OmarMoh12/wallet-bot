import { setPinRequestSchema, verifyPinRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Set or change the PIN used to authorise sensitive actions. */
export const POST = route(
  { bucket: 'write', bodySchema: setPinRequestSchema },
  async ({ body, actor, requestId }) => {
    await getServices().auth.setPin(actor, {
      pin: body.pin,
      ...(body.currentPin ? { currentPin: body.currentPin } : {}),
      requestId,
    });
    return { ok: true };
  },
);

/**
 * Verify a PIN without performing an action.
 *
 * Uses the `auth` bucket so brute-force attempts are throttled at the same rate as login,
 * on top of the per-user lockout in the auth service.
 */
export const PUT = route(
  { bucket: 'auth', bodySchema: verifyPinRequestSchema },
  async ({ body, actor, requestId }) => {
    await getServices().auth.requirePin(actor, body.pin, requestId);
    return { ok: true };
  },
);
