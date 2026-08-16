import { z } from 'zod';
import { AppError, bigintToNumber, type EvmNetwork } from '@wallet/shared';
import { HttpClient, hostOf } from '../http.js';
import {
  evmCanonical,
  isZeroAddress,
  toChecksumAddress,
  validateEvmAddress,
} from '../address/evm.js';
import { GAS_LIMITS, evmChain, type EvmChainConfig } from '../evm/chains.js';
import {
  ERC20_TRANSFER_TOPIC,
  decodeAddressWord,
  decodeUint256,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  parseQuantity,
  toHex,
  toQuantity,
} from '../evm/hex.js';
import { maxFeeWei, serializeUnsigned, type EvmTransactionRequest } from '../evm/transaction.js';
import type {
  AddressValidation,
  AssetRef,
  BlockchainProvider,
  BroadcastResult,
  ChainTransactionStatus,
  ChainTransfer,
  FeeEstimate,
  ProviderContext,
  ProviderHealth,
  ScanCursor,
  SignedTransfer,
  TokenBalance,
  TransferPage,
  TransferRequest,
  UnsignedTransfer,
} from '../types.js';

/**
 * EVM provider — one implementation for every EVM chain.
 *
 * Talks plain Ethereum JSON-RPC, so it works against any node: a public RPC endpoint, a
 * provider like QuickNode or Ankr, or your own. The chain-specific constants come from
 * `EVM_CHAINS`; nothing in this file is BSC-specific.
 *
 * Two things it does differently from the TRON and TON providers, because the chain does:
 *
 *   * **Gas is paid in the native coin, separately from the asset being sent.** Holding
 *     1000 USDT and zero BNB means you cannot move the USDT. The fee estimate and balance
 *     check treat that as a first-class failure (`INSUFFICIENT_GAS`) rather than a generic
 *     insufficient-balance error, because the remedy is completely different.
 *   * **Token transfers are log events, not transactions.** History comes from
 *     `eth_getLogs` filtered on the ERC-20 `Transfer` topic, which is why the scan cursor is
 *     a block range rather than an opaque page token.
 */

/* ------------------------------------------------------------------ schemas -- */

const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string().max(500),
  data: z.unknown().optional(),
});

const rpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
});

const quantitySchema = z.union([z.string(), z.number()]);

const logSchema = z.object({
  address: z.string().max(66),
  topics: z.array(z.string().max(66)).max(8),
  data: z.string().max(4096),
  blockNumber: quantitySchema.optional(),
  transactionHash: z.string().max(66),
  logIndex: quantitySchema.optional(),
  removed: z.boolean().optional(),
});

const logsSchema = z.array(logSchema).max(2000);

const blockSchema = z.object({
  number: quantitySchema.optional(),
  timestamp: quantitySchema.optional(),
});

const receiptSchema = z
  .object({
    status: quantitySchema.optional(),
    blockNumber: quantitySchema.optional(),
    transactionHash: z.string().max(66).optional(),
    gasUsed: quantitySchema.optional(),
    effectiveGasPrice: quantitySchema.optional(),
  })
  .nullable();

const txSchema = z
  .object({
    hash: z.string().max(66),
    from: z.string().max(66),
    to: z.string().max(66).nullable().optional(),
    value: quantitySchema.optional(),
    blockNumber: quantitySchema.nullable().optional(),
  })
  .nullable();

/* ------------------------------------------------------------------- cursor -- */

interface EvmCursor {
  /** Last block whose logs have been ingested, inclusive. */
  lastBlock?: string;
}

/**
 * Blocks scanned per pass.
 *
 * Public RPC endpoints cap `eth_getLogs` ranges — commonly at a few thousand blocks. BSC
 * produces ~28,800 blocks a day, so 2,000 blocks is roughly 100 minutes of history per pass:
 * comfortably inside every limit we have seen, and fast enough that a wallet added today
 * catches up within a handful of scans.
 */
const MAX_BLOCK_RANGE = 2_000n;

/** Never scan more than this far back on a first sight, to bound the initial catch-up. */
const INITIAL_LOOKBACK_BLOCKS = 20_000n;

export class EvmProvider implements BlockchainProvider {
  readonly name: string;
  readonly network: EvmNetwork;
  readonly env;
  readonly requiredConfirmations: number;

  private readonly http: HttpClient;
  private readonly rpcUrl: string;
  private readonly chain: EvmChainConfig;
  private requestId = 0;

  constructor(context: ProviderContext & { network: EvmNetwork }) {
    this.network = context.network;
    this.env = context.env;
    this.chain = evmChain(context.network, context.env);
    this.rpcUrl = context.urls.rpc ?? this.chain.defaultRpcUrl;
    this.requiredConfirmations = context.requiredConfirmations || this.chain.requiredConfirmations;
    this.name = `${context.network}-rpc:${context.env}`;

    const host = hostOf(this.rpcUrl);
    this.http = new HttpClient({
      allowedHosts: host ? [host] : [],
      timeoutMs: context.timeoutMs,
      maxResponseBytes: context.maxResponseBytes,
      userAgent: `wallet-bot/1.0 (+${context.network})`,
    });
  }

  /* --------------------------------------------------------------- transport -- */

  private async rpc<T>(
    method: string,
    params: unknown[],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    this.requestId += 1;

    const response = await this.http.requestJson(this.rpcUrl, rpcResponseSchema, {
      method: 'POST',
      body: { jsonrpc: '2.0', id: this.requestId, method, params },
    });

    if (response.error) {
      // -32000 covers most "your request was unreasonable" cases (range too wide, rate
      // limited). Surfacing the code keeps the message useful without leaking the endpoint.
      throw new AppError('PROVIDER_ERROR', {
        internal: `${method} failed: ${response.error.code} ${response.error.message}`,
        retryable: response.error.code === -32005 || response.error.code === -32000,
      });
    }

    const parsed = schema.safeParse(response.result);
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', {
        internal: `${method} returned an unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`,
      });
    }
    return parsed.data;
  }

  /* ---------------------------------------------------------------- addresses -- */

  validateAddress(address: string): AddressValidation {
    const result = validateEvmAddress(address);
    // `validateEvmAddress` cannot know which EVM chain it was called for, so correct the
    // reported network here.
    return result.valid ? { ...result, network: this.network } : result;
  }

  private requireValid(address: string): string {
    const canonical = evmCanonical(address);
    if (!canonical) {
      throw new AppError('INVALID_ADDRESS', { details: { network: this.network } });
    }
    return canonical;
  }

  /* ----------------------------------------------------------------- balances -- */

  async getNativeBalance(address: string): Promise<bigint> {
    const canonical = this.requireValid(address);
    const result = await this.rpc('eth_getBalance', [canonical, 'latest'], quantitySchema);
    return parseQuantity(result);
  }

  async getTokenBalances(address: string, assets: AssetRef[]): Promise<TokenBalance[]> {
    const canonical = this.requireValid(address);

    const balances: TokenBalance[] = [
      {
        contractAddress: null,
        symbolHint: this.chain.nativeSymbol,
        decimalsHint: this.chain.nativeDecimals,
        rawAmount: await this.getNativeBalance(canonical),
      },
    ];

    for (const asset of assets) {
      if (asset.kind !== 'token' || !asset.contractAddress) continue;
      const contract = evmCanonical(asset.contractAddress);
      if (!contract) continue;

      try {
        const data = `0x${toHex(encodeErc20BalanceOf(canonical))}`;
        const result = await this.rpc(
          'eth_call',
          [{ to: contract, data }, 'latest'],
          z.string().max(2048),
        );
        balances.push({
          contractAddress: asset.contractAddress,
          symbolHint: asset.symbol,
          decimalsHint: asset.decimals,
          rawAmount: decodeUint256(result),
        });
      } catch {
        // One unreachable token must not blank the whole portfolio. Report zero and let the
        // reconcile job correct it; the `updated_at` staleness is visible in the UI.
        balances.push({
          contractAddress: asset.contractAddress,
          symbolHint: asset.symbol,
          decimalsHint: asset.decimals,
          rawAmount: 0n,
        });
      }
    }

    return balances;
  }

  /* ------------------------------------------------------------------ history -- */

  private async blockNumber(): Promise<bigint> {
    return parseQuantity(await this.rpc('eth_blockNumber', [], quantitySchema));
  }

  private async blockTimestamp(blockNumber: bigint): Promise<Date | null> {
    try {
      const block = await this.rpc(
        'eth_getBlockByNumber',
        [toQuantity(blockNumber), false],
        blockSchema.nullable(),
      );
      if (!block?.timestamp) return null;
      // A Unix timestamp in seconds — a block height/time, not an amount.
      return new Date(bigintToNumber(parseQuantity(block.timestamp), 'blockTimestamp') * 1000);
    } catch {
      return null;
    }
  }

  /**
   * Transfer history from `eth_getLogs`.
   *
   * ERC-20 transfers are events, not transactions, so both directions are found by filtering
   * the `Transfer` topic with our address in the `from` slot and then in the `to` slot. The
   * native-coin transfers a plain RPC node cannot index are covered by the balance
   * reconciliation pass instead — see the note below.
   */
  async listTransfers(address: string, cursor: ScanCursor, limit: number): Promise<TransferPage> {
    const canonical = this.requireValid(address);
    const state = (cursor ?? {}) as EvmCursor;

    const head = await this.blockNumber();
    const confirmedHead =
      head > BigInt(this.requiredConfirmations) ? head - BigInt(this.requiredConfirmations) : 0n;

    const lastScanned = state.lastBlock ? BigInt(state.lastBlock) : null;
    const fromBlock =
      lastScanned !== null
        ? lastScanned + 1n
        : confirmedHead > INITIAL_LOOKBACK_BLOCKS
          ? confirmedHead - INITIAL_LOOKBACK_BLOCKS
          : 0n;

    if (fromBlock > confirmedHead) {
      // Nothing new has finalised since the last pass.
      return { transfers: [], cursor: state as ScanCursor, hasMore: false };
    }

    const toBlock =
      confirmedHead - fromBlock > MAX_BLOCK_RANGE ? fromBlock + MAX_BLOCK_RANGE : confirmedHead;

    // The address occupies the low 20 bytes of a 32-byte topic word.
    const addressTopic = `0x${'0'.repeat(24)}${canonical.slice(2)}`;

    const [incoming, outgoing] = await Promise.all([
      this.rpc(
        'eth_getLogs',
        [
          {
            fromBlock: toQuantity(fromBlock),
            toBlock: toQuantity(toBlock),
            topics: [ERC20_TRANSFER_TOPIC, null, addressTopic],
          },
        ],
        logsSchema,
      ),
      this.rpc(
        'eth_getLogs',
        [
          {
            fromBlock: toQuantity(fromBlock),
            toBlock: toQuantity(toBlock),
            topics: [ERC20_TRANSFER_TOPIC, addressTopic],
          },
        ],
        logsSchema,
      ),
    ]);

    const transfers: ChainTransfer[] = [];
    const timestamps = new Map<string, Date | null>();

    for (const [direction, logs] of [
      ['in', incoming],
      ['out', outgoing],
    ] as const) {
      for (const log of logs) {
        // A reorged-out log is explicitly flagged; ingesting it would record money that
        // no longer moved.
        if (log.removed) continue;
        if (log.topics.length < 3) continue;

        const contract = evmCanonical(log.address);
        if (!contract) continue;

        const from = decodeAddressWord(log.topics[1] as string);
        const to = decodeAddressWord(log.topics[2] as string);
        const amount = decodeUint256(log.data);
        if (amount === 0n) continue;

        // A self-transfer moves no net value and appears in both queries. Recording the
        // incoming leg would inflate the balance by the full amount, so skip it entirely.
        if (from === to) continue;

        const blockNumber = log.blockNumber ? parseQuantity(log.blockNumber) : null;
        const blockKey = blockNumber?.toString() ?? '';
        if (blockNumber !== null && !timestamps.has(blockKey)) {
          timestamps.set(blockKey, await this.blockTimestamp(blockNumber));
        }

        transfers.push({
          network: this.network,
          env: this.env,
          txHash: log.transactionHash,
          // The log index is unique within a block, and combined with the hash it uniquely
          // identifies this movement — which is exactly what the ledger's unique index needs.
          logIndex: log.logIndex ? bigintToNumber(parseQuantity(log.logIndex), 'logIndex') : 0,
          address: canonical,
          direction,
          counterparty: direction === 'in' ? toChecksumAddress(from) : toChecksumAddress(to),
          contractAddress: contract,
          symbolHint: null,
          decimalsHint: null,
          rawAmount: direction === 'in' ? amount : -amount,
          feeRawAmount: null,
          memo: null,
          blockNumber,
          blockTime: blockNumber !== null ? (timestamps.get(blockKey) ?? null) : null,
          confirmations:
            blockNumber !== null ? bigintToNumber(head - blockNumber, 'confirmations') : null,
          succeeded: true,
        });

        if (transfers.length >= limit) break;
      }
    }

    return {
      transfers,
      cursor: { lastBlock: toBlock.toString() } as ScanCursor,
      hasMore: toBlock < confirmedHead,
    };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransactionStatus> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new AppError('VALIDATION_ERROR', { internal: 'invalid EVM transaction hash' });
    }

    const receipt = await this.rpc('eth_getTransactionReceipt', [txHash], receiptSchema);

    if (!receipt) {
      // Not mined yet, or dropped from the mempool. Distinguish those by asking whether the
      // node still knows the transaction at all.
      const pending = await this.rpc('eth_getTransactionByHash', [txHash], txSchema);
      return {
        txHash,
        found: pending !== null,
        succeeded: false,
        confirmations: 0,
        blockNumber: null,
        blockTime: null,
      };
    }

    const blockNumber = receipt.blockNumber ? parseQuantity(receipt.blockNumber) : null;
    const head = await this.blockNumber();

    return {
      txHash,
      found: true,
      // status 0x1 = success, 0x0 = reverted. A reverted transaction still consumed gas but
      // moved no tokens.
      succeeded: receipt.status !== undefined && parseQuantity(receipt.status) === 1n,
      confirmations:
        blockNumber !== null ? bigintToNumber(head - blockNumber + 1n, 'confirmations') : 0,
      blockNumber,
      blockTime: blockNumber !== null ? await this.blockTimestamp(blockNumber) : null,
    };
  }

  /* ---------------------------------------------------------------------- gas -- */

  private async gasPrice(): Promise<bigint> {
    try {
      const price = parseQuantity(await this.rpc('eth_gasPrice', [], quantitySchema));
      if (price <= 0n) return this.chain.fallbackGasPriceWei;
      // A node quoting an absurd price — misconfigured, or hostile — must not produce a
      // ruinous fee on a confirmation screen.
      if (price > this.chain.maxGasPriceWei) return this.chain.maxGasPriceWei;
      return price;
    } catch {
      return this.chain.fallbackGasPriceWei;
    }
  }

  private async estimateGasLimit(params: {
    from: string;
    to: string;
    data: Uint8Array;
    value: bigint;
    isToken: boolean;
  }): Promise<bigint> {
    if (!params.isToken && params.data.length === 0) {
      // A plain value transfer is exactly 21000 by protocol definition; asking a node is
      // pointless and can fail if the sender has no balance yet.
      return GAS_LIMITS.nativeTransfer;
    }

    try {
      const estimate = parseQuantity(
        await this.rpc(
          'eth_estimateGas',
          [
            {
              from: params.from,
              to: params.to,
              value: toQuantity(params.value),
              data: `0x${toHex(params.data)}`,
            },
          ],
          quantitySchema,
        ),
      );

      // Pad, because state can change between estimation and mining — a recipient whose
      // balance slot goes from zero to non-zero costs more gas.
      const padded = (estimate * (100n + GAS_LIMITS.estimatePaddingPercent)) / 100n;

      if (padded > GAS_LIMITS.erc20TransferMax) {
        // Not a standard ERC-20 transfer: a token with transfer hooks, a fee-on-transfer
        // design, or something hostile. Refuse rather than send blind.
        throw new AppError('GAS_ESTIMATION_FAILED', {
          internal: `estimated gas ${padded} exceeds the ERC-20 ceiling`,
        });
      }
      return padded;
    } catch (error) {
      if (AppError.is(error) && error.code === 'GAS_ESTIMATION_FAILED') throw error;
      // Estimation commonly fails when the sender cannot yet afford the call. Fall back to a
      // known-good limit; the balance check below is what actually protects the user.
      return GAS_LIMITS.erc20TransferFallback;
    }
  }

  async estimateFee(request: TransferRequest): Promise<FeeEstimate> {
    const from = this.requireValid(request.fromAddress);
    const to = this.requireValid(request.toAddress);
    const isToken = request.asset.kind === 'token';

    const data = isToken ? encodeErc20Transfer(to, request.rawAmount) : new Uint8Array(0);

    const [price, gasLimit] = await Promise.all([
      this.gasPrice(),
      this.estimateGasLimit({
        from,
        to: isToken ? this.requireValid(request.asset.contractAddress as string) : to,
        data,
        value: isToken ? 0n : request.rawAmount,
        isToken,
      }),
    ]);

    return {
      rawAmount: gasLimit * price,
      decimals: this.chain.nativeDecimals,
      symbol: this.chain.nativeSymbol,
      estimated: true,
      detail: `gas ${gasLimit} × ${price} wei${isToken ? ' (ERC-20 transfer)' : ''}`,
    };
  }

  /* ------------------------------------------------------------------ sending -- */

  /**
   * Build an unsigned transaction.
   *
   * Touches no key material: nonce and gas come from the node, the payload is pure encoding.
   * The signer receives this and returns a signature; it never decides *what* to sign.
   */
  async buildTransfer(request: TransferRequest): Promise<UnsignedTransfer> {
    const from = this.requireValid(request.fromAddress);
    const to = this.requireValid(request.toAddress);

    if (from === to) throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    if (isZeroAddress(to)) {
      // A valid address that destroys funds. Almost always an empty field, never intent.
      throw new AppError('INVALID_ADDRESS', {
        details: { reason: 'zero_address' },
        internal: 'refusing to send to the zero address',
      });
    }
    if (request.rawAmount <= 0n) throw new AppError('AMOUNT_TOO_SMALL');

    const isToken = request.asset.kind === 'token';
    const contract = isToken ? this.requireValid(request.asset.contractAddress as string) : null;

    const data = isToken ? encodeErc20Transfer(to, request.rawAmount) : new Uint8Array(0);
    const target = isToken ? (contract as string) : to;
    const value = isToken ? 0n : request.rawAmount;

    const [nonce, price, gasLimit] = await Promise.all([
      this.rpc('eth_getTransactionCount', [from, 'pending'], quantitySchema).then(parseQuantity),
      this.gasPrice(),
      this.estimateGasLimit({ from, to: target, data, value, isToken }),
    ]);

    const tx: EvmTransactionRequest = this.chain.supportsEip1559
      ? {
          type: 'eip1559',
          chainId: this.chain.chainId,
          nonce,
          to: target,
          value,
          data,
          gasLimit,
          maxFeePerGas: price * 2n,
          maxPriorityFeePerGas: price / 10n,
        }
      : {
          type: 'legacy',
          chainId: this.chain.chainId,
          nonce,
          to: target,
          value,
          data,
          gasLimit,
          gasPrice: price,
        };

    // Verify the native balance covers value + the worst-case fee. On EVM chains this is the
    // single most common send failure: plenty of USDT, no BNB for gas.
    const nativeBalance = await this.getNativeBalance(from);
    const feeCeiling = maxFeeWei(tx);
    const nativeRequired = feeCeiling + (isToken ? 0n : request.rawAmount);

    if (nativeBalance < nativeRequired) {
      throw new AppError(isToken ? 'INSUFFICIENT_GAS' : 'INSUFFICIENT_BALANCE', {
        details: {
          symbol: this.chain.nativeSymbol,
          required: nativeRequired.toString(),
          available: nativeBalance.toString(),
        },
        internal: `native balance ${nativeBalance} < required ${nativeRequired}`,
      });
    }

    const unsignedBytes = serializeUnsigned(tx);

    return {
      network: this.network,
      env: this.env,
      from,
      to,
      rawAmount: request.rawAmount,
      assetContract: request.asset.contractAddress,
      memo: request.memo,
      payload: {
        kind: 'evm-transaction',
        txType: tx.type,
        chainId: tx.chainId,
        nonce: tx.nonce.toString(),
        to: tx.to,
        value: tx.value.toString(),
        data: `0x${toHex(tx.data)}`,
        gasLimit: tx.gasLimit.toString(),
        ...(tx.type === 'legacy'
          ? { gasPrice: (tx.gasPrice as bigint).toString() }
          : {
              maxFeePerGas: (tx.maxFeePerGas as bigint).toString(),
              maxPriorityFeePerGas: (tx.maxPriorityFeePerGas as bigint).toString(),
            }),
        // The signer recomputes this and refuses if it disagrees, so a payload altered in
        // transit cannot be signed.
        unsignedHex: `0x${toHex(unsignedBytes)}`,
      },
      // A nonce goes stale as soon as another transaction is sent from the same address.
      expiresAt: new Date(Date.now() + 120_000),
      digest: `0x${toHex(unsignedBytes)}`.slice(2, 66),
    };
  }

  async broadcast(signed: SignedTransfer): Promise<BroadcastResult> {
    const raw = (signed.payload as { rawTransaction?: string }).rawTransaction;
    if (!raw || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new AppError('SIGNER_REJECTED', {
        internal: 'EVM signer returned no raw transaction',
      });
    }

    const hash = await this.rpc('eth_sendRawTransaction', [raw], z.string().max(66));
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new AppError('PROVIDER_ERROR', { internal: 'broadcast returned a malformed hash' });
    }
    return { txHash: hash, accepted: true };
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const chainId = parseQuantity(await this.rpc('eth_chainId', [], quantitySchema));
      if (bigintToNumber(chainId, 'chainId') !== this.chain.chainId) {
        // The endpoint is serving a different chain than configured. Sending against it
        // would produce transactions signed for the wrong network.
        return {
          name: this.name,
          healthy: false,
          latencyMs: Date.now() - startedAt,
          detail: `chain id mismatch: node reports ${chainId}, expected ${this.chain.chainId}`,
        };
      }
      return { name: this.name, healthy: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        name: this.name,
        healthy: false,
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  /** Chain id, for the send pipeline's pre-flight check. */
  get chainId(): number {
    return this.chain.chainId;
  }
}
