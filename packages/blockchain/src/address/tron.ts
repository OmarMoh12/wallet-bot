import { base58CheckDecode, base58CheckEncode } from './base58.js';
import type { AddressValidation } from '../types.js';

/**
 * TRON addresses.
 *
 * Base58Check over a 21-byte payload: a `0x41` prefix byte followed by the 20-byte account
 * hash. The Base58 form always renders as a `T` followed by 33 characters.
 *
 * Case matters: base58 excludes the visually ambiguous characters (0, O, I, l), but the
 * remaining letters are distinct addresses. Normalising case would silently point a
 * transfer at a different account, so nothing here lower-cases anything.
 */

const TRON_PREFIX = 0x41;
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TRON_HEX = /^(0x)?41[0-9a-fA-F]{40}$/;

export function isTronBase58Shape(address: string): boolean {
  return TRON_BASE58.test(address);
}

/** Convert a `41…` hex address to the Base58Check form used everywhere in the UI. */
export function tronHexToBase58(hex: string): string | null {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^41[0-9a-fA-F]{40}$/.test(clean)) return null;
  const bytes = Uint8Array.from(Buffer.from(clean, 'hex'));
  return base58CheckEncode(bytes);
}

export function tronBase58ToHex(address: string): string | null {
  const payload = base58CheckDecode(address);
  if (!payload || payload.length !== 21 || payload[0] !== TRON_PREFIX) return null;
  return Buffer.from(payload).toString('hex');
}

/**
 * Validate a TRON address.
 *
 * Accepts both the Base58Check form and the `41…` hex form that TronGrid returns, and
 * canonicalises both to Base58Check so a wallet added by hand and a wallet seen in a chain
 * event compare equal.
 */
export function validateTronAddress(input: string): AddressValidation {
  const address = input.trim();

  if (address.length === 0) {
    return { valid: false, reason: 'empty' };
  }

  if (TRON_HEX.test(address)) {
    const base58 = tronHexToBase58(address);
    if (!base58) return { valid: false, reason: 'checksum' };
    return { valid: true, canonical: base58, display: base58, network: 'tron' };
  }

  if (!TRON_BASE58.test(address)) {
    return { valid: false, reason: 'format' };
  }

  const payload = base58CheckDecode(address);
  if (!payload) return { valid: false, reason: 'checksum' };
  if (payload.length !== 21) return { valid: false, reason: 'length' };
  if (payload[0] !== TRON_PREFIX) return { valid: false, reason: 'prefix' };

  return { valid: true, canonical: address, display: address, network: 'tron' };
}

/**
 * TRON does not distinguish mainnet from testnet in the address format — the same address
 * exists on both chains. Environment safety therefore has to come from the wallet's `env`
 * column and the provider it is scanned with, not from parsing the address.
 */
export function tronAddressEnvIsAmbiguous(): true {
  return true;
}
