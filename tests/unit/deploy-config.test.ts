import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Deployment configuration guards.
 *
 * These exist because of a real outage. Railway resolves ONE config file per service, and
 * with every service's root directory set to the repository root, all three resolved the
 * same `/railway.toml`. A `startCommand` there was applied to all of them, silently
 * overriding each service's own dashboard command — config-as-code wins, and nothing in the
 * deploy UI says so.
 *
 * The bot service therefore ran the worker's command: the migration CLI (with no
 * DATABASE_MIGRATION_URL, so it fell back to the unprivileged runtime role) followed by the
 * worker binary. It presented as an unexplained boot crash loop reporting only
 * `permission denied for schema public`, and the bot's own code never executed at all.
 *
 * A static check cannot see what Railway actually resolved — that is what
 * `scripts/check-railway-start-commands.mjs` is for, run after a deploy. What it CAN do is
 * stop the shape of the mistake from re-entering the repository.
 */

const repoRoot = new URL('../..', import.meta.url).pathname;
const read = (name: string): string => readFileSync(join(repoRoot, name), 'utf8');

interface RailwayServiceConfig {
  deploy?: { startCommand?: string };
}

const serviceConfigs = (): Array<{ service: string; file: string; config: RailwayServiceConfig }> =>
  readdirSync(repoRoot)
    .map((entry) => ({ entry, match: /^railway\.([a-z0-9-]+)\.json$/.exec(entry) }))
    .filter((row): row is { entry: string; match: RegExpExecArray } => row.match !== null)
    .map((row) => ({
      service: row.match[1] as string,
      file: row.entry,
      config: JSON.parse(read(row.entry)) as RailwayServiceConfig,
    }));

describe('railway.toml (shared, resolved by every service)', () => {
  it('declares no startCommand', () => {
    // The whole bug in one assertion: a startCommand here is inherited by every service.
    const lines = read('railway.toml')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));

    expect(lines.join('\n')).not.toMatch(/startCommand/);
  });

  it('still carries the shared build configuration', () => {
    expect(read('railway.toml')).toMatch(/dockerfilePath\s*=\s*"Dockerfile"/);
  });
});

describe('per-service Railway configuration', () => {
  it('exists for every deployable service', () => {
    const services = serviceConfigs()
      .map((row) => row.service)
      .sort();
    expect(services).toEqual(['bot', 'signer', 'worker']);
  });

  it('gives every service its own start command', () => {
    for (const { service, file, config } of serviceConfigs()) {
      const command = config.deploy?.startCommand;
      expect(command, `${file} must set deploy.startCommand`).toBeTruthy();
      // Each service must start the binary it is named after — the exact property that
      // failed when the bot ran `apps/worker/dist/index.js`.
      expect(command, `${file} must start apps/${service}`).toContain(
        `apps/${service}/dist/index.js`,
      );
    }
  });

  it('runs migrations from the worker only', () => {
    for (const { service, file, config } of serviceConfigs()) {
      const command = config.deploy?.startCommand ?? '';
      const migrates = command.includes('cli/migrate.js');
      if (service === 'worker') {
        expect(migrates, `${file} should apply migrations on deploy`).toBe(true);
      } else {
        // Only the worker is granted DATABASE_MIGRATION_URL. Any other service running the
        // migration CLI connects as the runtime role and dies on the first DDL statement.
        expect(migrates, `${file} must not run migrations`).toBe(false);
      }
    }
  });

  it('references the Dockerfile from the repository root', () => {
    for (const { file } of serviceConfigs()) {
      // These files live at the repository root now, so a relative "../../Dockerfile" (which
      // was correct when they lived under apps/) would no longer resolve.
      expect(read(file)).not.toContain('../../Dockerfile');
    }
  });
});

describe('dead configuration files', () => {
  it('keeps no railway.json under apps/', () => {
    // Railway only reads a service's own config path. Files under apps/ were never read at
    // all, while looking authoritative — they are why the real start command went unnoticed.
    for (const app of ['bot', 'worker', 'signer']) {
      expect(existsSync(join(repoRoot, 'apps', app, 'railway.json'))).toBe(false);
    }
  });
});
