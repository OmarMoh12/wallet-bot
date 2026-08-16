import { generateWalletRequestSchema } from '@wallet/shared';
import { route } from '@/lib/server/handler';
import { getServices } from '@/lib/server/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create a managed EVM wallet.
 *
 * The signer generates the keypair, encrypts the private key and stores it; only the address
 * comes back. Rate limited on the `send` bucket rather than `write`, because each call
 * creates key material on the signer and that should not be cheap to spam.
 */
export const POST = route(
  { bucket: 'send', bodySchema: generateWalletRequestSchema },
  async ({ service, body }) =>
    getServices().wallets.createManagedEvmWallet(service, {
      name: body.name,
      network: body.network,
      idempotencyKey: body.idempotencyKey,
    }),
);
