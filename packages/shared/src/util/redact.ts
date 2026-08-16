/**
 * Log redaction.
 *
 * The logger runs this over every object it serialises. It is deny-by-pattern on key names
 * plus a value scan for anything that looks like a bot token or a key, because the cheapest
 * way to leak a secret is to log an object you did not write.
 */

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|pwd|private|privkey|priv_key|seed|mnemonic|apikey|api_key|authorization|auth|cookie|session|pin|hash|signature|sig|encryption|master|service_role|credential)/i;

/** Keys that match the pattern above but are safe and useful to keep. */
const ALLOWED_KEYS = new Set([
  'txHash',
  'tx_hash',
  'transactionHash',
  'hashPrefix',
  'authDate',
  'auth_date',
  'sessionId',
  'session_id',
  'pinSet',
  'pin_set',
  'signatureValid',
]);

const REDACTED = '[redacted]';

/**
 * Telegram bot tokens look like `1234567890:AA...`.
 *
 * The optional `bot` prefix matters: the token most often leaks inside an API URL
 * (`https://api.telegram.org/bot<token>/getMe`), where a plain `\b` would not anchor
 * because `t` and `1` are both word characters.
 */
const BOT_TOKEN_PATTERN = /\b(?:bot)?\d{6,12}:[A-Za-z0-9_-]{30,}/g;
/** Long base64/hex blobs that are almost certainly key material. */
const KEY_BLOB_PATTERN = /\b(?:[A-Za-z0-9+/]{60,}={0,2}|[0-9a-fA-F]{64,})\b/g;
const PG_URL_PATTERN = /\b(postgres(?:ql)?:\/\/)[^:\s]+:[^@\s]+@/gi;

export function redactString(value: string): string {
  return value
    .replace(BOT_TOKEN_PATTERN, REDACTED)
    .replace(PG_URL_PATTERN, '$1[redacted]@')
    .replace(KEY_BLOB_PATTERN, REDACTED);
}

export type Redactable = unknown;

export function redact(value: Redactable, depth = 0): Redactable {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    // Never walk into inherited/prototype properties.
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (ALLOWED_KEYS.has(key)) {
      // An explicit allow-list entry means "this field is safe as-is". Skipping the value
      // scan matters because a 64-character transaction hash is indistinguishable from a
      // 32-byte key by shape alone — the field name is the only thing that can tell them
      // apart, and here it has.
      output[key] = typeof source[key] === 'bigint' ? source[key].toString() : source[key];
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redact(source[key], depth + 1);
  }
  return output;
}

/** A safe, short identifier for a secret — enough to correlate logs, useless to an attacker. */
export function fingerprintHint(value: string): string {
  return value.length <= 8 ? `len:${value.length}` : `${value.slice(0, 3)}…len:${value.length}`;
}
