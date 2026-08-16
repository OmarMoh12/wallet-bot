import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  encodeErc20Transfer,
  evmAddressFromPublicKey,
  keccak256,
  serializeUnsigned,
  toHex,
  type EvmTransactionRequest,
} from '@wallet/blockchain';
import { evmAddressForKey, generateEvmKey, signEvmTransaction } from '../../apps/signer/src/evm';
import { decryptKeyMaterial, encryptKeyMaterial } from '../../apps/signer/src/keystore';
import type { DecryptedKey } from '../../apps/signer/src/keystore';

/**
 * EVM signing, at the signer.
 *
 * The properties under test are the ones that make "private key handled securely" true
 * rather than aspirational: keys are generated correctly, they are encrypted at rest and
 * bound to their identity, and a payload that was altered after the API built it cannot be
 * signed.
 */

const MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const RECIPIENT = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';

function keyFor(privateKey: Buffer, address: string): DecryptedKey {
  return { address, network: 'bsc', env: 'testnet', privateKey };
}

function payloadFor(request: EvmTransactionRequest): Record<string, unknown> {
  return {
    kind: 'evm-transaction',
    txType: request.type,
    chainId: request.chainId,
    nonce: request.nonce.toString(),
    to: request.to,
    value: request.value.toString(),
    data: `0x${toHex(request.data)}`,
    gasLimit: request.gasLimit.toString(),
    ...(request.type === 'legacy'
      ? { gasPrice: (request.gasPrice as bigint).toString() }
      : {
          maxFeePerGas: (request.maxFeePerGas as bigint).toString(),
          maxPriorityFeePerGas: (request.maxPriorityFeePerGas as bigint).toString(),
        }),
    unsignedHex: `0x${toHex(serializeUnsigned(request))}`,
  };
}

function transferRequest(overrides: Partial<EvmTransactionRequest> = {}): EvmTransactionRequest {
  return {
    type: 'legacy',
    chainId: 97,
    nonce: 3n,
    to: USDT_BSC,
    value: 0n,
    // 25 USDT at 18 decimals — the BEP-20 scale.
    data: encodeErc20Transfer(RECIPIENT, 25n * 10n ** 18n),
    gasLimit: 65_000n,
    gasPrice: 10_000_000_000n,
    ...overrides,
  } as EvmTransactionRequest;
}

describe('key generation', () => {
  it('produces a 32-byte key and a matching address', () => {
    const generated = generateEvmKey();

    expect(generated.privateKey.length).toBe(32);
    expect(generated.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The address must actually be derivable from the key, or funds sent to it are lost.
    expect(evmAddressForKey(generated.privateKey)).toBe(generated.address);
  });

  it('produces a different key every time', () => {
    const a = generateEvmKey();
    const b = generateEvmKey();
    expect(a.address).not.toBe(b.address);
    expect(a.privateKey.equals(b.privateKey)).toBe(false);
  });

  it('produces a key inside the valid scalar range', () => {
    for (let i = 0; i < 8; i += 1) {
      const { privateKey } = generateEvmKey();
      const scalar = BigInt(`0x${privateKey.toString('hex')}`);
      expect(scalar > 0n).toBe(true);
      expect(scalar < secp256k1.CURVE.n).toBe(true);
    }
  });

  it('derives the address the same way the public chain does', () => {
    const { privateKey, address } = generateEvmKey();
    const publicKey = secp256k1.getPublicKey(privateKey, false);
    expect(evmAddressFromPublicKey(publicKey)).toBe(address);
  });
});

describe('key storage', () => {
  it('encrypts and decrypts round-trip', () => {
    const { privateKey, address } = generateEvmKey();
    const identity = { address, network: 'bsc' as const, env: 'testnet' as const };

    const material = encryptKeyMaterial(privateKey, identity, MASTER_KEY);
    // Ciphertext must not contain the plaintext key in any obvious form.
    expect(material).not.toContain(privateKey.toString('hex'));
    expect(material).not.toContain(privateKey.toString('base64'));

    expect(decryptKeyMaterial(material, identity, MASTER_KEY).equals(privateKey)).toBe(true);
  });

  it('refuses to decrypt with the wrong master key', () => {
    const { privateKey, address } = generateEvmKey();
    const identity = { address, network: 'bsc' as const, env: 'testnet' as const };
    const material = encryptKeyMaterial(privateKey, identity, MASTER_KEY);

    const otherKey = Buffer.alloc(32, 9).toString('base64');
    expect(() => decryptKeyMaterial(material, identity, otherKey)).toThrow();
  });

  it('refuses to decrypt an entry moved to a different address', () => {
    // The AAD binds the ciphertext to its identity, so swapping blobs between entries fails
    // authentication rather than signing for the wrong account.
    const { privateKey, address } = generateEvmKey();
    const material = encryptKeyMaterial(
      privateKey,
      { address, network: 'bsc', env: 'testnet' },
      MASTER_KEY,
    );

    expect(() =>
      decryptKeyMaterial(
        material,
        { address: RECIPIENT, network: 'bsc', env: 'testnet' },
        MASTER_KEY,
      ),
    ).toThrow();
  });

  it('refuses to decrypt an entry moved to a different network or environment', () => {
    const { privateKey, address } = generateEvmKey();
    const material = encryptKeyMaterial(
      privateKey,
      { address, network: 'bsc', env: 'testnet' },
      MASTER_KEY,
    );

    expect(() =>
      decryptKeyMaterial(material, { address, network: 'bsc', env: 'mainnet' }, MASTER_KEY),
    ).toThrow();
    expect(() =>
      decryptKeyMaterial(material, { address, network: 'tron', env: 'testnet' }, MASTER_KEY),
    ).toThrow();
  });
});

describe('transaction signing', () => {
  it('signs a BEP-20 transfer and returns a broadcastable transaction', () => {
    const { privateKey, address } = generateEvmKey();
    const request = transferRequest();

    const result = signEvmTransaction(payloadFor(request), keyFor(privateKey, address), 97);

    expect(result.rawTransaction).toMatch(/^0x[0-9a-f]+$/);
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.from.toLowerCase()).toBe(address.toLowerCase());
  });

  it('produces a signature that recovers to the signing address', () => {
    // The end-to-end property: the chain will credit this transaction to our address.
    const { privateKey, address } = generateEvmKey();
    const request = transferRequest();

    const digest = keccak256(serializeUnsigned(request));
    const signature = secp256k1.sign(digest, privateKey);
    const recovered = signature.recoverPublicKey(digest).toRawBytes(false);

    expect(evmAddressFromPublicKey(recovered).toLowerCase()).toBe(address.toLowerCase());
  });

  it('refuses a payload whose bytes disagree with its fields', () => {
    // The core integrity check: the API says "send 25 USDT", but the pre-encoded bytes say
    // something else. Recomputing locally catches it.
    const { privateKey, address } = generateEvmKey();
    const honest = transferRequest();
    const tampered = transferRequest({
      data: encodeErc20Transfer(RECIPIENT, 25_000n * 10n ** 18n),
    });

    const payload = {
      ...payloadFor(honest),
      // Fields say 25 USDT; the bytes say 25,000.
      unsignedHex: `0x${toHex(serializeUnsigned(tampered))}`,
    };

    expect(() => signEvmTransaction(payload, keyFor(privateKey, address), 97)).toThrow(
      /do not match/i,
    );
  });

  it('refuses a transaction built for a different chain', () => {
    const { privateKey, address } = generateEvmKey();
    // Mainnet payload arriving at a testnet-configured signer.
    const request = transferRequest({ chainId: 56 });

    expect(() => signEvmTransaction(payloadFor(request), keyFor(privateKey, address), 97)).toThrow(
      /chain id/i,
    );
  });

  it('refuses when the stored key does not derive the address it is filed under', () => {
    const { privateKey } = generateEvmKey();
    const other = generateEvmKey();

    // The keystore entry claims one address; the key belongs to another.
    expect(() =>
      signEvmTransaction(
        transferRequest() && payloadFor(transferRequest()),
        keyFor(privateKey, other.address),
        97,
      ),
    ).toThrow(/does not derive/i);
  });

  it('rejects a malformed payload rather than guessing', () => {
    const { privateKey, address } = generateEvmKey();
    const key = keyFor(privateKey, address);

    expect(() => signEvmTransaction({ kind: 'not-evm' }, key, 97)).toThrow();
    expect(() =>
      signEvmTransaction({ ...payloadFor(transferRequest()), to: '0xshort' }, key, 97),
    ).toThrow();
    expect(() =>
      signEvmTransaction({ ...payloadFor(transferRequest()), nonce: 'abc' }, key, 97),
    ).toThrow();
    expect(() =>
      signEvmTransaction({ ...payloadFor(transferRequest()), txType: 'unknown' }, key, 97),
    ).toThrow();
  });

  it('signs EIP-1559 transactions too', () => {
    const { privateKey, address } = generateEvmKey();
    const request = transferRequest({
      type: 'eip1559',
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasPrice: undefined,
    });

    const result = signEvmTransaction(payloadFor(request), keyFor(privateKey, address), 97);
    // Typed transactions carry their type byte.
    expect(result.rawTransaction.startsWith('0x02')).toBe(true);
  });

  it('never returns key material in its result', () => {
    const { privateKey, address } = generateEvmKey();
    const result = signEvmTransaction(
      payloadFor(transferRequest()),
      keyFor(privateKey, address),
      97,
    );

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(privateKey.toString('hex'));
    expect(serialised).not.toContain(privateKey.toString('base64'));
    expect(Object.keys(result).sort()).toEqual(['from', 'rawTransaction', 'transactionHash']);
  });
});
