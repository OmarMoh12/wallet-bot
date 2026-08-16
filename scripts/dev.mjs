#!/usr/bin/env node
/**
 * Development runner.
 *
 * Starts everything with one command: watch-builds the packages, then runs the web app, the
 * bot and the worker together with prefixed, colour-coded output.
 *
 * Written by hand rather than pulling in `concurrently`. It is ~100 lines, it lets us hold
 * the apps back until the packages have compiled once (otherwise they crash on a missing
 * `dist`), and it keeps one fewer dependency in a repo that handles money.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const COLORS = {
  packages: '\u001b[35m',
  web: '\u001b[36m',
  bot: '\u001b[32m',
  worker: '\u001b[33m',
  reset: '\u001b[0m',
  dim: '\u001b[2m',
};

const children = [];
let shuttingDown = false;

function prefix(name) {
  const color = COLORS[name] ?? '';
  return `${color}[${name.padEnd(8)}]${COLORS.reset} `;
}

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, FORCE_COLOR: '1', ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const pipe = (stream, isError) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        (isError ? process.stderr : process.stdout).write(`${prefix(name)}${line}\n`);
      }
    });
  };

  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${prefix(name)}${COLORS.dim}exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})${COLORS.reset}\n`,
    );
    // One service dying makes the rest misleading, so take the whole thing down.
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  if (!existsSync(join(root, '.env'))) {
    process.stdout.write(
      `${COLORS.dim}No .env found — copy .env.example to .env first. Continuing with defaults.${COLORS.reset}\n`,
    );
  }

  process.stdout.write(`${prefix('packages')}building workspace packages…\n`);

  await new Promise((resolve, reject) => {
    const build = spawn('pnpm', ['run', 'build:packages'], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    build.stdout.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) process.stdout.write(`${prefix('packages')}${text}\n`);
    });
    build.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) process.stderr.write(`${prefix('packages')}${text}\n`);
    });
    build.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`package build failed (exit ${code})`)),
    );
  });

  process.stdout.write(`${prefix('packages')}watching for changes\n`);
  run('packages', 'pnpm', [
    '--filter',
    './packages/**',
    '--parallel',
    'exec',
    'tsc',
    '-p',
    'tsconfig.json',
    '--watch',
    '--preserveWatchOutput',
  ]);

  run('web', 'pnpm', ['--filter', '@wallet/web', 'dev']);
  run('worker', 'pnpm', ['--filter', '@wallet/worker', 'dev']);

  // The bot needs a token; without one it would just crash-loop and drown the log.
  if (process.env.TELEGRAM_BOT_TOKEN) {
    run('bot', 'pnpm', ['--filter', '@wallet/bot', 'dev']);
  } else {
    process.stdout.write(
      `${prefix('bot')}${COLORS.dim}skipped — set TELEGRAM_BOT_TOKEN in .env to run the bot${COLORS.reset}\n`,
    );
  }

  process.stdout.write(`\n${COLORS.web}  Mini App:${COLORS.reset} http://localhost:3000\n`);
  process.stdout.write(
    `${COLORS.worker}  Worker health:${COLORS.reset} http://localhost:8080/health\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  shutdown(1);
});
