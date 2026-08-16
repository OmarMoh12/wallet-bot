import { createHash } from 'node:crypto';

/**
 * Base58Check, implemented here rather than pulled from a dependency.
 *
 * It is ~60 lines of well-specified arithmetic, and it sits directly on the path where a
 * mistyped recipient address becomes permanently lost funds. Owning it means the checksum
 * verification is auditable in this repository rather than in a transitive package.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = 58n;

/**
 * BigInt -> small integer, for alphabet indices and byte values only.
 *
 * Named rather than inline so the ban on `Number(...)` stays meaningful: every remaining
 * use in the codebase is either money (forbidden) or goes through a helper that says what
 * it is. Values here are always 0–255 by construction.
 */
function toSmallInt(value: bigint): number {
  return globalThis.Number(value);
}

const INDEX = new Map<string, bigint>();
for (let i = 0; i < ALPHABET.length; i += 1) {
  INDEX.set(ALPHABET[i] as string, BigInt(i));
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let output = '';
  while (value > 0n) {
    const remainder = value % BASE;
    value /= BASE;
    output = (ALPHABET[toSmallInt(remainder)] as string) + output;
  }

  // Leading zero bytes are encoded as '1' each — they are lost by the numeric conversion.
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output;
}

export function base58Decode(text: string): Uint8Array | null {
  if (text.length === 0) return new Uint8Array(0);

  let value = 0n;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) return null; // Not a base58 character.
    value = value * BASE + digit;
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(toSmallInt(value % 256n));
    value /= 256n;
  }

  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function doubleSha256(data: Uint8Array): Uint8Array {
  const first = createHash('sha256').update(data).digest();
  return new Uint8Array(createHash('sha256').update(first).digest());
}

/** Encode `payload` with a 4-byte double-SHA256 checksum appended. */
export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = doubleSha256(payload).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58Encode(full);
}

/**
 * Decode and verify. Returns null on any failure — bad alphabet, wrong length, or a
 * checksum mismatch. Callers treat null as "not a valid address", never as "probably fine".
 */
export function base58CheckDecode(text: string): Uint8Array | null {
  const decoded = base58Decode(text);
  if (!decoded || decoded.length < 5) return null;

  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const expected = doubleSha256(payload).slice(0, 4);

  for (let i = 0; i < 4; i += 1) {
    if (checksum[i] !== expected[i]) return null;
  }
  return payload;
}
