import type { AddressValidation } from '../types.js';

/**
 * TON addresses.
 *
 * Two interchangeable forms:
 *   * raw            `<workchain>:<64 hex chars>`  e.g. `0:83dfd552…`
 *   * user-friendly  36 bytes, base64 or base64url:
 *                      tag (1) | workchain (1) | account hash (32) | CRC16-CCITT (2)
 *
 * The tag encodes flags: 0x11 bounceable, 0x51 non-bounceable, +0x80 test-only. The SAME
 * account therefore has several valid textual representations, which is precisely why the
 * canonical form used for storage and comparison is the **raw** form. Comparing
 * user-friendly strings would make one wallet look like several.
 */

const RAW_FORM = /^(-?\d+):([0-9a-fA-F]{64})$/;
const FRIENDLY_FORM = /^[A-Za-z0-9_+/-]{48}={0,2}$/;

const TAG_BOUNCEABLE = 0x11;
const TAG_NON_BOUNCEABLE = 0x51;
const TAG_TEST_ONLY = 0x80;

/** CRC16-CCITT (XModem), polynomial 0x1021, initial value 0. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export interface TonAddressParts {
  workchain: number;
  hash: Uint8Array;
  bounceable: boolean;
  testOnly: boolean;
}

function toRaw(parts: TonAddressParts): string {
  return `${parts.workchain}:${Buffer.from(parts.hash).toString('hex')}`;
}

/** Render the user-friendly (base64url) form. */
export function tonToFriendly(
  parts: TonAddressParts,
  options: { bounceable?: boolean; testOnly?: boolean; urlSafe?: boolean } = {},
): string {
  const bounceable = options.bounceable ?? parts.bounceable;
  const testOnly = options.testOnly ?? parts.testOnly;

  let tag = bounceable ? TAG_BOUNCEABLE : TAG_NON_BOUNCEABLE;
  if (testOnly) tag |= TAG_TEST_ONLY;

  const buffer = new Uint8Array(36);
  buffer[0] = tag;
  // Workchain -1 is encoded as 0xff; 0 as 0x00.
  buffer[1] = parts.workchain === -1 ? 0xff : parts.workchain & 0xff;
  buffer.set(parts.hash, 2);

  const checksum = crc16(buffer.slice(0, 34));
  buffer[34] = (checksum >> 8) & 0xff;
  buffer[35] = checksum & 0xff;

  const base64 = Buffer.from(buffer).toString('base64');
  return options.urlSafe === false ? base64 : base64.replace(/\+/g, '-').replace(/\//g, '_');
}

function parseFriendly(address: string): TonAddressParts | null {
  // Accept both base64 and base64url input; normalise to standard base64 for decoding.
  const normalised = address.replace(/-/g, '+').replace(/_/g, '/');
  let buffer: Buffer;
  try {
    buffer = Buffer.from(normalised, 'base64');
  } catch {
    return null;
  }
  if (buffer.length !== 36) return null;

  const bytes = new Uint8Array(buffer);
  const expected = crc16(bytes.slice(0, 34));
  const actual = ((bytes[34] as number) << 8) | (bytes[35] as number);
  if (expected !== actual) return null;

  let tag = bytes[0] as number;
  let testOnly = false;
  if (tag & TAG_TEST_ONLY) {
    testOnly = true;
    tag &= ~TAG_TEST_ONLY;
  }
  if (tag !== TAG_BOUNCEABLE && tag !== TAG_NON_BOUNCEABLE) return null;

  const workchainByte = bytes[1] as number;
  if (workchainByte !== 0x00 && workchainByte !== 0xff) return null;

  return {
    workchain: workchainByte === 0xff ? -1 : 0,
    hash: bytes.slice(2, 34),
    bounceable: tag === TAG_BOUNCEABLE,
    testOnly,
  };
}

function parseRaw(address: string): TonAddressParts | null {
  const match = RAW_FORM.exec(address);
  if (!match) return null;
  const workchain = Number.parseInt(match[1] as string, 10);
  if (workchain !== 0 && workchain !== -1) return null;
  return {
    workchain,
    hash: Uint8Array.from(Buffer.from(match[2] as string, 'hex')),
    bounceable: true,
    testOnly: false,
  };
}

export function parseTonAddress(input: string): TonAddressParts | null {
  const address = input.trim();
  if (RAW_FORM.test(address)) return parseRaw(address);
  if (FRIENDLY_FORM.test(address)) return parseFriendly(address);
  return null;
}

/**
 * Validate a TON address and canonicalise it to raw form.
 *
 * The `testOnly` flag is reported but deliberately not treated as authoritative for
 * environment routing: a mainnet-flagged string is perfectly valid on testnet and vice
 * versa. The wallet's `env` column decides which chain we query.
 */
export function validateTonAddress(input: string): AddressValidation {
  const address = input.trim();
  if (address.length === 0) return { valid: false, reason: 'empty' };

  const parts = parseTonAddress(address);
  if (!parts) {
    if (RAW_FORM.test(address) || FRIENDLY_FORM.test(address)) {
      return { valid: false, reason: 'checksum' };
    }
    return { valid: false, reason: 'format' };
  }

  return {
    valid: true,
    canonical: toRaw(parts),
    // Display in the bounceable user-friendly form users see in wallets and explorers.
    display: tonToFriendly(parts, { bounceable: true }),
    network: 'ton',
    flags: { testOnly: parts.testOnly, bounceable: parts.bounceable, workchain: parts.workchain },
  };
}

/** Normalise any accepted TON form to raw. Returns null when invalid. */
export function tonCanonical(address: string): string | null {
  const parts = parseTonAddress(address);
  return parts ? toRaw(parts) : null;
}
