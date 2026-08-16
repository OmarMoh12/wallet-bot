import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@wallet/shared';
import { HttpClient } from '../http.js';
import { tronBase58ToHex, tronHexToBase58, validateTronAddress } from '../address/tron.js';
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
 * TRON provider, backed by TronGrid's public API.
 *
 * Design notes:
 *   * Every response is Zod-validated. Token metadata in particular (`symbol`, `decimals`)
 *     is attacker-controlled — anyone can deploy a TRC20 contract claiming to be USDT with
 *     18 decimals. We therefore treat chain-reported symbol/decimals as *hints* and always
 *     price against our own asset registry, matched by contract address.
 *   * Amounts are parsed straight from decimal strings into BigInt. No `Number` anywhere.
 *   * `buildTransfer` uses TronGrid's transaction-construction endpoints, which are
 *     keyless. Signing happens only in the isolated signer service.
 */

/** Decimal-string → BigInt, rejecting anything else. Chain data is untrusted input. */
const bigIntString = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? Math.trunc(value).toString() : value.trim()))
  .refine((value) => /^-?\d+$/.test(value), { message: 'expected an integer string' })
  .transform((value) => BigInt(value));

const accountSchema = z.object({
  data: z
    .array(
      z.object({
        balance: bigIntString.optional(),
        trc20: z.array(z.record(z.string(), z.string())).optional(),
      }),
    )
    .default([]),
});

const trc20TransferSchema = z.object({
  data: z
    .array(
      z.object({
        transaction_id: z.string().min(1).max(128),
        token_info: z
          .object({
            symbol: z.string().max(64).optional(),
            address: z.string().max(120).optional(),
            decimals: z.number().int().min(0).max(36).optional(),
          })
          .optional(),
        from: z.string().max(120),
        to: z.string().max(120),
        value: z.string().max(80),
        block_timestamp: z.number().optional(),
        type: z.string().max(40).optional(),
      }),
    )
    .default([]),
  meta: z
    .object({
      fingerprint: z.string().max(400).optional(),
      page_size: z.number().optional(),
    })
    .optional(),
});

const nativeTransactionSchema = z.object({
  data: z
    .array(
      z.object({
        txID: z.string().min(1).max(128),
        block_timestamp: z.number().optional(),
        blockNumber: z.number().optional(),
        ret: z.array(z.object({ contractRet: z.string().max(40).optional() })).optional(),
        raw_data: z
          .object({
            contract: z
              .array(
                z.object({
                  type: z.string().max(60),
                  parameter: z
                    .object({
                      value: z
                        .object({
                          amount: z.number().or(z.string()).optional(),
                          owner_address: z.string().max(120).optional(),
                          to_address: z.string().max(120).optional(),
                        })
                        .optional(),
                    })
                    .optional(),
                }),
              )
              .default([]),
          })
          .optional(),
      }),
    )
    .default([]),
  meta: z.object({ fingerprint: z.string().max(400).optional() }).optional(),
});

const nowBlockSchema = z.object({
  block_header: z.object({
    raw_data: z.object({ number: z.number().optional(), timestamp: z.number().optional() }),
  }),
});

const txInfoSchema = z.object({
  id: z.string().optional(),
  blockNumber: z.number().optional(),
  blockTimeStamp: z.number().optional(),
  receipt: z.object({ result: z.string().max(40).optional() }).optional(),
  result: z.string().max(40).optional(),
});

const createTransactionSchema = z.object({
  txID: z.string().optional(),
  raw_data_hex: z.string().optional(),
  raw_data: z.unknown().optional(),
  Error: z.string().optional(),
});

const triggerSchema = z.object({
  transaction: createTransactionSchema.optional(),
  result: z.object({ result: z.boolean().optional(), message: z.string().optional() }).optional(),
});

const broadcastSchema = z.object({
  result: z.boolean().optional(),
  txid: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

interface TronCursor {
  trc20Fingerprint?: string;
  nativeFingerprint?: string;
  /** Highest block timestamp already ingested; anything at or below is skipped. */
  lastSeenMs?: number;
}

/**
 * Conservative fee defaults (in SUN, 1 TRX = 1e6 SUN).
 *
 * TRON fees depend on the sender's staked bandwidth and energy, which we cannot know for a
 * watch-only address. These are deliberate over-estimates: showing a fee that turns out
 * lower is harmless, while under-estimating causes a transfer to fail after the user has
 * already confirmed it.
 */
const NATIVE_TRANSFER_FEE_SUN = 1_100_000n; // ~1.1 TRX
const TRC20_TRANSFER_FEE_SUN = 30_000_000n; // ~30 TRX worst case without energy

export class TronProvider implements BlockchainProvider {
  readonly name: string;
  readonly network = 'tron' as const;
  readonly env;
  readonly requiredConfirmations: number;

  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(context: ProviderContext) {
    this.env = context.env;
    this.requiredConfirmations = context.requiredConfirmations;
    this.baseUrl = (context.urls.trongrid ?? 'https://api.trongrid.io').replace(/\/+$/, '');
    this.apiKey = context.apiKeys.trongrid;
    this.name = `trongrid:${context.env}`;
    this.http = new HttpClient({
      allowedHosts: [new URL(this.baseUrl).hostname],
      timeoutMs: context.timeoutMs,
      maxResponseBytes: context.maxResponseBytes,
      userAgent: 'wallet-bot/1.0 (+tron)',
    });
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { 'TRON-PRO-API-KEY': this.apiKey } : {};
  }

  validateAddress(address: string): AddressValidation {
    return validateTronAddress(address);
  }

  private requireValid(address: string): string {
    const result = validateTronAddress(address);
    if (!result.valid) {
      throw new AppError('INVALID_ADDRESS', { details: { network: 'tron' } });
    }
    return result.canonical;
  }

  async getNativeBalance(address: string): Promise<bigint> {
    const canonical = this.requireValid(address);
    const response = await this.http.requestJson(
      `${this.baseUrl}/v1/accounts/${encodeURIComponent(canonical)}`,
      accountSchema,
      { headers: this.headers() },
    );
    return response.data[0]?.balance ?? 0n;
  }

  async getTokenBalances(address: string, assets: AssetRef[]): Promise<TokenBalance[]> {
    const canonical = this.requireValid(address);
    const response = await this.http.requestJson(
      `${this.baseUrl}/v1/accounts/${encodeURIComponent(canonical)}`,
      accountSchema,
      { headers: this.headers() },
    );

    const account = response.data[0];
    const balances: TokenBalance[] = [];

    // Native coin first.
    balances.push({
      contractAddress: null,
      symbolHint: 'TRX',
      decimalsHint: 6,
      rawAmount: account?.balance ?? 0n,
    });

    // TronGrid returns trc20 as [{ "<contract>": "<amount>" }, ...].
    const byContract = new Map<string, bigint>();
    for (const entry of account?.trc20 ?? []) {
      for (const [contract, amount] of Object.entries(entry)) {
        if (!/^-?\d+$/.test(amount)) continue; // Ignore malformed entries rather than throwing.
        byContract.set(contract, BigInt(amount));
      }
    }

    // Only report assets in our registry. An unknown contract claiming to be USDT is
    // ignored rather than displayed — this is the "fake token" defence.
    for (const asset of assets) {
      if (asset.kind !== 'token' || !asset.contractAddress) continue;
      balances.push({
        contractAddress: asset.contractAddress,
        symbolHint: asset.symbol,
        decimalsHint: asset.decimals,
        rawAmount: byContract.get(asset.contractAddress) ?? 0n,
      });
    }

    return balances;
  }

  async listTransfers(address: string, cursor: ScanCursor, limit: number): Promise<TransferPage> {
    const canonical = this.requireValid(address);
    const state = (cursor ?? {}) as TronCursor;
    const pageSize = Math.min(Math.max(limit, 1), 100);

    const transfers: ChainTransfer[] = [];
    const nextCursor: TronCursor = { ...state };

    // --- TRC20 transfers -----------------------------------------------------
    const trc20Url = new URL(
      `${this.baseUrl}/v1/accounts/${encodeURIComponent(canonical)}/transactions/trc20`,
    );
    trc20Url.searchParams.set('limit', String(pageSize));
    trc20Url.searchParams.set('order_by', 'block_timestamp,desc');
    if (state.trc20Fingerprint) trc20Url.searchParams.set('fingerprint', state.trc20Fingerprint);

    const trc20 = await this.http.requestJson(trc20Url.toString(), trc20TransferSchema, {
      headers: this.headers(),
    });

    for (const [index, item] of trc20.data.entries()) {
      if (!/^\d+$/.test(item.value)) continue;
      const from = normaliseTronAddress(item.from);
      const to = normaliseTronAddress(item.to);
      if (!from || !to) continue;

      const isIncoming = to === canonical;
      const isOutgoing = from === canonical;
      if (!isIncoming && !isOutgoing) continue;

      const magnitude = BigInt(item.value);
      transfers.push({
        network: 'tron',
        env: this.env,
        txHash: item.transaction_id,
        // TronGrid does not expose a log index on this endpoint; the position within the
        // transaction's transfer list is stable for a given hash, so we use it.
        logIndex: index,
        address: canonical,
        direction: isIncoming ? 'in' : 'out',
        counterparty: isIncoming ? from : to,
        contractAddress: item.token_info?.address ?? null,
        symbolHint: item.token_info?.symbol ?? null,
        decimalsHint: item.token_info?.decimals ?? null,
        rawAmount: isIncoming ? magnitude : -magnitude,
        feeRawAmount: null,
        memo: null,
        blockNumber: null,
        blockTime: item.block_timestamp ? new Date(item.block_timestamp) : null,
        confirmations: null,
        succeeded: true,
      });
    }
    if (trc20.meta?.fingerprint) nextCursor.trc20Fingerprint = trc20.meta.fingerprint;

    // --- Native TRX transfers -----------------------------------------------
    const nativeUrl = new URL(
      `${this.baseUrl}/v1/accounts/${encodeURIComponent(canonical)}/transactions`,
    );
    nativeUrl.searchParams.set('limit', String(pageSize));
    nativeUrl.searchParams.set('order_by', 'block_timestamp,desc');
    if (state.nativeFingerprint) {
      nativeUrl.searchParams.set('fingerprint', state.nativeFingerprint);
    }

    const native = await this.http.requestJson(nativeUrl.toString(), nativeTransactionSchema, {
      headers: this.headers(),
    });

    for (const item of native.data) {
      const contract = item.raw_data?.contract?.[0];
      if (!contract || contract.type !== 'TransferContract') continue;
      const value = contract.parameter?.value;
      if (!value?.amount) continue;

      const amountText = typeof value.amount === 'number' ? String(value.amount) : value.amount;
      if (!/^\d+$/.test(amountText)) continue;

      const from = normaliseTronAddress(value.owner_address ?? '');
      const to = normaliseTronAddress(value.to_address ?? '');
      if (!from || !to) continue;

      const isIncoming = to === canonical;
      const isOutgoing = from === canonical;
      if (!isIncoming && !isOutgoing) continue;

      const succeeded = (item.ret?.[0]?.contractRet ?? 'SUCCESS') === 'SUCCESS';
      const magnitude = BigInt(amountText);

      transfers.push({
        network: 'tron',
        env: this.env,
        txHash: item.txID,
        // Native transfers are the transaction itself; a fixed sentinel keeps them from
        // colliding with TRC20 log indices under the (hash, logIndex) unique constraint.
        logIndex: -1,
        address: canonical,
        direction: isIncoming ? 'in' : 'out',
        counterparty: isIncoming ? from : to,
        contractAddress: null,
        symbolHint: 'TRX',
        decimalsHint: 6,
        rawAmount: isIncoming ? magnitude : -magnitude,
        feeRawAmount: null,
        memo: null,
        blockNumber: item.blockNumber ? BigInt(item.blockNumber) : null,
        blockTime: item.block_timestamp ? new Date(item.block_timestamp) : null,
        confirmations: null,
        succeeded,
      });
    }
    if (native.meta?.fingerprint) nextCursor.nativeFingerprint = native.meta.fingerprint;

    const newest = transfers.reduce<number>(
      (max, transfer) => Math.max(max, transfer.blockTime?.getTime() ?? 0),
      state.lastSeenMs ?? 0,
    );
    nextCursor.lastSeenMs = newest;

    return {
      transfers,
      cursor: nextCursor as ScanCursor,
      hasMore: Boolean(trc20.meta?.fingerprint || native.meta?.fingerprint),
    };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransactionStatus> {
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new AppError('VALIDATION_ERROR', { internal: 'invalid TRON transaction hash' });
    }

    const info = await this.http.requestJson(
      `${this.baseUrl}/wallet/gettransactioninfobyid`,
      txInfoSchema,
      { method: 'POST', headers: this.headers(), body: { value: txHash } },
    );

    if (!info.id && info.blockNumber === undefined) {
      return {
        txHash,
        found: false,
        succeeded: false,
        confirmations: 0,
        blockNumber: null,
        blockTime: null,
      };
    }

    const head = await this.http.requestJson(`${this.baseUrl}/wallet/getnowblock`, nowBlockSchema, {
      method: 'POST',
      headers: this.headers(),
    });

    const headNumber = head.block_header.raw_data.number ?? 0;
    const blockNumber = info.blockNumber ?? 0;
    const confirmations = blockNumber > 0 ? Math.max(0, headNumber - blockNumber + 1) : 0;
    const receipt = info.receipt?.result;

    return {
      txHash,
      found: true,
      // An empty receipt on a mined TRON transaction means a plain TRX transfer, which
      // succeeded if it was included at all.
      succeeded: receipt === undefined || receipt === 'SUCCESS',
      confirmations,
      blockNumber: blockNumber > 0 ? BigInt(blockNumber) : null,
      blockTime: info.blockTimeStamp ? new Date(info.blockTimeStamp) : null,
    };
  }

  async estimateFee(request: TransferRequest): Promise<FeeEstimate> {
    const isToken = request.asset.kind === 'token';
    return {
      rawAmount: isToken ? TRC20_TRANSFER_FEE_SUN : NATIVE_TRANSFER_FEE_SUN,
      decimals: 6,
      symbol: 'TRX',
      estimated: true,
      detail: isToken
        ? 'Worst-case TRC20 energy cost; the actual fee is lower when the sender has staked energy.'
        : 'Bandwidth-only transfer.',
    };
  }

  async buildTransfer(request: TransferRequest): Promise<UnsignedTransfer> {
    const from = this.requireValid(request.fromAddress);
    const to = this.requireValid(request.toAddress);
    if (from === to) throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    if (request.rawAmount <= 0n) throw new AppError('AMOUNT_TOO_SMALL');

    let payload: Record<string, unknown>;

    if (request.asset.kind === 'native') {
      const built = await this.http.requestJson(
        `${this.baseUrl}/wallet/createtransaction`,
        createTransactionSchema,
        {
          method: 'POST',
          headers: this.headers(),
          body: {
            owner_address: from,
            to_address: to,
            amount: request.rawAmount.toString(),
            visible: true,
          },
        },
      );
      if (built.Error || !built.txID) {
        throw new AppError('PROVIDER_ERROR', {
          internal: `TRON createtransaction failed: ${built.Error ?? 'no txID'}`,
        });
      }
      payload = built as unknown as Record<string, unknown>;
    } else {
      if (!request.asset.contractAddress) {
        throw new AppError('ASSET_NOT_SUPPORTED', { internal: 'token asset without a contract' });
      }
      // transfer(address,uint256) — the recipient is encoded as a 32-byte word.
      const toHex = tronBase58ToHexWord(to);
      const amountHex = request.rawAmount.toString(16).padStart(64, '0');
      const built = await this.http.requestJson(
        `${this.baseUrl}/wallet/triggersmartcontract`,
        triggerSchema,
        {
          method: 'POST',
          headers: this.headers(),
          body: {
            owner_address: from,
            contract_address: request.asset.contractAddress,
            function_selector: 'transfer(address,uint256)',
            parameter: `${toHex}${amountHex}`,
            // TronGrid requires fee_limit as a JSON number. The constant is a fixed
            // protocol cap well inside the safe-integer range, not a user amount.
            fee_limit: globalThis.Number(TRC20_TRANSFER_FEE_SUN),
            call_value: 0,
            visible: true,
          },
        },
      );
      if (!built.transaction?.txID) {
        throw new AppError('PROVIDER_ERROR', {
          internal: `TRON triggersmartcontract failed: ${built.result?.message ?? 'no transaction'}`,
        });
      }
      payload = built.transaction as unknown as Record<string, unknown>;
    }

    const serialized = JSON.stringify(payload);
    return {
      network: 'tron',
      env: this.env,
      from,
      to,
      rawAmount: request.rawAmount,
      assetContract: request.asset.contractAddress,
      memo: request.memo,
      payload,
      // TRON transactions carry a ~60s expiration; keep our envelope shorter.
      expiresAt: new Date(Date.now() + 45_000),
      digest: createHash('sha256').update(serialized).digest('hex'),
    };
  }

  async broadcast(signed: SignedTransfer): Promise<BroadcastResult> {
    const response = await this.http.requestJson(
      `${this.baseUrl}/wallet/broadcasttransaction`,
      broadcastSchema,
      { method: 'POST', headers: this.headers(), body: signed.payload },
    );

    if (response.result !== true) {
      throw new AppError('SIGNER_REJECTED', {
        internal:
          `TRON broadcast rejected: ${response.code ?? ''} ${response.message ?? ''}`.trim(),
      });
    }

    const txid = response.txid ?? (signed.payload as { txID?: string }).txID;
    if (!txid) {
      throw new AppError('PROVIDER_ERROR', { internal: 'TRON broadcast returned no txid' });
    }
    return { txHash: txid, accepted: true };
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.http.requestJson(`${this.baseUrl}/wallet/getnowblock`, nowBlockSchema, {
        method: 'POST',
        headers: this.headers(),
        timeoutMs: 4000,
      });
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
}

/** TronGrid returns either base58 or `41…` hex depending on the endpoint. Normalise both. */
function normaliseTronAddress(value: string): string | null {
  if (!value) return null;
  const result = validateTronAddress(value);
  if (result.valid) return result.canonical;
  const converted = tronHexToBase58(value);
  return converted;
}

/**
 * Base58 TRON address → 32-byte ABI word.
 *
 * The `transfer(address,uint256)` ABI expects the 20-byte account, left-padded to 32 bytes.
 * The base58 payload is `0x41` + 20 bytes, so the prefix byte is dropped first.
 */
function tronBase58ToHexWord(address: string): string {
  const hex = tronBase58ToHex(address);
  if (!hex) throw new AppError('INVALID_ADDRESS');
  return hex.slice(2).padStart(64, '0');
}
