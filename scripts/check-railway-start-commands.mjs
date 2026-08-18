#!/usr/bin/env node
/**
 * Verify each Railway service's EFFECTIVE start command.
 *
 * Why this exists as a live check rather than only a static one: the start command that
 * actually runs is resolved by Railway, not by this repository. Config-as-code silently
 * overrides the dashboard, one config file can be resolved by several services, and none of
 * that is surfaced in the deploy UI. A service can therefore run a completely different
 * process from the one it is named after and still report a successful build.
 *
 * That is not a hypothetical failure: the `bot` service ran the worker's start command for
 * an entire deploy generation. It looked like a database permissions bug.
 *
 * Usage:
 *   node scripts/check-railway-start-commands.mjs                  # verify
 *   node scripts/check-railway-start-commands.mjs --json            # machine-readable
 *   node scripts/check-railway-start-commands.mjs --allow-missing   # tolerate undeployed
 *
 * A service that could not be checked is a failure by default. A gate that reports success
 * having verified nothing is worse than no gate. Pass `--allow-missing` when a service is
 * deliberately not deployed (the signer usually is not).
 *
 * Requires the Railway CLI, logged in and linked to the project (`railway link`).
 * Exit codes: 0 = all match, 1 = a mismatch or an unverified service, 2 = could not check.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const allowMissing = process.argv.includes('--allow-missing');

/** Expected commands come from the repo, so the check has a source of truth under review. */
function expectedCommands() {
  const expected = new Map();
  for (const entry of readdirSync(repoRoot)) {
    const match = /^railway\.([a-z0-9-]+)\.json$/.exec(entry);
    if (!match) continue;
    const config = JSON.parse(readFileSync(join(repoRoot, entry), 'utf8'));
    const command = config?.deploy?.startCommand;
    if (typeof command === 'string' && command.length > 0) {
      expected.set(match[1], { command, file: entry });
    }
  }
  return expected;
}

function railwayStatus() {
  try {
    return JSON.parse(
      execFileSync('railway', ['status', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || 'unknown error';
    console.error('Could not query Railway. Is the CLI installed, logged in and linked?');
    console.error(`  ${detail}`);
    process.exit(2);
  }
}

/**
 * The command Railway will actually run. `serviceManifest` is the resolved manifest for the
 * active deployment — it already reflects config-file-over-dashboard precedence, which is
 * exactly the layer that broke. The instance-level `startCommand` is only the dashboard
 * setting, so it is a fallback, not the answer.
 */
function effectiveCommand(instance) {
  for (const deployment of instance.activeDeployments ?? []) {
    const command = deployment?.meta?.serviceManifest?.deploy?.startCommand;
    if (typeof command === 'string' && command.length > 0) return command;
  }
  return instance.startCommand ?? null;
}

const expected = expectedCommands();
if (expected.size === 0) {
  console.error('No railway.<service>.json files found at the repository root.');
  process.exit(2);
}

const results = [];
for (const env of railwayStatus()?.environments?.edges ?? []) {
  for (const edge of env.node?.serviceInstances?.edges ?? []) {
    const instance = edge.node;
    const name = instance.serviceName;
    const want = expected.get(name);
    if (!want) continue;
    const actual = effectiveCommand(instance);
    results.push({
      service: name,
      environment: env.node?.name ?? 'unknown',
      expected: want.command,
      actual,
      source: want.file,
      ok: actual === want.command,
    });
  }
}

if (results.length === 0) {
  console.error('No matching Railway services found. Is the CLI linked to the right project?');
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const row of results) {
    if (row.ok) {
      console.log(`OK    ${row.service} (${row.environment})`);
      console.log(`        ${row.actual}`);
    } else {
      console.log(`WRONG ${row.service} (${row.environment})`);
      console.log(`        expected (${row.source}): ${row.expected}`);
      console.log(`        actually running:        ${row.actual ?? '(none)'}`);
    }
  }
}

const failed = results.filter((row) => !row.ok);
const unchecked = [...expected.keys()].filter((name) => !results.some((r) => r.service === name));
if (unchecked.length > 0) {
  console.error(`\nNot deployed / not found, so UNVERIFIED: ${unchecked.join(', ')}`);
  if (!allowMissing) {
    console.error('  Re-run with --allow-missing if these are deliberately not deployed.');
  }
}

if (failed.length === 0 && unchecked.length > 0 && !allowMissing) {
  process.exit(1);
}

if (failed.length > 0) {
  console.error(
    `\n${failed.length} service(s) are running the wrong command. A service running another ` +
      `service's command can still build, deploy and report success — fix the "Config as ` +
      `code" path or the dashboard start command before trusting this deploy.`,
  );
  process.exit(1);
}

console.log(`\nAll ${results.length} checked service(s) run their intended command.`);
