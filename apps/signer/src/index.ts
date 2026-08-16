import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { Keystore } from './keystore.js';
import {
  NonceCache,
  PolicyError,
  SpendTracker,
  enforceSpendPolicy,
  verifySignedRequest,
  type SpendPolicyConfig,
} from './policy.js';
import { SigningError, signTransaction, wipe } from './sign.js';
import { generateEvmKey } from './evm.js';

/**
 * The signing service.
 *
 * A separate process, on a private network, holding the only copy of the key material. It
 * exists so that a compromise of the web app, the bot, the worker, or the database still
 * cannot move funds — an attacker would additionally need code execution on this host.
 *
 * It is **inert by default**: with no `SIGNER_MASTER_KEY` and an empty keystore it starts,
 * answers health checks, and refuses every signing request.
 *
 * Deployment rules (enforced below):
 *   * binds to 127.0.0.1 unless `SIGNER_BIND` is set deliberately;
 *   * refuses to start bound to 0.0.0.0 without `SIGNER_ALLOW_PUBLIC_BIND=true`;
 *   * every request must carry a valid HMAC signature, timestamp and nonce.
 */

const MAX_BODY_BYTES = 64 * 1024;

const env = process.env;

const config = {
  port: Number.parseInt(env.SIGNER_PORT ?? '8090', 10),
  bind: env.SIGNER_BIND ?? '127.0.0.1',
  allowPublicBind: env.SIGNER_ALLOW_PUBLIC_BIND === 'true',
  hmacSecret: env.SIGNER_HMAC_SECRET ?? '',
  masterKey: env.SIGNER_MASTER_KEY ?? '',
  keystorePath: env.SIGNER_KEYSTORE_PATH ?? './.signer/keystore.json',
  enabled: env.SIGNER_ENABLED === 'true',
};

const policy: SpendPolicyConfig = {
  maxPerTxMinor: BigInt(Number.parseInt(env.SIGNER_MAX_USD_PER_TX ?? '250', 10)) * 100n,
  maxPerDayMinor: BigInt(Number.parseInt(env.SIGNER_MAX_USD_PER_DAY ?? '1000', 10)) * 100n,
  allowedRecipients: (env.SIGNER_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  allowedNetworks: (env.SIGNER_ALLOWED_NETWORKS ?? 'tron')
    .split(',')
    .map((entry) => entry.trim())
    .filter(
      (entry): entry is 'tron' | 'ton' | 'bsc' =>
        entry === 'tron' || entry === 'ton' || entry === 'bsc',
    ),
  env: env.SIGNER_CHAIN_ENV === 'mainnet' ? 'mainnet' : 'testnet',
};

const keystore = new Keystore(config.keystorePath, config.masterKey);
const nonceCache = new NonceCache();
const spendTracker = new SpendTracker();

/* ------------------------------------------------------------------ schema -- */

/**
 * Address generation.
 *
 * The signer creates the keypair, encrypts and stores the private key, and returns **only**
 * the address. The private key never crosses this boundary — not in the response, not in a
 * log line, not in an error. That is the whole reason generation happens here rather than in
 * the API tier.
 */
const generateRequestSchema = z.object({
  network: z.enum(['bsc']),
  env: z.enum(['mainnet', 'testnet']),
  label: z.string().max(60).optional(),
  idempotencyKey: z.string().min(8).max(128),
});

const signRequestSchema = z.object({
  sendRequestId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  valueUsdMinor: z.string().regex(/^\d+$/).nullable(),
  unsigned: z.object({
    network: z.enum(['tron', 'ton']),
    env: z.enum(['mainnet', 'testnet']),
    from: z.string().min(20).max(120),
    to: z.string().min(20).max(120),
    rawAmount: z.string().regex(/^\d+$/),
    assetContract: z.string().max(120).nullable(),
    memo: z.string().max(120).nullable(),
    payload: z.record(z.string(), z.unknown()),
    digest: z.string().regex(/^[0-9a-f]{64}$/i),
    expiresAt: z.string(),
  }),
});

/* ------------------------------------------------------------------ server -- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new PolicyError('PAYLOAD_TOO_LARGE', 'request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

/** Structured log with no key material and no request bodies. */
function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: 'signer',
    msg: message,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else console.warn(line);
}

async function handleSign(body: string): Promise<Record<string, unknown>> {
  if (!config.enabled) {
    throw new PolicyError('SIGNER_DISABLED', 'signing is disabled on this instance');
  }
  if (!config.masterKey) {
    throw new PolicyError('SIGNER_MISCONFIGURED', 'no master key configured', 500);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    throw new PolicyError('BAD_REQUEST', 'body is not valid JSON', 400);
  }

  const parsed = signRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new PolicyError('BAD_REQUEST', 'request failed validation', 400);
  }
  const request = parsed.data;
  const unsigned = request.unsigned;

  // A quote that has expired must not be signed, however it got here.
  if (
    Number.isFinite(Date.parse(unsigned.expiresAt)) &&
    Date.parse(unsigned.expiresAt) < Date.now()
  ) {
    throw new PolicyError('EXPIRED', 'unsigned transaction has expired', 409);
  }

  // Idempotency: a repeat of a key we have already signed is refused rather than re-signed.
  const previous = spendTracker.previousResult(request.idempotencyKey);
  if (previous) {
    throw new PolicyError(
      'ALREADY_SIGNED',
      'this idempotency key has already been signed by this instance',
      409,
    );
  }

  const valueUsdMinor = request.valueUsdMinor === null ? null : BigInt(request.valueUsdMinor);

  // Policy runs BEFORE any key is decrypted.
  enforceSpendPolicy(
    { network: unsigned.network, env: unsigned.env, to: unsigned.to, valueUsdMinor },
    policy,
    spendTracker,
  );

  const key = keystore.find({
    address: unsigned.from,
    network: unsigned.network,
    env: unsigned.env,
  });
  if (!key) {
    throw new PolicyError('KEY_NOT_FOUND', 'no key is provisioned for this address', 404);
  }

  try {
    const signed = signTransaction(
      {
        network: unsigned.network,
        env: unsigned.env,
        from: unsigned.from,
        to: unsigned.to,
        rawAmount: unsigned.rawAmount,
        assetContract: unsigned.assetContract,
        memo: unsigned.memo,
        payload: unsigned.payload,
        digest: unsigned.digest,
      },
      key,
    );

    if (valueUsdMinor !== null) spendTracker.record(valueUsdMinor);
    spendTracker.rememberResult(request.idempotencyKey, signed.digest);

    log('info', 'transaction signed', {
      sendRequestId: request.sendRequestId,
      network: unsigned.network,
      env: unsigned.env,
      // Addresses are public; amounts and keys are not logged.
      from: unsigned.from,
    });

    return {
      ok: true,
      signerRef: `signer:${signed.digest.slice(0, 16)}`,
      digest: signed.digest,
      payload: signed.payload,
    };
  } finally {
    wipe(key.privateKey);
  }
}

async function handleGenerate(body: string): Promise<Record<string, unknown>> {
  if (!config.enabled) {
    throw new PolicyError('SIGNER_DISABLED', 'key generation is disabled on this instance');
  }
  if (!config.masterKey) {
    throw new PolicyError('SIGNER_MISCONFIGURED', 'no master key configured', 500);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    throw new PolicyError('BAD_REQUEST', 'body is not valid JSON', 400);
  }

  const parsed = generateRequestSchema.safeParse(parsedJson);
  if (!parsed.success) throw new PolicyError('BAD_REQUEST', 'request failed validation', 400);
  const request = parsed.data;

  if (!policy.allowedNetworks.includes(request.network)) {
    throw new PolicyError('NETWORK_NOT_ALLOWED', `network ${request.network} is not permitted`);
  }
  if (request.env !== policy.env) {
    throw new PolicyError('ENV_MISMATCH', `signer is configured for ${policy.env}`);
  }

  // Generating twice for the same intent would strand a funded address nobody knows about.
  const previous = spendTracker.previousResult(`gen:${request.idempotencyKey}`);
  if (previous) {
    return { ok: true, address: previous, created: false };
  }

  const generated = generateEvmKey();
  try {
    await keystore.add({
      address: generated.address,
      network: request.network,
      env: request.env,
      privateKey: generated.privateKey,
      ...(request.label ? { label: request.label } : {}),
    });
  } finally {
    // Wipe before anything else can touch it. Best effort — V8 may retain copies — but the
    // window is a single synchronous block.
    wipe(generated.privateKey);
  }

  spendTracker.rememberResult(`gen:${request.idempotencyKey}`, generated.address);

  // The address is public. The key is not mentioned, and cannot be.
  log('info', 'generated an address', {
    network: request.network,
    env: request.env,
    address: generated.address,
  });

  return { ok: true, address: generated.address, created: true };
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  void (async () => {
    try {
      if (method === 'GET' && (url === '/health' || url === '/healthz')) {
        // Unauthenticated, and deliberately says nothing about what keys exist.
        respond(res, 200, {
          ok: true,
          service: 'signer',
          enabled: config.enabled,
          configured: Boolean(config.masterKey && config.hmacSecret),
          env: policy.env,
        });
        return;
      }

      if (method !== 'POST') {
        respond(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
        return;
      }

      const body = await readBody(req);

      verifySignedRequest({
        secret: config.hmacSecret,
        method,
        path: url,
        body,
        timestamp: headerValue(req, 'x-signer-timestamp'),
        nonce: headerValue(req, 'x-signer-nonce'),
        signature: headerValue(req, 'x-signer-signature'),
        nonceCache,
      });

      if (url === '/health') {
        respond(res, 200, {
          ok: true,
          keys: keystore.size,
          spentMinor: spendTracker.spentMinor().toString(),
        });
        return;
      }

      if (url === '/sign') {
        const result = await handleSign(body);
        respond(res, 200, result);
        return;
      }

      if (url === '/generate') {
        const result = await handleGenerate(body);
        respond(res, 200, result);
        return;
      }

      respond(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof PolicyError) {
        log('warn', 'request refused', { code: error.code, path: url });
        respond(res, error.status, { ok: false, error: error.code });
        return;
      }
      if (error instanceof SigningError) {
        log('warn', 'signing refused', { code: error.code });
        respond(res, 422, { ok: false, error: error.code });
        return;
      }
      log('error', 'unhandled signer error', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      respond(res, 500, { ok: false, error: 'INTERNAL_ERROR' });
    }
  })();
});

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/* ---------------------------------------------------------------- start-up -- */

async function main(): Promise<void> {
  if (config.bind === '0.0.0.0' && !config.allowPublicBind) {
    // The signer on a public interface is the single worst misconfiguration possible here.
    throw new Error(
      'Refusing to bind the signer to 0.0.0.0. Use a private network, or set ' +
        'SIGNER_ALLOW_PUBLIC_BIND=true if you genuinely intend this.',
    );
  }

  await keystore.load();

  if (config.enabled && (!config.masterKey || !config.hmacSecret)) {
    throw new Error('SIGNER_ENABLED=true requires SIGNER_MASTER_KEY and SIGNER_HMAC_SECRET');
  }

  server.listen(config.port, config.bind, () => {
    log('info', 'signer listening', {
      bind: config.bind,
      port: config.port,
      enabled: config.enabled,
      keys: keystore.size,
      env: policy.env,
      networks: policy.allowedNetworks,
    });
    if (!config.enabled) {
      log('warn', 'signer is DISABLED — every signing request will be refused');
    }
  });
}

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

main().catch((error: unknown) => {
  log('error', 'signer failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
