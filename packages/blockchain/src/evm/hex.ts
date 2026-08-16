import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Hex and RLP primitives for EVM chains.
 *
 * Written here rather than pulled from ethers/viem. Those are excellent libraries, but they
 * are large, and the surface this application actually needs is small and completely
 * specified: hex coding, keccak256, RLP, and one transaction envelope. Owning it keeps the
 * signer's dependency footprint minimal — and the signer is the process that can move money.
 *
 * Every function here is total: it either returns a correct value or throws. Nothing
 * silently truncates.
 */

export class HexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HexError';
  }
}

const HEX_CHARS = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += HEX_CHARS[byte >> 4];
    output += HEX_CHARS[byte & 0x0f];
  }
  return output;
}

export function fromHex(value: string): Uint8Array {
  const clean = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (clean.length % 2 !== 0) throw new HexError(`fromHex: odd-length input "${value}"`);
  if (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new HexError(`fromHex: not hexadecimal "${value}"`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function keccak256Hex(data: Uint8Array): string {
  return `0x${toHex(keccak256(data))}`;
}

/**
 * Parse a quantity returned by a JSON-RPC node.
 *
 * Nodes return `0x` for "zero" and occasionally decimal strings. This accepts both and
 * rejects anything else — a malformed balance must not become `NaN` or `0` by accident.
 */
export function parseQuantity(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new HexError(`parseQuantity: unsafe numeric quantity ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value !== 'string') throw new HexError('parseQuantity: expected a string');

  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0x' || trimmed === '0X') return 0n;
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  throw new HexError(`parseQuantity: not a quantity "${value}"`);
}

/** Render a BigInt as a minimal JSON-RPC quantity (`0x0`, `0x1f`, never `0x01f`). */
export function toQuantity(value: bigint): string {
  if (value < 0n) throw new HexError('toQuantity: negative quantity');
  return `0x${value.toString(16)}`;
}

/** BigInt → big-endian bytes with no leading zeros. Zero encodes as an empty array. */
export function bigIntToBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new HexError('bigIntToBytes: negative value');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return fromHex(hex);
}

/** BigInt → fixed-width big-endian bytes, left-padded. Used for ABI words. */
export function bigIntToBytesPadded(value: bigint, width: number): Uint8Array {
  const bytes = bigIntToBytes(value);
  if (bytes.length > width) throw new HexError(`bigIntToBytesPadded: value exceeds ${width} bytes`);
  const output = new Uint8Array(width);
  output.set(bytes, width - bytes.length);
  return output;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/* ---------------------------------------------------------------------- RLP -- */

export type RlpInput = Uint8Array | RlpInput[];

function encodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.from([length + offset]);
  const lengthBytes = bigIntToBytes(BigInt(length));
  return concatBytes(Uint8Array.from([lengthBytes.length + offset + 55]), lengthBytes);
}

/**
 * RLP encoding, per the Ethereum yellow paper.
 *
 * Deliberately takes byte arrays rather than numbers or strings: RLP has no notion of
 * integers, and the canonical encoding of a quantity (minimal big-endian, no leading zeros)
 * is a decision the caller must make explicitly. `bigIntToBytes` is that decision.
 */
export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    // A single byte below 0x80 is its own encoding.
    if (input.length === 1 && (input[0] as number) < 0x80) return input;
    return concatBytes(encodeLength(input.length, 0x80), input);
  }

  let payload = new Uint8Array(0);
  for (const item of input) payload = concatBytes(payload, rlpEncode(item));
  return concatBytes(encodeLength(payload.length, 0xc0), payload);
}

/* ----------------------------------------------------------------- ERC-20 ABI -- */

/** `transfer(address,uint256)` — the first four bytes of its keccak256 hash. */
export const ERC20_TRANSFER_SELECTOR = fromHex('a9059cbb');
/** `balanceOf(address)` */
export const ERC20_BALANCE_OF_SELECTOR = fromHex('70a08231');
/** `decimals()` */
export const ERC20_DECIMALS_SELECTOR = fromHex('313ce567');
/** `Transfer(address,address,uint256)` event topic. */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Encode `transfer(address,uint256)` calldata.
 *
 * The recipient is validated by the caller; here it is only decoded. Both arguments are
 * left-padded to 32 bytes, which is what the ABI requires and what a hand-rolled encoder
 * most often gets wrong.
 */
export function encodeErc20Transfer(toAddress: string, amount: bigint): Uint8Array {
  const address = fromHex(toAddress);
  if (address.length !== 20) throw new HexError('encodeErc20Transfer: address must be 20 bytes');
  if (amount < 0n) throw new HexError('encodeErc20Transfer: negative amount');

  const paddedAddress = new Uint8Array(32);
  paddedAddress.set(address, 12);

  return concatBytes(ERC20_TRANSFER_SELECTOR, paddedAddress, bigIntToBytesPadded(amount, 32));
}

/** Encode `balanceOf(address)` calldata. */
export function encodeErc20BalanceOf(ownerAddress: string): Uint8Array {
  const address = fromHex(ownerAddress);
  if (address.length !== 20) throw new HexError('encodeErc20BalanceOf: address must be 20 bytes');
  const padded = new Uint8Array(32);
  padded.set(address, 12);
  return concatBytes(ERC20_BALANCE_OF_SELECTOR, padded);
}

/**
 * Decode a 32-byte ABI word into a quantity.
 *
 * A node returning `0x` (empty) for a call to a non-contract address must read as zero, not
 * throw — that is how "this token is not deployed here" surfaces.
 */
export function decodeUint256(data: string): bigint {
  const clean = data.startsWith('0x') ? data.slice(2) : data;
  if (clean.length === 0) return 0n;
  if (clean.length < 64) return parseQuantity(`0x${clean}`);
  // Take the first word; ERC-20 getters return exactly one.
  return BigInt(`0x${clean.slice(0, 64)}`);
}

/** Decode the 20-byte address packed into the low bytes of a 32-byte topic or word. */
export function decodeAddressWord(word: string): string {
  const clean = word.startsWith('0x') ? word.slice(2) : word;
  if (clean.length < 40) throw new HexError('decodeAddressWord: word too short');
  return `0x${clean.slice(clean.length - 40).toLowerCase()}`;
}
