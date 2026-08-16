import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { NETWORKS, type Network } from '@wallet/shared';

/**
 * Encrypted keystore.
 *
 * Design constraints, in order of importance:
 *
 *   * **Key material never enters the database.** This file lives on the signer host (or a
 *     mounted secret volume). A full compromise of Postgres, the web app, the bot and the
 *     worker still yields nothing signable.
 *   * **Encrypted at rest with AES-256-GCM.** The data-encryption key is derived from
 *     `SIGNER_MASTER_KEY`, which exists only in the signer's environment.
 *   * **AAD binds each entry to its address and network.** An attacker who can swap
 *     ciphertext blobs between entries cannot make the signer use key A while believing it
 *     is signing for address B — the authentication tag fails.
 *   * **Nothing here is ever logged or returned.** The only thing that leaves this module is
 *     a signature.
 *
 * This is the *reference* implementation so the architecture is complete and testable. For
 * anything beyond small balances, point the signer at an HSM or a cloud KMS instead: the
 * `Keystore` interface is the seam for that, and no caller changes.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const entrySchema = z.object({
  address: z.string().min(20).max(120),
  network: z.enum(NETWORKS),
  env: z.enum(['mainnet', 'testnet']),
  /** base64: iv || ciphertext || tag */
  material: z.string().min(32),
  keyId: z.string().max(32).default('v1'),
  createdAt: z.string(),
  label: z.string().max(60).optional(),
});

const keystoreSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema).default([]),
});

export type KeystoreEntry = z.infer<typeof entrySchema>;

export interface DecryptedKey {
  address: string;
  network: Network;
  env: 'mainnet' | 'testnet';
  /** Raw private key bytes. Callers must not retain or copy this. */
  privateKey: Buffer;
}

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

function masterKey(secret: string): Buffer {
  if (!secret) throw new KeystoreError('SIGNER_MASTER_KEY is not set');
  const key = Buffer.from(secret, 'base64');
  if (key.length < KEY_BYTES) {
    throw new KeystoreError('SIGNER_MASTER_KEY must decode to at least 32 bytes');
  }
  return key.subarray(0, KEY_BYTES);
}

/** Ties a ciphertext to the identity it is stored under. */
function aad(entry: Pick<KeystoreEntry, 'address' | 'network' | 'env'>): Buffer {
  return Buffer.from(`${entry.network}:${entry.env}:${entry.address}`, 'utf8');
}

export function encryptKeyMaterial(
  privateKey: Buffer,
  identity: Pick<KeystoreEntry, 'address' | 'network' | 'env'>,
  secret: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey(secret), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

export function decryptKeyMaterial(
  material: string,
  identity: Pick<KeystoreEntry, 'address' | 'network' | 'env'>,
  secret: string,
): Buffer {
  const raw = Buffer.from(material, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new KeystoreError('key material is malformed');

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', masterKey(secret), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Wrong master key, tampered ciphertext, or an entry moved between identities.
    throw new KeystoreError('could not decrypt key material (wrong key or tampered entry)');
  }
}

export class Keystore {
  private entries: KeystoreEntry[] = [];
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly secret: string,
  ) {}

  async load(): Promise<void> {
    if (!existsSync(this.path)) {
      this.entries = [];
      this.loaded = true;
      return;
    }
    const raw = await readFile(this.path, 'utf8');
    const parsed = keystoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new KeystoreError('keystore file is malformed');
    this.entries = parsed.data.entries;
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new KeystoreError('keystore has not been loaded');
  }

  get size(): number {
    return this.entries.length;
  }

  /** Addresses only — never key material. Safe to expose on the health endpoint. */
  list(): Array<Pick<KeystoreEntry, 'address' | 'network' | 'env' | 'label' | 'createdAt'>> {
    this.assertLoaded();
    return this.entries.map((entry) => ({
      address: entry.address,
      network: entry.network,
      env: entry.env,
      ...(entry.label ? { label: entry.label } : {}),
      createdAt: entry.createdAt,
    }));
  }

  /**
   * Find and decrypt the key for an address.
   *
   * The address comparison is constant-time. That is not paranoia about secrecy — the
   * address is public — but it keeps the lookup from becoming an oracle for *which*
   * addresses this signer controls.
   */
  find(identity: {
    address: string;
    network: Network;
    env: 'mainnet' | 'testnet';
  }): DecryptedKey | null {
    this.assertLoaded();

    const target = Buffer.from(identity.address, 'utf8');
    const match = this.entries.find((entry) => {
      if (entry.network !== identity.network || entry.env !== identity.env) return false;
      const candidate = Buffer.from(entry.address, 'utf8');
      return candidate.length === target.length && timingSafeEqual(candidate, target);
    });

    if (!match) return null;

    return {
      address: match.address,
      network: match.network,
      env: match.env,
      privateKey: decryptKeyMaterial(match.material, match, this.secret),
    };
  }

  async add(entry: {
    address: string;
    network: Network;
    env: 'mainnet' | 'testnet';
    privateKey: Buffer;
    label?: string;
  }): Promise<void> {
    this.assertLoaded();

    if (this.entries.some((existing) => existing.address === entry.address)) {
      throw new KeystoreError('an entry for this address already exists');
    }

    this.entries.push({
      address: entry.address,
      network: entry.network,
      env: entry.env,
      material: encryptKeyMaterial(entry.privateKey, entry, this.secret),
      keyId: 'v1',
      createdAt: new Date().toISOString(),
      ...(entry.label ? { label: entry.label } : {}),
    });

    await this.persist();
  }

  async remove(address: string): Promise<boolean> {
    this.assertLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.address !== address);
    if (this.entries.length === before) return false;
    await this.persist();
    return true;
  }

  /**
   * Re-encrypt every entry under a new master key.
   *
   * The rotation procedure (see docs/security.md) is: set `SIGNER_MASTER_KEY_NEW`, run this,
   * swap the variables, restart. Old ciphertext is never left behind in the file.
   */
  async rotate(newSecret: string): Promise<number> {
    this.assertLoaded();
    const rotated = this.entries.map((entry) => ({
      ...entry,
      material: encryptKeyMaterial(
        decryptKeyMaterial(entry.material, entry, this.secret),
        entry,
        newSecret,
      ),
    }));
    this.entries = rotated;
    await this.persist();
    return rotated.length;
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
    await writeFile(this.path, payload, { encoding: 'utf8', mode: 0o600 });
    // Re-assert permissions in case the file already existed with looser ones.
    await chmod(this.path, 0o600).catch(() => {});
  }
}
