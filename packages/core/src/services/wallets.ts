import {
  AppError,
  TokenAmount,
  assetKey,
  jobKey,
  type CreateWalletRequest,
  type WalletBalanceDto,
  type WalletDetailDto,
  type WalletDto,
} from '@wallet/shared';
import { detectNetworks, validateAddress } from '@wallet/blockchain';
import { isEvmNetwork, type EvmNetwork } from '@wallet/shared';
import { isUniqueViolation, opsRepo, walletsRepo, type AssetRow } from '@wallet/db';
import { asUser, audit, fxPreference, type ServiceContext } from './base.js';
import { fiatFromMinor, toAssetDto, toValuedTokenDto, toWalletDto } from '../mappers.js';

/**
 * Wallet management.
 *
 * Only public addresses are ever accepted or stored. The API schema hard-codes
 * `type: 'watch_only'`, so there is no request shape that can create a signing wallet — that
 * requires provisioning on the signer service, out of band.
 */

/** A wallet whose last successful scan is older than this shows as "sync delayed". */
const SCAN_DEGRADED_AFTER_SECONDS = 15 * 60;

export class WalletService {
  async list(
    context: ServiceContext,
    options: { includeInactive?: boolean } = {},
  ): Promise<WalletDto[]> {
    const rows = await asUser(context, (tx) =>
      walletsRepo.listWallets(tx, context.actor.userId, options),
    );
    return rows.map((row) =>
      toWalletDto(row, { degradedAfterSeconds: SCAN_DEGRADED_AFTER_SECONDS }),
    );
  }

  /**
   * Add a wallet.
   *
   * Address validation is network-specific and always server-side: the client's opinion
   * about whether an address is valid is irrelevant. The canonical form is what gets stored
   * and compared, so the same account entered in two different textual forms is recognised
   * as one wallet rather than two.
   */
  async create(context: ServiceContext, request: CreateWalletRequest): Promise<WalletDto> {
    const env = request.env ?? context.app.config.chain.env;
    const validation = validateAddress(request.network, request.address);

    if (!validation.valid) {
      // If the address is valid on a *different* network, say so — it is by far the most
      // common mistake and the most expensive one to make later.
      const alternatives = detectNetworks(request.address);
      if (alternatives.length > 0) {
        throw new AppError('ADDRESS_NETWORK_MISMATCH', {
          details: { expected: request.network, looksLike: alternatives },
        });
      }
      throw new AppError('INVALID_ADDRESS', {
        details: { network: request.network, reason: validation.reason },
      });
    }

    try {
      const row = await asUser(context, async (tx) => {
        const created = await walletsRepo.createWallet(tx, {
          userId: context.actor.userId,
          name: request.name,
          network: request.network,
          env,
          address: validation.display,
          addressCanonical: validation.canonical,
          type: 'watch_only',
        });

        await audit(context, tx, {
          action: 'wallet.created',
          entityType: 'wallet',
          entityId: created.id,
          metadata: { network: request.network, env },
        });
        return created;
      });

      // Scan immediately so the wallet is not empty for a whole polling interval.
      await context.app.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', '', true)`;
        await opsRepo.enqueueJob(tx, {
          type: 'chain.scan',
          payload: { walletId: row.id, reason: 'wallet-created' },
          dedupeKey: jobKey('chain.scan', row.id),
          priority: 10,
        });
      });

      return toWalletDto(row, { degradedAfterSeconds: SCAN_DEGRADED_AFTER_SECONDS });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('WALLET_ALREADY_EXISTS');
      throw error;
    }
  }

  async update(
    context: ServiceContext,
    walletId: string,
    input: { name?: string; isActive?: boolean },
  ): Promise<WalletDto> {
    const row = await asUser(context, async (tx) => {
      const updated = await walletsRepo.updateWallet(tx, context.actor.userId, walletId, input);
      if (!updated) throw new AppError('WALLET_NOT_FOUND');
      await audit(context, tx, {
        action: 'wallet.updated',
        entityType: 'wallet',
        entityId: walletId,
        metadata: { ...input },
      });
      return updated;
    });
    return toWalletDto(row, { degradedAfterSeconds: SCAN_DEGRADED_AFTER_SECONDS });
  }

  async remove(context: ServiceContext, walletId: string): Promise<void> {
    await asUser(context, async (tx) => {
      const removed = await walletsRepo.softDeleteWallet(tx, context.actor.userId, walletId);
      if (!removed) throw new AppError('WALLET_NOT_FOUND');
      await audit(context, tx, {
        action: 'wallet.deleted',
        entityType: 'wallet',
        entityId: walletId,
      });
    });
  }

  /** Wallet with balances, valued in USD and ILS. */
  async detail(context: ServiceContext, walletId: string): Promise<WalletDetailDto> {
    const { wallet, balances } = await asUser(context, async (tx) => {
      const row = await walletsRepo.findWallet(tx, context.actor.userId, walletId);
      if (!row) throw new AppError('WALLET_NOT_FOUND');
      return { wallet: row, balances: await walletsRepo.listWalletBalances(tx, walletId) };
    });

    const preference = await fxPreference(context);
    const prices = await context.app.currency.getPrices(
      balances.map((balance) => ({
        id: balance.asset.id,
        symbol: balance.asset.symbol,
        priceId: balance.asset.price_id,
      })),
    );

    let totalUsdMinor = 0n;
    let totalIlsMinor = 0n;
    let partial = false;
    const items: WalletBalanceDto[] = [];

    for (const balance of balances) {
      const amount = TokenAmount.fromRaw(balance.raw_amount, {
        assetKey: assetKey({
          network: balance.asset.network,
          env: balance.asset.env,
          contractAddress: balance.asset.contract_address,
          symbol: balance.asset.symbol,
        }),
        symbol: balance.asset.symbol,
        decimals: balance.asset.decimals,
      });

      const valued = await context.app.currency.valueToken(
        amount,
        prices.get(balance.asset.id),
        preference,
      );

      if (valued.usd) totalUsdMinor += valued.usd.minor;
      else if (!amount.isZero()) partial = true;
      if (valued.ils) totalIlsMinor += valued.ils.minor;

      items.push({
        asset: toAssetDto(balance.asset),
        value: toValuedTokenDto({
          token: {
            assetId: balance.asset.id,
            symbol: amount.symbol,
            decimals: amount.decimals,
            raw: amount.raw.toString(),
            decimal: amount.toDecimalString(),
          },
          usd: valued.usd,
          ils: valued.ils,
          pricedAt: valued.pricedAt,
        }),
        updatedAt: balance.updated_at?.toISOString() ?? null,
      });
    }

    return {
      ...toWalletDto(wallet, { degradedAfterSeconds: SCAN_DEGRADED_AFTER_SECONDS }),
      balances: items,
      // A partial valuation reports null rather than an under-counted total.
      totalUsd: partial ? null : fiatFromMinor(totalUsdMinor, 'USD'),
      totalIls: partial ? null : fiatFromMinor(totalIlsMinor, 'ILS'),
    };
  }

  /**
   * Create a **managed** EVM wallet: the signer generates the keypair, keeps the encrypted
   * private key, and returns only the address.
   *
   * This is the one place a wallet with `type = 'managed'` can be created through the API,
   * and it is deliberately narrow:
   *
   *   * only EVM networks — TRON and TON keys are provisioned out of band;
   *   * the private key never crosses the signer boundary, so there is no code path, and no
   *     response shape, that could expose or log it;
   *   * generation is idempotent on a client key, so a retry cannot strand a second funded
   *     address that nobody knows about.
   *
   * The address is immediately usable for **receiving**. Sending additionally requires the
   * master kill switch, which stays off by default.
   */
  async createManagedEvmWallet(
    context: ServiceContext,
    request: { name: string; network: EvmNetwork; idempotencyKey: string },
  ): Promise<WalletDto> {
    const env = context.app.config.chain.env;

    if (!isEvmNetwork(request.network)) {
      throw new AppError('ASSET_NOT_SUPPORTED', {
        details: { reason: 'address generation is only supported on EVM networks' },
      });
    }

    const generated = await context.app.signer.generateAddress({
      network: request.network,
      env,
      label: request.name.slice(0, 60),
      idempotencyKey: request.idempotencyKey,
    });

    const validation = validateAddress(request.network, generated.address);
    if (!validation.valid) {
      // The signer returned something that is not an address. Refuse rather than store it —
      // funds sent there would be unrecoverable.
      throw new AppError('KEY_GENERATION_FAILED', {
        internal: `signer returned an invalid address: ${generated.address}`,
      });
    }

    try {
      const row = await asUser(context, async (tx) => {
        const created = await walletsRepo.createWallet(tx, {
          userId: context.actor.userId,
          name: request.name,
          network: request.network,
          env,
          address: validation.display,
          addressCanonical: validation.canonical,
          // Managed: a signer holds the key. Every other creation path is watch-only.
          type: 'managed',
        });

        await audit(context, tx, {
          action: 'wallet.generated',
          entityType: 'wallet',
          entityId: created.id,
          metadata: {
            network: request.network,
            env,
            // The address is public and belongs in the audit trail. Nothing else does.
            address: validation.display,
            simulated: generated.simulated,
          },
        });
        return created;
      });

      await context.app.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', '', true)`;
        await opsRepo.enqueueJob(tx, {
          type: 'chain.scan',
          payload: { walletId: row.id, reason: 'wallet-generated' },
          dedupeKey: jobKey('chain.scan', row.id),
          priority: 10,
        });
      });

      return toWalletDto(row, { degradedAfterSeconds: SCAN_DEGRADED_AFTER_SECONDS });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('WALLET_ALREADY_EXISTS');
      throw error;
    }
  }

  /** Queue an immediate rescan. Idempotent: repeated taps collapse into one queued job. */
  async requestRescan(context: ServiceContext, walletId: string): Promise<void> {
    const wallet = await asUser(context, (tx) =>
      walletsRepo.findWallet(tx, context.actor.userId, walletId),
    );
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    await context.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', '', true)`;
      await opsRepo.enqueueJob(tx, {
        type: 'chain.scan',
        payload: { walletId, reason: 'manual' },
        dedupeKey: jobKey('chain.scan', walletId),
        priority: 10,
      });
    });

    await asUser(context, (tx) =>
      audit(context, tx, {
        action: 'wallet.rescan_requested',
        entityType: 'wallet',
        entityId: walletId,
      }),
    );
  }

  /** Assets available on a wallet's network/env, for the send and receive pickers. */
  async assetsForWallet(context: ServiceContext, walletId: string): Promise<AssetRow[]> {
    return asUser(context, async (tx) => {
      const wallet = await walletsRepo.findWallet(tx, context.actor.userId, walletId);
      if (!wallet) throw new AppError('WALLET_NOT_FOUND');
      const rows = await tx<AssetRow[]>`
        SELECT * FROM assets
        WHERE network = ${wallet.network} AND env = ${wallet.env} AND is_active
        ORDER BY kind DESC, symbol ASC
      `;
      return [...rows];
    });
  }
}
