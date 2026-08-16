import { describe, expect, it } from 'vitest';
import {
  chainEventKey,
  fingerprintHint,
  notificationKey,
  redact,
  redactString,
  assetKey,
  normaliseAddress,
} from '@wallet/shared';
import {
  hashIp,
  hashPin,
  hashSessionToken,
  issueSessionToken,
  looksLikeSessionToken,
  quoteFingerprint,
  verifyPin,
} from '@wallet/core';
import {
  NonceCache,
  SpendTracker,
  canonicalRequest,
  enforceSpendPolicy,
  verifySignedRequest,
  PolicyError,
} from '../../apps/signer/src/policy';
import { createHmac } from 'node:crypto';

/**
 * Security primitives: log redaction, key derivation, idempotency keys, and the signer's
 * request authentication.
 */

describe('log redaction', () => {
  it('strips Telegram bot tokens from free text', () => {
    const leaked =
      'calling https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe';
    expect(redactString(leaked)).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    expect(redactString(leaked)).toContain('[redacted]');
  });

  it('strips credentials from a Postgres URL', () => {
    const url = 'postgresql://appuser:sup3rsecret@db.example.com:5432/wallet';
    const output = redactString(url);
    expect(output).not.toContain('sup3rsecret');
    expect(output).toContain('db.example.com');
  });

  it('redacts sensitive keys but keeps useful ones', () => {
    const output = redact({
      token: 'abc',
      sessionSecret: 'shh',
      privateKey: 'deadbeef',
      txHash: 'a'.repeat(64),
      userId: 'u-1',
    }) as Record<string, unknown>;

    expect(output.token).toBe('[redacted]');
    expect(output.sessionSecret).toBe('[redacted]');
    expect(output.privateKey).toBe('[redacted]');
    // A transaction hash is public and essential for debugging.
    expect(output.txHash).toBe('a'.repeat(64));
    expect(output.userId).toBe('u-1');
  });

  it('does not walk into prototype pollution vectors', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const output = redact(hostile) as Record<string, unknown>;
    expect(output.safe).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('gives a non-reversible hint for a secret', () => {
    expect(fingerprintHint('supersecretvalue')).toContain('len:16');
    expect(fingerprintHint('supersecretvalue')).not.toContain('secret');
  });
});

describe('session tokens', () => {
  it('issues a high-entropy token and stores only its hash', () => {
    const secret = Buffer.alloc(32, 3).toString('base64');
    const { token, tokenHash } = issueSessionToken(secret);

    expect(looksLikeSessionToken(token)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(hashSessionToken(secret, token)).toBe(tokenHash);
  });

  it('produces a different hash under a different server secret', () => {
    const { token } = issueSessionToken(Buffer.alloc(32, 1).toString('base64'));
    const a = hashSessionToken('secret-a', token);
    const b = hashSessionToken('secret-b', token);
    expect(a).not.toBe(b);
  });

  it('rejects malformed tokens before touching the database', () => {
    expect(looksLikeSessionToken('short')).toBe(false);
    expect(looksLikeSessionToken('has spaces and is long enough to pass length check!!')).toBe(
      false,
    );
  });
});

describe('PIN hashing', () => {
  it('verifies a correct PIN and rejects a wrong one', async () => {
    const pepper = 'test-pepper';
    const credentials = await hashPin('123456', pepper);

    expect(await verifyPin('123456', credentials, pepper)).toBe(true);
    expect(await verifyPin('123457', credentials, pepper)).toBe(false);
  });

  it('fails without the server pepper, so a database leak is not enough', async () => {
    const credentials = await hashPin('123456', 'real-pepper');
    expect(await verifyPin('123456', credentials, 'guessed-pepper')).toBe(false);
  });

  it('salts each PIN separately', async () => {
    const a = await hashPin('123456', 'p');
    const b = await hashPin('123456', 'p');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('rejects a malformed PIN', async () => {
    await expect(hashPin('12345', 'p')).rejects.toThrow();
    const credentials = await hashPin('123456', 'p');
    expect(await verifyPin('abcdef', credentials, 'p')).toBe(false);
  });
});

describe('IP hashing', () => {
  it('is deterministic, keyed, and non-reversible', () => {
    const a = hashIp('secret', '203.0.113.7');
    const b = hashIp('secret', '203.0.113.7');
    const c = hashIp('other-secret', '203.0.113.7');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('203.0.113');
    expect(hashIp('secret', null)).toBeNull();
  });
});

describe('idempotency keys', () => {
  it('produces one stable key per on-chain movement', () => {
    const key = chainEventKey({ network: 'tron', env: 'mainnet', txHash: 'abc', logIndex: 0 });
    expect(key).toBe(
      chainEventKey({ network: 'tron', env: 'mainnet', txHash: 'abc', logIndex: 0 }),
    );
    // A different log index in the same transaction is a DIFFERENT movement.
    expect(key).not.toBe(
      chainEventKey({ network: 'tron', env: 'mainnet', txHash: 'abc', logIndex: 1 }),
    );
    // The same hash on another network is also different.
    expect(key).not.toBe(
      chainEventKey({ network: 'ton', env: 'mainnet', txHash: 'abc', logIndex: 0 }),
    );
  });

  it('escapes separators so segments cannot collide', () => {
    const a = chainEventKey({ network: 'tron', env: 'mainnet', txHash: 'a:b', logIndex: 1 });
    const b = chainEventKey({ network: 'tron', env: 'mainnet', txHash: 'a', logIndex: 1 });
    expect(a).not.toBe(b);
  });

  it('separates notification types for the same subject', () => {
    expect(notificationKey({ type: 'crypto_received', subjectId: 'x' })).not.toBe(
      notificationKey({ type: 'crypto_sent', subjectId: 'x' }),
    );
  });

  it('distinguishes native assets from tokens', () => {
    const native = assetKey({
      network: 'tron',
      env: 'mainnet',
      contractAddress: null,
      symbol: 'TRX',
    });
    const token = assetKey({
      network: 'tron',
      env: 'mainnet',
      contractAddress: 'TR7',
      symbol: 'USDT',
    });
    expect(native).not.toBe(token);
  });

  it('does not lower-case addresses when normalising', () => {
    // Base58 and base64url addresses are case-sensitive: folding case would merge two
    // distinct accounts.
    expect(normaliseAddress('  TAbC  ')).toBe('TAbC');
  });

  it('changes the quote fingerprint when any field changes', () => {
    const base = { walletId: 'w', amount: '100', to: 'T1' };
    const a = quoteFingerprint(base);
    expect(a).toBe(quoteFingerprint({ ...base }));
    expect(a).not.toBe(quoteFingerprint({ ...base, amount: '101' }));
    expect(a).not.toBe(quoteFingerprint({ ...base, to: 'T2' }));
  });
});

describe('signer request authentication', () => {
  const secret = 'signer-secret';

  function sign(body: string, timestamp: string, nonce: string, path = '/sign'): string {
    return createHmac('sha256', secret)
      .update(canonicalRequest({ method: 'POST', path, timestamp, nonce, body }))
      .digest('hex');
  }

  it('accepts a correctly signed request', () => {
    const cache = new NonceCache();
    const timestamp = String(Date.now());
    const body = '{"a":1}';
    const nonce = 'nonce-0001';

    expect(() =>
      verifySignedRequest({
        secret,
        method: 'POST',
        path: '/sign',
        body,
        timestamp,
        nonce,
        signature: sign(body, timestamp, nonce),
        nonceCache: cache,
      }),
    ).not.toThrow();
  });

  it('rejects a replayed request', () => {
    const cache = new NonceCache();
    const timestamp = String(Date.now());
    const body = '{"a":1}';
    const nonce = 'nonce-0002';
    const signature = sign(body, timestamp, nonce);
    const params = {
      secret,
      method: 'POST',
      path: '/sign',
      body,
      timestamp,
      nonce,
      signature,
      nonceCache: cache,
    };

    verifySignedRequest(params);
    expect(() => verifySignedRequest(params)).toThrow(PolicyError);
  });

  it('rejects a tampered body', () => {
    const cache = new NonceCache();
    const timestamp = String(Date.now());
    const nonce = 'nonce-0003';
    const signature = sign('{"amount":1}', timestamp, nonce);

    expect(() =>
      verifySignedRequest({
        secret,
        method: 'POST',
        path: '/sign',
        body: '{"amount":1000000}',
        timestamp,
        nonce,
        signature,
        nonceCache: cache,
      }),
    ).toThrow(PolicyError);
  });

  it('rejects a signature reused against a different path', () => {
    const cache = new NonceCache();
    const timestamp = String(Date.now());
    const nonce = 'nonce-0004';
    const body = '{}';

    expect(() =>
      verifySignedRequest({
        secret,
        method: 'POST',
        path: '/sign',
        body,
        timestamp,
        nonce,
        signature: sign(body, timestamp, nonce, '/health'),
        nonceCache: cache,
      }),
    ).toThrow(PolicyError);
  });

  it('rejects a stale timestamp', () => {
    const cache = new NonceCache();
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const nonce = 'nonce-0005';
    const body = '{}';

    expect(() =>
      verifySignedRequest({
        secret,
        method: 'POST',
        path: '/sign',
        body,
        timestamp,
        nonce,
        signature: sign(body, timestamp, nonce),
        nonceCache: cache,
      }),
    ).toThrow(PolicyError);
  });

  it('refuses everything when no secret is configured', () => {
    expect(() =>
      verifySignedRequest({
        secret: '',
        method: 'POST',
        path: '/sign',
        body: '{}',
        timestamp: String(Date.now()),
        nonce: 'nonce-0006',
        signature: 'a'.repeat(64),
        nonceCache: new NonceCache(),
      }),
    ).toThrow(PolicyError);
  });
});

describe('signer spend policy', () => {
  const config = {
    maxPerTxMinor: 25_000n,
    maxPerDayMinor: 100_000n,
    allowedRecipients: [],
    allowedNetworks: ['tron' as const],
    env: 'testnet' as const,
  };

  it('accepts a transfer inside the limits', () => {
    const tracker = new SpendTracker();
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'testnet', to: 'T1', valueUsdMinor: 10_000n },
        config,
        tracker,
      ),
    ).not.toThrow();
  });

  it('rejects an amount over the per-transaction cap', () => {
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'testnet', to: 'T1', valueUsdMinor: 30_000n },
        config,
        new SpendTracker(),
      ),
    ).toThrow(PolicyError);
  });

  it('rejects once the rolling daily total would be exceeded', () => {
    const tracker = new SpendTracker();
    tracker.record(95_000n);
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'testnet', to: 'T1', valueUsdMinor: 10_000n },
        config,
        tracker,
      ),
    ).toThrow(PolicyError);
  });

  it('refuses an unvalued transfer, since the caps cannot be applied', () => {
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'testnet', to: 'T1', valueUsdMinor: null },
        config,
        new SpendTracker(),
      ),
    ).toThrow(PolicyError);
  });

  it('refuses a network the signer is not provisioned for', () => {
    expect(() =>
      enforceSpendPolicy(
        { network: 'ton', env: 'testnet', to: 'T1', valueUsdMinor: 100n },
        config,
        new SpendTracker(),
      ),
    ).toThrow(PolicyError);
  });

  it('refuses a mainnet request on a testnet signer', () => {
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'mainnet', to: 'T1', valueUsdMinor: 100n },
        config,
        new SpendTracker(),
      ),
    ).toThrow(PolicyError);
  });

  it('honours a recipient allow-list when configured', () => {
    const restricted = { ...config, allowedRecipients: ['TGOOD'] };
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'testnet', to: 'TBAD', valueUsdMinor: 100n },
        restricted,
        new SpendTracker(),
      ),
    ).toThrow(PolicyError);
    expect(() =>
      enforceSpendPolicy(
        { network: 'tron', env: 'testnet', to: 'TGOOD', valueUsdMinor: 100n },
        restricted,
        new SpendTracker(),
      ),
    ).not.toThrow();
  });
});
