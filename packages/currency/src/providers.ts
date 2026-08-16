import { z } from 'zod';
import { AppError, AssetPrice, ExchangeRate, type FiatCurrency } from '@wallet/shared';
import { HttpClient, hostOf } from '@wallet/blockchain';
import type { FxProvider, PriceProvider } from './types.js';

/**
 * Market-data providers.
 *
 * All of them reuse the hardened HTTP client from `@wallet/blockchain`: host allow-list, no
 * redirects, response size cap, timeout, Zod validation. A currency API is exactly as
 * untrusted as a blockchain indexer.
 *
 * The two FX defaults (Frankfurter, open.er-api.com) need no API key, so a fresh
 * deployment has working currency conversion with zero configuration.
 */

const DECIMAL = /^\d+(\.\d+)?$/;

function decimalFromNumber(value: number, label: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('EXCHANGE_RATE_UNAVAILABLE', { internal: `${label}: non-finite rate` });
  }
  // Providers return JSON numbers; convert once, at the edge, with fixed precision, and
  // everything downstream stays exact.
  const text = value.toFixed(10);
  if (!DECIMAL.test(text)) {
    throw new AppError('EXCHANGE_RATE_UNAVAILABLE', { internal: `${label}: unparsable rate` });
  }
  return text;
}

function client(url: string, timeoutMs: number, maxResponseBytes: number): HttpClient {
  const host = hostOf(url);
  if (!host) throw new AppError('INTERNAL_ERROR', { internal: `invalid market-data URL: ${url}` });
  return new HttpClient({
    allowedHosts: [host],
    timeoutMs,
    maxResponseBytes,
    userAgent: 'wallet-bot/1.0 (+market-data)',
  });
}

/* -------------------------------------------------------------------- FX -- */

const frankfurterSchema = z.object({
  base: z.string().length(3).optional(),
  date: z.string().max(20).optional(),
  rates: z.record(z.string(), z.number()),
});

/** Frankfurter — ECB reference rates, keyless, well maintained. */
export class FrankfurterProvider implements FxProvider {
  readonly name = 'frankfurter';
  private readonly http: HttpClient;

  constructor(
    private readonly baseUrl: string,
    options: { timeoutMs: number; maxResponseBytes: number },
  ) {
    this.http = client(baseUrl, options.timeoutMs, options.maxResponseBytes);
  }

  async fetchRate(base: FiatCurrency, quote: FiatCurrency): Promise<ExchangeRate> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/latest`);
    url.searchParams.set('base', base);
    url.searchParams.set('symbols', quote);

    const response = await this.http.requestJson(url.toString(), frankfurterSchema);
    const value = response.rates[quote];
    if (value === undefined) {
      throw new AppError('EXCHANGE_RATE_UNAVAILABLE', {
        internal: `frankfurter did not return ${base}/${quote}`,
      });
    }

    return ExchangeRate.fromDecimalString({
      base,
      quote,
      value: decimalFromNumber(value, 'frankfurter'),
      asOf: new Date(),
      source: this.name,
    });
  }
}

const erApiSchema = z.object({
  result: z.string().max(20).optional(),
  base_code: z.string().length(3).optional(),
  time_last_update_unix: z.number().optional(),
  rates: z.record(z.string(), z.number()),
});

/** open.er-api.com — keyless fallback with a different upstream than Frankfurter. */
export class ErApiProvider implements FxProvider {
  readonly name = 'erapi';
  private readonly http: HttpClient;

  constructor(
    private readonly baseUrl: string,
    options: { timeoutMs: number; maxResponseBytes: number },
  ) {
    this.http = client(baseUrl, options.timeoutMs, options.maxResponseBytes);
  }

  async fetchRate(base: FiatCurrency, quote: FiatCurrency): Promise<ExchangeRate> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/latest/${encodeURIComponent(base)}`;
    const response = await this.http.requestJson(url, erApiSchema);
    if (response.result && response.result !== 'success') {
      throw new AppError('EXCHANGE_RATE_UNAVAILABLE', { internal: 'er-api reported failure' });
    }

    const value = response.rates[quote];
    if (value === undefined) {
      throw new AppError('EXCHANGE_RATE_UNAVAILABLE', {
        internal: `er-api did not return ${base}/${quote}`,
      });
    }

    return ExchangeRate.fromDecimalString({
      base,
      quote,
      value: decimalFromNumber(value, 'er-api'),
      asOf: response.time_last_update_unix
        ? new Date(response.time_last_update_unix * 1000)
        : new Date(),
      source: this.name,
    });
  }
}

/* ---------------------------------------------------------------- prices -- */

const coingeckoSchema = z.record(z.string(), z.object({ usd: z.number().optional() }));

/** CoinGecko simple-price endpoint. Keyless tier is sufficient for a handful of assets. */
export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';
  private readonly http: HttpClient;

  constructor(
    private readonly baseUrl: string,
    private readonly options: { timeoutMs: number; maxResponseBytes: number; apiKey?: string },
  ) {
    this.http = client(baseUrl, options.timeoutMs, options.maxResponseBytes);
  }

  async fetchPrices(ids: string[]): Promise<Map<string, AssetPrice>> {
    const result = new Map<string, AssetPrice>();
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return result;

    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/simple/price`);
    url.searchParams.set('ids', unique.join(','));
    url.searchParams.set('vs_currencies', 'usd');

    const response = await this.http.requestJson(url.toString(), coingeckoSchema, {
      headers: this.options.apiKey ? { 'x-cg-demo-api-key': this.options.apiKey } : {},
    });

    const asOf = new Date();
    for (const id of unique) {
      const usd = response[id]?.usd;
      if (usd === undefined) continue; // Absent, not zero.
      result.set(
        id,
        AssetPrice.fromDecimalString({
          assetKey: id,
          symbol: id,
          quote: 'USD',
          value: decimalFromNumber(usd, 'coingecko'),
          asOf,
          source: this.name,
        }),
      );
    }
    return result;
  }
}

const binanceSchema = z.array(z.object({ symbol: z.string().max(30), price: z.string().max(40) }));

/**
 * Binance public ticker, used as a price fallback.
 *
 * It keys on trading pairs rather than CoinGecko ids, so the mapping below translates the
 * ids we store on assets. Anything not in the map is simply not priced by this provider.
 */
const BINANCE_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  tether: 'USDCUSDT', // USDT/USD is ~1; USDC/USDT is the closest liquid proxy.
  tron: 'TRXUSDT',
  'the-open-network': 'TONUSDT',
  'usd-coin': 'USDCUSDT',
});

export class BinanceProvider implements PriceProvider {
  readonly name = 'binance';
  private readonly http: HttpClient;

  constructor(
    private readonly baseUrl: string,
    options: { timeoutMs: number; maxResponseBytes: number },
  ) {
    this.http = client(baseUrl, options.timeoutMs, options.maxResponseBytes);
  }

  async fetchPrices(ids: string[]): Promise<Map<string, AssetPrice>> {
    const result = new Map<string, AssetPrice>();
    const wanted = ids.filter((id) => BINANCE_SYMBOLS[id]);
    if (wanted.length === 0) return result;

    const symbols = wanted.map((id) => BINANCE_SYMBOLS[id] as string);
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/api/v3/ticker/price`);
    url.searchParams.set('symbols', JSON.stringify([...new Set(symbols)]));

    const response = await this.http.requestJson(url.toString(), binanceSchema);
    const bySymbol = new Map(response.map((entry) => [entry.symbol, entry.price]));
    const asOf = new Date();

    for (const id of wanted) {
      // A stablecoin quoted against USDT is ~1 by construction; we still record the number
      // the market gives us rather than hard-coding 1.00.
      const price = id === 'tether' ? '1.0' : bySymbol.get(BINANCE_SYMBOLS[id] as string);
      if (!price || !DECIMAL.test(price)) continue;
      result.set(
        id,
        AssetPrice.fromDecimalString({
          assetKey: id,
          symbol: id,
          quote: 'USD',
          value: price,
          asOf,
          source: this.name,
        }),
      );
    }
    return result;
  }
}
