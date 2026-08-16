import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request authentication and spend policy for the signer.
 *
 * The signer assumes the calling service may already be compromised. It therefore re-checks
 * everything independently rather than trusting the API's word:
 *
 *   * HMAC over method + path + timestamp + nonce + body hash;
 *   * a bounded timestamp window and a nonce cache, so a captured request cannot be replayed;
 *   * its own per-transaction and daily USD caps, configured separately from the API's;
 *   * a recipient allow-list when one is configured.
 */

export class PolicyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------- HMAC -- */

const MAX_CLOCK_SKEW_MS = 60_000;

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

/** Bounded replay cache. Entries expire with the timestamp window. */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = MAX_CLOCK_SKEW_MS * 2) {}

  /** Returns false when the nonce has already been used. */
  claim(nonce: string, now = Date.now()): boolean {
    this.evict(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  private evict(now: number): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(nonce);
    }
    // Hard cap so a flood of unique nonces cannot exhaust memory.
    if (this.seen.size > 50_000) this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface VerifyRequestParams {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  nonceCache: NonceCache;
  now?: number;
}

export function verifySignedRequest(params: VerifyRequestParams): void {
  const { secret, timestamp, nonce, signature } = params;
  const now = params.now ?? Date.now();

  if (!secret) {
    throw new PolicyError('SIGNER_MISCONFIGURED', 'signer has no HMAC secret configured', 500);
  }
  if (!timestamp || !nonce || !signature) {
    throw new PolicyError('UNAUTHORIZED', 'missing signature headers', 401);
  }
  if (!/^\d{10,16}$/.test(timestamp)) {
    throw new PolicyError('UNAUTHORIZED', 'malformed timestamp', 401);
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
    throw new PolicyError('UNAUTHORIZED', 'malformed nonce', 401);
  }

  const skew = Math.abs(now - Number.parseInt(timestamp, 10));
  if (skew > MAX_CLOCK_SKEW_MS) {
    throw new PolicyError('UNAUTHORIZED', 'request timestamp is outside the accepted window', 401);
  }

  const expected = createHmac('sha256', secret)
    .update(
      canonicalRequest({
        method: params.method,
        path: params.path,
        timestamp,
        nonce,
        body: params.body,
      }),
    )
    .digest('hex');

  const received = signature.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) {
    throw new PolicyError('UNAUTHORIZED', 'malformed signature', 401);
  }

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PolicyError('UNAUTHORIZED', 'signature mismatch', 401);
  }

  // Signature is valid — now make sure it is not a replay.
  if (!params.nonceCache.claim(nonce, now)) {
    throw new PolicyError('REPLAY_DETECTED', 'this request was already processed', 409);
  }
}

/* ------------------------------------------------------------ spend policy -- */

export interface SpendPolicyConfig {
  /** USD minor units. */
  maxPerTxMinor: bigint;
  maxPerDayMinor: bigint;
  /** When non-empty, only these recipient addresses may be paid. */
  allowedRecipients: string[];
  allowedNetworks: Array<'tron' | 'ton' | 'bsc'>;
  env: 'mainnet' | 'testnet';
}

interface SpendRecord {
  at: number;
  amountMinor: bigint;
}

/**
 * Rolling spend ledger, kept in the signer's own memory.
 *
 * Deliberately independent of the database: if the API is compromised and lies about how
 * much has been spent, the signer's own count still applies. Restarting the signer resets
 * it, which is a conscious trade-off — the per-transaction cap is the hard limit, and the
 * daily cap is defence in depth.
 */
export class SpendTracker {
  private readonly records: SpendRecord[] = [];
  private readonly processed = new Map<string, string>();

  constructor(private readonly windowMs = 24 * 60 * 60 * 1000) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.records.length > 0 && (this.records[0] as SpendRecord).at < cutoff) {
      this.records.shift();
    }
  }

  spentMinor(now = Date.now()): bigint {
    this.prune(now);
    return this.records.reduce((total, record) => total + record.amountMinor, 0n);
  }

  record(amountMinor: bigint, now = Date.now()): void {
    this.prune(now);
    this.records.push({ at: now, amountMinor });
  }

  /**
   * Idempotency at the signer.
   *
   * Returns a previously issued result for a repeated key, so an API retry after an
   * ambiguous response cannot produce a second signature for the same intent.
   */
  rememberResult(idempotencyKey: string, digest: string): void {
    if (this.processed.size > 10_000) this.processed.clear();
    this.processed.set(idempotencyKey, digest);
  }

  previousResult(idempotencyKey: string): string | undefined {
    return this.processed.get(idempotencyKey);
  }
}

export function enforceSpendPolicy(
  request: {
    network: 'tron' | 'ton' | 'bsc';
    env: 'mainnet' | 'testnet';
    to: string;
    valueUsdMinor: bigint | null;
  },
  config: SpendPolicyConfig,
  tracker: SpendTracker,
): void {
  if (!config.allowedNetworks.includes(request.network)) {
    throw new PolicyError('NETWORK_NOT_ALLOWED', `network ${request.network} is not permitted`);
  }

  if (request.env !== config.env) {
    // Prevents a mainnet request reaching a signer provisioned for testnet, or vice versa.
    throw new PolicyError('ENV_MISMATCH', `signer is configured for ${config.env}`);
  }

  if (config.allowedRecipients.length > 0 && !config.allowedRecipients.includes(request.to)) {
    throw new PolicyError('RECIPIENT_NOT_ALLOWED', 'recipient is not on the allow-list');
  }

  if (request.valueUsdMinor === null) {
    // No valuation means the caps cannot be enforced. Refuse rather than sign blind.
    throw new PolicyError('VALUE_REQUIRED', 'a USD valuation is required to enforce spend limits');
  }

  if (request.valueUsdMinor > config.maxPerTxMinor) {
    throw new PolicyError('PER_TX_LIMIT', 'amount exceeds the signer per-transaction limit');
  }

  if (tracker.spentMinor() + request.valueUsdMinor > config.maxPerDayMinor) {
    throw new PolicyError('DAILY_LIMIT', 'amount exceeds the signer daily limit');
  }
}
