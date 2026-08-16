import type { Network, NetworkEnv, NotificationType } from '../domain/enums.js';

/**
 * Canonical key builders.
 *
 * Every idempotency, dedupe and cache key in the system is produced here rather than
 * interpolated at call sites. Two independent code paths that mean "the same event" must
 * produce byte-identical keys, or the uniqueness constraints that protect us from duplicate
 * money movement stop working.
 */

const SEP = ':';

function segment(value: string | number): string {
  const text = String(value);
  if (text.includes(SEP)) {
    // Escape so `a:b` + `c` can never collide with `a` + `b:c`.
    return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  }
  return text;
}

function join(...parts: Array<string | number>): string {
  return parts.map(segment).join(SEP);
}

/** Stable identity for an asset across the whole system. */
export function assetKey(params: {
  network: Network;
  env: NetworkEnv;
  contractAddress?: string | null;
  symbol: string;
}): string {
  return join(
    params.network,
    params.env,
    params.contractAddress ? params.contractAddress : `native-${params.symbol.toLowerCase()}`,
  );
}

/**
 * Identity of a single on-chain value movement.
 *
 * `logIndex` distinguishes multiple transfers inside one transaction (a TRC20 transfer and a
 * TRX transfer in the same tx, or several jetton messages in a TON transaction). Without it,
 * a batched payout would collapse into a single ledger row and understate the balance.
 */
export function chainEventKey(params: {
  network: Network;
  env: NetworkEnv;
  txHash: string;
  logIndex: number;
}): string {
  return join('chain', params.network, params.env, params.txHash, params.logIndex);
}

/** Cursor position key for a wallet scan. */
export function scanCursorKey(params: {
  network: Network;
  env: NetworkEnv;
  address: string;
}): string {
  return join('scan', params.network, params.env, params.address);
}

/** Notification dedupe key — unique per user, so the same event never notifies twice. */
export function notificationKey(params: {
  type: NotificationType;
  subjectId: string;
  /** Optional discriminator, e.g. the confirmation milestone. */
  variant?: string;
}): string {
  return params.variant
    ? join('notify', params.type, params.subjectId, params.variant)
    : join('notify', params.type, params.subjectId);
}

/** Job dedupe key — prevents a queue from filling with equivalent pending work. */
export function jobKey(type: string, ...parts: Array<string | number>): string {
  return join('job', type, ...parts);
}

/** Rate-limit bucket key. */
export function rateLimitKey(bucket: string, subject: string): string {
  return join('rl', bucket, subject);
}

/** Idempotency key for a transaction created from a scheduled payment execution. */
export function scheduledExecutionKey(scheduledPaymentId: string, attempt: number): string {
  return join('sched', scheduledPaymentId, attempt);
}

/** Idempotency key namespace for send requests. */
export function sendRequestKey(userId: string, clientKey: string): string {
  return join('send', userId, clientKey);
}

/**
 * Normalise an address for uniqueness comparisons.
 *
 * TRON base58 addresses are case-sensitive; TON user-friendly addresses are base64url and also
 * case-sensitive. So this only trims — it deliberately does NOT lowercase, because doing so
 * would make two distinct addresses look identical. Network-specific canonicalisation (e.g.
 * TON raw vs user-friendly form) happens in `@wallet/blockchain`.
 */
export function normaliseAddress(address: string): string {
  return address.trim();
}
