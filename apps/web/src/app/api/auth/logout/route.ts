import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revoke the current session. The client also drops its in-memory token. */
export const POST = route({ bucket: 'write' }, async ({ actor, requestId }) => {
  await getServices().auth.revokeSession(actor, requestId);
  return { ok: true };
});
