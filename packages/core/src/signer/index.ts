import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@wallet/shared';
import type { SignedTransfer, UnsignedTransfer } from '@wallet/blockchain';
import type { ServerConfig } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * The signing seam.
 *
 * The web tier can *describe* a transfer but can never produce a signed one. Two
 * implementations:
 *
 *   * `MockSigner`  — default. Returns a deterministic fake signature and marks the result
 *     simulated. Nothing is broadcast. This is what runs until an operator deliberately
 *     turns real sending on.
 *   * `RemoteSigner` — calls the isolated signer service over a private network with an
 *     HMAC-signed, timestamped, nonce-bearing request. The signer holds the only copy of
 *     `SIGNER_MASTER_KEY`; the web app cannot decrypt key material even if fully
 *     compromised.
 *
 * There is deliberately no `LocalSigner` that reads a key from the database. See
 * docs/security.md §"Signing architecture" for the threat model.
 */

export interface SignRequest {
  /** Correlates the signer's audit log with ours. */
  sendRequestId: string;
  idempotencyKey: string;
  unsigned: UnsignedTransfer;
  /** USD value, minor units — the signer enforces its own limits independently. */
  valueUsdMinor: bigint | null;
}

export interface SignResult {
  signed: SignedTransfer;
  /** True when nothing was really signed. Propagated all the way to the UI. */
  simulated: boolean;
  signerRef: string;
}

/** Request to create a new address whose key the signer will hold. */
export interface GenerateAddressRequest {
  network: 'bsc';
  env: 'mainnet' | 'testnet';
  label?: string;
  /** Prevents a retry from stranding a second, unknown funded address. */
  idempotencyKey: string;
}

export interface GenerateAddressResult {
  address: string;
  /** False when a previous call with the same key already produced this address. */
  created: boolean;
  simulated: boolean;
}

export interface Signer {
  readonly mode: 'mock' | 'remote';
  readonly simulated: boolean;
  sign(request: SignRequest): Promise<SignResult>;
  /**
   * Create an address and retain its private key.
   *
   * The key is generated, encrypted and stored **inside the signer**. Only the address comes
   * back — there is no API shape that can return a private key, which is what makes
   * "the user can never see it" a structural property rather than a policy.
   */
  generateAddress(request: GenerateAddressRequest): Promise<GenerateAddressResult>;
  health(): Promise<{ healthy: boolean; detail?: string }>;
}

/* ------------------------------------------------------------- HMAC framing -- */

export interface SignedEnvelope {
  timestamp: string;
  nonce: string;
  signature: string;
  body: string;
}

/**
 * Canonical string signed by both sides: `METHOD\npath\ntimestamp\nnonce\nsha256(body)`.
 * Including the method and path stops a signed body from being replayed against a
 * different endpoint.
 */
export function canonicalRequest(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  const bodyHash = createHmac('sha256', 'body').update(params.body).digest('hex');
  return [params.method.toUpperCase(), params.path, params.timestamp, params.nonce, bodyHash].join(
    '\n',
  );
}

export function signEnvelope(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyEnvelopeSignature(
  secret: string,
  canonical: string,
  received: string,
): boolean {
  if (!secret || !received || !/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = signEnvelope(secret, canonical);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* -------------------------------------------------------------- mock signer -- */

export class MockSigner implements Signer {
  readonly mode = 'mock' as const;
  readonly simulated = true;

  async sign(request: SignRequest): Promise<SignResult> {
    // Deterministic per request so a retry with the same idempotency key produces the same
    // artefact — mirroring the guarantee a real signer must provide.
    const signature = createHmac('sha256', 'mock-signer')
      .update(`${request.idempotencyKey}:${request.unsigned.digest}`)
      .digest('hex');

    return {
      signed: {
        network: request.unsigned.network,
        env: request.unsigned.env,
        payload: {
          ...request.unsigned.payload,
          mockSignature: signature,
          simulated: true,
        },
        digest: request.unsigned.digest,
      },
      simulated: true,
      signerRef: `mock:${signature.slice(0, 16)}`,
    };
  }

  /**
   * Deterministic fake address.
   *
   * Derived from the idempotency key so the same request always yields the same address,
   * and prefixed `0x00…` so it is recognisably not a real account. No key is generated,
   * because in mock mode nothing can ever be signed with one.
   */
  async generateAddress(request: GenerateAddressRequest): Promise<GenerateAddressResult> {
    const digest = createHmac('sha256', 'mock-address')
      .update(`${request.network}:${request.env}:${request.idempotencyKey}`)
      .digest('hex');
    return {
      address: `0x${digest.slice(0, 40)}`,
      created: true,
      simulated: true,
    };
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: 'mock signer — nothing is broadcast' };
  }
}

/* ------------------------------------------------------------ remote signer -- */

const signerResponseSchema = z.object({
  ok: z.boolean(),
  signerRef: z.string().max(128).optional(),
  digest: z.string().max(128).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(200).optional(),
});

export class RemoteSigner implements Signer {
  readonly mode = 'remote' as const;
  readonly simulated = false;

  constructor(
    private readonly options: {
      url: string;
      secret: string;
      timeoutMs: number;
      logger: Logger;
    },
  ) {
    if (!options.secret) {
      throw new AppError('INTERNAL_ERROR', { internal: 'RemoteSigner requires an HMAC secret' });
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const serialized = JSON.stringify(body);
    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const signature = signEnvelope(
      this.options.secret,
      canonicalRequest({ method: 'POST', path, timestamp, nonce, body: serialized }),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.url.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signer-timestamp': timestamp,
          'x-signer-nonce': nonce,
          'x-signer-signature': signature,
        },
        body: serialized,
        redirect: 'manual',
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new AppError(response.status >= 500 ? 'SIGNER_UNAVAILABLE' : 'SIGNER_REJECTED', {
          internal: `signer responded ${response.status}: ${text.slice(0, 200)}`,
          // Never retried automatically: a retry after an ambiguous response is how a
          // transfer gets signed twice.
          retryable: false,
        });
      }

      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new AppError('SIGNER_REJECTED', { internal: 'signer response failed validation' });
      }
      return parsed.data;
    } catch (error) {
      if (AppError.is(error)) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('SIGNER_UNAVAILABLE', {
          internal: 'signer timed out',
          retryable: false,
        });
      }
      throw new AppError('SIGNER_UNAVAILABLE', {
        internal: `signer unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        retryable: false,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async sign(request: SignRequest): Promise<SignResult> {
    const response = await this.post(
      '/sign',
      {
        sendRequestId: request.sendRequestId,
        idempotencyKey: request.idempotencyKey,
        valueUsdMinor: request.valueUsdMinor?.toString() ?? null,
        unsigned: {
          network: request.unsigned.network,
          env: request.unsigned.env,
          from: request.unsigned.from,
          to: request.unsigned.to,
          rawAmount: request.unsigned.rawAmount.toString(),
          assetContract: request.unsigned.assetContract,
          memo: request.unsigned.memo,
          payload: request.unsigned.payload,
          digest: request.unsigned.digest,
          expiresAt: request.unsigned.expiresAt.toISOString(),
        },
      },
      signerResponseSchema,
    );

    if (!response.ok || !response.payload) {
      throw new AppError('SIGNER_REJECTED', {
        internal: `signer refused: ${response.error ?? 'no reason given'}`,
      });
    }

    // The signer echoes the digest of what it signed. A mismatch means the payload changed
    // in transit, which must never be broadcast.
    if (response.digest && response.digest !== request.unsigned.digest) {
      throw new AppError('SIGNER_REJECTED', {
        internal: 'signer returned a digest that does not match the request',
      });
    }

    return {
      signed: {
        network: request.unsigned.network,
        env: request.unsigned.env,
        payload: response.payload,
        digest: request.unsigned.digest,
      },
      simulated: false,
      signerRef: response.signerRef ?? 'remote',
    };
  }

  async generateAddress(request: GenerateAddressRequest): Promise<GenerateAddressResult> {
    const response = await this.post(
      '/generate',
      {
        network: request.network,
        env: request.env,
        ...(request.label ? { label: request.label } : {}),
        idempotencyKey: request.idempotencyKey,
      },
      z.object({
        ok: z.boolean(),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        created: z.boolean().optional(),
        error: z.string().max(200).optional(),
      }),
    );

    if (!response.ok) {
      throw new AppError('KEY_GENERATION_FAILED', {
        internal: `signer refused key generation: ${response.error ?? 'no reason given'}`,
      });
    }

    return { address: response.address, created: response.created ?? true, simulated: false };
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const response = await this.post('/health', {}, z.object({ ok: z.boolean() }));
      return { healthy: response.ok };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }
}

/**
 * Choose a signer.
 *
 * A real (remote) signer is used only when ALL of the following hold:
 *   * `SIGNER_MODE=remote`,
 *   * `SENDING_ENABLED=true`, and
 *   * we are in production, or pointed at a testnet.
 *
 * The last clause is what guarantees a development machine pointed at mainnet cannot
 * broadcast real funds no matter how the rest of the environment is configured.
 */
export function useRemoteSigner(config: ServerConfig): boolean {
  return (
    config.sending.signerMode === 'remote' &&
    config.sending.enabled &&
    (config.isProduction || config.chain.env === 'testnet')
  );
}

export function createSigner(config: ServerConfig, logger: Logger): Signer {
  if (!useRemoteSigner(config)) {
    logger.info('signer: mock mode — transfers are simulated and never broadcast', {
      operation: 'signer.init',
      signerMode: config.sending.signerMode,
      sendingEnabled: config.sending.enabled,
      chainEnv: config.chain.env,
    });
    return new MockSigner();
  }
  logger.warn('signer: REMOTE mode — real transfers can be broadcast', {
    operation: 'signer.init',
    chainEnv: config.chain.env,
  });
  return new RemoteSigner({
    url: config.sending.signerUrl,
    secret: config.sending.signerHmacSecret,
    timeoutMs: 15_000,
    logger,
  });
}
