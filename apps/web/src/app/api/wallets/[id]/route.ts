import { AppError, updateWalletRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Path params are validated too — an id is untrusted input like any other. */
function walletId(params: Record<string, string>): string {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('WALLET_NOT_FOUND');
  return parsed.data;
}

export const GET = route({ bucket: 'read' }, async ({ service, params }) =>
  getServices().wallets.detail(service, walletId(params)),
);

export const PATCH = route(
  { bucket: 'write', bodySchema: updateWalletRequestSchema },
  async ({ service, params, body }) =>
    getServices().wallets.update(service, walletId(params), body),
);

export const DELETE = route({ bucket: 'write' }, async ({ service, params }) => {
  await getServices().wallets.remove(service, walletId(params));
  return { ok: true };
});
