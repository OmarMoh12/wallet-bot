import { z } from 'zod';

/**
 * Server configuration.
 *
 * One schema, parsed once at process start, for every server-side deployable (web API, bot,
 * worker). Two properties are load-bearing:
 *
 *  1. **Fail fast.** A missing `SESSION_SECRET` in production stops the process at boot
 *     instead of producing unverifiable sessions at runtime.
 *  2. **Nothing here is public.** No value in this module may be referenced from a client
 *     component. `apps/web/src/env.ts` re-exports only the handful of genuinely public
 *     values, and `scripts/check-env-leaks.mjs` greps the built bundle for the rest.
 *
 * Safety defaults are chosen so a misconfigured deployment is *inert*, not dangerous:
 * sending disabled, signer in mock mode, chain env = testnet.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().catch(fallback).default(fallback);

const base64Key = z
  .string()
  .min(32)
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length >= 32;
      } catch {
        return false;
      }
    },
    { message: 'must be at least 32 bytes of base64' },
  );

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

export const serverConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    CORS_ALLOWED_ORIGINS: csv,
    // `silent` is a real pino level and a legitimate operational choice (tests, and
    // environments where logs are captured elsewhere).
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanish.default(false),

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: booleanish.default(false),
    DATABASE_POOL_MAX: positiveInt(10),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInt(8000),

    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_BOT_USERNAME: z.string().default(''),
    TELEGRAM_WEBAPP_URL: z.string().url().default('http://localhost:3000'),
    TELEGRAM_MINIAPP_SHORT_NAME: z.string().default(''),
    TELEGRAM_ADMIN_IDS: csv,
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_URL: z.string().default(''),
    TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
    TELEGRAM_INITDATA_MAX_AGE_SECONDS: positiveInt(900),

    SESSION_SECRET: z.string().default(''),
    SESSION_TTL_SECONDS: positiveInt(3600),
    ENCRYPTION_KEY: z.string().default(''),
    ENCRYPTION_KEY_ID: z.string().default('v1'),
    PIN_PEPPER: z.string().default(''),

    CHAIN_ENV: z.enum(['mainnet', 'testnet']).default('testnet'),
    BLOCKCHAIN_MOCK: booleanish.default(true),
    TRONGRID_API_KEY: z.string().optional(),
    TRON_MAINNET_API_URL: z.string().url().default('https://api.trongrid.io'),
    TRON_TESTNET_API_URL: z.string().url().default('https://api.shasta.trongrid.io'),
    TRON_CONFIRMATIONS: positiveInt(19),
    TONCENTER_API_KEY: z.string().optional(),
    TONAPI_KEY: z.string().optional(),
    TON_MAINNET_API_URL: z.string().url().default('https://toncenter.com/api/v2'),
    TON_TESTNET_API_URL: z.string().url().default('https://testnet.toncenter.com/api/v2'),
    TON_MAINNET_TONAPI_URL: z.string().url().default('https://tonapi.io'),
    TON_TESTNET_TONAPI_URL: z.string().url().default('https://testnet.tonapi.io'),
    TON_CONFIRMATIONS: positiveInt(1),

    // --- EVM ---------------------------------------------------------------
    // Optional. Each chain has a working public default in EVM_CHAINS, so a fresh
    // deployment needs none of these; set them to use your own node or a paid provider.
    BSC_MAINNET_RPC_URL: z.string().default(''),
    BSC_TESTNET_RPC_URL: z.string().default(''),
    BSC_CONFIRMATIONS: z.coerce.number().int().min(1).max(200).optional(),
    HTTP_TIMEOUT_MS: positiveInt(8000),
    HTTP_MAX_RESPONSE_BYTES: positiveInt(2_097_152),

    FX_PRIMARY_PROVIDER: z.enum(['frankfurter', 'erapi']).default('frankfurter'),
    FX_FALLBACK_PROVIDER: z.enum(['frankfurter', 'erapi', 'none']).default('erapi'),
    FRANKFURTER_API_URL: z.string().url().default('https://api.frankfurter.dev/v1'),
    ERAPI_URL: z.string().url().default('https://open.er-api.com/v6'),
    CRYPTO_PRICE_PRIMARY_PROVIDER: z.enum(['coingecko', 'binance']).default('coingecko'),
    CRYPTO_PRICE_FALLBACK_PROVIDER: z.enum(['coingecko', 'binance', 'none']).default('binance'),
    COINGECKO_API_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
    COINGECKO_API_KEY: z.string().optional(),
    BINANCE_API_URL: z.string().url().default('https://api.binance.com'),
    FX_REFRESH_SECONDS: positiveInt(900),
    FX_MAX_STALENESS_SECONDS: positiveInt(86_400),
    PRICE_REFRESH_SECONDS: positiveInt(300),
    PRICE_MAX_STALENESS_SECONDS: positiveInt(3600),
    FX_USD_ILS_MIN: z.string().default('2.0'),
    FX_USD_ILS_MAX: z.string().default('6.0'),

    WORKER_CONCURRENCY: positiveInt(4),
    WORKER_POLL_INTERVAL_MS: positiveInt(1000),
    WORKER_JOB_TIMEOUT_MS: positiveInt(60_000),
    WORKER_HEALTH_PORT: positiveInt(8080),
    CHAIN_SCAN_INTERVAL_SECONDS: positiveInt(60),
    REDIS_URL: z.string().default(''),

    RATE_LIMIT_ENABLED: booleanish.default(true),
    RATE_LIMIT_AUTH_PER_MINUTE: positiveInt(10),
    RATE_LIMIT_READ_PER_MINUTE: positiveInt(120),
    RATE_LIMIT_WRITE_PER_MINUTE: positiveInt(30),
    RATE_LIMIT_SEND_PER_HOUR: positiveInt(10),
    RATE_LIMIT_MAX_BODY_BYTES: positiveInt(65_536),

    SENDING_ENABLED: booleanish.default(false),
    SIGNER_MODE: z.enum(['mock', 'remote']).default('mock'),
    SIGNER_URL: z.string().default('http://127.0.0.1:8090'),
    SIGNER_HMAC_SECRET: z.string().default(''),
    SEND_MAX_USD_PER_TX: positiveInt(250),
    SEND_MAX_USD_PER_DAY: positiveInt(1000),
    SEND_REQUIRE_PIN: booleanish.default(true),
    SEND_CONFIRM_TTL_SECONDS: positiveInt(180),

    APP_VERSION: z.string().default('1.0.0'),
  })
  .passthrough();

export type RawServerConfig = z.infer<typeof serverConfigSchema>;

export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  appEnv: 'development' | 'test' | 'staging' | 'production';
  isProduction: boolean;
  /** True in development/test: forces mock signing and permits mock chain data. */
  safeMode: boolean;
  appUrl: string;
  version: string;
  corsAllowedOrigins: string[];
  log: { level: string; pretty: boolean };

  database: {
    url: string;
    ssl: boolean;
    poolMax: number;
    statementTimeoutMs: number;
  };

  telegram: {
    botToken: string;
    botUsername: string;
    webAppUrl: string;
    miniAppShortName: string | undefined;
    adminTelegramIds: bigint[];
    mode: 'polling' | 'webhook';
    webhookUrl: string;
    webhookSecret: string;
    initDataMaxAgeSeconds: number;
  };

  security: {
    sessionSecret: string;
    sessionTtlSeconds: number;
    encryptionKey: string;
    encryptionKeyId: string;
    pinPepper: string;
  };

  chain: {
    env: 'mainnet' | 'testnet';
    mock: boolean;
    timeoutMs: number;
    maxResponseBytes: number;
    tron: { apiUrl: string; apiKey: string | undefined; confirmations: number };
    ton: {
      apiUrl: string;
      tonApiUrl: string;
      apiKey: string | undefined;
      tonApiKey: string | undefined;
      confirmations: number;
    };
    /** Per-EVM-network overrides. Empty means "use the chain registry defaults". */
    evm: Partial<Record<'bsc', { rpcUrl?: string; confirmations?: number }>>;
  };

  market: {
    fxProviders: Array<'frankfurter' | 'erapi'>;
    priceProviders: Array<'coingecko' | 'binance'>;
    frankfurterUrl: string;
    erapiUrl: string;
    coingeckoUrl: string;
    coingeckoApiKey: string | undefined;
    binanceUrl: string;
    fxRefreshSeconds: number;
    fxMaxStalenessSeconds: number;
    priceRefreshSeconds: number;
    priceMaxStalenessSeconds: number;
    usdIlsBounds: { min: string; max: string };
  };

  worker: {
    concurrency: number;
    pollIntervalMs: number;
    jobTimeoutMs: number;
    healthPort: number;
    chainScanIntervalSeconds: number;
    redisUrl: string | null;
  };

  rateLimit: {
    enabled: boolean;
    authPerMinute: number;
    readPerMinute: number;
    writePerMinute: number;
    sendPerHour: number;
    maxBodyBytes: number;
  };

  sending: {
    enabled: boolean;
    signerMode: 'mock' | 'remote';
    signerUrl: string;
    signerHmacSecret: string;
    maxUsdPerTxMinor: bigint;
    maxUsdPerDayMinor: bigint;
    requirePin: boolean;
    confirmTtlSeconds: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate the environment.
 *
 * Production adds hard requirements that development can do without. The distinction is
 * exactly the set of things whose absence would make the system insecure rather than merely
 * inconvenient.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  const isProduction = raw.APP_ENV === 'production' || raw.APP_ENV === 'staging';
  const safeMode = !isProduction;

  const issues: string[] = [];

  if (isProduction) {
    if (!raw.TELEGRAM_BOT_TOKEN) issues.push('TELEGRAM_BOT_TOKEN is required in production');
    if (!raw.SESSION_SECRET) issues.push('SESSION_SECRET is required in production');
    else if (!base64Key.safeParse(raw.SESSION_SECRET).success) {
      issues.push('SESSION_SECRET must be >= 32 bytes of base64');
    }
    if (!raw.PIN_PEPPER) issues.push('PIN_PEPPER is required in production');
    if (!raw.APP_URL.startsWith('https://')) {
      issues.push('APP_URL must be https in production (Telegram requires it)');
    }
    if (raw.TELEGRAM_MODE === 'webhook' && !raw.TELEGRAM_WEBHOOK_SECRET) {
      issues.push('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook');
    }
    if (raw.BLOCKCHAIN_MOCK) {
      issues.push('BLOCKCHAIN_MOCK must be false in production');
    }
  }

  // Sending is the one area where an inconsistent configuration must not "mostly work".
  if (raw.SENDING_ENABLED) {
    if (raw.SIGNER_MODE === 'remote' && !raw.SIGNER_HMAC_SECRET) {
      issues.push('SIGNER_HMAC_SECRET is required when SENDING_ENABLED and SIGNER_MODE=remote');
    }
    if (raw.SIGNER_MODE === 'mock' && isProduction) {
      issues.push('SIGNER_MODE=mock cannot be combined with SENDING_ENABLED in production');
    }
    if (raw.SEND_REQUIRE_PIN === false && isProduction) {
      issues.push('SEND_REQUIRE_PIN cannot be disabled in production');
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const adminIds: bigint[] = [];
  for (const entry of raw.TELEGRAM_ADMIN_IDS) {
    if (/^\d{1,19}$/.test(entry)) adminIds.push(BigInt(entry));
  }

  const fxProviders: Array<'frankfurter' | 'erapi'> = [raw.FX_PRIMARY_PROVIDER];
  if (raw.FX_FALLBACK_PROVIDER !== 'none' && raw.FX_FALLBACK_PROVIDER !== raw.FX_PRIMARY_PROVIDER) {
    fxProviders.push(raw.FX_FALLBACK_PROVIDER);
  }

  const priceProviders: Array<'coingecko' | 'binance'> = [raw.CRYPTO_PRICE_PRIMARY_PROVIDER];
  if (
    raw.CRYPTO_PRICE_FALLBACK_PROVIDER !== 'none' &&
    raw.CRYPTO_PRICE_FALLBACK_PROVIDER !== raw.CRYPTO_PRICE_PRIMARY_PROVIDER
  ) {
    priceProviders.push(raw.CRYPTO_PRICE_FALLBACK_PROVIDER);
  }

  const isMainnet = raw.CHAIN_ENV === 'mainnet';
  const bscRpcUrl = (isMainnet ? raw.BSC_MAINNET_RPC_URL : raw.BSC_TESTNET_RPC_URL) || '';

  return {
    nodeEnv: raw.NODE_ENV,
    appEnv: raw.APP_ENV,
    isProduction,
    safeMode,
    appUrl: raw.APP_URL.replace(/\/+$/, ''),
    version: raw.APP_VERSION,
    corsAllowedOrigins:
      raw.CORS_ALLOWED_ORIGINS.length > 0 ? raw.CORS_ALLOWED_ORIGINS : [raw.APP_URL],
    log: { level: raw.LOG_LEVEL, pretty: raw.LOG_PRETTY },

    database: {
      url: raw.DATABASE_URL,
      ssl: raw.DATABASE_SSL,
      poolMax: raw.DATABASE_POOL_MAX,
      statementTimeoutMs: raw.DATABASE_STATEMENT_TIMEOUT_MS,
    },

    telegram: {
      botToken: raw.TELEGRAM_BOT_TOKEN,
      botUsername: raw.TELEGRAM_BOT_USERNAME.replace(/^@/, ''),
      webAppUrl: raw.TELEGRAM_WEBAPP_URL.replace(/\/+$/, ''),
      miniAppShortName: raw.TELEGRAM_MINIAPP_SHORT_NAME || undefined,
      adminTelegramIds: adminIds,
      mode: raw.TELEGRAM_MODE,
      webhookUrl: raw.TELEGRAM_WEBHOOK_URL,
      webhookSecret: raw.TELEGRAM_WEBHOOK_SECRET,
      initDataMaxAgeSeconds: raw.TELEGRAM_INITDATA_MAX_AGE_SECONDS,
    },

    security: {
      // Development gets a deterministic placeholder so `pnpm dev` works with an empty .env,
      // and production rejects it above.
      sessionSecret: raw.SESSION_SECRET || 'dev-only-insecure-session-secret-change-me-0000',
      sessionTtlSeconds: raw.SESSION_TTL_SECONDS,
      encryptionKey: raw.ENCRYPTION_KEY,
      encryptionKeyId: raw.ENCRYPTION_KEY_ID,
      pinPepper: raw.PIN_PEPPER || 'dev-only-insecure-pin-pepper',
    },

    chain: {
      env: raw.CHAIN_ENV,
      mock: raw.BLOCKCHAIN_MOCK,
      timeoutMs: raw.HTTP_TIMEOUT_MS,
      maxResponseBytes: raw.HTTP_MAX_RESPONSE_BYTES,
      tron: {
        apiUrl: isMainnet ? raw.TRON_MAINNET_API_URL : raw.TRON_TESTNET_API_URL,
        apiKey: raw.TRONGRID_API_KEY || undefined,
        confirmations: raw.TRON_CONFIRMATIONS,
      },
      ton: {
        apiUrl: isMainnet ? raw.TON_MAINNET_API_URL : raw.TON_TESTNET_API_URL,
        tonApiUrl: isMainnet ? raw.TON_MAINNET_TONAPI_URL : raw.TON_TESTNET_TONAPI_URL,
        apiKey: raw.TONCENTER_API_KEY || undefined,
        tonApiKey: raw.TONAPI_KEY || undefined,
        confirmations: raw.TON_CONFIRMATIONS,
      },
      evm: {
        bsc: {
          ...(bscRpcUrl ? { rpcUrl: bscRpcUrl } : {}),
          ...(raw.BSC_CONFIRMATIONS !== undefined ? { confirmations: raw.BSC_CONFIRMATIONS } : {}),
        },
      },
    },

    market: {
      fxProviders,
      priceProviders,
      frankfurterUrl: raw.FRANKFURTER_API_URL,
      erapiUrl: raw.ERAPI_URL,
      coingeckoUrl: raw.COINGECKO_API_URL,
      coingeckoApiKey: raw.COINGECKO_API_KEY || undefined,
      binanceUrl: raw.BINANCE_API_URL,
      fxRefreshSeconds: raw.FX_REFRESH_SECONDS,
      fxMaxStalenessSeconds: raw.FX_MAX_STALENESS_SECONDS,
      priceRefreshSeconds: raw.PRICE_REFRESH_SECONDS,
      priceMaxStalenessSeconds: raw.PRICE_MAX_STALENESS_SECONDS,
      usdIlsBounds: { min: raw.FX_USD_ILS_MIN, max: raw.FX_USD_ILS_MAX },
    },

    worker: {
      concurrency: raw.WORKER_CONCURRENCY,
      pollIntervalMs: raw.WORKER_POLL_INTERVAL_MS,
      jobTimeoutMs: raw.WORKER_JOB_TIMEOUT_MS,
      healthPort: raw.WORKER_HEALTH_PORT,
      chainScanIntervalSeconds: raw.CHAIN_SCAN_INTERVAL_SECONDS,
      redisUrl: raw.REDIS_URL || null,
    },

    rateLimit: {
      enabled: raw.RATE_LIMIT_ENABLED,
      authPerMinute: raw.RATE_LIMIT_AUTH_PER_MINUTE,
      readPerMinute: raw.RATE_LIMIT_READ_PER_MINUTE,
      writePerMinute: raw.RATE_LIMIT_WRITE_PER_MINUTE,
      sendPerHour: raw.RATE_LIMIT_SEND_PER_HOUR,
      maxBodyBytes: raw.RATE_LIMIT_MAX_BODY_BYTES,
    },

    sending: {
      // Belt and braces: sending is impossible outside production unless the signer is real.
      enabled: raw.SENDING_ENABLED,
      signerMode: raw.SIGNER_MODE,
      signerUrl: raw.SIGNER_URL,
      signerHmacSecret: raw.SIGNER_HMAC_SECRET,
      maxUsdPerTxMinor: BigInt(raw.SEND_MAX_USD_PER_TX) * 100n,
      maxUsdPerDayMinor: BigInt(raw.SEND_MAX_USD_PER_DAY) * 100n,
      requirePin: raw.SEND_REQUIRE_PIN,
      confirmTtlSeconds: raw.SEND_CONFIRM_TTL_SECONDS,
    },
  };
}

/** Values that are safe to expose to the browser. Everything else stays server-side. */
export function publicConfig(config: ServerConfig) {
  return {
    appName: 'Wallet',
    appUrl: config.appUrl,
    version: config.version,
    chainEnv: config.chain.env,
    safeMode: config.safeMode,
    sendingEnabled: config.sending.enabled,
    simulatedSending: config.sending.signerMode === 'mock',
  };
}
