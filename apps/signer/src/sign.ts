import { createHash, sign as nodeSign, createPrivateKey } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { tryEvmChain } from '@wallet/blockchain';
import type { Network } from '@wallet/shared';
import { signEvmTransaction } from './evm.js';
import type { DecryptedKey } from './keystore.js';

/**
 * Transaction signing.
 *
 * Scope is deliberately narrow: this module turns "an unsigned transaction plus a key" into
 * "a signed transaction", and does nothing else. It performs no policy checks — those all
 * happen in `policy.ts` before a key is ever decrypted — and it never touches the network.
 *
 * `@noble/curves` is the only cryptographic dependency: audited, zero-dependency, and
 * constant-time for the operations we use. Node's built-in secp256k1 cannot return the
 * recovery id that TRON requires, which is why it is not used here.
 */

export class SigningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
  }
}

export interface UnsignedInput {
  network: Network;
  env: 'mainnet' | 'testnet';
  from: string;
  to: string;
  rawAmount: string;
  assetContract: string | null;
  memo: string | null;
  payload: Record<string, unknown>;
  digest: string;
}

export interface SignedOutput {
  payload: Record<string, unknown>;
  digest: string;
}

/* --------------------------------------------------------------------- TRON -- */

/**
 * Sign a TRON transaction.
 *
 * TRON signs `sha256(raw_data_hex)` with secp256k1 and appends a 1-byte recovery id, giving
 * a 65-byte signature. The signed transaction is the original object with a `signature`
 * array added — exactly what `/wallet/broadcasttransaction` expects.
 */
function signTron(unsigned: UnsignedInput, key: DecryptedKey): SignedOutput {
  const rawDataHex = unsigned.payload.raw_data_hex;
  if (typeof rawDataHex !== 'string' || !/^[0-9a-fA-F]+$/.test(rawDataHex)) {
    throw new SigningError('INVALID_PAYLOAD', 'TRON payload is missing a valid raw_data_hex');
  }

  const txId = unsigned.payload.txID;
  if (typeof txId !== 'string' || !/^[0-9a-f]{64}$/i.test(txId)) {
    throw new SigningError('INVALID_PAYLOAD', 'TRON payload is missing a valid txID');
  }

  // The txID is defined as sha256(raw_data). Recomputing it locally means a tampered
  // raw_data_hex cannot be signed under a txID the caller chose.
  const computed = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex');
  if (computed !== txId.toLowerCase()) {
    throw new SigningError('DIGEST_MISMATCH', 'TRON txID does not match raw_data_hex');
  }

  if (key.privateKey.length !== 32) {
    throw new SigningError('INVALID_KEY', 'TRON private key must be 32 bytes');
  }

  const signature = secp256k1.sign(Buffer.from(computed, 'hex'), key.privateKey);
  const compact = signature.toCompactRawBytes(); // r || s, 64 bytes
  const recovery = signature.recovery;
  if (recovery === undefined) {
    throw new SigningError('SIGN_FAILED', 'secp256k1 signature has no recovery id');
  }

  const full = Buffer.concat([Buffer.from(compact), Buffer.from([recovery])]);

  return {
    payload: { ...unsigned.payload, signature: [full.toString('hex')] },
    digest: unsigned.digest,
  };
}

/* ---------------------------------------------------------------------- TON -- */

/**
 * Sign a TON message.
 *
 * TON uses ed25519, which Node supports natively. What Node cannot do is assemble the BOC
 * (bag of cells) that a wallet contract expects — that needs the wallet contract's ABI, the
 * current seqno, and cell serialisation.
 *
 * Rather than emit something that looks signed but cannot be broadcast, this fails closed
 * with a precise code unless the caller supplies a pre-built cell to sign. Wiring a TON
 * wallet adapter is documented in docs/security.md; the interface does not change.
 */
function signTon(unsigned: UnsignedInput, key: DecryptedKey): SignedOutput {
  const cellHash = unsigned.payload.cellHash;

  if (typeof cellHash !== 'string' || !/^[0-9a-f]{64}$/i.test(cellHash)) {
    throw new SigningError(
      'TON_ADAPTER_REQUIRED',
      'TON signing requires a pre-built message cell (payload.cellHash). ' +
        'Configure a TON wallet adapter before enabling TON sends.',
    );
  }

  if (key.privateKey.length !== 32 && key.privateKey.length !== 64) {
    throw new SigningError('INVALID_KEY', 'TON ed25519 key must be 32 or 64 bytes');
  }

  // Node needs a PKCS#8 wrapper around the raw 32-byte seed.
  const seed = key.privateKey.subarray(0, 32);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });

  const signature = nodeSign(null, Buffer.from(cellHash, 'hex'), privateKey);

  return {
    payload: { ...unsigned.payload, signature: signature.toString('base64') },
    digest: unsigned.digest,
  };
}

/* --------------------------------------------------------------------- EVM -- */

/**
 * Sign an EVM transaction.
 *
 * Delegated to `evm.ts`, which additionally recomputes the transaction bytes from the
 * structured fields and refuses if they disagree with what the caller sent — the strongest
 * integrity check of the three chains, because EVM payloads are fully self-describing.
 */
function signEvm(unsigned: UnsignedInput, key: DecryptedKey): SignedOutput {
  const chain = tryEvmChain(unsigned.network, unsigned.env);
  if (!chain) {
    throw new SigningError(
      'UNSUPPORTED_NETWORK',
      `no EVM chain configured for ${unsigned.network}`,
    );
  }

  const result = signEvmTransaction(unsigned.payload, key, chain.chainId);

  return {
    payload: {
      rawTransaction: result.rawTransaction,
      transactionHash: result.transactionHash,
      from: result.from,
      chainId: chain.chainId,
    },
    digest: unsigned.digest,
  };
}

/* ------------------------------------------------------------------ dispatch -- */

export function signTransaction(unsigned: UnsignedInput, key: DecryptedKey): SignedOutput {
  if (key.network !== unsigned.network || key.env !== unsigned.env) {
    // Would mean the keystore lookup and the request disagree — refuse rather than guess.
    throw new SigningError('IDENTITY_MISMATCH', 'key does not match the requested network');
  }

  switch (unsigned.network) {
    case 'tron':
      return signTron(unsigned, key);
    case 'ton':
      return signTon(unsigned, key);
    case 'bsc':
      return signEvm(unsigned, key);
    default: {
      const exhaustive: never = unsigned.network;
      void exhaustive;
      throw new SigningError('UNSUPPORTED_NETWORK', 'no signer for this network');
    }
  }
}

/** Zero a key buffer after use. Best effort — V8 may still hold copies. */
export function wipe(buffer: Buffer): void {
  buffer.fill(0);
}
