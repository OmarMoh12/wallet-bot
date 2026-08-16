import type { AddressValidation } from '../types.js';
import { fromHex, keccak256, toHex } from '../evm/hex.js';

/**
 * EVM addresses (EIP-55).
 *
 * An EVM address is 20 bytes rendered as hex. Case is **not** part of the address — but
 * EIP-55 overloads it as a checksum: the case pattern is derived from the keccak256 hash of
 * the lowercase address. That gives an accidental-typo detection rate of roughly 99.986%,
 * which matters a great deal when the alternative is unrecoverable loss.
 *
 * Storage and comparison use the **lowercase** form, because that is what the address
 * actually is. Display uses the checksummed form, because that is what every wallet and
 * explorer shows and what users compare against.
 */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Apply the EIP-55 mixed-case checksum to a lowercase address. */
export function toChecksumAddress(address: string): string {
  const clean = (address.startsWith('0x') ? address.slice(2) : address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`toChecksumAddress: not a 20-byte hex address: ${address}`);
  }

  // The hash is taken over the ASCII of the lowercase hex digits, not over the bytes.
  const hash = toHex(keccak256(new TextEncoder().encode(clean)));

  let output = '0x';
  for (let i = 0; i < clean.length; i += 1) {
    const character = clean[i] as string;
    const hashDigit = Number.parseInt(hash[i] as string, 16);
    output += hashDigit >= 8 ? character.toUpperCase() : character;
  }
  return output;
}

/**
 * Is this address correctly checksummed?
 *
 * All-lowercase and all-uppercase addresses carry no checksum and are reported as
 * `unchecked` rather than invalid — most tooling emits lowercase, and rejecting it would be
 * wrong. Mixed case that fails the checksum is a genuine error.
 */
export function checksumState(address: string): 'valid' | 'unchecked' | 'invalid' {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  const hasLower = /[a-f]/.test(clean);
  const hasUpper = /[A-F]/.test(clean);
  if (!hasLower || !hasUpper) return 'unchecked';
  return toChecksumAddress(address) === (address.startsWith('0x') ? address : `0x${address}`)
    ? 'valid'
    : 'invalid';
}

/**
 * Validate an EVM address.
 *
 * The canonical form is lowercase; the display form is checksummed. An address whose mixed
 * case fails the EIP-55 checksum is rejected outright — that is a corrupted address, and
 * accepting it would defeat the only typo protection the format has.
 */
export function validateEvmAddress(input: string): AddressValidation {
  const address = input.trim();
  if (address.length === 0) return { valid: false, reason: 'empty' };
  if (!address.startsWith('0x') && !address.startsWith('0X')) {
    return { valid: false, reason: 'prefix' };
  }
  if (!HEX_ADDRESS.test(address)) {
    return { valid: false, reason: address.length === 42 ? 'format' : 'length' };
  }

  const state = checksumState(address);
  if (state === 'invalid') return { valid: false, reason: 'checksum' };

  const canonical = address.toLowerCase();

  return {
    valid: true,
    canonical,
    display: toChecksumAddress(canonical),
    // Every EVM network shares this format; the caller's `network` decides the chain.
    network: 'bsc',
    flags: { checksum: state, zeroAddress: canonical === ZERO_ADDRESS },
  };
}

/**
 * The burn address.
 *
 * Sending here destroys funds irrecoverably. It is a valid address, so validation accepts
 * it, but the send pipeline refuses it explicitly — an accidental empty-field submission
 * should not be able to burn a balance.
 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function isZeroAddress(address: string): boolean {
  return address.trim().toLowerCase() === ZERO_ADDRESS;
}

/** Lowercase form for storage and comparison. Returns null when invalid. */
export function evmCanonical(address: string): string | null {
  const result = validateEvmAddress(address);
  return result.valid ? result.canonical : null;
}

/**
 * Derive the address from an uncompressed secp256k1 public key.
 *
 * `address = last 20 bytes of keccak256(publicKey without the 0x04 prefix)`.
 *
 * Lives here rather than in the signer so it can be unit-tested against known vectors
 * without any key material — the signer imports it.
 */
export function evmAddressFromPublicKey(publicKey: Uint8Array): string {
  const body = publicKey.length === 65 && publicKey[0] === 0x04 ? publicKey.subarray(1) : publicKey;
  if (body.length !== 64) {
    throw new Error('evmAddressFromPublicKey: expected a 64-byte uncompressed public key');
  }
  const hash = keccak256(body);
  return toChecksumAddress(`0x${toHex(hash.subarray(12))}`);
}

/** Bytes of an address, for ABI encoding. */
export function evmAddressBytes(address: string): Uint8Array {
  const canonical = evmCanonical(address);
  if (!canonical) throw new Error(`evmAddressBytes: invalid address ${address}`);
  return fromHex(canonical);
}
