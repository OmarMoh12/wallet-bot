'use client';

import { useEffect, useState } from 'react';
import type { AssetDto, ReceiveInfoDto, WalletDto } from '@wallet/shared';
import { Screen } from '@/components/layout/Screen';
import { Button, Card, EmptyState, Skeleton, cx } from '@/components/ui/primitives';
import { Icon, AssetGlyph } from '@/components/ui/Icon';
import { useApiQuery } from '@/hooks/useApi';
import { copyText } from '@/lib/telegram';
import { useApp } from '@/providers/AppProvider';

/**
 * Receive.
 *
 * The QR is rendered on the server and delivered as a data URI, so no QR library ships to
 * the client and the encoded string is guaranteed to be the address the server validated.
 *
 * The network warning is unmissable by design: sending the wrong asset to a correct-looking
 * address is the most common way people lose crypto, and it is unrecoverable.
 */
export default function ReceivePage() {
  const { t, toast } = useApp();
  const [walletId, setWalletId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);

  const { data: wallets, loading: walletsLoading } = useApiQuery<WalletDto[]>('/api/wallets');
  const { data: assets } = useApiQuery<{ items: AssetDto[] }>(
    walletId ? '/api/assets' : null,
    walletId ? { walletId } : undefined,
  );
  const { data: info, loading: infoLoading } = useApiQuery<ReceiveInfoDto>(
    walletId && assetId ? '/api/receive' : null,
    walletId && assetId ? { walletId, assetId } : undefined,
  );

  useEffect(() => {
    if (!walletId && wallets && wallets.length > 0) setWalletId(wallets[0]?.id ?? null);
  }, [wallets, walletId]);

  useEffect(() => {
    if (assets && assets.items.length > 0) {
      const exists = assets.items.some((asset) => asset.id === assetId);
      if (!exists) setAssetId(assets.items[0]?.id ?? null);
    }
  }, [assets, assetId]);

  if (walletsLoading) {
    return (
      <Screen title={t('receive.title')} back>
        <Skeleton className="h-72 w-full rounded-3xl" />
      </Screen>
    );
  }

  if (!wallets || wallets.length === 0) {
    return (
      <Screen title={t('receive.title')} back>
        <EmptyState icon="wallet" title={t('wallets.empty')} hint={t('wallets.emptyHint')} />
      </Screen>
    );
  }

  return (
    <Screen title={t('receive.title')} back>
      <div className="space-y-4">
        <Selector
          label={t('receive.selectWallet')}
          options={wallets.map((wallet) => ({
            id: wallet.id,
            label: wallet.name,
            hint: wallet.network.toUpperCase(),
          }))}
          value={walletId}
          onChange={setWalletId}
        />

        {assets && assets.items.length > 0 ? (
          <div>
            <p className="px-1 pb-2 text-[13px] font-medium text-muted">{t('send.selectAsset')}</p>
            <div className="flex flex-wrap gap-2">
              {assets.items.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => setAssetId(asset.id)}
                  aria-pressed={assetId === asset.id}
                  className={cx(
                    'flex items-center gap-2 rounded-full border px-3 py-2 text-[13px] font-medium',
                    assetId === asset.id
                      ? 'border-accent bg-accent/12 text-accent'
                      : 'border-border bg-surface text-muted',
                  )}
                >
                  <AssetGlyph symbol={asset.symbol} size={20} />
                  {asset.symbol}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {infoLoading ? (
          <Skeleton className="h-80 w-full rounded-3xl" />
        ) : info ? (
          <>
            <Card className="p-6">
              <div className="mx-auto w-fit rounded-3xl bg-white p-3">
                {/*
                  A plain <img> rather than next/image: the source is an inline data URI
                  produced by our own server, so there is nothing for the image optimiser
                  to fetch, resize or cache.
                */}
                <img
                  src={info.qrSvgDataUri}
                  alt={t('receive.showQr')}
                  width={220}
                  height={220}
                  className="block h-[220px] w-[220px]"
                />
              </div>

              <p className="mt-5 text-center text-[13px] text-muted">{t('receive.address')}</p>
              <p
                className="numeric mt-1 break-all text-center text-[13.5px] font-medium text-text"
                dir="ltr"
              >
                {info.address}
              </p>

              <div className="mt-5 grid grid-cols-1 gap-2">
                <Button
                  icon="copy"
                  onClick={() => {
                    void copyText(info.address).then((ok) => {
                      if (ok) toast(t('common.copied'), 'success');
                    });
                  }}
                >
                  {t('receive.copyAddress')}
                </Button>
              </div>
            </Card>

            <div
              className="flex items-start gap-2.5 rounded-2xl border border-warning/25 bg-warning/10 px-4 py-3.5 text-[13px] leading-relaxed text-warning"
              role="alert"
            >
              <Icon name="warning" size={17} className="mt-px shrink-0" />
              <span>
                {t('receive.networkWarning', {
                  asset: info.asset.symbol,
                  network: info.networkLabel,
                })}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </Screen>
  );
}

function Selector({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div>
      <p className="px-1 pb-2 text-[13px] font-medium text-muted">{label}</p>
      <Card>
        {options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={value === option.id}
            className={cx(
              'row-press flex w-full items-center gap-3 px-4 py-3 text-start',
              index > 0 && 'border-t border-border',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-text">
                {option.label}
              </span>
              {option.hint ? (
                <span className="block text-[12px] text-muted">{option.hint}</span>
              ) : null}
            </span>
            {value === option.id ? <Icon name="check" size={18} className="text-accent" /> : null}
          </button>
        ))}
      </Card>
    </div>
  );
}
