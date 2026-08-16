import { ProviderRegistry } from '@wallet/blockchain';
import {
  BinanceProvider,
  CoinGeckoProvider,
  CurrencyService,
  ErApiProvider,
  FrankfurterProvider,
  type FxProvider,
  type PriceProvider,
  type RateStore,
  type StoredPrice,
  type StoredRate,
} from '@wallet/currency';
import { createDatabase, opsRepo, withSystem, type Sql } from '@wallet/db';
import { TelegramClient } from '@wallet/telegram';
import type { FiatCurrency } from '@wallet/shared';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createSigner, type Signer } from './signer/index.js';

/**
 * The composition root.
 *
 * Every dependency is constructed once here and passed explicitly. There is no service
 * locator and no module-level mutable state, so a test can build a context with a mock
 * provider and a throwaway database without touching globals.
 */
export interface AppContext {
  config: ServerConfig;
  logger: Logger;
  sql: Sql;
  providers: ProviderRegistry;
  currency: CurrencyService;
  telegram: TelegramClient | null;
  signer: Signer;
}

/** Database-backed implementation of the currency package's persistence seam. */
class DbRateStore implements RateStore {
  constructor(private readonly sql: Sql) {}

  async loadLatestFx(base: FiatCurrency, quote: FiatCurrency): Promise<StoredRate | null> {
    const row = await withSystem(this.sql, (tx) => opsRepo.latestExchangeRate(tx, base, quote));
    if (!row) return null;
    return {
      base: row.base,
      quote: row.quote,
      rate: row.rate,
      source: row.source,
      isManual: row.is_manual,
      fetchedAt: row.fetched_at,
    };
  }

  async saveFx(rate: StoredRate): Promise<void> {
    await withSystem(this.sql, (tx) =>
      opsRepo.insertExchangeRate(tx, {
        base: rate.base,
        quote: rate.quote,
        rate: rate.rate,
        source: rate.source,
        isManual: rate.isManual,
      }),
    );
  }

  async loadLatestPrices(assetIds: string[]): Promise<Map<string, StoredPrice>> {
    if (assetIds.length === 0) return new Map();
    const rows = await withSystem(this.sql, (tx) => opsRepo.latestAssetPrices(tx, assetIds));
    return new Map(
      rows.map((row) => [
        row.asset_id,
        {
          assetId: row.asset_id,
          symbol: row.symbol,
          quote: row.quote,
          price: row.price,
          source: row.source,
          fetchedAt: row.fetched_at,
        },
      ]),
    );
  }

  async savePrice(price: StoredPrice): Promise<void> {
    await withSystem(this.sql, (tx) =>
      opsRepo.insertAssetPrice(tx, {
        assetId: price.assetId,
        quote: price.quote,
        price: price.price,
        source: price.source,
      }),
    );
  }
}

function buildFxProviders(config: ServerConfig): FxProvider[] {
  const options = {
    timeoutMs: config.chain.timeoutMs,
    maxResponseBytes: config.chain.maxResponseBytes,
  };
  return config.market.fxProviders.map((name) =>
    name === 'frankfurter'
      ? new FrankfurterProvider(config.market.frankfurterUrl, options)
      : new ErApiProvider(config.market.erapiUrl, options),
  );
}

function buildPriceProviders(config: ServerConfig): PriceProvider[] {
  const options = {
    timeoutMs: config.chain.timeoutMs,
    maxResponseBytes: config.chain.maxResponseBytes,
  };
  return config.market.priceProviders.map((name) =>
    name === 'coingecko'
      ? new CoinGeckoProvider(config.market.coingeckoUrl, {
          ...options,
          apiKey: config.market.coingeckoApiKey,
        })
      : new BinanceProvider(config.market.binanceUrl, options),
  );
}

export interface CreateContextOptions {
  service: string;
  config?: ServerConfig;
  env?: NodeJS.ProcessEnv;
  /** Reuse an existing pool (tests). */
  sql?: Sql;
}

export function createAppContext(options: CreateContextOptions): AppContext {
  const config = options.config ?? loadServerConfig(options.env);
  const logger = createLogger(config, options.service);

  const sql =
    options.sql ??
    createDatabase({
      url: config.database.url,
      ssl: config.database.ssl,
      maxConnections: config.database.poolMax,
      statementTimeoutMs: config.database.statementTimeoutMs,
      idleTimeoutSeconds: 30,
      connectTimeoutSeconds: 10,
      applicationName: `wallet-${options.service}`,
    });

  // Mock chain data whenever explicitly requested, and automatically outside production —
  // a developer with no API keys gets deterministic data instead of provider errors.
  const useMock =
    config.chain.mock ||
    (!config.isProduction && !config.chain.tron.apiKey && !config.chain.ton.apiKey);

  const providers = new ProviderRegistry({
    env: config.chain.env,
    mock: useMock,
    timeoutMs: config.chain.timeoutMs,
    maxResponseBytes: config.chain.maxResponseBytes,
    tron: {
      apiUrl: config.chain.tron.apiUrl,
      apiKey: config.chain.tron.apiKey,
      confirmations: config.chain.tron.confirmations,
    },
    ton: {
      apiUrl: config.chain.ton.apiUrl,
      tonApiUrl: config.chain.ton.tonApiUrl,
      apiKey: config.chain.ton.apiKey,
      tonApiKey: config.chain.ton.tonApiKey,
      confirmations: config.chain.ton.confirmations,
    },
    evm: config.chain.evm,
  });

  const currency = new CurrencyService({
    store: new DbRateStore(sql),
    fxProviders: buildFxProviders(config),
    priceProviders: buildPriceProviders(config),
    fxPolicy: {
      refreshSeconds: config.market.fxRefreshSeconds,
      maxStalenessSeconds: config.market.fxMaxStalenessSeconds,
      bounds: { 'USD/ILS': config.market.usdIlsBounds },
    },
    pricePolicy: {
      refreshSeconds: config.market.priceRefreshSeconds,
      maxStalenessSeconds: config.market.priceMaxStalenessSeconds,
    },
  });

  const telegram = config.telegram.botToken
    ? new TelegramClient(config.telegram.botToken, { timeoutMs: 10_000 })
    : null;

  if (!telegram) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set; notifications will be queued but not delivered');
  }
  if (useMock) {
    logger.warn('Blockchain providers are running in MOCK mode; no real chain data is used');
  }

  return {
    config,
    logger,
    sql,
    providers,
    currency,
    telegram,
    signer: createSigner(config, logger),
  };
}

export async function closeAppContext(context: AppContext): Promise<void> {
  await context.sql.end({ timeout: 5 });
}
