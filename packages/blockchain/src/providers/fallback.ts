import type { Network, NetworkEnv } from '@wallet/shared';
import { AppError } from '@wallet/shared';
import type {
  AddressValidation,
  AssetRef,
  BlockchainProvider,
  BroadcastResult,
  ChainTransactionStatus,
  FeeEstimate,
  ProviderHealth,
  ScanCursor,
  SignedTransfer,
  TokenBalance,
  TransferPage,
  TransferRequest,
  UnsignedTransfer,
} from '../types.js';

interface BreakerState {
  failures: number;
  openUntil: number;
}

/**
 * Wraps a primary provider with one or more fallbacks, plus a circuit breaker.
 *
 * Read operations fail over. **Write operations do not**: `broadcast` is pinned to the
 * primary. Retrying a broadcast against a second provider is exactly how the same transfer
 * gets submitted twice, so a broadcast failure surfaces as an error for a human to resolve
 * rather than being silently retried elsewhere.
 *
 * The breaker opens after `failureThreshold` consecutive failures and stays open for
 * `cooldownMs`, so a dead indexer stops costing us a timeout on every single request.
 */
export class FallbackProvider implements BlockchainProvider {
  readonly name: string;
  readonly network: Network;
  readonly env: NetworkEnv;
  readonly requiredConfirmations: number;

  private readonly providers: BlockchainProvider[];
  private readonly breakers = new Map<string, BreakerState>();

  constructor(
    providers: BlockchainProvider[],
    private readonly options: { failureThreshold: number; cooldownMs: number } = {
      failureThreshold: 3,
      cooldownMs: 60_000,
    },
  ) {
    const primary = providers[0];
    if (!primary) throw new Error('FallbackProvider requires at least one provider');
    this.providers = providers;
    this.network = primary.network;
    this.env = primary.env;
    this.requiredConfirmations = primary.requiredConfirmations;
    this.name = `fallback(${providers.map((provider) => provider.name).join(' → ')})`;
  }

  private get primary(): BlockchainProvider {
    return this.providers[0] as BlockchainProvider;
  }

  private isOpen(provider: BlockchainProvider): boolean {
    const state = this.breakers.get(provider.name);
    return Boolean(state && state.openUntil > Date.now());
  }

  private recordSuccess(provider: BlockchainProvider): void {
    this.breakers.delete(provider.name);
  }

  private recordFailure(provider: BlockchainProvider): void {
    const state = this.breakers.get(provider.name) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.options.failureThreshold) {
      state.openUntil = Date.now() + this.options.cooldownMs;
      state.failures = 0;
    }
    this.breakers.set(provider.name, state);
  }

  /** Try each provider in order, skipping any whose breaker is open. */
  private async read<T>(
    operation: string,
    run: (provider: BlockchainProvider) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    let attempted = false;

    for (const provider of this.providers) {
      if (this.isOpen(provider)) continue;
      attempted = true;
      try {
        const result = await run(provider);
        this.recordSuccess(provider);
        return result;
      } catch (error) {
        // A client-side error (bad address, bad amount) is not a provider fault and must
        // not trip the breaker or trigger a pointless failover.
        if (AppError.is(error) && error.status < 500 && error.code !== 'RATE_LIMITED') {
          throw error;
        }
        this.recordFailure(provider);
        lastError = error;
      }
    }

    if (!attempted) {
      throw new AppError('NETWORK_UNAVAILABLE', {
        internal: `all ${this.network} providers are circuit-open for ${operation}`,
        retryable: true,
      });
    }
    throw AppError.is(lastError)
      ? lastError
      : new AppError('PROVIDER_ERROR', {
          internal: `all ${this.network} providers failed for ${operation}`,
          cause: lastError,
          retryable: true,
        });
  }

  validateAddress(address: string): AddressValidation {
    return this.primary.validateAddress(address);
  }

  getNativeBalance(address: string): Promise<bigint> {
    return this.read('getNativeBalance', (provider) => provider.getNativeBalance(address));
  }

  getTokenBalances(address: string, assets: AssetRef[]): Promise<TokenBalance[]> {
    return this.read('getTokenBalances', (provider) => provider.getTokenBalances(address, assets));
  }

  listTransfers(address: string, cursor: ScanCursor, limit: number): Promise<TransferPage> {
    // Cursors are provider-specific, so a failover would misinterpret the resume point.
    // Falling back with a null cursor re-reads recent history, which is safe precisely
    // because ingestion is idempotent.
    return this.read('listTransfers', (provider) =>
      provider.listTransfers(address, provider === this.primary ? cursor : null, limit),
    );
  }

  getTransactionStatus(txHash: string): Promise<ChainTransactionStatus> {
    return this.read('getTransactionStatus', (provider) => provider.getTransactionStatus(txHash));
  }

  estimateFee(request: TransferRequest): Promise<FeeEstimate> {
    return this.read('estimateFee', (provider) => provider.estimateFee(request));
  }

  buildTransfer(request: TransferRequest): Promise<UnsignedTransfer> {
    // Pinned to the primary: an unsigned payload built by one provider must be broadcast
    // by the same one.
    return this.primary.buildTransfer(request);
  }

  broadcast(signed: SignedTransfer): Promise<BroadcastResult> {
    // Deliberately no failover. See the class comment.
    return this.primary.broadcast(signed);
  }

  async health(): Promise<ProviderHealth> {
    const results = await Promise.all(this.providers.map((provider) => provider.health()));
    const healthy = results.some((result) => result.healthy);
    const latencies = results
      .map((result) => result.latencyMs)
      .filter((value): value is number => value !== null);
    return {
      name: this.name,
      healthy,
      latencyMs: latencies.length > 0 ? Math.min(...latencies) : null,
      detail: results
        .map((result) => `${result.name}=${result.healthy ? 'ok' : 'down'}`)
        .join(', '),
    };
  }
}
