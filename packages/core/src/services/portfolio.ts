import {
  AppError,
  FiatAmount,
  TokenAmount,
  assetKey,
  shareBps,
  type AssetDto,
  type ExchangeRateDto,
  type PortfolioSummaryDto,
  type ValuedTokenDto,
} from '@wallet/shared';
import { accountsRepo, walletsRepo, type AssetRow } from '@wallet/db';
import { asUser, fxPreference, type ServiceContext } from './base.js';
import { fiatFromMinor, toAssetDto, toExchangeRateDto, toValuedTokenDto } from '../mappers.js';

/**
 * Portfolio aggregation.
 *
 * The invariant this service protects: **a displayed total is either complete and correct,
 * or absent.** If any holding cannot be priced, or the FX rate is unusable, the affected
 * totals come back `null` and `partial` is set. The UI shows "—" and an explanation. It
 * never shows a number that silently omits an asset — an under-counted balance is worse
 * than no balance, because it looks authoritative.
 */
export class PortfolioService {
  async summary(context: ServiceContext): Promise<PortfolioSummaryDto> {
    const preference = await fxPreference(context);

    const [balances, cashRows] = await Promise.all([
      asUser(context, (tx) => walletsRepo.listPortfolioBalances(tx, context.actor.userId)),
      asUser(context, (tx) => accountsRepo.cashTotals(tx, context.actor.userId)),
    ]);

    let partial = false;

    /* ---------------------------------------------------------- crypto -- */

    const uniqueAssets = new Map<string, AssetRow>();
    for (const balance of balances) uniqueAssets.set(balance.asset.id, balance.asset);

    const prices = await context.app.currency.getPrices(
      [...uniqueAssets.values()].map((asset) => ({
        id: asset.id,
        symbol: asset.symbol,
        priceId: asset.price_id,
      })),
    );

    // Balances of the same asset held in several wallets are combined into one row.
    const combined = new Map<string, { asset: AssetRow; raw: bigint }>();
    for (const balance of balances) {
      const existing = combined.get(balance.asset.id);
      const raw = BigInt(balance.raw_amount);
      if (existing) existing.raw += raw;
      else combined.set(balance.asset.id, { asset: balance.asset, raw });
    }

    let cryptoUsdMinor = 0n;
    let cryptoIlsMinor = 0n;
    const valuedAssets: Array<{ asset: AssetDto; value: ValuedTokenDto; usdMinor: bigint }> = [];

    for (const entry of combined.values()) {
      if (entry.raw === 0n) continue;

      const amount = TokenAmount.fromRaw(entry.raw, {
        assetKey: assetKey({
          network: entry.asset.network,
          env: entry.asset.env,
          contractAddress: entry.asset.contract_address,
          symbol: entry.asset.symbol,
        }),
        symbol: entry.asset.symbol,
        decimals: entry.asset.decimals,
      });

      const valued = await context.app.currency.valueToken(
        amount,
        prices.get(entry.asset.id),
        preference,
      );

      if (!valued.usd) {
        // Unpriced holding: still shown as a quantity, but the totals become unreliable.
        partial = true;
      } else {
        cryptoUsdMinor += valued.usd.minor;
        if (valued.ils) cryptoIlsMinor += valued.ils.minor;
        else partial = true;
      }

      valuedAssets.push({
        asset: toAssetDto(entry.asset),
        value: toValuedTokenDto({
          token: {
            assetId: entry.asset.id,
            symbol: amount.symbol,
            decimals: amount.decimals,
            raw: amount.raw.toString(),
            decimal: amount.toDecimalString(),
          },
          usd: valued.usd,
          ils: valued.ils,
          pricedAt: valued.pricedAt,
        }),
        usdMinor: valued.usd?.minor ?? 0n,
      });
    }

    valuedAssets.sort((a, b) => (a.usdMinor === b.usdMinor ? 0 : a.usdMinor > b.usdMinor ? -1 : 1));

    /* ------------------------------------------------------------ cash -- */

    let cashUsdMinor = 0n;
    let cashIlsMinor = 0n;
    let cashNativeMinor = 0n;
    const nativeCurrency = cashRows.find((row) => row.currency === 'ILS') ? 'ILS' : 'USD';

    for (const row of cashRows) {
      const amount = FiatAmount.fromMinor(row.total_minor, row.currency);
      if (row.currency === nativeCurrency) cashNativeMinor += amount.minor;

      const usd = await context.app.currency.convert(amount, 'USD', preference);
      const ils = await context.app.currency.convert(amount, 'ILS', preference);
      if (usd) cashUsdMinor += usd.amount.minor;
      else if (!amount.isZero()) partial = true;
      if (ils) cashIlsMinor += ils.amount.minor;
      else if (!amount.isZero()) partial = true;
    }

    /* ------------------------------------------------------------ rate -- */

    let rate: ExchangeRateDto | null = null;
    try {
      const result = await context.app.currency.getRate('USD', 'ILS', preference);
      rate = toExchangeRateDto(result, context.app.config.market.fxMaxStalenessSeconds);
      if (rate.isStale) partial = true;
    } catch (error) {
      if (!AppError.is(error) || !error.code.startsWith('EXCHANGE_RATE')) throw error;
      partial = true;
    }

    const totalUsdMinor = cryptoUsdMinor + cashUsdMinor;
    const totalIlsMinor = cryptoIlsMinor + cashIlsMinor;

    return {
      totalUsd: partial ? null : fiatFromMinor(totalUsdMinor, 'USD'),
      totalIls: partial ? null : fiatFromMinor(totalIlsMinor, 'ILS'),
      cash: {
        usd: partial ? null : fiatFromMinor(cashUsdMinor, 'USD'),
        ils: partial ? null : fiatFromMinor(cashIlsMinor, 'ILS'),
        // The native cash figure never depends on an FX rate, so it is always shown.
        native:
          fiatFromMinor(cashNativeMinor, nativeCurrency) ?? fiatFromMinor(0n, nativeCurrency)!,
      },
      crypto: {
        usd: partial ? null : fiatFromMinor(cryptoUsdMinor, 'USD'),
        ils: partial ? null : fiatFromMinor(cryptoIlsMinor, 'ILS'),
      },
      assets: valuedAssets.map((entry) => ({
        asset: entry.asset,
        value: entry.value,
        shareBps: shareBps(entry.usdMinor, cryptoUsdMinor),
      })),
      rate,
      partial,
      generatedAt: new Date().toISOString(),
    };
  }
}
