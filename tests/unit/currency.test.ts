import { describe, expect, it, vi } from 'vitest';
import { AppError, ExchangeRate, FiatAmount, TokenAmount, AssetPrice } from '@wallet/shared';
import {
  CurrencyService,
  type FxProvider,
  type PriceProvider,
  type RateStore,
  type StoredPrice,
  type StoredRate,
} from '@wallet/currency';

/**
 * Currency service.
 *
 * The behaviour under test is the one the requirements call out explicitly: never silently
 * use an invalid or unknown exchange rate.
 */

class MemoryStore implements RateStore {
  rates = new Map<string, StoredRate>();
  prices = new Map<string, StoredPrice>();

  async loadLatestFx(base: 'USD' | 'ILS', quote: 'USD' | 'ILS'): Promise<StoredRate | null> {
    return this.rates.get(`${base}/${quote}`) ?? null;
  }
  async saveFx(rate: StoredRate): Promise<void> {
    this.rates.set(`${rate.base}/${rate.quote}`, rate);
  }
  async loadLatestPrices(assetIds: string[]): Promise<Map<string, StoredPrice>> {
    const output = new Map<string, StoredPrice>();
    for (const id of assetIds) {
      const found = this.prices.get(id);
      if (found) output.set(id, found);
    }
    return output;
  }
  async savePrice(price: StoredPrice): Promise<void> {
    this.prices.set(price.assetId, price);
  }
}

function fxProvider(value: string, name = 'stub'): FxProvider {
  return {
    name,
    async fetchRate(base, quote) {
      return ExchangeRate.fromDecimalString({ base, quote, value, asOf: new Date(), source: name });
    },
  };
}

function failingProvider(name = 'broken'): FxProvider {
  return {
    name,
    async fetchRate() {
      throw new Error('provider down');
    },
  };
}

function service(options: {
  store?: MemoryStore;
  fx?: FxProvider[];
  prices?: PriceProvider[];
  maxStaleness?: number;
  refresh?: number;
}) {
  const store = options.store ?? new MemoryStore();
  return {
    store,
    service: new CurrencyService({
      store,
      fxProviders: options.fx ?? [fxProvider('3.70')],
      priceProviders: options.prices ?? [],
      fxPolicy: {
        refreshSeconds: options.refresh ?? 900,
        maxStalenessSeconds: options.maxStaleness ?? 86_400,
        bounds: { 'USD/ILS': { min: '2.0', max: '6.0' } },
      },
      pricePolicy: { refreshSeconds: 300, maxStalenessSeconds: 3600 },
    }),
  };
}

describe('exchange rates', () => {
  it('fetches, validates and caches a rate', async () => {
    const { service: currency, store } = service({});
    const result = await currency.getRate('USD', 'ILS');

    expect(result.rate.toDecimalString(2)).toBe('3.70');
    expect(result.stale).toBe(false);
    expect(store.rates.get('USD/ILS')).toBeDefined();
  });

  it('rejects a rate outside the sanity band instead of storing it', async () => {
    // A provider glitch returning 0.0001 would otherwise value the whole portfolio wrongly.
    const { service: currency, store } = service({ fx: [fxProvider('0.0001')] });
    await expect(currency.getRate('USD', 'ILS')).rejects.toThrow(AppError);
    expect(store.rates.size).toBe(0);
  });

  it('rejects an absurdly high rate too', async () => {
    const { service: currency } = service({ fx: [fxProvider('9999')] });
    await expect(currency.getRate('USD', 'ILS')).rejects.toThrow(AppError);
  });

  it('falls back to the second provider when the first fails', async () => {
    const { service: currency } = service({
      fx: [failingProvider(), fxProvider('3.65', 'backup')],
    });
    const result = await currency.getRate('USD', 'ILS');
    expect(result.rate.source).toBe('backup');
  });

  it('serves a stale stored rate, clearly flagged, when every provider is down', async () => {
    const store = new MemoryStore();
    store.rates.set('USD/ILS', {
      base: 'USD',
      quote: 'ILS',
      rate: '3.60',
      source: 'cached',
      isManual: false,
      fetchedAt: new Date(Date.now() - 3600 * 1000),
    });

    const { service: currency } = service({ store, fx: [failingProvider()] });
    const result = await currency.getRate('USD', 'ILS');

    expect(result.stale).toBe(true);
    expect(result.rate.toDecimalString(2)).toBe('3.60');
  });

  it('refuses entirely once the stored rate is past the staleness cap', async () => {
    const store = new MemoryStore();
    store.rates.set('USD/ILS', {
      base: 'USD',
      quote: 'ILS',
      rate: '3.60',
      source: 'cached',
      isManual: false,
      fetchedAt: new Date(Date.now() - 10 * 86_400 * 1000),
    });

    const { service: currency } = service({ store, fx: [failingProvider()], maxStaleness: 3600 });
    await expect(currency.getRate('USD', 'ILS')).rejects.toMatchObject({
      code: 'EXCHANGE_RATE_STALE',
    });
  });

  it('honours a user manual rate over the automatic feed', async () => {
    const { service: currency } = service({ fx: [fxProvider('3.70')] });
    const result = await currency.getRate('USD', 'ILS', { mode: 'manual', manualUsdIls: '4.00' });

    expect(result.isManual).toBe(true);
    expect(result.rate.toDecimalString(2)).toBe('4.00');
  });

  it('inverts a manual rate for the reverse direction', async () => {
    const { service: currency } = service({});
    const result = await currency.getRate('ILS', 'USD', { mode: 'manual', manualUsdIls: '4.00' });
    expect(result.rate.toDecimalString(2)).toBe('0.25');
  });

  it('coalesces concurrent lookups into a single provider call', async () => {
    const fetch = vi.fn(async (base: 'USD' | 'ILS', quote: 'USD' | 'ILS') =>
      ExchangeRate.fromDecimalString({ base, quote, value: '3.70', asOf: new Date(), source: 'x' }),
    );
    const { service: currency } = service({ fx: [{ name: 'x', fetchRate: fetch }] });

    await Promise.all([
      currency.getRate('USD', 'ILS'),
      currency.getRate('USD', 'ILS'),
      currency.getRate('USD', 'ILS'),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null from convert rather than inventing a value', async () => {
    const { service: currency } = service({ fx: [failingProvider()] });
    const result = await currency.convert(FiatAmount.parse('100', 'USD'), 'ILS');
    expect(result).toBeNull();
  });

  it('treats a same-currency conversion as the identity', async () => {
    const { service: currency } = service({});
    const amount = FiatAmount.parse('42.00', 'USD');
    const result = await currency.convert(amount, 'USD');
    expect(result?.amount.equals(amount)).toBe(true);
  });
});

describe('asset prices', () => {
  const priceProvider: PriceProvider = {
    name: 'stub',
    async fetchPrices(ids) {
      const output = new Map<string, AssetPrice>();
      for (const id of ids) {
        if (id === 'unpriceable') continue; // absent, not zero
        output.set(
          id,
          AssetPrice.fromDecimalString({
            assetKey: id,
            symbol: id,
            quote: 'USD',
            value: '1.0002',
            asOf: new Date(),
            source: 'stub',
          }),
        );
      }
      return output;
    },
  };

  it('omits assets the provider could not price', async () => {
    const { service: currency } = service({ prices: [priceProvider] });
    const prices = await currency.getPrices([
      { id: 'tether', symbol: 'USDT', priceId: 'tether' },
      { id: 'unpriceable', symbol: 'XXX', priceId: 'unpriceable' },
    ]);

    expect(prices.has('tether')).toBe(true);
    // Crucially absent rather than present-as-zero, which would understate a portfolio.
    expect(prices.has('unpriceable')).toBe(false);
  });

  it('skips assets with no price identifier at all', async () => {
    const { service: currency } = service({ prices: [priceProvider] });
    const prices = await currency.getPrices([{ id: 'custom', symbol: 'CUS', priceId: null }]);
    expect(prices.size).toBe(0);
  });

  it('values a token in both currencies', async () => {
    const { service: currency } = service({ prices: [priceProvider] });
    const prices = await currency.getPrices([{ id: 'tether', symbol: 'USDT', priceId: 'tether' }]);
    const amount = TokenAmount.parse('100', { assetKey: 'tether', symbol: 'USDT', decimals: 6 });

    const valued = await currency.valueToken(amount, prices.get('tether'));
    expect(valued.usd?.toDecimalString()).toBe('100.02');
    expect(valued.ils?.toDecimalString()).toBe('370.07');
  });

  it('returns nulls for a missing price rather than zero', async () => {
    const { service: currency } = service({ prices: [priceProvider] });
    const amount = TokenAmount.parse('100', { assetKey: 'x', symbol: 'X', decimals: 6 });
    const valued = await currency.valueToken(amount, undefined);

    expect(valued.usd).toBeNull();
    expect(valued.ils).toBeNull();
    expect(valued.pricedAt).toBeNull();
  });
});
