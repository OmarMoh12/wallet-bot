#!/usr/bin/env node
/**
 * Keystore management CLI.
 *
 *   node dist/cli/keystore.js list
 *   node dist/cli/keystore.js add --network tron --env testnet --address T... --key <hex>
 *   node dist/cli/keystore.js remove --address T...
 *   node dist/cli/keystore.js rotate --new-key <base64>
 *
 * Run this **on the signer host only**. The private key is read from `--key` or, preferably,
 * from stdin so it never appears in shell history or the process list.
 */
import { createInterface } from 'node:readline';
import { Keystore } from '../keystore.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'list';
  const path = process.env.SIGNER_KEYSTORE_PATH ?? './.signer/keystore.json';
  const secret = process.env.SIGNER_MASTER_KEY ?? '';

  if (!secret) {
    console.error('SIGNER_MASTER_KEY must be set. Generate one with: openssl rand -base64 32');
    process.exit(1);
  }

  const keystore = new Keystore(path, secret);
  await keystore.load();

  switch (command) {
    case 'list': {
      const entries = keystore.list();
      if (entries.length === 0) {
        console.error('Keystore is empty.');
        return;
      }
      for (const entry of entries) {
        console.error(
          `${entry.network}/${entry.env}  ${entry.address}  ${entry.label ?? ''}  (added ${entry.createdAt})`,
        );
      }
      return;
    }

    case 'add': {
      const network = arg('network');
      const env = arg('env') ?? 'testnet';
      const address = arg('address');
      const label = arg('label');

      if (network !== 'tron' && network !== 'ton') {
        console.error('--network must be tron or ton');
        process.exit(1);
      }
      if (env !== 'mainnet' && env !== 'testnet') {
        console.error('--env must be mainnet or testnet');
        process.exit(1);
      }
      if (!address) {
        console.error('--address is required');
        process.exit(1);
      }

      // Prefer stdin so the key never lands in shell history.
      const hex = arg('key') ?? (await readStdin('Private key (hex, hidden from history): '));
      if (!/^[0-9a-fA-F]{64,128}$/.test(hex)) {
        console.error('Private key must be 32–64 bytes of hex');
        process.exit(1);
      }

      await keystore.add({
        address,
        network,
        env,
        privateKey: Buffer.from(hex, 'hex'),
        ...(label ? { label } : {}),
      });

      console.error(`Added ${network}/${env} ${address}.`);
      console.error(
        'Reminder: set the matching wallet to type=managed in the database before it can send.',
      );
      return;
    }

    case 'remove': {
      const address = arg('address');
      if (!address) {
        console.error('--address is required');
        process.exit(1);
      }
      const removed = await keystore.remove(address);
      console.error(removed ? `Removed ${address}.` : `No entry for ${address}.`);
      return;
    }

    case 'rotate': {
      const newKey = arg('new-key') ?? (await readStdin('New master key (base64): '));
      if (!newKey) {
        console.error('A new master key is required');
        process.exit(1);
      }
      const count = await keystore.rotate(newKey);
      console.error(`Re-encrypted ${count} entr${count === 1 ? 'y' : 'ies'}.`);
      console.error('Now update SIGNER_MASTER_KEY in the environment and restart the signer.');
      return;
    }

    default:
      console.error(`Unknown command: ${command}. Use list | add | remove | rotate.`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
