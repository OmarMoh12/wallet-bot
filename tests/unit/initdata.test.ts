import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '@wallet/shared';
import { sanitizeStartParam, verifyInitData, verifyWebhookSecret } from '@wallet/telegram';

/**
 * Telegram initData verification.
 *
 * This is the entire authentication boundary of the Mini App, so the tests cover both the
 * happy path and every way a forgery might try to slip through.
 */

const BOT_TOKEN = '123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY-AAAA';

function signInitData(params: Record<string, string>, token = BOT_TOKEN): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const search = new URLSearchParams(params);
  search.set('hash', hash);
  return search.toString();
}

function validParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEtest',
    user: JSON.stringify({
      id: 42424242,
      first_name: 'Test',
      username: 'tester',
      language_code: 'ar',
    }),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected the call to throw');
  } catch (error) {
    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
  }
}

describe('verifyInitData', () => {
  it('accepts a correctly signed payload', () => {
    const initData = signInitData(validParams());
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 });

    expect(result.user.id).toBe(42424242);
    expect(result.user.username).toBe('tester');
    expect(result.user.language_code).toBe('ar');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a tampered field', () => {
    const initData = signInitData(validParams());
    // Swap the user for a different id, leaving the original hash in place.
    const tampered = initData.replace(
      encodeURIComponent(
        JSON.stringify({
          id: 42424242,
          first_name: 'Test',
          username: 'tester',
          language_code: 'ar',
        }),
      ),
      encodeURIComponent(JSON.stringify({ id: 999, first_name: 'Mallory' })),
    );
    expectCode(
      () => verifyInitData(tampered, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('rejects a payload signed with a different bot token', () => {
    const initData = signInitData(validParams(), '987654321:SOME-OTHER-BOT-TOKEN-VALUE-BBBB');
    expectCode(
      () => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('rejects an unsigned payload', () => {
    const search = new URLSearchParams(validParams()).toString();
    expectCode(
      () => verifyInitData(search, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('rejects a stale payload', () => {
    const old = String(Math.floor(Date.now() / 1000) - 4000);
    const initData = signInitData(validParams({ auth_date: old }));
    expectCode(
      () => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INIT_DATA_EXPIRED',
    );
  });

  it('rejects a future-dated payload beyond clock skew', () => {
    const future = String(Math.floor(Date.now() / 1000) + 600);
    const initData = signInitData(validParams({ auth_date: future }));
    expectCode(
      () => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('rejects an oversized payload before parsing it', () => {
    expectCode(
      () => verifyInitData('a'.repeat(5000), { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('rejects a bot account', () => {
    const initData = signInitData(
      validParams({ user: JSON.stringify({ id: 5, first_name: 'B', is_bot: true }) }),
    );
    expectCode(
      () => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('rejects a payload with no user', () => {
    const params = validParams();
    delete params.user;
    const initData = signInitData(params);
    expectCode(
      () => verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
      'INVALID_INIT_DATA',
    );
  });

  it('accepts a payload carrying the newer signature field', () => {
    // Telegram added `signature` for third-party validation; the bot-token check must still
    // succeed whether or not it participates in the check-string.
    const initData = signInitData(validParams({ signature: 'abc123' }));
    const result = verifyInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 });
    expect(result.user.id).toBe(42424242);
  });
});

describe('sanitizeStartParam', () => {
  it('accepts a well-formed deep-link payload', () => {
    expect(sanitizeStartParam('tx_0a1b2c')).toBe('tx_0a1b2c');
  });

  it('rejects anything outside the safe character set', () => {
    // start_param is attacker-controllable: anyone can send the user a crafted link.
    expect(sanitizeStartParam('../../etc/passwd')).toBeNull();
    expect(sanitizeStartParam("'; DROP TABLE users; --")).toBeNull();
    expect(sanitizeStartParam('<script>')).toBeNull();
    expect(sanitizeStartParam('a'.repeat(200))).toBeNull();
    expect(sanitizeStartParam('')).toBeNull();
  });
});

describe('verifyWebhookSecret', () => {
  it('accepts a matching secret and rejects everything else', () => {
    expect(verifyWebhookSecret('s3cret', 's3cret')).toBe(true);
    expect(verifyWebhookSecret('wrong', 's3cret')).toBe(false);
    expect(verifyWebhookSecret(null, 's3cret')).toBe(false);
    // An unconfigured secret must never pass, or the webhook would be open.
    expect(verifyWebhookSecret('anything', '')).toBe(false);
  });
});
