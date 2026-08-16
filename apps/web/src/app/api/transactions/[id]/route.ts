import { AppError, updateTransactionRequestSchema, uuidSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function transactionId(params: Record<string, string>): string {
  const parsed = uuidSchema.safeParse(params.id);
  if (!parsed.success) throw new AppError('TRANSACTION_NOT_FOUND');
  return parsed.data;
}

export const GET = route({ bucket: 'read' }, async ({ service, params }) =>
  getServices().transactions.get(service, transactionId(params)),
);

export const PATCH = route(
  { bucket: 'write', bodySchema: updateTransactionRequestSchema },
  async ({ service, params, body }) =>
    getServices().transactions.update(service, transactionId(params), body),
);

export const DELETE = route({ bucket: 'write' }, async ({ service, params }) => {
  await getServices().transactions.remove(service, transactionId(params));
  return { ok: true };
});
