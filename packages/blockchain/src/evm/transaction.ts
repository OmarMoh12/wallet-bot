import {
  HexError,
  bigIntToBytes,
  concatBytes,
  fromHex,
  keccak256,
  rlpEncode,
  toHex,
  type RlpInput,
} from './hex.js';

/**
 * EVM transaction encoding.
 *
 * Two envelopes are supported:
 *
 *   * **Legacy (type 0)** with EIP-155 replay protection — what BSC uses. Its validators
 *     charge a flat gas price and ignore a priority fee, so a type-2 transaction there just
 *     adds encoding complexity for no benefit.
 *   * **EIP-1559 (type 2)** — for chains where base fee and tip are real. Implemented now so
 *     adding Ethereum or Polygon needs no new encoding work.
 *
 * The unsigned payload and the signed payload are built by the same function, differing only
 * in whether signature fields are present. That symmetry is the point: a signed transaction
 * that encodes different fields from the one that was hashed is a class of bug that ends
 * with funds at the wrong address.
 */

export type EvmTxType = 'legacy' | 'eip1559';

export interface EvmTransactionRequest {
  type: EvmTxType;
  chainId: number;
  nonce: bigint;
  /** Recipient. `null` would be a contract deployment, which this application never does. */
  to: string;
  value: bigint;
  data: Uint8Array;
  gasLimit: bigint;
  /** Legacy only. */
  gasPrice?: bigint;
  /** EIP-1559 only. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface EvmSignature {
  /** Recovery id, 0 or 1. */
  yParity: number;
  r: bigint;
  s: bigint;
}

function assertRequest(request: EvmTransactionRequest): void {
  if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
    throw new HexError('EVM transaction: chainId must be a positive integer');
  }
  if (request.nonce < 0n) throw new HexError('EVM transaction: negative nonce');
  if (request.value < 0n) throw new HexError('EVM transaction: negative value');
  if (request.gasLimit <= 0n) throw new HexError('EVM transaction: gasLimit must be positive');
  if (!/^0x[0-9a-fA-F]{40}$/.test(request.to)) {
    throw new HexError('EVM transaction: `to` must be a 20-byte hex address');
  }
  if (request.type === 'legacy') {
    if (request.gasPrice === undefined || request.gasPrice <= 0n) {
      throw new HexError('EVM legacy transaction: gasPrice must be positive');
    }
  } else {
    if (request.maxFeePerGas === undefined || request.maxFeePerGas <= 0n) {
      throw new HexError('EIP-1559 transaction: maxFeePerGas must be positive');
    }
    if (request.maxPriorityFeePerGas === undefined || request.maxPriorityFeePerGas < 0n) {
      throw new HexError('EIP-1559 transaction: maxPriorityFeePerGas must be non-negative');
    }
    if (request.maxPriorityFeePerGas > request.maxFeePerGas) {
      throw new HexError('EIP-1559 transaction: priority fee exceeds max fee');
    }
  }
}

/**
 * Build the RLP field list.
 *
 * When `signature` is absent this produces the payload that gets hashed for signing; when it
 * is present, the payload that gets broadcast. For legacy transactions the unsigned form
 * carries `[chainId, 0, 0]` in the signature slots — that is EIP-155 replay protection, and
 * omitting it would produce a transaction valid on every EVM chain simultaneously.
 */
function fields(request: EvmTransactionRequest, signature?: EvmSignature): RlpInput[] {
  const to = fromHex(request.to);
  const chainId = bigIntToBytes(BigInt(request.chainId));
  const nonce = bigIntToBytes(request.nonce);
  const gasLimit = bigIntToBytes(request.gasLimit);
  const value = bigIntToBytes(request.value);

  if (request.type === 'legacy') {
    const base: RlpInput[] = [
      nonce,
      bigIntToBytes(request.gasPrice as bigint),
      gasLimit,
      to,
      value,
      request.data,
    ];

    if (!signature) {
      // EIP-155: sign over [..., chainId, 0, 0].
      return [...base, chainId, new Uint8Array(0), new Uint8Array(0)];
    }

    // v = yParity + chainId * 2 + 35
    const v = BigInt(signature.yParity) + BigInt(request.chainId) * 2n + 35n;
    return [...base, bigIntToBytes(v), bigIntToBytes(signature.r), bigIntToBytes(signature.s)];
  }

  const base: RlpInput[] = [
    chainId,
    nonce,
    bigIntToBytes(request.maxPriorityFeePerGas as bigint),
    bigIntToBytes(request.maxFeePerGas as bigint),
    gasLimit,
    to,
    value,
    request.data,
    // Empty access list. This application never needs one.
    [],
  ];

  if (!signature) return base;
  return [
    ...base,
    bigIntToBytes(BigInt(signature.yParity)),
    bigIntToBytes(signature.r),
    bigIntToBytes(signature.s),
  ];
}

/** The bytes a signer must hash and sign. */
export function serializeUnsigned(request: EvmTransactionRequest): Uint8Array {
  assertRequest(request);
  const encoded = rlpEncode(fields(request));
  // Typed transactions are prefixed with their type byte before hashing (EIP-2718).
  return request.type === 'legacy' ? encoded : concatBytes(Uint8Array.from([0x02]), encoded);
}

/** keccak256 of the unsigned payload — the digest that gets signed. */
export function signingHash(request: EvmTransactionRequest): Uint8Array {
  return keccak256(serializeUnsigned(request));
}

/** The raw transaction to hand to `eth_sendRawTransaction`. */
export function serializeSigned(request: EvmTransactionRequest, signature: EvmSignature): string {
  assertRequest(request);
  if (signature.yParity !== 0 && signature.yParity !== 1) {
    throw new HexError('EVM signature: yParity must be 0 or 1');
  }
  if (signature.r <= 0n || signature.s <= 0n) {
    throw new HexError('EVM signature: r and s must be positive');
  }

  const encoded = rlpEncode(fields(request, signature));
  const raw = request.type === 'legacy' ? encoded : concatBytes(Uint8Array.from([0x02]), encoded);
  return `0x${toHex(raw)}`;
}

/**
 * The transaction hash, as it will appear on the chain and in explorers.
 *
 * Computed from the *signed* payload, so it is only known after signing — which is why the
 * send pipeline records the hash returned by the signer/broadcast rather than predicting one.
 */
export function transactionHash(rawTransaction: string): string {
  return `0x${toHex(keccak256(fromHex(rawTransaction)))}`;
}

/**
 * Total cost ceiling of a transaction in wei: `value + gasLimit * gasPrice`.
 *
 * Used for the balance check. The actual fee is `gasUsed * gasPrice` and is normally lower,
 * but a balance check has to assume the worst case or the transaction can fail after the
 * user has confirmed it.
 */
export function maxCostWei(request: EvmTransactionRequest): bigint {
  const pricePerGas =
    request.type === 'legacy' ? (request.gasPrice as bigint) : (request.maxFeePerGas as bigint);
  return request.value + request.gasLimit * pricePerGas;
}

/** Fee ceiling alone, excluding the transferred value. */
export function maxFeeWei(request: EvmTransactionRequest): bigint {
  const pricePerGas =
    request.type === 'legacy' ? (request.gasPrice as bigint) : (request.maxFeePerGas as bigint);
  return request.gasLimit * pricePerGas;
}
