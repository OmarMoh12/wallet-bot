#!/usr/bin/env node
/** Remove build output across the workspace. */
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'apps/web/.next',
  'apps/bot/dist',
  'apps/worker/dist',
  'apps/signer/dist',
  'packages/shared/dist',
  'packages/db/dist',
  'packages/blockchain/dist',
  'packages/currency/dist',
  'packages/telegram/dist',
  'packages/core/dist',
  'coverage',
];

for (const target of targets) {
  const path = join(root, target);
  if (!existsSync(path)) continue;
  await rm(path, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
