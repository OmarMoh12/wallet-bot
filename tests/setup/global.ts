/**
 * Global test setup.
 *
 * Establishes a deterministic environment so no test depends on a developer's `.env`, and
 * so nothing in the suite can accidentally reach a real network or a real chain:
 *
 *   * `APP_ENV=test` and `BLOCKCHAIN_MOCK=true` force the deterministic provider;
 *   * `SENDING_ENABLED=false` and `SIGNER_MODE=mock` mean no test can broadcast anything;
 *   * fixed secrets make signatures and hashes reproducible across runs.
 */

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? Buffer.alloc(32, 7).toString('base64');
process.env.PIN_PEPPER = process.env.PIN_PEPPER ?? 'test-pepper-not-for-production';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString('base64');

// A syntactically valid but entirely fictitious bot token, used to sign test initData.
process.env.TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ?? '123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY-AAAA';
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? 'test_wallet_bot';

process.env.BLOCKCHAIN_MOCK = 'true';
process.env.CHAIN_ENV = 'testnet';
process.env.SENDING_ENABLED = 'false';
process.env.SIGNER_MODE = 'mock';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED ?? 'true';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://app_user:app_user_pw@127.0.0.1:5432/wallet_test';

process.env.DATABASE_MIGRATION_URL =
  process.env.TEST_DATABASE_MIGRATION_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/wallet_test';

process.env.DATABASE_SSL = 'false';
