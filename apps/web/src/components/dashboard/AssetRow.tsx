'use client';

import type { AssetDto, ValuedTokenDto } from '@wallet/shared';
import { AssetGlyph } from '@/components/ui/Icon';
import { fiat, token } from '@/lib/format';
import { useApp } from '@/providers/AppProvider';

/**
 * One holding: quantity on the left, fiat value on the right.
 *
 * An unpriced asset still shows its quantity — the user genuinely holds it — with "—" where
 * the value would be, so the gap is visible rather than implied.
 */
export function AssetRow({
  asset,
  value,
  hidden,
  shareBps,
}: {
  asset: AssetDto;
  value: ValuedTokenDto;
  hidden: boolean;
  shareBps?: number;
}) {
  const { locale, t } = useApp();

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <AssetGlyph symbol={asset.symbol} size={40} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-text">{asset.symbol}</p>
        <p className="truncate text-[12.5px] text-muted">
          {asset.name}
          {typeof shareBps === 'number' && shareBps > 0 ? (
            <span className="numeric"> · {(shareBps / 100).toFixed(0)}%</span>
          ) : null}
        </p>
      </div>

      <div className="text-end">
        <p className="numeric text-[15px] font-semibold text-text">
          <span className="bidi-isolate">
            {token(value.token, locale, { hidden, maxFractionDigits: 4 })}
          </span>
        </p>
        <p className="numeric text-[12.5px] text-muted">
          <span className="bidi-isolate">
            {value.usd ? fiat(value.usd, locale, { hidden }) : t('common.unavailable')}
          </span>
        </p>
      </div>
    </div>
  );
}
