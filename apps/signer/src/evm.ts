import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  evmAddressFromPublicKey,
  fromHex,
  keccak256,
  serializeSigned,
  serializeUnsigned,
  toHex,
  type EvmTransactionRequest,
} from '@wallet/blockchain';
import { SigningError } from './sign.js';
import type { DecryptedKey } from './keystore.js';

/**
 * EVM signing and key generation.
 *
 * This is the only place in the system where an EVM private key exists in cleartext, and it
 * exists for microseconds inside a single function call. Three rules hold throughout:
 *
 *   1. A private key is **never** returned, logged, echoed in an error, or written anywhere
 *      except the AES-256-GCM encrypted keystore.
 *   2. The transaction bytes to be signed are **recomputed locally** from the structured
 *      fields and compared against what the caller sent. A payload altered in transit — a
 *      swapped recipient, a raised amount — fails to match and is refused.
 *   3. The chain id is signed into the transaction (EIP-155), so a signature is valid on
 *      exactly one chain and cannot be replayed onto another.
 */

/** The maximum valid secp256k1 scalar, exclusive. */
const CURVE_ORDER = secp256k1.CURVE.n;

export interface GeneratedEvmKey {
  address: string;
  privateKey: Buffer;
}

/**
 * Generate a fresh EVM keypair.
 *
 * Uses the OS CSPRNG via `node:crypto`. Rejection sampling keeps the key uniform over
 * `[1, n)` — naively reducing 32 random bytes modulo the curve order introduces a bias that,
 * while tiny, is exactly the kind of shortcut that has broken real wallets.
 *
 * The caller receives the **address** and an owned buffer it must wipe after storing.
 */
export function generateEvmKey(): GeneratedEvmKey {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = randomBytes(32);
    const scalar = BigInt(`0x${candidate.toString('hex')}`);
    if (scalar === 0n || scalar >= CURVE_ORDER) continue;

    const publicKey = secp256k1.getPublicKey(candidate, false);
    return { address: evmAddressFromPublicKey(publicKey), privateKey: candidate };
  }

  // Practically unreachable: the rejection probability is about 2^-128 per attempt.
  throw new SigningError('KEY_GENERATION_FAILED', 'could not generate a valid secp256k1 key');
}

/** Derive the address for an existing key, without exposing the key. */
export function evmAddressForKey(privateKey: Buffer): string {
  if (privateKey.length !== 32) {
    throw new SigningError('INVALID_KEY', 'EVM private key must be 32 bytes');
  }
  return evmAddressFromPublicKey(secp256k1.getPublicKey(privateKey, false));
}

/* --------------------------------------------------------------- transaction -- */

interface EvmPayload {
  kind?: string;
  txType?: string;
  chainId?: number;
  nonce?: string;
  to?: string;
  value?: string;
  data?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  unsignedHex?: string;
}

function quantity(value: string | undefined, field: string): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new SigningError('INVALID_PAYLOAD', `EVM payload: ${field} must be a decimal string`);
  }
  return BigInt(value);
}

/**
 * Rebuild the transaction request from the payload.
 *
 * Every field is re-validated here rather than trusted. The signer treats the calling
 * service as potentially compromised, so "the API said the gas limit was 21000" is not
 * evidence of anything.
 */
function toRequest(payload: EvmPayload): EvmTransactionRequest {
  if (payload.kind !== 'evm-transaction') {
    throw new SigningError('INVALID_PAYLOAD', 'not an EVM transaction payload');
  }
  if (typeof payload.chainId !== 'number' || !Number.isSafeInteger(payload.chainId)) {
    throw new SigningError('INVALID_PAYLOAD', 'EVM payload: missing chainId');
  }
  if (typeof payload.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payload.to)) {
    throw new SigningError('INVALID_PAYLOAD', 'EVM payload: `to` must be a 20-byte address');
  }
  if (typeof payload.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(payload.data)) {
    throw new SigningError('INVALID_PAYLOAD', 'EVM payload: `data` must be hex');
  }

  const common = {
    chainId: payload.chainId,
    nonce: quantity(payload.nonce, 'nonce'),
    to: payload.to,
    value: quantity(payload.value, 'value'),
    data: fromHex(payload.data),
    gasLimit: quantity(payload.gasLimit, 'gasLimit'),
  };

  if (payload.txType === 'legacy') {
    return { type: 'legacy', ...common, gasPrice: quantity(payload.gasPrice, 'gasPrice') };
  }
  if (payload.txType === 'eip1559') {
    return {
      type: 'eip1559',
      ...common,
      maxFeePerGas: quantity(payload.maxFeePerGas, 'maxFeePerGas'),
      maxPriorityFeePerGas: quantity(payload.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    };
  }
  throw new SigningError('INVALID_PAYLOAD', `EVM payload: unknown txType ${payload.txType}`);
}

/**
 * Sign an EVM transaction.
 *
 * The integrity check is the important part: the unsigned bytes are recomputed from the
 * structured fields and compared byte-for-byte against `unsignedHex`. If the caller's
 * payload was tampered with between construction and signing — a different recipient, a
 * larger amount — the two disagree and nothing is signed.
 */
export function signEvmTransaction(
  payload: Record<string, unknown>,
  key: DecryptedKey,
  expectedChainId?: number,
): { rawTransaction: string; transactionHash: string; from: string } {
  const request = toRequest(payload as EvmPayload);

  if (expectedChainId !== undefined && request.chainId !== expectedChainId) {
    // A transaction signed for the wrong chain is either a configuration error or a
    // cross-chain replay attempt. Neither may proceed.
    throw new SigningError(
      'CHAIN_ID_MISMATCH',
      `payload chain id ${request.chainId} does not match the configured chain`,
    );
  }

  if (key.privateKey.length !== 32) {
    throw new SigningError('INVALID_KEY', 'EVM private key must be 32 bytes');
  }

  // The key must actually control the address this transfer claims to be from.
  const derived = evmAddressForKey(key.privateKey).toLowerCase();
  if (derived !== key.address.toLowerCase()) {
    throw new SigningError(
      'IDENTITY_MISMATCH',
      'the stored key does not derive the address it is filed under',
    );
  }

  // Recompute what the caller says it wants signed, and refuse on any disagreement.
  const rebuilt = serializeUnsigned(request);
  const claimed = (payload as EvmPayload).unsignedHex;
  if (typeof claimed !== 'string' || `0x${toHex(rebuilt)}` !== claimed.toLowerCase()) {
    throw new SigningError(
      'DIGEST_MISMATCH',
      'the transaction bytes do not match the declared fields',
    );
  }

  const digest = keccak256(rebuilt);
  const signature = secp256k1.sign(digest, key.privateKey);
  if (signature.recovery === undefined) {
    throw new SigningError('SIGN_FAILED', 'secp256k1 signature has no recovery id');
  }

  const rawTransaction = serializeSigned(request, {
    yParity: signature.recovery,
    r: signature.r,
    s: signature.s,
  });

  return {
    rawTransaction,
    transactionHash: `0x${toHex(keccak256(fromHex(rawTransaction)))}`,
    from: derived,
  };
}
