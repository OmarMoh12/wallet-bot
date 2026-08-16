import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@wallet/shared';
import { withSystem, type Sql } from '@wallet/db';
import { RateLimiter, createAppContext, type AppContext } from '@wallet/core';
import { closeSql, getSql, isDatabaseAvailable, uniqueKey } from '../setup/db';

/**
 * Rate limiting.
 *
 * Verified against the real Postgres counter, because the guarantee that matters — that two
 * instances share one budget — cannot be observed with an in-memory stub.
 */

const available = await isDatabaseAvailable();
const describeIf = available ? describe : describe.skip;

if (!available) {
  console.warn('[skip] rate limit tests: TEST_DATABASE_URL is not reachable');
}

describeIf('rate limiter', () => {
  let sql: Sql;
  let app: AppContext;

  beforeAll(async () => {
    sql = getSql();
    app = createAppContext({ service: 'test', sql });
  });

  afterAll(async () => {
    await closeSql();
  });

  it('allows requests below the limit and reports the remaining budget', async () => {
    const limiter = new RateLimiter(app);
    const subject = uniqueKey('sub');

    const first = await limiter.check('auth', subject);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(first.limit - 1);
  });

  it('blocks once the limit is exceeded', async () => {
    const limiter = new RateLimiter(app);
    const subject = uniqueKey('sub');
    const limit = app.config.rateLimit.authPerMinute;

    for (let i = 0; i < limit; i += 1) {
      const decision = await limiter.check('auth', subject);
      expect(decision.allowed).toBe(true);
    }

    const blocked = await limiter.check('auth', subject);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('throws a typed, retry-after-carrying error from enforce', async () => {
    const limiter = new RateLimiter(app);
    const subject = uniqueKey('sub');

    for (let i = 0; i < app.config.rateLimit.authPerMinute; i += 1) {
      await limiter.enforce('auth', subject);
    }

    try {
      await limiter.enforce('auth', subject);
      throw new Error('expected the limiter to throw');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe('RATE_LIMITED');
      expect((error as AppError).details?.retryAfterSeconds).toBeDefined();
    }
  });

  it('keeps buckets independent', async () => {
    const limiter = new RateLimiter(app);
    const subject = uniqueKey('sub');

    for (let i = 0; i < app.config.rateLimit.authPerMinute + 2; i += 1) {
      await limiter.check('auth', subject);
    }

    // A saturated auth bucket must not lock the user out of reading their dashboard.
    const read = await limiter.check('read', subject);
    expect(read.allowed).toBe(true);
  });

  it('keeps subjects independent', async () => {
    const limiter = new RateLimiter(app);
    const noisy = uniqueKey('noisy');
    const quiet = uniqueKey('quiet');

    for (let i = 0; i < app.config.rateLimit.authPerMinute + 2; i += 1) {
      await limiter.check('auth', noisy);
    }

    expect((await limiter.check('auth', quiet)).allowed).toBe(true);
  });

  it('shares one budget across separate instances via the database', async () => {
    const subject = uniqueKey('shared');
    const limit = app.config.rateLimit.authPerMinute;

    // Two limiters model two serverless instances: separate memory, one counter.
    const a = new RateLimiter(app);
    const b = new RateLimiter(app);

    for (let i = 0; i < limit; i += 1) {
      await (i % 2 === 0 ? a : b).check('auth', subject);
    }

    const decision = await b.check('auth', subject);
    expect(decision.allowed).toBe(false);
  });

  it('counts atomically under concurrency', async () => {
    const limiter = new RateLimiter(app);
    const subject = uniqueKey('conc');

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.check('read', subject)),
    );

    // A read-modify-write counter would let several requests observe the same value; the
    // atomic upsert gives every caller a distinct hit count.
    const remainings = decisions.map((decision) => decision.remaining);
    expect(new Set(remainings).size).toBe(decisions.length);
  });

  it('persists the counter where operators can inspect it', async () => {
    const limiter = new RateLimiter(app);
    const subject = uniqueKey('persist');
    await limiter.check('write', subject);

    const rows = await withSystem(
      sql,
      (tx) =>
        tx<Array<{ hits: number }>>`
        SELECT hits FROM api_rate_limits WHERE bucket = 'write' AND subject = ${subject}
      `,
    );
    expect(rows[0]?.hits).toBe(1);
  });
});
