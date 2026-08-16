import type { Network, NetworkEnv } from '@wallet/shared';

/** Result of validating an address against a specific network. */
export type AddressValidation =
  | {
      valid: true;
      /** Comparison/storage form. Stable across every representation of the same account. */
      canonical: string;
      /** Preferred display form. */
      display: string;
      network: Network;
      flags?: Record<string, string | number | boolean>;
    }
  | {
      valid: false;
      reason: 'empty' | 'format' | 'length' | 'checksum' | 'prefix' | 'network';
    };

/** An asset as the provider layer needs to know it. */
export interface AssetRef {
  id: string;
  symbol: string;
  decimals: number;
  /** null for the network's native coin. */
  contractAddress: string | null;
  kind: 'native' | 'token';
}

/** One value movement observed on chain. */
export interface ChainTransfer {
  network: Network;
  env: NetworkEnv;
  txHash: string;
  /** Distinguishes multiple transfers within a single transaction. */
  logIndex: number;
  /** Address of the wallet we scanned, in canonical form. */
  address: string;
  direction: 'in' | 'out';
  counterparty: string | null;
  /** Contract/jetton-master address, or null for the native coin. */
  contractAddress: string | null;
  /** Symbol as reported by the chain. Untrusted: used only as a hint, never for pricing. */
  symbolHint: string | null;
  decimalsHint: number | null;
  /** Signed base units, in the token's own decimals. Always exact. */
  rawAmount: bigint;
  feeRawAmount: bigint | null;
  memo: string | null;
  blockNumber: bigint | null;
  blockTime: Date | null;
  confirmations: number | null;
  /** Chain-reported execution result. `false` means the transfer did not take effect. */
  succeeded: boolean;
}

export interface TokenBalance {
  contractAddress: string | null;
  symbolHint: string | null;
  decimalsHint: number | null;
  rawAmount: bigint;
}

/** Opaque provider-specific resume point. Persisted on the wallet row. */
export type ScanCursor = Record<string, unknown> | null;

export interface TransferPage {
  transfers: ChainTransfer[];
  cursor: ScanCursor;
  /** True when more pages are available immediately. */
  hasMore: boolean;
}

export interface ChainTransactionStatus {
  txHash: string;
  found: boolean;
  succeeded: boolean;
  confirmations: number;
  blockNumber: bigint | null;
  blockTime: Date | null;
}

export interface FeeEstimate {
  /** Fee is always denominated in the network's native coin. */
  rawAmount: bigint;
  decimals: number;
  symbol: string;
  /** True when the number is a conservative default rather than a live quote. */
  estimated: boolean;
  detail?: string;
}

export interface TransferRequest {
  fromAddress: string;
  toAddress: string;
  asset: AssetRef;
  rawAmount: bigint;
  memo: string | null;
}

/**
 * An unsigned transaction, ready to hand to the signer.
 *
 * `payload` is provider-specific and opaque to the web tier. Critically, building this
 * never requires a private key — construction happens in the API process, signing happens
 * only in the isolated signer.
 */
export interface UnsignedTransfer {
  network: Network;
  env: NetworkEnv;
  from: string;
  to: string;
  rawAmount: bigint;
  assetContract: string | null;
  memo: string | null;
  /** Provider-specific unsigned transaction body. */
  payload: Record<string, unknown>;
  expiresAt: Date;
  /** Digest of the payload, echoed by the signer so tampering in transit is detectable. */
  digest: string;
}

export interface SignedTransfer {
  network: Network;
  env: NetworkEnv;
  /** Provider-specific signed body produced by the signer service. */
  payload: Record<string, unknown>;
  digest: string;
}

export interface BroadcastResult {
  txHash: string;
  accepted: boolean;
  detail?: string;
}

export interface ProviderHealth {
  name: string;
  healthy: boolean;
  latencyMs: number | null;
  detail?: string;
}

/**
 * The interface every chain integration implements.
 *
 * Adding Ethereum or Solana later means writing one of these plus a row in the asset
 * registry — nothing in the domain, database, or UI layers needs to change.
 */
export interface BlockchainProvider {
  readonly name: string;
  readonly network: Network;
  readonly env: NetworkEnv;
  /** Confirmations before a transaction is considered final on this network. */
  readonly requiredConfirmations: number;

  validateAddress(address: string): AddressValidation;

  getNativeBalance(address: string): Promise<bigint>;
  getTokenBalances(address: string, assets: AssetRef[]): Promise<TokenBalance[]>;

  /** Incremental transfer history. Providers must return newest-first and honour `cursor`. */
  listTransfers(address: string, cursor: ScanCursor, limit: number): Promise<TransferPage>;

  getTransactionStatus(txHash: string): Promise<ChainTransactionStatus>;

  estimateFee(request: TransferRequest): Promise<FeeEstimate>;

  /** Builds an unsigned transaction. MUST NOT sign, and MUST NOT touch key material. */
  buildTransfer(request: TransferRequest): Promise<UnsignedTransfer>;

  broadcast(signed: SignedTransfer): Promise<BroadcastResult>;

  health(): Promise<ProviderHealth>;
}

export interface ProviderContext {
  env: NetworkEnv;
  timeoutMs: number;
  maxResponseBytes: number;
  apiKeys: Record<string, string | undefined>;
  urls: Record<string, string>;
  requiredConfirmations: number;
}
