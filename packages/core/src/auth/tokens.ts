import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '@wallet/shared';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Session tokens and PIN hashing.
 *
 * **Session tokens** are opaque 32-byte random strings. The database stores only
 * `HMAC-SHA256(SESSION_SECRET, token)`. That means a database dump alone yields nothing
 * usable: without the server secret an attacker cannot even verify a guess offline, let
 * alone reverse one.
 *
 * **PINs** are six digits — a 10^6 search space, which is only acceptable because it is
 * defended in depth: a per-user random salt, a server-side pepper that never touches the
 * database, `scrypt` with production parameters, and a hard lockout after a handful of
 * failures. A database compromise on its own does not permit offline PIN cracking, because
 * the pepper lives in the environment.
 */

const TOKEN_BYTES = 32;

/** scrypt parameters. N=2^15 costs ~50 ms per hash, which is the point. */
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const PIN_KEY_LENGTH = 32;

export interface IssuedToken {
  token: string;
  tokenHash: string;
}

export function issueSessionToken(secret: string): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(secret, token) };
}

export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

/**
 * Cheap structural check before touching the database.
 * Rejects obvious garbage so a flood of malformed tokens costs no queries.
 */
export function looksLikeSessionToken(token: string): boolean {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(token);
}

/* --------------------------------------------------------------------- PIN -- */

export interface PinCredentials {
  hash: string;
  salt: string;
}

function assertPinShape(pin: string): void {
  if (!/^\d{6}$/.test(pin)) {
    throw new AppError('VALIDATION_ERROR', { internal: 'PIN must be exactly six digits' });
  }
}

export async function hashPin(pin: string, pepper: string): Promise<PinCredentials> {
  assertPinShape(pin);
  const salt = randomBytes(16).toString('base64');
  const derived = await scrypt(`${pin}:${pepper}`, salt, PIN_KEY_LENGTH, SCRYPT_OPTIONS);
  return { hash: derived.toString('base64'), salt };
}

/** Constant-time verification. Returns false rather than throwing on malformed stored data. */
export async function verifyPin(
  pin: string,
  credentials: PinCredentials,
  pepper: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(pin)) return false;
  if (!credentials.hash || !credentials.salt) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(credentials.hash, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== PIN_KEY_LENGTH) return false;

  const derived = await scrypt(
    `${pin}:${pepper}`,
    credentials.salt,
    PIN_KEY_LENGTH,
    SCRYPT_OPTIONS,
  );
  return timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------- fingerprints -- */

/**
 * Hash an IP address for audit logging.
 *
 * Keyed with the server secret and truncated: enough to correlate abuse from one source,
 * not enough to turn the audit log into a location database, and not reversible by anyone
 * who obtains the table.
 */
export function hashIp(secret: string, ip: string | null): string | null {
  if (!ip) return null;
  return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

/** Stable digest for a send quote. Any change to the numbers changes the fingerprint. */
export function quoteFingerprint(parts: Record<string, string | number | null>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ''}`)
    .join('&');
  return createHmac('sha256', 'quote').update(canonical).digest('hex');
}
