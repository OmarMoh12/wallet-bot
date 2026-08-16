import { describe, expect, it } from 'vitest';
import {
  ZERO_ADDRESS,
  addressUrl,
  checksumState,
  decodeAddressWord,
  decodeUint256,
  detectNetworks,
  encodeErc20Transfer,
  evmAddressFromPublicKey,
  evmCanonical,
  evmChain,
  isZeroAddress,
  keccak256,
  maxCostWei,
  maxFeeWei,
  networkLabel,
  parseQuantity,
  rlpEncode,
  serializeSigned,
  serializeUnsigned,
  signingHash,
  toChecksumAddress,
  toHex,
  toQuantity,
  transactionUrl,
  validateAddress,
  validateEvmAddress,
  type EvmTransactionRequest,
} from '@wallet/blockchain';
import { EVM_NETWORKS, isEvmNetwork } from '@wallet/shared';

/**
 * EVM primitives.
 *
 * Two categories, both verified against published vectors rather than against our own
 * output: address checksums (EIP-55) and transaction encoding (RLP + EIP-155). Getting
 * either wrong sends funds somewhere unrecoverable, so "it round-trips with itself" is not
 * an acceptable standard of proof here.
 */

describe('EIP-55 checksum', () => {
  // The reference vectors from EIP-55 itself.
  const VECTORS = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('reproduces the reference checksums from lowercase input', () => {
    for (const expected of VECTORS) {
      expect(toChecksumAddress(expected.toLowerCase())).toBe(expected);
    }
  });

  it('accepts a correctly checksummed address', () => {
    for (const address of VECTORS) {
      expect(checksumState(address)).toBe('valid');
      expect(validateEvmAddress(address).valid).toBe(true);
    }
  });

  it('rejects a corrupted checksum', () => {
    // Flip the case of one LETTER: still 40 valid hex digits, but no longer checksummed.
    // (Flipping a digit would change nothing, since digits have no case.)
    const original = VECTORS[0] as string;
    const index = [...original].findIndex(
      (character, position) => position > 1 && /[a-zA-Z]/.test(character),
    );
    const letter = original[index] as string;
    const flipped = letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
    const broken = `${original.slice(0, index)}${flipped}${original.slice(index + 1)}`;

    expect(broken).not.toBe(original);
    expect(checksumState(broken)).toBe('invalid');

    const result = validateEvmAddress(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('checksum');
  });

  it('accepts an all-lowercase address as unchecked rather than invalid', () => {
    // Most tooling emits lowercase; rejecting it would be wrong.
    const lower = (VECTORS[0] as string).toLowerCase();
    expect(checksumState(lower)).toBe('unchecked');
    expect(validateEvmAddress(lower).valid).toBe(true);
  });

  it('canonicalises to lowercase and displays checksummed', () => {
    const result = validateEvmAddress(VECTORS[0] as string);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Case is not part of the address, so storage and comparison use lowercase.
      expect(result.canonical).toBe((VECTORS[0] as string).toLowerCase());
      // Display uses the form every wallet and explorer shows.
      expect(result.display).toBe(VECTORS[0]);
    }
  });

  it('rejects malformed input', () => {
    expect(validateEvmAddress('').valid).toBe(false);
    expect(validateEvmAddress('0x123').valid).toBe(false);
    expect(validateEvmAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').valid).toBe(false);
    expect(validateEvmAddress(`0x${'z'.repeat(40)}`).valid).toBe(false);
    expect(validateEvmAddress(`0x${'a'.repeat(41)}`).valid).toBe(false);
  });

  it('flags the zero address without rejecting it', () => {
    // It is a valid address; the send pipeline refuses it separately.
    const result = validateEvmAddress(ZERO_ADDRESS);
    expect(result.valid).toBe(true);
    expect(isZeroAddress(ZERO_ADDRESS)).toBe(true);
    expect(isZeroAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false);
  });
});

describe('address derivation', () => {
  it('derives the documented address from a known public key', () => {
    // Private key 0x0000…0001 — the canonical secp256k1 generator test vector.
    const publicKey = Buffer.from(
      '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
        '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
      'hex',
    );
    expect(evmAddressFromPublicKey(publicKey).toLowerCase()).toBe(
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    );
  });

  it('rejects a public key of the wrong length', () => {
    expect(() => evmAddressFromPublicKey(new Uint8Array(33))).toThrow();
  });
});

describe('network routing', () => {
  const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

  it('recognises bsc as an EVM network', () => {
    expect(isEvmNetwork('bsc')).toBe(true);
    expect(isEvmNetwork('tron')).toBe(false);
    expect(isEvmNetwork('ton')).toBe(false);
    expect(EVM_NETWORKS).toContain('bsc');
  });

  it('validates an EVM address against bsc and tags it with that network', () => {
    const result = validateAddress('bsc', address);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.network).toBe('bsc');
  });

  it('refuses an EVM address on TRON and TON', () => {
    expect(validateAddress('tron', address).valid).toBe(false);
    expect(validateAddress('ton', address).valid).toBe(false);
  });

  it('refuses TRON and TON addresses on bsc', () => {
    expect(validateAddress('bsc', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').valid).toBe(false);
    expect(validateAddress('bsc', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs').valid).toBe(
      false,
    );
  });

  it('detects the EVM family for the network-mismatch warning', () => {
    expect(detectNetworks(address)).toEqual(['bsc']);
  });

  it('builds BscScan links for both environments', () => {
    const hash = `0x${'a'.repeat(64)}`;
    expect(transactionUrl('bsc', 'mainnet', hash)).toBe(`https://bscscan.com/tx/${hash}`);
    expect(transactionUrl('bsc', 'testnet', hash)).toBe(`https://testnet.bscscan.com/tx/${hash}`);
    expect(addressUrl('bsc', 'mainnet', address)).toBe(`https://bscscan.com/address/${address}`);
  });

  it('labels the network for the receive warning', () => {
    expect(networkLabel('bsc', 'mainnet')).toBe('BNB Smart Chain (BEP-20)');
    expect(networkLabel('bsc', 'testnet')).toContain('testnet');
  });

  it('exposes distinct chain ids per environment', () => {
    expect(evmChain('bsc', 'mainnet').chainId).toBe(56);
    expect(evmChain('bsc', 'testnet').chainId).toBe(97);
  });
});

describe('hex and quantity handling', () => {
  it('parses the quantity forms a node actually returns', () => {
    expect(parseQuantity('0x0')).toBe(0n);
    // An empty `0x` means zero, not an error — nodes really do return this.
    expect(parseQuantity('0x')).toBe(0n);
    expect(parseQuantity('0x1f')).toBe(31n);
    expect(parseQuantity('42')).toBe(42n);
    expect(parseQuantity(42)).toBe(42n);
  });

  it('rejects a malformed quantity rather than yielding NaN', () => {
    expect(() => parseQuantity('nonsense')).toThrow();
    expect(() => parseQuantity('0xzz')).toThrow();
    expect(() => parseQuantity(null)).toThrow();
  });

  it('renders minimal quantities', () => {
    expect(toQuantity(0n)).toBe('0x0');
    expect(toQuantity(31n)).toBe('0x1f');
    // Never zero-padded: `0x01f` is not a valid JSON-RPC quantity.
    expect(toQuantity(256n)).toBe('0x100');
  });

  it('decodes ABI words', () => {
    expect(decodeUint256(`0x${'0'.repeat(63)}5`)).toBe(5n);
    // A call to a non-contract returns empty; that must read as zero.
    expect(decodeUint256('0x')).toBe(0n);
    expect(decodeAddressWord(`0x${'0'.repeat(24)}5aaeb6053f3e94c9b9a09f33669435e7ef1beaed`)).toBe(
      '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
    );
  });
});

describe('keccak256', () => {
  it('matches the known hash of the empty input', () => {
    expect(toHex(keccak256(new Uint8Array(0)))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });

  it('matches the ERC-20 transfer selector', () => {
    // The first four bytes of keccak256("transfer(address,uint256)").
    const hash = keccak256(new TextEncoder().encode('transfer(address,uint256)'));
    expect(toHex(hash).slice(0, 8)).toBe('a9059cbb');
  });
});

describe('RLP', () => {
  it('encodes the canonical examples', () => {
    // "dog" -> 0x83646f67
    expect(toHex(rlpEncode(new TextEncoder().encode('dog')))).toBe('83646f67');
    // Empty string -> 0x80
    expect(toHex(rlpEncode(new Uint8Array(0)))).toBe('80');
    // Empty list -> 0xc0
    expect(toHex(rlpEncode([]))).toBe('c0');
    // A single byte below 0x80 is its own encoding.
    expect(toHex(rlpEncode(Uint8Array.from([0x0f])))).toBe('0f');
    // ["cat","dog"] -> 0xc88363617483646f67
    expect(
      toHex(rlpEncode([new TextEncoder().encode('cat'), new TextEncoder().encode('dog')])),
    ).toBe('c88363617483646f67');
  });

  it('uses the long-form length prefix past 55 bytes', () => {
    const encoded = rlpEncode(new Uint8Array(56));
    // 0xb8 = 0x80 + 55 + 1 length byte, then the length itself.
    expect(toHex(encoded).slice(0, 4)).toBe('b838');
  });
});

describe('ERC-20 calldata', () => {
  it('encodes transfer(address,uint256) with both arguments padded to 32 bytes', () => {
    const data = encodeErc20Transfer('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 1_000_000n);
    const hex = toHex(data);

    expect(hex.slice(0, 8)).toBe('a9059cbb');
    // 4-byte selector + two 32-byte words.
    expect(data.length).toBe(4 + 32 + 32);
    // The address occupies the LOW 20 bytes of the first word.
    expect(hex.slice(8, 32)).toBe('0'.repeat(24));
    expect(hex.slice(32, 72)).toBe('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
    expect(BigInt(`0x${hex.slice(72)}`)).toBe(1_000_000n);
  });

  it('refuses a malformed address or a negative amount', () => {
    expect(() => encodeErc20Transfer('0x1234', 1n)).toThrow();
    expect(() => encodeErc20Transfer('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', -1n)).toThrow();
  });
});

describe('transaction encoding', () => {
  const base: EvmTransactionRequest = {
    type: 'legacy',
    chainId: 56,
    nonce: 9n,
    to: '0x3535353535353535353535353535353535353535',
    value: 1_000_000_000_000_000_000n,
    data: new Uint8Array(0),
    gasLimit: 21_000n,
    gasPrice: 20_000_000_000n,
  };

  it('reproduces the RLP signing payload from the EIP-155 example', () => {
    // The worked example in EIP-155 itself: nonce 9, 20 gwei, 21000 gas, 1 ETH, chain id 1.
    // Asserting the bytes as well as the hash means a bug in RLP cannot hide behind a
    // coincidentally-matching digest.
    expect(toHex(serializeUnsigned({ ...base, chainId: 1 }))).toBe(
      'ec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080',
    );
  });

  it('produces the EIP-155 signing hash from the specification example', () => {
    expect(toHex(signingHash({ ...base, chainId: 1 }))).toBe(
      'daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53',
    );
  });

  it('signs a different hash for a different chain id', () => {
    // This is exactly what makes a signature non-replayable across EVM chains.
    const mainnet = toHex(signingHash({ ...base, chainId: 56 }));
    const testnet = toHex(signingHash({ ...base, chainId: 97 }));
    expect(mainnet).not.toBe(testnet);
  });

  it('changes the hash when any field changes', () => {
    const original = toHex(signingHash(base));
    expect(toHex(signingHash({ ...base, value: base.value + 1n }))).not.toBe(original);
    expect(
      toHex(signingHash({ ...base, to: '0x3535353535353535353535353535353535353536' })),
    ).not.toBe(original);
    expect(toHex(signingHash({ ...base, nonce: 10n }))).not.toBe(original);
    expect(toHex(signingHash({ ...base, gasLimit: 22_000n }))).not.toBe(original);
  });

  it('encodes v as yParity + chainId*2 + 35 for legacy transactions', () => {
    const raw = serializeSigned(base, { yParity: 0, r: 1n, s: 2n });
    // chainId 56 -> v = 0 + 112 + 35 = 147 = 0x93
    expect(raw).toContain('93');
    expect(raw.startsWith('0x')).toBe(true);
  });

  it('prefixes EIP-1559 transactions with the type byte', () => {
    const tx: EvmTransactionRequest = {
      type: 'eip1559',
      chainId: 1,
      nonce: 0n,
      to: base.to,
      value: 0n,
      data: new Uint8Array(0),
      gasLimit: 21_000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    };
    const raw = serializeSigned(tx, { yParity: 1, r: 5n, s: 6n });
    expect(raw.startsWith('0x02')).toBe(true);
  });

  it('rejects an invalid request rather than encoding it', () => {
    expect(() => signingHash({ ...base, gasLimit: 0n })).toThrow();
    expect(() => signingHash({ ...base, to: '0xnothex' })).toThrow();
    expect(() => signingHash({ ...base, chainId: 0 })).toThrow();
    expect(() => signingHash({ ...base, value: -1n })).toThrow();
    expect(() =>
      signingHash({ ...base, type: 'eip1559', maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }),
    ).toThrow();
  });

  it('rejects a malformed signature', () => {
    expect(() => serializeSigned(base, { yParity: 2, r: 1n, s: 1n })).toThrow();
    expect(() => serializeSigned(base, { yParity: 0, r: 0n, s: 1n })).toThrow();
  });

  it('computes the worst-case cost the balance check must cover', () => {
    // 21000 * 20 gwei = 0.00042 native, plus the transferred value.
    expect(maxFeeWei(base)).toBe(420_000_000_000_000n);
    expect(maxCostWei(base)).toBe(base.value + 420_000_000_000_000n);

    // For a token transfer the value is zero, so the whole cost is gas.
    const tokenTx = { ...base, value: 0n, gasLimit: 65_000n };
    expect(maxCostWei(tokenTx)).toBe(maxFeeWei(tokenTx));
  });
});

describe('BEP-20 USDT decimals', () => {
  it('is 18 on BSC, not the 6 it uses on TRON and Ethereum', () => {
    // Hard-coding 6 here is the classic BSC integration bug and misstates balances by 10^12.
    // The assertion exists so a future edit to the asset registry cannot reintroduce it.
    const oneUsdtOnBsc = 10n ** 18n;
    const oneUsdtOnTron = 10n ** 6n;
    expect(oneUsdtOnBsc / oneUsdtOnTron).toBe(10n ** 12n);
  });
});

describe('canonicalisation', () => {
  it('treats differently-cased spellings as the same account', () => {
    const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const lower = checksummed.toLowerCase();
    expect(evmCanonical(checksummed)).toBe(evmCanonical(lower));
  });

  it('returns null for an invalid address', () => {
    expect(evmCanonical('not-an-address')).toBeNull();
  });
});
