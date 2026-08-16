import {
  AppError,
  AssetPrice,
  ExchangeRate,
  type FiatAmount,
  RATE_SCALE_DECIMALS,
  type TokenAmount,
  parseDecimal,
  type FiatCurrency,
} from '@wallet/shared';
import type {
  FxPolicy,
  FxProvider,
  PricePolicy,
  PriceProvider,
  RateResult,
  RateStore,
  StoredPrice,
  UserFxPreference,
} from './types.js';

/**
 * Currency service.
 *
 * The rule this whole file exists to enforce: **never silently use an invalid or unknown
 * rate.** Concretely —
 *
 *   * a fetched rate outside the configured sanity band is rejected, not stored;
 *   * a rate older than `maxStalenessSeconds` throws `EXCHANGE_RATE_STALE` rather than being
 *     used;
 *   * when no rate is available the caller gets `null` and the UI shows "—". It never shows
 *     a total assembled from a guess.
 *
 * Caching is two-tier: a process-local memo (so a request that values twenty assets makes
 * one lookup) backed by the database (so a cold serverless instance does not hit the
 * provider, and so every process agrees on the same number).
 */

interface CacheEntry<T> {
  value: T;
  loadedAt: number;
}

export class CurrencyService {
  private fxMemo = new Map<string, CacheEntry<RateResult>>();
  private priceMemo = new Map<string, CacheEntry<AssetPrice>>();
  /** Coalesces concurrent refreshes so ten parallel requests cause one provider call. */
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      store: RateStore;
      fxProviders: FxProvider[];
      priceProviders: PriceProvider[];
      fxPolicy: FxPolicy;
      pricePolicy: PricePolicy;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private key(base: string, quote: string): string {
    return `${base}/${quote}`;
  }

  /** Reject a rate that falls outside the configured sanity band for the pair. */
  private assertWithinBounds(rate: ExchangeRate): void {
    const bounds = this.deps.fxPolicy.bounds[this.key(rate.base, rate.quote)];
    if (!bounds) return;
    const min = parseDecimal(bounds.min, RATE_SCALE_DECIMALS, { allowTruncation: true });
    const max = parseDecimal(bounds.max, RATE_SCALE_DECIMALS, { allowTruncation: true });
    if (rate.scaled < min || rate.scaled > max) {
      throw new AppError('EXCHANGE_RATE_UNAVAILABLE', {
        internal: `rate ${rate.base}/${rate.quote} = ${rate.toDecimalString(6)} is outside the sanity band ${bounds.min}..${bounds.max} (source ${rate.source})`,
      });
    }
  }

  /**
   * Current FX rate.
   *
   * `preference` lets a user pin a manual rate; when they do, it is used verbatim and
   * reported as manual so the UI can label it. Otherwise: memo → database → providers.
   */
  async getRate(
    base: FiatCurrency,
    quote: FiatCurrency,
    preference?: UserFxPreference,
  ): Promise<RateResult> {
    if (base === quote) {
      return {
        rate: ExchangeRate.fromDecimalString({
          base,
          quote,
          value: '1',
          asOf: this.now(),
          source: 'identity',
        }),
        stale: false,
        isManual: false,
        ageSeconds: 0,
      };
    }

    if (preference?.mode === 'manual' && preference.manualUsdIls) {
      const manual = this.buildManualRate(base, quote, preference.manualUsdIls);
      if (manual) return manual;
      // A malformed manual rate falls through to automatic rather than throwing: the user's
      // settings should not be able to break their dashboard.
    }

    const cacheKey = this.key(base, quote);
    const cached = this.fxMemo.get(cacheKey);
    const refreshMs = this.deps.fxPolicy.refreshSeconds * 1000;
    if (cached && Date.now() - cached.loadedAt < refreshMs) {
      return cached.value;
    }

    const result = await this.coalesce(`fx:${cacheKey}`, () => this.loadRate(base, quote));
    this.fxMemo.set(cacheKey, { value: result, loadedAt: Date.now() });
    return result;
  }

  private buildManualRate(
    base: FiatCurrency,
    quote: FiatCurrency,
    manualUsdIls: string,
  ): RateResult | null {
    try {
      const usdIls = ExchangeRate.fromDecimalString({
        base: 'USD',
        quote: 'ILS',
        value: manualUsdIls,
        asOf: this.now(),
        source: 'manual',
      });
      let rate: ExchangeRate | null = null;
      if (base === 'USD' && quote === 'ILS') rate = usdIls;
      else if (base === 'ILS' && quote === 'USD') rate = usdIls.invert();
      if (!rate) return null;
      return { rate, stale: false, isManual: true, ageSeconds: 0 };
    } catch {
      return null;
    }
  }

  private async loadRate(base: FiatCurrency, quote: FiatCurrency): Promise<RateResult> {
    const stored = await this.deps.store.loadLatestFx(base, quote);
    const storedRate = stored
      ? ExchangeRate.fromDecimalString({
          base,
          quote,
          value: stored.rate,
          asOf: stored.fetchedAt,
          source: stored.source,
        })
      : null;

    const storedAge = storedRate?.ageSeconds(this.now()) ?? Number.POSITIVE_INFINITY;
    if (storedRate && storedAge < this.deps.fxPolicy.refreshSeconds) {
      return {
        rate: storedRate,
        stale: false,
        isManual: stored?.isManual ?? false,
        ageSeconds: storedAge,
      };
    }

    // Stored value is stale (or absent): try the providers in order.
    const failures: string[] = [];
    for (const provider of this.deps.fxProviders) {
      try {
        const fresh = await provider.fetchRate(base, quote);
        this.assertWithinBounds(fresh);
        await this.deps.store.saveFx({
          base,
          quote,
          rate: fresh.toDecimalString(10),
          source: fresh.source,
          isManual: false,
          fetchedAt: fresh.asOf,
        });
        return { rate: fresh, stale: false, isManual: false, ageSeconds: 0 };
      } catch (error) {
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : 'failed'}`);
      }
    }

    // Every provider failed. Serve the stored rate if it is still inside the staleness cap,
    // clearly flagged as stale; otherwise refuse.
    if (storedRate && storedAge <= this.deps.fxPolicy.maxStalenessSeconds) {
      return {
        rate: storedRate,
        stale: true,
        isManual: stored?.isManual ?? false,
        ageSeconds: storedAge,
      };
    }

    throw new AppError(storedRate ? 'EXCHANGE_RATE_STALE' : 'EXCHANGE_RATE_UNAVAILABLE', {
      internal: `no usable ${base}/${quote} rate. Provider failures: ${failures.join(' | ')}`,
      details: storedRate ? { ageSeconds: storedAge } : undefined,
      retryable: true,
    });
  }

  /** Force a refresh from providers. Used by the scheduled `fx.refresh` job. */
  async refreshRate(base: FiatCurrency, quote: FiatCurrency): Promise<RateResult> {
    this.fxMemo.delete(this.key(base, quote));
    const failures: string[] = [];
    for (const provider of this.deps.fxProviders) {
      try {
        const fresh = await provider.fetchRate(base, quote);
        this.assertWithinBounds(fresh);
        await this.deps.store.saveFx({
          base,
          quote,
          rate: fresh.toDecimalString(10),
          source: fresh.source,
          isManual: false,
          fetchedAt: fresh.asOf,
        });
        const result = { rate: fresh, stale: false, isManual: false, ageSeconds: 0 };
        this.fxMemo.set(this.key(base, quote), { value: result, loadedAt: Date.now() });
        return result;
      } catch (error) {
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : 'failed'}`);
      }
    }
    throw new AppError('EXCHANGE_RATE_UNAVAILABLE', {
      internal: `refresh failed for ${base}/${quote}: ${failures.join(' | ')}`,
      retryable: true,
    });
  }

  /**
   * Convert an amount. Returns null when no trustworthy rate exists, so a caller building
   * a dashboard total can mark the result partial instead of inventing a number.
   */
  async convert(
    amount: FiatAmount,
    target: FiatCurrency,
    preference?: UserFxPreference,
  ): Promise<{ amount: FiatAmount; rate: RateResult } | null> {
    if (amount.currency === target) {
      const identity = await this.getRate(target, target);
      return { amount, rate: identity };
    }
    try {
      const rate = await this.getRate(amount.currency, target, preference);
      return { amount: rate.rate.convert(amount), rate };
    } catch (error) {
      if (AppError.is(error) && error.code.startsWith('EXCHANGE_RATE')) return null;
      throw error;
    }
  }

  /* ------------------------------------------------------------- prices -- */

  /**
   * Latest USD prices for the given assets, keyed by asset id.
   *
   * `priceId` is the provider-specific identifier from the asset registry. Assets without
   * one, or whose price could not be fetched, are simply absent from the map.
   */
  async getPrices(
    assets: Array<{ id: string; symbol: string; priceId: string | null }>,
  ): Promise<Map<string, AssetPrice>> {
    const output = new Map<string, AssetPrice>();
    const needed: Array<{ id: string; symbol: string; priceId: string }> = [];

    const refreshMs = this.deps.pricePolicy.refreshSeconds * 1000;
    for (const asset of assets) {
      const memo = this.priceMemo.get(asset.id);
      if (memo && Date.now() - memo.loadedAt < refreshMs) {
        output.set(asset.id, memo.value);
        continue;
      }
      if (asset.priceId)
        needed.push({ id: asset.id, symbol: asset.symbol, priceId: asset.priceId });
    }

    if (needed.length === 0) return output;

    const stored = await this.deps.store.loadLatestPrices(needed.map((asset) => asset.id));
    const stillNeeded: typeof needed = [];

    for (const asset of needed) {
      const row = stored.get(asset.id);
      if (!row) {
        stillNeeded.push(asset);
        continue;
      }
      const price = this.toAssetPrice(row);
      const age = price.ageSeconds(this.now());
      if (age < this.deps.pricePolicy.refreshSeconds) {
        output.set(asset.id, price);
        this.priceMemo.set(asset.id, { value: price, loadedAt: Date.now() });
      } else {
        stillNeeded.push(asset);
        // Keep the stale value as a fallback if every provider fails below.
        if (age <= this.deps.pricePolicy.maxStalenessSeconds) output.set(asset.id, price);
      }
    }

    if (stillNeeded.length === 0) return output;

    const priceIds = stillNeeded.map((asset) => asset.priceId);
    for (const provider of this.deps.priceProviders) {
      let fetched: Map<string, AssetPrice>;
      try {
        fetched = await provider.fetchPrices(priceIds);
      } catch {
        continue; // Try the next provider.
      }

      for (const asset of stillNeeded) {
        const price = fetched.get(asset.priceId);
        if (!price) continue;
        const bound = AssetPrice.fromScaled({
          assetKey: asset.id,
          symbol: asset.symbol,
          quote: 'USD',
          scaled: price.scaled,
          asOf: price.asOf,
          source: price.source,
        });
        output.set(asset.id, bound);
        this.priceMemo.set(asset.id, { value: bound, loadedAt: Date.now() });
        await this.deps.store.savePrice({
          assetId: asset.id,
          symbol: asset.symbol,
          quote: 'USD',
          price: bound.toDecimalString(10),
          source: bound.source,
          fetchedAt: bound.asOf,
        });
      }

      // Stop as soon as everything is covered.
      if (stillNeeded.every((asset) => output.has(asset.id))) break;
    }

    return output;
  }

  private toAssetPrice(row: StoredPrice): AssetPrice {
    return AssetPrice.fromDecimalString({
      assetKey: row.assetId,
      symbol: row.symbol,
      quote: row.quote,
      value: row.price,
      asOf: row.fetchedAt,
      source: row.source,
    });
  }

  /**
   * Value a token holding in USD and ILS.
   * Returns nulls (not zeros) for whichever leg could not be computed.
   */
  async valueToken(
    amount: TokenAmount,
    price: AssetPrice | undefined,
    preference?: UserFxPreference,
  ): Promise<{ usd: FiatAmount | null; ils: FiatAmount | null; pricedAt: Date | null }> {
    if (!price) return { usd: null, ils: null, pricedAt: null };
    if (price.ageSeconds(this.now()) > this.deps.pricePolicy.maxStalenessSeconds) {
      return { usd: null, ils: null, pricedAt: null };
    }

    const usd = price.value(amount);
    const converted = await this.convert(usd, 'ILS', preference);
    return { usd, ils: converted?.amount ?? null, pricedAt: price.asOf };
  }

  /** Drop cached values. Used by tests and by the admin "force refresh" action. */
  clearCache(): void {
    this.fxMemo.clear();
    this.priceMemo.clear();
  }

  private async coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
