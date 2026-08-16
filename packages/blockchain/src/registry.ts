import {
  AppError,
  EVM_NETWORKS,
  type EvmNetwork,
  type Network,
  type NetworkEnv,
} from '@wallet/shared';
import { FallbackProvider } from './providers/fallback.js';
import { MockProvider } from './providers/mock.js';
import { TonProvider } from './providers/ton.js';
import { TronProvider } from './providers/tron.js';
import { EvmProvider } from './providers/evm.js';
import { evmChain, tryEvmChain } from './evm/chains.js';
import type { BlockchainProvider } from './types.js';

export interface BlockchainConfig {
  env: NetworkEnv;
  /** Force the mock provider regardless of configured keys. */
  mock: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  tron: {
    apiUrl: string;
    scanApiUrl?: string;
    apiKey?: string;
    scanApiKey?: string;
    confirmations: number;
  };
  ton: {
    apiUrl: string;
    tonApiUrl?: string;
    apiKey?: string;
    tonApiKey?: string;
    confirmations: number;
  };
  /**
   * Per-EVM-network overrides, keyed by network name.
   *
   * Everything is optional: a chain with no entry uses the public RPC endpoint and the
   * confirmation depth from `EVM_CHAINS`, so a fresh deployment works with no configuration.
   */
  evm?: Partial<Record<EvmNetwork, { rpcUrl?: string; confirmations?: number }>>;
}

/**
 * Builds the provider for each network, once, at process start.
 *
 * The mock provider is selected when `mock` is set. Callers decide that from
 * `BLOCKCHAIN_MOCK` and from whether real credentials exist — a development machine with no
 * keys gets deterministic fake data rather than a stream of provider errors.
 */
export class ProviderRegistry {
  private readonly providers = new Map<Network, BlockchainProvider>();

  constructor(private readonly config: BlockchainConfig) {
    this.providers.set('tron', this.buildTron());
    this.providers.set('ton', this.buildTon());
    for (const network of EVM_NETWORKS) {
      // Only register a chain that exists in this environment; BSC has both mainnet and
      // testnet, but a future chain might be mainnet-only.
      if (tryEvmChain(network, this.config.env)) {
        this.providers.set(network, this.buildEvm(network));
      }
    }
  }

  private buildEvm(network: EvmNetwork): BlockchainProvider {
    const chain = evmChain(network, this.config.env);
    const overrides = this.config.evm?.[network];

    if (this.config.mock) {
      return new MockProvider({
        network,
        env: this.config.env,
        requiredConfirmations: overrides?.confirmations ?? chain.requiredConfirmations,
      });
    }

    const provider = new EvmProvider({
      network,
      env: this.config.env,
      timeoutMs: this.config.timeoutMs,
      maxResponseBytes: this.config.maxResponseBytes,
      apiKeys: {},
      urls: { rpc: overrides?.rpcUrl ?? chain.defaultRpcUrl },
      requiredConfirmations: overrides?.confirmations ?? chain.requiredConfirmations,
    });

    return new FallbackProvider([provider], { failureThreshold: 3, cooldownMs: 60_000 });
  }

  private buildTron(): BlockchainProvider {
    if (this.config.mock) {
      return new MockProvider({
        network: 'tron',
        env: this.config.env,
        requiredConfirmations: this.config.tron.confirmations,
      });
    }
    const primary = new TronProvider({
      env: this.config.env,
      timeoutMs: this.config.timeoutMs,
      maxResponseBytes: this.config.maxResponseBytes,
      apiKeys: { trongrid: this.config.tron.apiKey },
      urls: { trongrid: this.config.tron.apiUrl },
      requiredConfirmations: this.config.tron.confirmations,
    });
    return new FallbackProvider([primary], { failureThreshold: 3, cooldownMs: 60_000 });
  }

  private buildTon(): BlockchainProvider {
    if (this.config.mock) {
      return new MockProvider({
        network: 'ton',
        env: this.config.env,
        requiredConfirmations: this.config.ton.confirmations,
      });
    }
    const primary = new TonProvider({
      env: this.config.env,
      timeoutMs: this.config.timeoutMs,
      maxResponseBytes: this.config.maxResponseBytes,
      apiKeys: { toncenter: this.config.ton.apiKey, tonapi: this.config.ton.tonApiKey },
      urls: { toncenter: this.config.ton.apiUrl, tonapi: this.config.ton.tonApiUrl ?? '' },
      requiredConfirmations: this.config.ton.confirmations,
    });
    return new FallbackProvider([primary], { failureThreshold: 3, cooldownMs: 60_000 });
  }

  get(network: Network): BlockchainProvider {
    const provider = this.providers.get(network);
    if (!provider) {
      throw new AppError('ASSET_NOT_SUPPORTED', { internal: `no provider for network ${network}` });
    }
    return provider;
  }

  all(): BlockchainProvider[] {
    return [...this.providers.values()];
  }

  get env(): NetworkEnv {
    return this.config.env;
  }

  get isMock(): boolean {
    return this.config.mock;
  }

  /** Replace a provider. Test-only seam; production code never calls this. */
  register(network: Network, provider: BlockchainProvider): void {
    this.providers.set(network, provider);
  }
}
