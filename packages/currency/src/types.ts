import type { AssetPrice, ExchangeRate, FiatCurrency } from '@wallet/shared';

/** A source of USD↔ILS (and any other fiat pair) rates. */
export interface FxProvider {
  readonly name: string;
  fetchRate(base: FiatCurrency, quote: FiatCurrency): Promise<ExchangeRate>;
}

/** A source of crypto spot prices in USD. */
export interface PriceProvider {
  readonly name: string;
  /**
   * `ids` are provider-specific identifiers taken from `assets.price_id`.
   * Returns a map keyed by the same ids. Missing ids are simply absent — never zero.
   */
  fetchPrices(ids: string[]): Promise<Map<string, AssetPrice>>;
}

/**
 * Persistence seam.
 *
 * The currency package does not depend on `@wallet/db`; the composition root wires this to
 * the repositories. That keeps rate logic unit-testable with an in-memory store, and keeps
 * the dependency graph one-directional.
 */
export interface RateStore {
  loadLatestFx(base: FiatCurrency, quote: FiatCurrency): Promise<StoredRate | null>;
  saveFx(rate: StoredRate): Promise<void>;
  loadLatestPrices(assetIds: string[]): Promise<Map<string, StoredPrice>>;
  savePrice(price: StoredPrice): Promise<void>;
}

export interface StoredRate {
  base: FiatCurrency;
  quote: FiatCurrency;
  /** Exact decimal string, e.g. "3.7412". */
  rate: string;
  source: string;
  isManual: boolean;
  fetchedAt: Date;
}

export interface StoredPrice {
  assetId: string;
  symbol: string;
  quote: FiatCurrency;
  price: string;
  source: string;
  fetchedAt: Date;
}

export interface FxPolicy {
  /** How long a fetched rate is considered fresh. */
  refreshSeconds: number;
  /**
   * Past this age the rate is refused outright. The app then hides converted totals rather
   * than displaying a number derived from a rate nobody should trust.
   */
  maxStalenessSeconds: number;
  /** Sanity band. A rate outside it is rejected as a provider malfunction. */
  bounds: Record<string, { min: string; max: string }>;
}

export interface PricePolicy {
  refreshSeconds: number;
  maxStalenessSeconds: number;
}

export interface RateResult {
  rate: ExchangeRate;
  /** True when the rate is older than `refreshSeconds` but still inside the staleness cap. */
  stale: boolean;
  isManual: boolean;
  ageSeconds: number;
}

/** Per-user overrides that let someone pin a rate they consider authoritative. */
export interface UserFxPreference {
  mode: 'auto' | 'manual';
  manualUsdIls: string | null;
}
