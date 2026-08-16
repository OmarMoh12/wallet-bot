import type { EvmNetwork, NetworkEnv } from '@wallet/shared';

/**
 * EVM chain registry.
 *
 * EVM chains differ from one another only in a handful of constants: chain id, RPC
 * endpoint, native coin, explorer, and how fast blocks finalise. Everything else — address
 * format, transaction encoding, ERC-20 semantics, log filtering — is identical. So there is
 * **one** `EvmProvider`, parameterised by a row from this table.
 *
 * Adding Ethereum, Polygon or Arbitrum is: a value in `NETWORKS`, an `ALTER TYPE` migration,
 * a row here, and asset rows. No new provider code.
 */

export interface EvmChainConfig {
  readonly network: EvmNetwork;
  readonly env: NetworkEnv;
  /** EIP-155 chain id. Signed into every transaction; a mismatch is a replay across chains. */
  readonly chainId: number;
  readonly name: string;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
  /** Public RPC endpoint. Override per deployment with EVM_*_RPC_URL. */
  readonly defaultRpcUrl: string;
  readonly explorerBaseUrl: string;
  /**
   * Confirmations before a transaction is treated as final.
   *
   * BSC produces a block every ~3 seconds and reaches deterministic finality after roughly
   * two epochs; 15 is a pragmatic depth that costs ~45 seconds and is well past the depth
   * of any reorg observed in normal operation.
   */
  readonly requiredConfirmations: number;
  /**
   * Whether the chain supports EIP-1559 fee fields.
   *
   * BSC accepts type-2 transactions but its validators effectively ignore the priority fee
   * and charge a flat gas price, so we send legacy type-0 transactions there: simpler to
   * encode, and no risk of overpaying a tip that does nothing.
   */
  readonly supportsEip1559: boolean;
  /** Fallback gas price in wei when the node's estimate is unavailable or implausible. */
  readonly fallbackGasPriceWei: bigint;
  /** Hard ceiling on gas price, so a malfunctioning node cannot quote a ruinous fee. */
  readonly maxGasPriceWei: bigint;
}

type ChainKey = `${EvmNetwork}:${NetworkEnv}`;

export const EVM_CHAINS: Readonly<Record<ChainKey, EvmChainConfig>> = Object.freeze({
  'bsc:mainnet': {
    network: 'bsc',
    env: 'mainnet',
    chainId: 56,
    name: 'BNB Smart Chain',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    defaultRpcUrl: 'https://bsc-dataseed.bnbchain.org',
    explorerBaseUrl: 'https://bscscan.com',
    requiredConfirmations: 15,
    supportsEip1559: false,
    // 3 gwei — BSC's long-standing floor.
    fallbackGasPriceWei: 3_000_000_000n,
    // 100 gwei. Even a congested BSC block is far below this.
    maxGasPriceWei: 100_000_000_000n,
  },
  'bsc:testnet': {
    network: 'bsc',
    env: 'testnet',
    chainId: 97,
    name: 'BNB Smart Chain Testnet',
    nativeSymbol: 'tBNB',
    nativeDecimals: 18,
    defaultRpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    explorerBaseUrl: 'https://testnet.bscscan.com',
    requiredConfirmations: 6,
    supportsEip1559: false,
    fallbackGasPriceWei: 10_000_000_000n,
    maxGasPriceWei: 200_000_000_000n,
  },
});

export function evmChain(network: EvmNetwork, env: NetworkEnv): EvmChainConfig {
  const config = EVM_CHAINS[`${network}:${env}` as ChainKey];
  if (!config) throw new Error(`No EVM chain configured for ${network}:${env}`);
  return config;
}

export function tryEvmChain(network: string, env: string): EvmChainConfig | null {
  return EVM_CHAINS[`${network}:${env}` as ChainKey] ?? null;
}

/**
 * Gas limits.
 *
 * A plain value transfer is exactly 21000 by protocol definition. ERC-20 transfers vary with
 * storage state — writing to a zero balance slot costs more than updating a non-zero one —
 * so the estimate is taken from the node and padded. These are the floors and ceilings we
 * accept around that estimate.
 */
export const GAS_LIMITS = {
  /** Protocol constant for a native transfer with no calldata. */
  nativeTransfer: 21_000n,
  /** Typical ERC-20 transfer lands at 40k–65k; this is the fallback when estimation fails. */
  erc20TransferFallback: 100_000n,
  /**
   * Refuse an estimate above this. A `transfer` that wants 500k gas is not a standard
   * ERC-20 — it is a token with hooks, a fee-on-transfer design, or something hostile, and
   * none of those should be sent blind.
   */
  erc20TransferMax: 300_000n,
  /** Padding applied to a node estimate, in percent, to absorb state changes before mining. */
  estimatePaddingPercent: 25n,
} as const;
