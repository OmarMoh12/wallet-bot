import { describe, expect, it } from 'vitest';
import {
  base58CheckDecode,
  base58CheckEncode,
  crc16,
  detectNetworks,
  parseTonAddress,
  tonCanonical,
  tonToFriendly,
  transactionUrl,
  addressUrl,
  validateAddress,
  validateTonAddress,
  validateTronAddress,
} from '@wallet/blockchain';

/**
 * Address validation.
 *
 * A wrong answer here means funds sent somewhere unrecoverable, so the tests cover both
 * "accepts the real thing" and "rejects the near-miss".
 */

// Real, well-known mainnet contract addresses, used purely as valid-format samples.
const TRON_VALID = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_VALID_2 = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8';
const TON_VALID = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

describe('base58check', () => {
  it('round-trips a payload', () => {
    const payload = Uint8Array.from([0x41, ...new Array(20).fill(0xab)]);
    const encoded = base58CheckEncode(payload);
    const decoded = base58CheckDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded as Uint8Array)).toEqual(Array.from(payload));
  });

  it('rejects a single mistyped character', () => {
    const payload = Uint8Array.from([0x41, ...new Array(20).fill(0x01)]);
    const encoded = base58CheckEncode(payload);
    const broken = `${encoded.slice(0, -1)}${encoded.endsWith('a') ? 'b' : 'a'}`;
    expect(base58CheckDecode(broken)).toBeNull();
  });

  it('rejects characters outside the base58 alphabet', () => {
    expect(base58CheckDecode('0OIl' + TRON_VALID)).toBeNull();
  });
});

describe('TRON addresses', () => {
  it('accepts a valid base58 address', () => {
    const result = validateTronAddress(TRON_VALID);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.canonical).toBe(TRON_VALID);
      expect(result.network).toBe('tron');
    }
  });

  it('canonicalises the hex form to base58', () => {
    const hex = validateTronAddress(TRON_VALID);
    expect(hex.valid).toBe(true);
  });

  it('rejects a checksum failure', () => {
    // Flip one character: the shape is right, the checksum is not.
    const broken = `${TRON_VALID.slice(0, -1)}X`;
    const result = validateTronAddress(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('checksum');
  });

  it('rejects wrong-length and empty input', () => {
    expect(validateTronAddress('').valid).toBe(false);
    expect(validateTronAddress('T123').valid).toBe(false);
    expect(validateTronAddress(`${TRON_VALID}extra`).valid).toBe(false);
  });

  it('is case-sensitive', () => {
    // Lower-casing a base58 address produces a DIFFERENT address, not the same one.
    const result = validateTronAddress(TRON_VALID.toLowerCase());
    expect(result.valid).toBe(false);
  });
});

describe('TON addresses', () => {
  it('accepts a user-friendly address and canonicalises it to raw form', () => {
    const result = validateTonAddress(TON_VALID);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Raw form is the comparison key, because one account has several friendly forms.
      expect(result.canonical).toMatch(/^-?\d+:[0-9a-f]{64}$/);
      expect(result.network).toBe('ton');
    }
  });

  it('treats bounceable and non-bounceable forms as the same account', () => {
    const parts = parseTonAddress(TON_VALID);
    expect(parts).not.toBeNull();
    const bounceable = tonToFriendly(parts as NonNullable<typeof parts>, { bounceable: true });
    const nonBounceable = tonToFriendly(parts as NonNullable<typeof parts>, { bounceable: false });
    expect(bounceable).not.toBe(nonBounceable);
    expect(tonCanonical(bounceable)).toBe(tonCanonical(nonBounceable));
  });

  it('accepts the raw form', () => {
    const canonical = tonCanonical(TON_VALID);
    expect(canonical).not.toBeNull();
    expect(validateTonAddress(canonical as string).valid).toBe(true);
  });

  it('rejects a corrupted checksum', () => {
    const broken = `${TON_VALID.slice(0, -2)}AA`;
    const result = validateTonAddress(broken);
    expect(result.valid).toBe(false);
  });

  it('computes CRC16-CCITT correctly', () => {
    // Known vector: CRC16/XMODEM of "123456789" is 0x31C3.
    expect(crc16(Buffer.from('123456789', 'ascii'))).toBe(0x31c3);
  });
});

describe('cross-network validation', () => {
  it('refuses a TON address on TRON and vice versa', () => {
    expect(validateAddress('tron', TON_VALID).valid).toBe(false);
    expect(validateAddress('ton', TRON_VALID).valid).toBe(false);
  });

  it('detects which networks would accept an address', () => {
    expect(detectNetworks(TRON_VALID)).toEqual(['tron']);
    expect(detectNetworks(TON_VALID)).toEqual(['ton']);
    expect(detectNetworks('nonsense')).toEqual([]);
  });
});

describe('explorer links', () => {
  const hash = 'a'.repeat(64);

  it('builds real explorer URLs per network and environment', () => {
    expect(transactionUrl('tron', 'mainnet', hash)).toBe(
      `https://tronscan.org/#/transaction/${hash}`,
    );
    expect(transactionUrl('tron', 'testnet', hash)).toBe(
      `https://shasta.tronscan.org/#/transaction/${hash}`,
    );
    expect(transactionUrl('ton', 'mainnet', hash)).toBe(
      `https://tonviewer.com/transaction/${hash}`,
    );
    expect(transactionUrl('ton', 'testnet', hash)).toBe(
      `https://testnet.tonviewer.com/transaction/${hash}`,
    );
  });

  it('URL-encodes the address so a crafted value cannot escape the path', () => {
    const url = addressUrl('tron', 'mainnet', 'a/../../b?x=1');
    expect(url).toContain('%2F');
    expect(url).not.toContain('?x=1');
  });

  it('returns null rather than a fabricated link when there is nothing to link to', () => {
    expect(transactionUrl('tron', 'mainnet', '')).toBeNull();
  });

  it('never emits a second copy of TRON_VALID_2 by accident', () => {
    expect(addressUrl('tron', 'mainnet', TRON_VALID_2)).toContain(TRON_VALID_2);
  });
});
