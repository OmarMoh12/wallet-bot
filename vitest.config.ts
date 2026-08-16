import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * Unit tests run everywhere with no external dependency. Integration tests need a real
 * PostgreSQL — they exercise RLS, unique-index idempotency and trigger-maintained balances,
 * none of which can be verified against a mock without testing the mock instead of the
 * system. When `TEST_DATABASE_URL` is unreachable those suites skip with a clear message
 * rather than failing, so a fresh clone still gets a green unit run.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/global.ts'],
    // Integration tests share one database; running files in parallel would make them
    // observe each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.test.ts', 'packages/*/src/cli/**'],
    },
  },
  resolve: {
    // Point at TypeScript sources rather than built output, so a test failure shows the
    // line you actually wrote and no build step is needed before running tests.
    alias: [
      {
        find: /^@wallet\/shared$/,
        replacement: new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@wallet\/db$/,
        replacement: new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@wallet\/blockchain$/,
        replacement: new URL('./packages/blockchain/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@wallet\/currency$/,
        replacement: new URL('./packages/currency/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@wallet\/telegram$/,
        replacement: new URL('./packages/telegram/src/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@wallet\/core$/,
        replacement: new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      },
    ],
  },
});
