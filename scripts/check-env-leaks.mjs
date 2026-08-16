#!/usr/bin/env node
/**
 * Secret-leak scanner for the built client bundle.
 *
 * `NEXT_PUBLIC_*` inlining is easy to get wrong, and the failure is silent: a server-only
 * value referenced from a client component ends up in JavaScript that every user downloads.
 * This script reads the actual build output and looks for the actual values.
 *
 * Run after `pnpm build`, and in CI before deploying:
 *   node scripts/check-env-leaks.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(root, 'apps/web/.next/static');

/** Variables whose *value* must never appear in client JavaScript. */
const SECRET_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'PIN_PEPPER',
  'SIGNER_HMAC_SECRET',
  'SIGNER_MASTER_KEY',
  'TRONGRID_API_KEY',
  'TONCENTER_API_KEY',
  'TONAPI_KEY',
  'COINGECKO_API_KEY',
  'EXCHANGE_RATE_API_KEY',
];

/** Patterns that indicate a secret regardless of what the environment happens to hold. */
const PATTERNS = [
  { name: 'telegram bot token', regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}/ },
  { name: 'postgres connection string', regex: /postgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']+@/ },
  { name: 'process.env.DATABASE_URL reference', regex: /process\.env\.DATABASE_URL/ },
  { name: 'process.env.SESSION_SECRET reference', regex: /process\.env\.SESSION_SECRET/ },
];

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

async function main() {
  if (!existsSync(bundleDir)) {
    console.error(`No client bundle at ${bundleDir}. Run "pnpm build" first.`);
    process.exit(1);
  }

  // Only check variables that actually have a value; an empty one cannot leak.
  const values = SECRET_VARS.map((name) => ({ name, value: process.env[name] })).filter(
    (entry) => typeof entry.value === 'string' && entry.value.length >= 8,
  );

  const findings = [];
  let scanned = 0;

  for await (const file of walk(bundleDir)) {
    scanned += 1;
    const contents = await readFile(file, 'utf8');
    const relative = file.slice(root.length + 1);

    for (const { name, value } of values) {
      if (contents.includes(value)) {
        findings.push(`${relative}: contains the value of ${name}`);
      }
    }
    for (const { name, regex } of PATTERNS) {
      if (regex.test(contents)) {
        findings.push(`${relative}: matches ${name}`);
      }
    }
  }

  console.log(
    `Scanned ${scanned} client bundle file(s) for ${values.length} configured secret value(s).`,
  );

  if (findings.length > 0) {
    console.error('\nSECRET LEAK DETECTED:');
    for (const finding of findings) console.error(`  - ${finding}`);
    console.error(
      '\nA server-only value reached the browser bundle. Check that the module is imported\n' +
        'only from server components or route handlers, and that it carries `import "server-only"`.',
    );
    process.exit(1);
  }

  console.log('No server-only values found in the client bundle.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
