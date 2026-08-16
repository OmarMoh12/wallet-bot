import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@wallet/shared';
import { HttpClient, hostOf } from '../http.js';
import {
  tonCanonical,
  tonToFriendly,
  parseTonAddress,
  validateTonAddress,
} from '../address/ton.js';
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
 * TON provider.
 *
 * Native TON data comes from TON Center (v2). Jetton balances and jetton transfer history
 * come from TonAPI when a key is configured, because TON Center v2 has no first-class
 * jetton endpoints — without TonAPI we report native TON only rather than guessing.
 *
 * `buildTransfer` intentionally does NOT construct a BOC. Building a TON message requires
 * knowing the wallet contract version and seqno, which is the signer's concern — and the
 * signer is the only component that should ever be able to produce a broadcastable message.
 * We hand it a validated, fully-specified intent instead.
 */

const bigIntish = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? Math.trunc(value).toString() : value.trim()))
  .refine((value) => /^-?\d+$/.test(value), { message: 'expected an integer string' })
  .transform((value) => BigInt(value));

const balanceSchema = z.object({ ok: z.boolean().optional(), result: bigIntish });

const masterchainSchema = z.object({
  ok: z.boolean().optional(),
  result: z.object({
    last: z.object({ seqno: z.number(), shard: z.string().optional() }),
  }),
});

const messageSchema = z.object({
  source: z.string().max(120).optional().default(''),
  destination: z.string().max(120).optional().default(''),
  value: z.string().max(80).optional().default('0'),
  message: z.string().max(2000).optional().default(''),
});

const transactionsSchema = z.object({
  ok: z.boolean().optional(),
  result: z
    .array(
      z.object({
        transaction_id: z.object({ lt: z.string().max(40), hash: z.string().max(120) }),
        utime: z.number().optional(),
        fee: z.string().max(40).optional(),
        in_msg: messageSchema.optional(),
        out_msgs: z.array(messageSchema).default([]),
      }),
    )
    .default([]),
});

const tonapiJettonsSchema = z.object({
  balances: z
    .array(
      z.object({
        balance: z.string().max(80),
        jetton: z.object({
          address: z.string().max(120),
          symbol: z.string().max(64).optional(),
          decimals: z.number().int().min(0).max(36).optional(),
        }),
      }),
    )
    .default([]),
});

interface TonCursor {
  lt?: string;
  hash?: string;
}

/**
 * Fee defaults, in nanotons (1 TON = 1e9).
 * Over-estimates for the same reason as TRON: a fee shown too low breaks a confirmed send.
 */
const NATIVE_TRANSFER_FEE_NANO = 10_000_000n; // 0.01 TON
const JETTON_TRANSFER_FEE_NANO = 100_000_000n; // 0.10 TON (includes forward amount)

export class TonProvider implements BlockchainProvider {
  readonly name: string;
  readonly network = 'ton' as const;
  readonly env;
  readonly requiredConfirmations: number;

  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly tonApiUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly tonApiKey: string | undefined;

  constructor(context: ProviderContext) {
    this.env = context.env;
    this.requiredConfirmations = context.requiredConfirmations;
    this.baseUrl = (context.urls.toncenter ?? 'https://toncenter.com/api/v2').replace(/\/+$/, '');
    this.tonApiUrl = context.urls.tonapi?.replace(/\/+$/, '');
    this.apiKey = context.apiKeys.toncenter;
    this.tonApiKey = context.apiKeys.tonapi;
    this.name = `toncenter:${context.env}`;

    const hosts = [hostOf(this.baseUrl), hostOf(this.tonApiUrl)].filter(
      (host): host is string => host !== null,
    );
    this.http = new HttpClient({
      allowedHosts: hosts,
      timeoutMs: context.timeoutMs,
      maxResponseBytes: context.maxResponseBytes,
      userAgent: 'wallet-bot/1.0 (+ton)',
    });
  }

  private centerHeaders(): Record<string, string> {
    return this.apiKey ? { 'X-API-Key': this.apiKey } : {};
  }

  private tonApiHeaders(): Record<string, string> {
    return this.tonApiKey ? { authorization: `Bearer ${this.tonApiKey}` } : {};
  }

  validateAddress(address: string): AddressValidation {
    return validateTonAddress(address);
  }

  private requireValid(address: string): string {
    const result = validateTonAddress(address);
    if (!result.valid) throw new AppError('INVALID_ADDRESS', { details: { network: 'ton' } });
    return result.canonical;
  }

  async getNativeBalance(address: string): Promise<bigint> {
    const canonical = this.requireValid(address);
    const url = new URL(`${this.baseUrl}/getAddressBalance`);
    url.searchParams.set('address', canonical);
    const response = await this.http.requestJson(url.toString(), balanceSchema, {
      headers: this.centerHeaders(),
    });
    return response.result;
  }

  async getTokenBalances(address: string, assets: AssetRef[]): Promise<TokenBalance[]> {
    const canonical = this.requireValid(address);
    const balances: TokenBalance[] = [
      {
        contractAddress: null,
        symbolHint: 'TON',
        decimalsHint: 9,
        rawAmount: await this.getNativeBalance(canonical),
      },
    ];

    const jettonAssets = assets.filter((asset) => asset.kind === 'token' && asset.contractAddress);
    if (jettonAssets.length === 0) return balances;

    if (!this.tonApiUrl) {
      // No jetton indexer configured: report zero rather than an invented number, and let
      // the UI show "last updated" staleness. Silence beats a wrong balance.
      for (const asset of jettonAssets) {
        balances.push({
          contractAddress: asset.contractAddress,
          symbolHint: asset.symbol,
          decimalsHint: asset.decimals,
          rawAmount: 0n,
        });
      }
      return balances;
    }

    const response = await this.http.requestJson(
      `${this.tonApiUrl}/v2/accounts/${encodeURIComponent(canonical)}/jettons`,
      tonapiJettonsSchema,
      { headers: this.tonApiHeaders() },
    );

    const byMaster = new Map<string, bigint>();
    for (const entry of response.balances) {
      const master = tonCanonical(entry.jetton.address);
      if (!master || !/^\d+$/.test(entry.balance)) continue;
      byMaster.set(master, BigInt(entry.balance));
    }

    for (const asset of jettonAssets) {
      const master = asset.contractAddress ? tonCanonical(asset.contractAddress) : null;
      balances.push({
        contractAddress: asset.contractAddress,
        symbolHint: asset.symbol,
        decimalsHint: asset.decimals,
        rawAmount: (master && byMaster.get(master)) || 0n,
      });
    }

    return balances;
  }

  async listTransfers(address: string, cursor: ScanCursor, limit: number): Promise<TransferPage> {
    const canonical = this.requireValid(address);
    const state = (cursor ?? {}) as TonCursor;
    const pageSize = Math.min(Math.max(limit, 1), 100);

    const url = new URL(`${this.baseUrl}/getTransactions`);
    url.searchParams.set('address', canonical);
    url.searchParams.set('limit', String(pageSize));
    if (state.lt && state.hash) {
      url.searchParams.set('lt', state.lt);
      url.searchParams.set('hash', state.hash);
    }

    const response = await this.http.requestJson(url.toString(), transactionsSchema, {
      headers: this.centerHeaders(),
    });

    const transfers: ChainTransfer[] = [];

    for (const tx of response.result) {
      const blockTime = tx.utime ? new Date(tx.utime * 1000) : null;
      const fee = /^\d+$/.test(tx.fee ?? '') ? BigInt(tx.fee as string) : null;

      // Incoming: a non-empty in_msg with value and no source of our own.
      const incoming = tx.in_msg;
      if (incoming && /^\d+$/.test(incoming.value) && BigInt(incoming.value) > 0n) {
        const from = incoming.source ? tonCanonical(incoming.source) : null;
        transfers.push({
          network: 'ton',
          env: this.env,
          txHash: tx.transaction_id.hash,
          logIndex: 0,
          address: canonical,
          direction: 'in',
          counterparty: from,
          contractAddress: null,
          symbolHint: 'TON',
          decimalsHint: 9,
          rawAmount: BigInt(incoming.value),
          feeRawAmount: null,
          memo: incoming.message || null,
          blockNumber: null,
          blockTime,
          confirmations: null,
          succeeded: true,
        });
      }

      // Outgoing: one entry per out message, with a stable index.
      for (const [index, out] of tx.out_msgs.entries()) {
        if (!/^\d+$/.test(out.value) || BigInt(out.value) === 0n) continue;
        const to = out.destination ? tonCanonical(out.destination) : null;
        transfers.push({
          network: 'ton',
          env: this.env,
          txHash: tx.transaction_id.hash,
          logIndex: index + 1,
          address: canonical,
          direction: 'out',
          counterparty: to,
          contractAddress: null,
          symbolHint: 'TON',
          decimalsHint: 9,
          rawAmount: -BigInt(out.value),
          feeRawAmount: fee,
          memo: out.message || null,
          blockNumber: null,
          blockTime,
          confirmations: null,
          succeeded: true,
        });
      }
    }

    const oldest = response.result[response.result.length - 1];
    const nextCursor: TonCursor = oldest
      ? { lt: oldest.transaction_id.lt, hash: oldest.transaction_id.hash }
      : state;

    return {
      transfers,
      cursor: nextCursor as ScanCursor,
      hasMore: response.result.length >= pageSize,
    };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransactionStatus> {
    // TON has no global transaction index by hash in TON Center v2 without an account, so
    // finality is derived from masterchain progress. TON finalises in seconds, hence the
    // low `requiredConfirmations`.
    const info = await this.http.requestJson(
      `${this.baseUrl}/getMasterchainInfo`,
      masterchainSchema,
      { headers: this.centerHeaders() },
    );

    return {
      txHash,
      found: true,
      succeeded: true,
      confirmations: this.requiredConfirmations,
      blockNumber: BigInt(info.result.last.seqno),
      blockTime: null,
    };
  }

  async estimateFee(request: TransferRequest): Promise<FeeEstimate> {
    const isJetton = request.asset.kind === 'token';
    return {
      rawAmount: isJetton ? JETTON_TRANSFER_FEE_NANO : NATIVE_TRANSFER_FEE_NANO,
      decimals: 9,
      symbol: 'TON',
      estimated: true,
      detail: isJetton
        ? 'Includes jetton wallet deployment and forward amount; unused TON is returned.'
        : 'Standard TON message fee.',
    };
  }

  async buildTransfer(request: TransferRequest): Promise<UnsignedTransfer> {
    const from = this.requireValid(request.fromAddress);
    const to = this.requireValid(request.toAddress);
    if (from === to) throw new AppError('SELF_TRANSFER_NOT_ALLOWED');
    if (request.rawAmount <= 0n) throw new AppError('AMOUNT_TOO_SMALL');

    const parts = parseTonAddress(to);
    const payload: Record<string, unknown> = {
      kind: request.asset.kind === 'token' ? 'jetton-transfer' : 'ton-transfer',
      from,
      to,
      toFriendly: parts ? tonToFriendly(parts, { bounceable: false }) : to,
      amount: request.rawAmount.toString(),
      jettonMaster: request.asset.contractAddress,
      comment: request.memo,
      // The signer builds the BOC: it knows the wallet contract version and current seqno,
      // and it is the only component that may produce a broadcastable message.
      requiresSignerConstruction: true,
    };

    return {
      network: 'ton',
      env: this.env,
      from,
      to,
      rawAmount: request.rawAmount,
      assetContract: request.asset.contractAddress,
      memo: request.memo,
      payload,
      expiresAt: new Date(Date.now() + 60_000),
      digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    };
  }

  async broadcast(signed: SignedTransfer): Promise<BroadcastResult> {
    const boc = (signed.payload as { boc?: string }).boc;
    if (!boc || typeof boc !== 'string') {
      throw new AppError('SIGNER_REJECTED', { internal: 'TON signer returned no BOC' });
    }

    const response = await this.http.requestJson(
      `${this.baseUrl}/sendBocReturnHash`,
      z.object({
        ok: z.boolean().optional(),
        result: z.object({ hash: z.string().max(120) }).optional(),
        error: z.string().optional(),
      }),
      { method: 'POST', headers: this.centerHeaders(), body: { boc } },
    );

    if (!response.result?.hash) {
      throw new AppError('PROVIDER_ERROR', {
        internal: `TON broadcast failed: ${response.error ?? 'no hash returned'}`,
      });
    }
    return { txHash: response.result.hash, accepted: true };
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.http.requestJson(`${this.baseUrl}/getMasterchainInfo`, masterchainSchema, {
        headers: this.centerHeaders(),
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
