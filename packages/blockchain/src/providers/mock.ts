import { createHash } from 'node:crypto';
import type { Network, NetworkEnv } from '@wallet/shared';
import { AppError } from '@wallet/shared';
import { pow10 } from '@wallet/shared';
import { validateAddress } from '../address/index.js';

/** Native coin metadata per network, so the mock matches the real chain's shape. */
function nativeSymbolFor(network: Network): string {
  if (network === 'ton') return 'TON';
  if (network === 'tron') return 'TRX';
  return 'BNB';
}

function nativeDecimalsFor(network: Network): number {
  if (network === 'ton') return 9;
  if (network === 'tron') return 6;
  // Every EVM chain uses 18 decimals for its native coin.
  return 18;
}
import type {
  AddressValidation,
  AssetRef,
  BlockchainProvider,
  BroadcastResult,
  ChainTransactionStatus,
  ChainTransfer,
  FeeEstimate,
  ProviderHealth,
  ScanCursor,
  SignedTransfer,
  TokenBalance,
  TransferPage,
  TransferRequest,
  UnsignedTransfer,
} from '../types.js';

/**
 * Deterministic in-memory provider.
 *
 * Used for local development, for tests, and as the default whenever no provider keys are
 * configured. Two properties matter:
 *
 *   * **Deterministic.** Balances and history are derived from a hash of the address, so the
 *     same wallet always produces the same data and tests never flake.
 *   * **Never broadcasts.** `broadcast` returns a synthetic hash prefixed `mock-` and marks
 *     the result simulated. There is no code path here that reaches a real network.
 *
 * Tests can also push explicit transfers with `seedTransfer`, which is how the
 * "incoming transfer → detected → stored → notified" integration test drives the pipeline.
 */
export class MockProvider implements BlockchainProvider {
  readonly name: string;
  readonly network: Network;
  readonly env: NetworkEnv;
  readonly requiredConfirmations: number;

  private readonly seeded = new Map<string, ChainTransfer[]>();
  private readonly balanceOverrides = new Map<string, bigint>();
  private readonly statuses = new Map<string, ChainTransactionStatus>();
  private broadcastCount = 0;

  constructor(options: {
    network: Network;
    env: NetworkEnv;
    requiredConfirmations?: number;
    label?: string;
  }) {
    this.network = options.network;
    this.env = options.env;
    this.requiredConfirmations = options.requiredConfirmations ?? 1;
    this.name = `mock:${options.label ?? options.network}:${options.env}`;
  }

  /** Deterministic pseudo-random value in [0, max) derived from a seed string. */
  private deterministic(seed: string, max: bigint): bigint {
    const digest = createHash('sha256').update(`${this.network}:${this.env}:${seed}`).digest('hex');
    return BigInt(`0x${digest.slice(0, 16)}`) % max;
  }

  validateAddress(address: string): AddressValidation {
    return validateAddress(this.network, address);
  }

  private requireValid(address: string): string {
    const result = validateAddress(this.network, address);
    if (!result.valid)
      throw new AppError('INVALID_ADDRESS', { details: { network: this.network } });
    return result.canonical;
  }

  /** Test hook: make a wallet appear to hold a specific amount. */
  setBalance(address: string, contractAddress: string | null, rawAmount: bigint): void {
    this.balanceOverrides.set(
      `${this.requireValid(address)}|${contractAddress ?? 'native'}`,
      rawAmount,
    );
  }

  /** Test hook: make the next scan of `address` observe this transfer. */
  seedTransfer(transfer: ChainTransfer): void {
    const key = transfer.address;
    const list = this.seeded.get(key) ?? [];
    list.push(transfer);
    this.seeded.set(key, list);
  }

  setTransactionStatus(status: ChainTransactionStatus): void {
    this.statuses.set(status.txHash, status);
  }

  clear(): void {
    this.seeded.clear();
    this.balanceOverrides.clear();
    this.statuses.clear();
    this.broadcastCount = 0;
  }

  async getNativeBalance(address: string): Promise<bigint> {
    const canonical = this.requireValid(address);
    const override = this.balanceOverrides.get(`${canonical}|native`);
    if (override !== undefined) return override;
    const scale = pow10(nativeDecimalsFor(this.network));
    return this.deterministic(`native:${canonical}`, 500n * scale);
  }

  async getTokenBalances(address: string, assets: AssetRef[]): Promise<TokenBalance[]> {
    const canonical = this.requireValid(address);
    const balances: TokenBalance[] = [
      {
        contractAddress: null,
        symbolHint: nativeSymbolFor(this.network),
        decimalsHint: nativeDecimalsFor(this.network),
        rawAmount: await this.getNativeBalance(canonical),
      },
    ];

    for (const asset of assets) {
      if (asset.kind !== 'token' || !asset.contractAddress) continue;
      const key = `${canonical}|${asset.contractAddress}`;
      const override = this.balanceOverrides.get(key);
      const unit = 10n ** BigInt(asset.decimals);
      balances.push({
        contractAddress: asset.contractAddress,
        symbolHint: asset.symbol,
        decimalsHint: asset.decimals,
        rawAmount: override ?? this.deterministic(key, 2000n * unit),
      });
    }
    return balances;
  }

  async listTransfers(address: string, cursor: ScanCursor, limit: number): Promise<TransferPage> {
    const canonical = this.requireValid(address);
    const pending = this.seeded.get(canonical) ?? [];
    const page = pending.slice(0, Math.max(limit, 1));
    // Seeded transfers are consumed once, matching a real provider's forward-only cursor.
    this.seeded.set(canonical, pending.slice(page.length));

    const state = (cursor ?? {}) as { round?: number };
    return {
      transfers: page,
      cursor: { round: (state.round ?? 0) + 1, mock: true },
      hasMore: pending.length > page.length,
    };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransactionStatus> {
    const seeded = this.statuses.get(txHash);
    if (seeded) return seeded;
    return {
      txHash,
      found: true,
      succeeded: true,
      confirmations: this.requiredConfirmations,
      blockNumber: 1_000_000n,
      blockTime: new Date(),
    };
  }

  async estimateFee(request: TransferRequest): Promise<FeeEstimate> {
    const isToken = request.asset.kind === 'token';
    const decimals = nativeDecimalsFor(this.network);
    const unit = pow10(decimals);

    // Fees roughly in the shape of each chain's real ones, so a test that asserts "the fee
    // is small relative to the amount" behaves the same against the mock.
    const rawAmount =
      this.network === 'ton'
        ? isToken
          ? unit / 10n
          : unit / 100n
        : this.network === 'tron'
          ? isToken
            ? 30n * unit
            : (11n * unit) / 10n
          : // EVM: ~0.0005 native for a transfer, ~0.0015 for an ERC-20 call.
            isToken
            ? (15n * unit) / 10_000n
            : (5n * unit) / 10_000n;

    return {
      rawAmount,
      decimals,
      symbol: nativeSymbolFor(this.network),
      estimated: true,
      detail: 'mock',
    };
  }

  async buildTransfer(request: TransferRequest): Promise<UnsignedTransfer> {
    const from = this.requireValid(request.fromAddress);
    const to = this.requireValid(request.toAddress);
    if (from === to) throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    if (request.rawAmount <= 0n) throw new AppError('AMOUNT_TOO_SMALL');

    const payload = {
      mock: true,
      from,
      to,
      amount: request.rawAmount.toString(),
      contract: request.asset.contractAddress,
      memo: request.memo,
    };
    return {
      network: this.network,
      env: this.env,
      from,
      to,
      rawAmount: request.rawAmount,
      assetContract: request.asset.contractAddress,
      memo: request.memo,
      payload,
      expiresAt: new Date(Date.now() + 120_000),
      digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    };
  }

  /** Returns a synthetic hash. Nothing leaves this process. */
  async broadcast(signed: SignedTransfer): Promise<BroadcastResult> {
    this.broadcastCount += 1;
    const hash = createHash('sha256')
      .update(`${signed.digest}:${this.broadcastCount}`)
      .digest('hex');
    return { txHash: `mock-${hash}`, accepted: true, detail: 'simulated — nothing was broadcast' };
  }

  async health(): Promise<ProviderHealth> {
    return { name: this.name, healthy: true, latencyMs: 0, detail: 'mock provider' };
  }
}
